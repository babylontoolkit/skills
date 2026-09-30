'use strict';

/**
 * Runs one child process for the bridge (T24 step 4, D41): never through a shell, always with a hard
 * timeout, stdout capped, stderr streamed line by line.
 */

const { spawn } = require('child_process');

const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * @typedef {{ code: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean }} RunResult
 * @typedef {(file: string, args: string[], opts?: RunOptions) => Promise<RunResult>} RunProcess
 * @typedef {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal, onLine?: (line: string) => void, env?: NodeJS.ProcessEnv }} RunOptions
 */

/** @type {RunProcess} */
function runProcess(file, args, { cwd, timeoutMs = 120_000, signal, onLine, env } = {}) {
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

module.exports = { runProcess, MAX_STDOUT_BYTES, KILL_GRACE_MS };
