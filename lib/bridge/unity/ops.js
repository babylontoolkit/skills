'use strict';

/**
 * Runs one Unity Bridge job on this computer (T24 step 6).
 *
 * Order: the helper's own guard (tiers, paths, toolkit floor, unsaved work — D3/D39) → `started` →
 * one `log.op` line → the operation → `final`. A refusal is reported as `refused` BEFORE anything runs,
 * which the App Builder records as refused (nothing ran).
 *
 * Every Unity CLI call carries `--format json --non-interactive` and never `--yes` (D41), runs without a
 * shell, and has a hard timeout (120 s ordinary, 1800 s long).
 */

const fs = require('fs');
const path = require('path');

const defaultLog = require('../log');
const { capText, BRIDGE_MAX_IMAGE_BASE64, isSafeJobId } = require('../protocol');
const { PATH_PARAMS, isLongOperation } = require('../policy');
const { helperTier, resolveProjectPath, dirtyScenes, unsavedWorkReason } = require('./guard');
const { runProcess: defaultRunProcess } = require('./run');
const { ensureAutomation: defaultEnsureAutomation } = require('./automation');

const ORDINARY_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 1_800_000;
const PROGRESS_EVERY_MS = 500;
const EDITOR_POLL_MS = 5_000;
const EDITOR_OPEN_WAIT_MS = 180_000;
const CANCELLED = 'Cancel requested — Unity may still finish the operation.';
const NO_CLI =
  'The Unity command-line tool (unity) was not found on this computer. Install it, then run bt-agent bridge again.';

/**
 * @typedef {import('../protocol').BridgeDispatch} BridgeDispatch
 * @typedef {import('../protocol').BridgeJobEvent} BridgeJobEvent
 * @typedef {import('../protocol').BridgeResultPayload} BridgeResultPayload
 * @typedef {import('./run').RunProcess} RunProcess
 * @typedef {import('./run').RunResult} RunResult
 * @typedef {{ key: string, name: string, root: string, productGuid?: string, toolkitVersion?: string }} LocalProject
 * @typedef {{
 *   project: LocalProject,
 *   cli?: { path: string, version: string },
 *   emit: (event: BridgeJobEvent) => Promise<void>,
 *   signal?: AbortSignal,
 *   noScripts?: boolean,
 *   runProcess?: RunProcess,
 *   api?: { post: (path: string, body: unknown, signal?: AbortSignal) => Promise<{ status: number, body: any }> },
 *   ensureAutomation?: typeof defaultEnsureAutomation,
 *   log?: { info: (m: string) => void, op: (tier: string, label: string) => void, error?: (m: string) => void },
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} UnityDeps
 */

/** Does this Node hand JSON.parse revivers the source text (Node 21+)? */
const REVIVER_HAS_SOURCE = (() => {
  let seen = false;
  JSON.parse('1', (_k, v, ctx) => ((seen = Boolean(ctx && ctx.source === '1')), v));
  return seen;
})();

/**
 * JSON.parse that keeps 64-bit integers exact: Unity instance ids (e.g. 568105584918862612) are beyond
 * Number's safe range, and a rounded id handed back to the model names a different object — or none.
 * They come back as strings, which is how the CLI passes them anyway.
 * @param {string} text
 * @returns {any}
 */
function parseJsonExact(text) {
  if (REVIVER_HAS_SOURCE) {
    return JSON.parse(text, (_k, v, ctx) =>
      typeof v === 'number' && !Number.isSafeInteger(v) && ctx && /^-?\d+$/.test(ctx.source) ? ctx.source : v
    );
  }
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

/** @param {string} stdout @returns {any} */
function parseEnvelope(stdout) {
  try {
    const v = parseJsonExact(stdout);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} value a command result → text for the model (a string result is shown as is) */
function resultText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** @param {any} env @returns {string} */
function firstError(env) {
  const first = env && Array.isArray(env.errors) ? env.errors[0] : undefined;
  if (first && typeof first.message === 'string') return first.message;
  if (typeof first === 'string') return first;
  return 'Unity reported a failure.';
}

/** @param {RunResult} res */
function rawText(res) {
  return [res.stdout, res.stderr].filter((s) => s && s.trim()).join('\n').trim();
}

/** @param {number} ms @param {AbortSignal} [signal] */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/** @param {string} a @param {string} b */
function samePath(a, b) {
  const norm = (/** @type {string} */ p) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync(r);
    } catch {
      // keep the resolved path
    }
    return process.platform === 'darwin' || process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** @param {unknown} value @returns {string} */
function paramValue(value) {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** @param {string} p */
function removeQuietly(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // scratch clean-up is best effort
  }
}

/**
 * @param {BridgeDispatch} dispatch
 * @returns {string} the one-line description printed in the helper's terminal
 */
function labelOf(dispatch) {
  const op = /** @type {any} */ (dispatch.op);
  switch (op.kind) {
    case 'unity.command':
      return `unity command ${op.name}`;
    case 'unity.cli':
      return `unity ${(op.args || []).join(' ')}`;
    case 'unity.list':
      return `unity command --query ${op.query || '(all)'}`;
    case 'unity.script':
      return `unity run_script ${op.entry}`;
    case 'unity.capture':
      return `unity screenshot ${op.view || 'game'} ${op.width}x${op.height}`;
    case 'unity.editor':
      return `unity editor ${op.action}`;
    default:
      return op.kind;
  }
}

/**
 * @param {BridgeDispatch} dispatch
 * @param {UnityDeps} deps
 * @returns {Promise<void>}
 */
async function executeUnity(dispatch, deps) {
  const {
    project,
    cli,
    emit,
    signal,
    noScripts = false,
    runProcess = defaultRunProcess,
    api,
    ensureAutomation = defaultEnsureAutomation,
    log = defaultLog,
    now = Date.now,
    sleep = defaultSleep,
  } = deps;
  const jobId = dispatch.jobId;
  // The id names files under .bridge/ — never run one that is not a plain token (D3).
  if (!isSafeJobId(jobId)) return;
  const op = /** @type {any} */ (dispatch.op);
  const P = project.root;
  const suffix = ['--project-path', P, '--format', 'json', '--non-interactive'];

  /** @param {string} reason */
  const refuse = (reason) => emit({ jobId, type: 'refused', reason });

  // 1. guard
  const tier = helperTier(dispatch, project, { noScripts });
  if (!tier.ok) return refuse(tier.reason);
  if (!cli) return refuse(NO_CLI);

  /** a quiet Unity call (no progress lines) — used by the guards and the grant */
  const runUnityQuiet = (/** @type {string[]} */ args, timeoutMs = ORDINARY_TIMEOUT_MS) =>
    runProcess(cli.path, args, { cwd: P, timeoutMs, signal });

  const needsSavedWork =
    (op.kind === 'unity.command' && op.name === 'bt_export_level') || (op.kind === 'unity.editor' && op.action === 'close');
  if (needsSavedWork) {
    const unsaved = unsavedWorkReason(await dirtyScenes((args) => runUnityQuiet(args), P));
    if (unsaved) return refuse(unsaved);
  }

  // path params resolve under the project (validateOperation already refused the unsafe ones)
  /** @type {Record<string, unknown>} */
  let params = {};
  if (op.kind === 'unity.command') {
    params = { ...(op.params || {}) };
    for (const key of Object.keys(params)) {
      if (PATH_PARAMS.has(key) && typeof params[key] === 'string') {
        const abs = resolveProjectPath(P, params[key]);
        if (!abs) return refuse(`The "${key}" path "${params[key]}" is outside the Unity project.`);
        params[key] = abs;
      }
    }
  }

  // 2. started, 3. log
  await emit({ jobId, type: 'started' });
  log.op(tier.tier, labelOf(dispatch));

  let lastProgress = 0;
  /** @param {string} line */
  const onLine = (line) => {
    const t = now();
    if (t - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = t;
    emit({ jobId, type: 'progress', line: capText(line, 500) }).catch(() => {});
  };

  const long = isLongOperation(op);
  const hardTimeoutMs = long || op.kind === 'unity.script' ? LONG_TIMEOUT_MS : ORDINARY_TIMEOUT_MS;
  /** @param {string[]} args @param {number} [timeoutMs] */
  const runUnity = (args, timeoutMs = hardTimeoutMs) => runProcess(cli.path, args, { cwd: P, timeoutMs, signal, onLine });

  /** @param {BridgeResultPayload} result */
  const finalize = (result) =>
    emit({
      jobId,
      type: 'final',
      result: signal && signal.aborted ? { ok: false, text: CANCELLED } : { ...result, text: capText(result.text) },
    });

  /** @param {RunResult} res @returns {BridgeResultPayload|null} */
  const interrupted = (res) => {
    if (res.aborted || (signal && signal.aborted)) return { ok: false, text: CANCELLED };
    if (res.timedOut) {
      return { ok: false, text: `Timed out after ${Math.round(hardTimeoutMs / 1000)} s — Unity may still finish the operation.` };
    }
    return null;
  };

  /**
   * `unity command <name> <suffix> --timeout <s> -- --<k> <v>…` → the envelope's result (params after `--` are command parameters, never CLI options).
   * @param {string} name @param {Record<string, unknown>} p
   * @returns {Promise<BridgeResultPayload>}
   */
  const runCommand = async (name, p) => {
    // The CLI's own options come first; everything after `--` is a parameter OF THE COMMAND, so a
    // param can never become `--yes`, `--project-path`, `--format` or `--timeout` for the CLI itself
    // (D41). Real commands declare `timeout` (eval, run_tests…) and `format` (get_serialized_fields),
    // and this is how they still reach them.
    const args = ['command', name, ...suffix, '--timeout', String(long ? 1800 : 110), '--'];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      args.push(`--${k}`, paramValue(v));
    }
    const res = await runUnity(args);
    const stop = interrupted(res);
    if (stop) return stop;
    const env = parseEnvelope(res.stdout);
    if (!env) return { ok: res.code === 0, text: rawText(res) || `unity exited with code ${res.code}`, exitCode: res.code ?? undefined };
    const ok = env.success === true;
    const data = env.data || {};
    const text = ok ? resultText(data.result !== undefined ? data.result : data) : firstError(env);
    return { ok, text, exitCode: res.code ?? undefined };
  };

  /** @returns {Promise<BridgeResultPayload>} */
  const run = async () => {
    switch (op.kind) {
      case 'unity.list': {
        const res = await runUnity([
          'command',
          '--query',
          typeof op.query === 'string' ? op.query : '',
          '--detail',
          'compact',
          '--limit',
          '200',
          ...suffix,
        ]);
        const stop = interrupted(res);
        if (stop) return stop;
        const env = parseEnvelope(res.stdout);
        if (!env) return { ok: res.code === 0, text: rawText(res), exitCode: res.code ?? undefined };
        if (env.success !== true) return { ok: false, text: firstError(env), exitCode: res.code ?? undefined };
        const commands = env.data && Array.isArray(env.data.commands) ? env.data.commands : [];
        const lines = commands.map(
          (/** @type {any} */ c) => `${c.name} — ${String(c.description || '').replace(/\s+/g, ' ').trim()}`
        );
        const text = lines.length
          ? `${lines.length} command(s):\n${lines.join('\n')}`
          : 'No Unity commands matched that query.';
        return { ok: true, text, exitCode: res.code ?? undefined };
      }

      case 'unity.command': {
        const name = /** @type {string} */ (op.name);
        if (name === 'screenshot' && (params.output === undefined || params.output === '')) {
          const out = path.join(P, '.bridge', 'out');
          fs.mkdirSync(out, { recursive: true });
          params.output = path.join(out, `${jobId}.png`);
        }
        if (name.startsWith('bt_') && api) {
          // Never changes the job's outcome; the grant never reaches a log, a progress line or a result.
          await ensureAutomation(project, {
            api,
            runUnity: (args) => runUnityQuiet(args),
            now,
            log,
          });
        }
        return runCommand(name, params);
      }

      case 'devserver.start': {
        /** @type {Record<string, unknown>} */
        const p = {};
        if (op.port !== undefined) p.port = op.port;
        else if (op.auto === true) p.auto = true;
        return runCommand('bt_devserver_start', p);
      }

      case 'devserver.status':
        return runCommand('bt_devserver_status', {});

      case 'unity.cli': {
        const args = /** @type {string[]} */ (op.args);
        const withProject = ['test', 'recompile', 'logs', 'projects'].includes(args[0]);
        const res = await runUnity([
          ...args,
          ...(withProject ? ['--project-path', P] : []),
          '--format',
          'json',
          '--non-interactive',
        ]);
        const stop = interrupted(res);
        if (stop) return stop;
        const env = parseEnvelope(res.stdout);
        if (env) {
          const ok = res.code === 0 && env.success !== false;
          return { ok, text: ok ? JSON.stringify(env.data !== undefined ? env.data : env, null, 2) : firstError(env), exitCode: res.code ?? undefined };
        }
        return { ok: res.code === 0, text: rawText(res) || `unity exited with code ${res.code}`, exitCode: res.code ?? undefined };
      }

      case 'unity.script': {
        const dir = path.join(P, '.bridge', 'scripts');
        fs.mkdirSync(dir, { recursive: true });
        const rel = `.bridge/scripts/${jobId}.cs`;
        const file = path.join(dir, `${jobId}.cs`);
        fs.writeFileSync(file, /** @type {string} */ (op.source));
        try {
          const res = await runUnity([
            'command',
            'run_script',
            ...suffix,
            '--timeout',
            '1800',
            '--',
            '--file',
            rel,
            '--entry',
            /** @type {string} */ (op.entry),
          ]);
          const stop = interrupted(res);
          if (stop) return stop;
          const env = parseEnvelope(res.stdout);
          if (!env) return { ok: false, text: rawText(res) || `unity exited with code ${res.code}`, exitCode: res.code ?? undefined };
          const result = env.data ? env.data.result : undefined;
          const ok = env.success === true && !(result && typeof result === 'object' && result.success === false);
          const text = env.success === true ? resultText(result !== undefined ? result : env.data) : firstError(env);
          return { ok, text, exitCode: res.code ?? undefined };
        } finally {
          removeQuietly(file);
        }
      }

      case 'unity.capture': {
        const dir = path.join(P, '.bridge', 'out');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${jobId}.png`);
        const view = op.view === 'scene' ? 'scene' : 'game';
        /** @param {number} w @param {number} h @returns {Promise<BridgeResultPayload|{ base64: string }>} */
        const shoot = async (w, h) => {
          removeQuietly(file);
          const res = await runUnity([
            'command',
            'screenshot',
            ...suffix,
            '--',
            '--view',
            view,
            '--output',
            file,
            '--width',
            String(w),
            '--height',
            String(h),
          ]);
          const stop = interrupted(res);
          if (stop) return stop;
          const env = parseEnvelope(res.stdout);
          if (env && env.success !== true) return { ok: false, text: firstError(env), exitCode: res.code ?? undefined };
          let bytes;
          try {
            bytes = fs.readFileSync(file);
          } catch {
            return { ok: false, text: rawText(res) || 'Unity did not write the capture.', exitCode: res.code ?? undefined };
          }
          return { base64: bytes.toString('base64') };
        };
        try {
          let w = op.width;
          let h = op.height;
          let shot = await shoot(w, h);
          if ('base64' in shot && shot.base64.length > BRIDGE_MAX_IMAGE_BASE64) {
            w = Math.max(64, Math.floor(w / 2));
            h = Math.max(64, Math.floor(h / 2));
            shot = await shoot(w, h);
            if ('base64' in shot && shot.base64.length > BRIDGE_MAX_IMAGE_BASE64) {
              return { ok: false, text: 'capture too large' };
            }
          }
          if (!('base64' in shot)) return shot;
          return {
            ok: true,
            text: `Captured the ${view} view at ${w}x${h}.`,
            image: { base64: shot.base64, mimeType: 'image/png' },
          };
        } finally {
          removeQuietly(file);
        }
      }

      case 'unity.editor': {
        const status = async () => {
          const res = await runUnity(['status', '--format', 'json', '--non-interactive'], ORDINARY_TIMEOUT_MS);
          const env = parseEnvelope(res.stdout);
          const instances = env && env.data && Array.isArray(env.data.instances) ? env.data.instances : [];
          return {
            res,
            env,
            mine: instances.filter((/** @type {any} */ i) => i && typeof i.project === 'string' && samePath(i.project, P)),
          };
        };

        if (op.action === 'status') {
          const { res, env, mine } = await status();
          const stop = interrupted(res);
          if (stop) return stop;
          if (!env) return { ok: false, text: rawText(res) || 'Could not read the Unity status.', exitCode: res.code ?? undefined };
          const text = mine.length
            ? JSON.stringify({ running: true, instances: mine }, null, 2)
            : `Unity is not running with the project "${project.name}".`;
          return { ok: env.success !== false, text };
        }

        if (op.action === 'open') {
          const res = await runUnity(['open', P, '--non-interactive'], ORDINARY_TIMEOUT_MS);
          const stop = interrupted(res);
          if (stop) return stop;
          const deadline = now() + EDITOR_OPEN_WAIT_MS;
          while (now() < deadline) {
            if (signal && signal.aborted) return { ok: false, text: CANCELLED };
            const s = await status();
            if (s.mine.some((/** @type {any} */ i) => !i.state || i.state === 'ready')) {
              return { ok: true, text: `Unity is open with the project "${project.name}".` };
            }
            await sleep(EDITOR_POLL_MS, signal);
          }
          return { ok: false, text: `Unity did not report the project "${project.name}" as open within 180 s.` };
        }

        if (op.action === 'close') {
          const res = await runUnity(['close', P, '--timeout', '60', '--format', 'json', '--non-interactive'], ORDINARY_TIMEOUT_MS);
          const stop = interrupted(res);
          if (stop) return stop;
          const env = parseEnvelope(res.stdout);
          if (!env) return { ok: res.code === 0, text: rawText(res) || 'Unity closed.', exitCode: res.code ?? undefined };
          return { ok: env.success === true, text: env.success === true ? `Unity closed the project "${project.name}".` : firstError(env) };
        }

        return { ok: false, text: `Unknown Unity editor action "${op.action}".` };
      }

      default:
        return { ok: false, text: `This Desktop Agent does not know the operation "${op.kind}".` };
    }
  };

  let result;
  try {
    result = await run();
  } catch (err) {
    result = { ok: false, text: `The Desktop Agent failed: ${err && err.message ? err.message : err}` };
  }
  await finalize(result);
}

module.exports = { executeUnity, labelOf, parseEnvelope, parseJsonExact, CANCELLED, NO_CLI, ORDINARY_TIMEOUT_MS, LONG_TIMEOUT_MS };
