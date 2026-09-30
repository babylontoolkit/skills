'use strict';

/**
 * Runs one child process for the bridge (T24 step 4, D41): never through a shell, always with a hard
 * timeout, stdout capped, stderr streamed line by line.
 */

const { spawn: defaultSpawn } = require('child_process');

const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * @typedef {{ code: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean }} RunResult
 * @typedef {(file: string, args: string[], opts?: RunOptions) => Promise<RunResult>} RunProcess
 * @typedef {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal, onLine?: (line: string) => void, env?: NodeJS.ProcessEnv, spawn?: typeof defaultSpawn }} RunOptions
 * @typedef {(file: string, args: string[], opts?: LaunchOptions) => Promise<RunResult>} LaunchDetached
 * @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, waitMs?: number, signal?: AbortSignal, spawn?: typeof defaultSpawn }} LaunchOptions
 */

/**
 * An ordinary job: in the helper's process group, so Ctrl-C and a cancel stop it with the helper.
 * @type {RunProcess}
 */
function runProcess(file, args, { cwd, timeoutMs = 120_000, signal, onLine, env, spawn = defaultSpawn } = {}) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    let outBytes = 0;
    let err = '';
    let partial = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    /** @type {NodeJS.Timeout|undefined} */
    let killTimer;

    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e && e.message ? e.message : e), timedOut, aborted });
      return;
    }

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    /** @param {string} line */
    const emitLine = (line) => {
      const trimmed = line.replace(/\r$/, '');
      if (onLine && trimmed.trim()) {
        try {
          onLine(trimmed);
        } catch {
          // a progress sink must never break the run
        }
      }
    };

    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      if (outBytes >= MAX_STDOUT_BYTES) return;
      const room = MAX_STDOUT_BYTES - outBytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      out.push(piece);
      outBytes += piece.length;
    });

    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      const text = chunk.toString('utf8');
      if (err.length < MAX_STDERR_BYTES) err += text;
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop() || '';
      for (const line of lines) emitLine(line);
    });

    /** @param {number|null} code @param {string} [extraErr] */
    const finish = (code, extraErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (partial) emitLine(partial);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: extraErr ? `${err}${err ? '\n' : ''}${extraErr}` : err,
        timedOut,
        aborted,
      });
    };

    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Starts something that must OUTLIVE the helper — the Unity Editor (`unity open`). The launcher runs
 * detached (its own process group/session, so Ctrl-C in the helper's terminal never reaches the Editor
 * it starts), with no pipes (an Editor that inherited a pipe to a dead helper dies on its next write),
 * and unref'd (the helper can exit while it runs). It is never killed on cancel or timeout: stopping
 * the launcher would stop the Editor it is starting.
 *
 * Resolves with the launcher's exit code when it exits within `waitMs` (`unity open` returns at once;
 * a non-zero code means the Editor was not started), else as launched (code 0). Output is not
 * captured — the caller confirms the Editor by polling `unity status`. A cancel ends the WAIT (never
 * the launcher).
 * @type {LaunchDetached}
 */
function launchDetached(file, args, { cwd, env, waitMs = 30_000, signal, spawn = defaultSpawn } = {}) {
  return new Promise((resolve) => {
    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = spawn(file, args, { cwd, env, detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e && e.message ? e.message : e), timedOut: false, aborted: false });
      return;
    }
    child.unref();
    let settled = false;
    /** @param {number|null} code @param {string} [stderr] */
    const finish = (code, stderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout: '', stderr, timedOut: false, aborted: Boolean(signal && signal.aborted) });
    };
    // NOT unref'd: the child is, so this timer is what keeps the helper alive while it waits for the
    // launcher to exit (found live — with both unref'd, a process with nothing else pending exited mid-job).
    const timer = setTimeout(() => finish(0), waitMs);
    const onAbort = () => finish(null);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => finish(null, e.message));
    child.on('exit', (code) => finish(code));
  });
}

module.exports = { runProcess, launchDetached, MAX_STDOUT_BYTES, KILL_GRACE_MS };
