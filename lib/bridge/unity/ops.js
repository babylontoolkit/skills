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
const { helperTier, resolveProjectPath, pruneEmptyScratchDirs, dirtyScenes, unsavedWorkReason } = require('./guard');
const { runProcess: defaultRunProcess, launchDetached: defaultLaunchDetached } = require('./run');
const { ensureAutomation: defaultEnsureAutomation } = require('./automation');
const { packageVersion, isUnityProject } = require('./discover');

const ORDINARY_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 1_800_000;
const PROGRESS_EVERY_MS = 500;
const EDITOR_POLL_MS = 5_000;
const EDITOR_OPEN_WAIT_MS = 180_000;
const CANCELLED = 'Cancel requested — Unity may still finish the operation.';
const NO_CLI =
  'The Unity command-line tool (unity) was not found on this computer. Install it, then run bt-agent bridge again.';
const NO_PROJECT = 'No Unity project is open. Use unity_project to open or create one.';
const PIPELINE_PACKAGE = 'com.unity.pipeline';

// ── D56: `unity_project create` = the Agent Reference's Babylon Toolkit scaffold (unity-exporter-cli.md §4, §4B.4) ──
const GIT_MISSING = 'git is not on PATH — Unity needs it to install packages from git URLs. Install git and try again.';
/** The two Babylon Toolkit packages, in install order (the Khronos glTF package first — the toolkit builds on it). */
const TOOLKIT_PACKAGES = [
  { name: 'org.khronos.unitygltf', url: 'https://github.com/babylontoolkit/unitygltf.git' },
  { name: 'com.babylontoolkit.editor', url: 'https://github.com/babylontoolkit/professionaledition.git' },
];
const SCAFFOLD_STEPS = 10;
const SCAFFOLD_POLL_MS = 5_000;
/** Each package add, and the exporter compile, is bounded at 15 min (§4.1); the whole create at 30 min (D56). */
const PACKAGE_WAIT_MS = 15 * 60_000;
const CREATE_BUDGET_MS = 30 * 60_000;
/** A brand-new project's first open imports every asset before the Editor reports ready. */
const CREATE_OPEN_WAIT_MS = 10 * 60_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
/**
 * The helper's own fixed C# — copied verbatim from AgentReference `references/scripts/` (see each file's
 * header). They run whatever the Allow scripts switch says and even when the user started the helper with
 * --no-scripts (D58): both gate scripts the MODEL supplies (unity_script), and these are part of the helper,
 * not something a job can change.
 */
const SCAFFOLD_DIR = path.join(__dirname, 'scaffold');
const BOOTSTRAP_CS = path.join(SCAFFOLD_DIR, 'bt-bootstrap.cs');
const NEWSCENE_CS = path.join(SCAFFOLD_DIR, 'bt-newscene.cs');
const STARTER_SCENE = 'Assets/Scenes/Level01.unity';
/** §4.1: the real success condition — the exporter type compiled into the Editor's domain. */
const EXPORTER_COMPILED_CS =
  'foreach (var a in System.AppDomain.CurrentDomain.GetAssemblies()) if (a.GetType("CanvasTools.CanvasToolsExporter") != null) return "READY"; return "no";';
/** §4.2: both toolkit packages registered. */
const PACKAGES_REGISTERED_CS =
  'var r = ""; foreach (var n in new[]{"org.khronos.unitygltf","com.babylontoolkit.editor"}) r += n + "=" + (UnityEditor.PackageManager.PackageInfo.FindForAssetPath("Packages/" + n + "/package.json") != null) + "; "; return r;';
/** §4.2: the one that matters — did the exporter compile in? */
const EXPORTER_ASSEMBLY_CS = 'return typeof(CanvasTools.CanvasToolsExporter).Assembly.FullName;';
/** bt-new-unity-project.sh's VERIFY line (pro / tsc / exportRoot / scene). */
const SCAFFOLD_VERIFY_CS =
  'string r = UnityTools.GetRootPath(); return "pro=" + ToolkitManager.IsPro() + " tsc=" + System.IO.File.Exists(System.IO.Path.Combine(r, CanvasTools.CVPanel.TscLocalPath)) + " exportRoot=" + CanvasToolsInfo.DefaultProjectFolder + " scene=" + UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene().path;';

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
 *   launch?: import('./run').LaunchDetached,
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
 * The npm to run `npm install` with (D56 step 8): the npm that ships next to this Node when it is there —
 * run as `<node> <npm-cli.js>`, so no shell and no `.cmd` shim is needed on Windows — else `npm` on PATH.
 * @param {{ execPath?: string, platform?: NodeJS.Platform, exists?: (p: string) => boolean }} [opts]
 * @returns {{ file: string, args: string[] }}
 */
function resolveNpm({ execPath = process.execPath, platform = process.platform, exists = fs.existsSync } = {}) {
  const dir = path.dirname(execPath);
  const candidates =
    platform === 'win32'
      ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const cli = candidates.find((c) => exists(c));
  return cli ? { file: execPath, args: [path.resolve(cli), 'install'] } : { file: 'npm', args: ['install'] };
}

/**
 * Is the package in this project at all — in the manifest, the lock file, or embedded? (A git package has
 * no version in either file, so `packageVersion` alone cannot answer this.)
 * @param {string} root @param {string} name
 */
function hasPackage(root, name) {
  const read = (/** @type {string} */ f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const manifest = read(path.join(root, 'Packages', 'manifest.json'));
  if (manifest && manifest.dependencies && name in manifest.dependencies) return true;
  const lock = read(path.join(root, 'Packages', 'packages-lock.json'));
  if (lock && lock.dependencies && name in lock.dependencies) return true;
  return fs.existsSync(path.join(root, 'Packages', name, 'package.json'));
}

/**
 * An `eval` / `eval_file` envelope → the value the C# returned, or its error (a C# exception is outer
 * `success:false`; a compile error can be `data.result.success:false`). Mirrors bt-new-unity-project.sh's `J`.
 * @param {any} env
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function evalOutcome(env) {
  if (!env) return { ok: false, error: 'unreachable' };
  if (env.success !== true) return { ok: false, error: firstError(env) };
  const inner = env.data && env.data.result;
  if (inner && typeof inner === 'object' && inner.success === false) {
    return { ok: false, error: typeof inner.error === 'string' && inner.error ? inner.error : 'Unity reported a failure.' };
  }
  const value = inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
  return { ok: true, value: value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value) };
}

/**
 * A `package_status` envelope → its status word (`idle` | `in_progress` | `completed` | `failed`), or
 * undefined when the Editor could not be reached (a domain reload — "not yet", never a failure).
 * @param {any} env
 * @returns {{ status: string, text: string } | undefined}
 */
function packageStatusOf(env) {
  if (!env || env.success !== true) return undefined;
  let v = env.data && env.data.result !== undefined ? env.data.result : env.data;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      // a plain word
    }
  }
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  const status = v && typeof v === 'object' && typeof v.status === 'string' ? v.status : text;
  return { status, text };
}

/** @param {number} ms */
function seconds(ms) {
  return ms < 1000 ? '<1s' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
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
    case 'unity.project':
      return `unity project ${op.action}${op.name ? ` "${op.name}"` : ''}`;
    default:
      return op.kind;
  }
}


/**
 * Whether the Editor for `dir` ANSWERS commands yet (verifier, 2026-09-29): `unity status` lists an Editor as
 * ready while the Pipeline still refuses commands with "Server Busy" (HTTP 503) as it settles after a launch,
 * which cost the model a reopen. Ready = `editor_status` succeeds and reports neither compiling nor a domain
 * reload; a busy answer, a failure or unreadable output is not ready.
 * @param {import('./run').RunProcess} runProcess @param {string} cliPath @param {string} dir @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function editorAnswers(runProcess, cliPath, dir, signal) {
  let res;
  try {
    res = await runProcess(
      cliPath,
      ['command', 'editor_status', '--project-path', dir, '--timeout', '10', '--format', 'json', '--non-interactive'],
      { cwd: dir, timeoutMs: 15_000, signal }
    );
  } catch {
    return false;
  }
  if (res.timedOut || res.aborted) return false;
  const env = parseEnvelope(res.stdout);
  if (!env || env.success !== true) return false; // "Server Busy" (503, retryable) lands here
  const r = env.data && env.data.result !== undefined ? env.data.result : env.data;
  if (!r || typeof r !== 'object') return true;
  return r.status !== 'compiling' && r.status !== 'reloading' && r.status !== 'busy' && r.compiling !== true && r.domainReloadInProgress !== true;
}

/** At or below this many matches `unity_list_commands` shows each command's parameters (T24-2). */
const LIST_FULL_DETAIL_MAX = 5;

/** @param {unknown} v */
const oneLine = (v) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();

/**
 * One listed command: `name — description`, then (full detail only) one line per parameter —
 * `  --name <type> (required|optional[, default x]) — description`.
 * @param {any} c @returns {string}
 */
function describeListedCommand(c) {
  const head = `${c.name} — ${oneLine(c.description)}`;
  if (!Array.isArray(c.parameters)) return head;
  if (!c.parameters.length) return `${head}\n  (no parameters)`;
  const params = c.parameters.map((/** @type {any} */ p) => {
    const req = p.required === true ? 'required' : 'optional';
    const def = p.required !== true && p.defaultValue !== undefined && p.defaultValue !== null ? `, default ${oneLine(JSON.stringify(p.defaultValue))}` : '';
    const desc = oneLine(p.description);
    return `  --${p.name} <${oneLine(p.type) || 'value'}> (${req}${def})${desc ? ` — ${desc}` : ''}`;
  });
  return [head, ...params].join('\n');
}

/** Unity CLI subcommands whose project is a trailing POSITIONAL argument (`unity <cmd> --help`: `[project]`, defaults to cwd). */
const CLI_POSITIONAL_PROJECT = new Set(['test', 'projects info', 'projects verify', 'projects clean', 'projects upgrade', 'projects size', 'projects require']);
/** Unity CLI subcommands that take `--project-path <path>` (`unity recompile --help`, `unity list --help`). */
const CLI_PROJECT_PATH_OPTION = new Set(['recompile', 'list']);

/**
 * How a `unity.cli` op names the project — per subcommand, the way its --help says (T24-1): a positional for
 * `test` / `projects info|verify|clean|upgrade|size|require`, `--project-path` for `recompile` / `list`, and nothing
 * otherwise (`logs` reads the Hub log and rejects the option). A positional the model already gave is kept.
 * @param {string[]} args @param {string} root @returns {string[]}
 */
function cliProjectArgs(args, root) {
  const one = args[0];
  const two = args.length > 1 ? `${args[0]} ${args[1]}` : '';
  if (CLI_PROJECT_PATH_OPTION.has(one)) return args.includes('--project-path') ? [] : ['--project-path', root];
  const head = CLI_POSITIONAL_PROJECT.has(two) ? 2 : CLI_POSITIONAL_PROJECT.has(one) ? 1 : 0;
  if (!head) return [];
  // A bare token right after `--flag` is read as that flag's value; any other bare token is the model's own positional.
  const tail = args.slice(head);
  const hasPositional = tail.some((a, i) => !a.startsWith('-') && !(i > 0 && /^--[^=]+$/.test(tail[i - 1])));
  return hasPositional ? [] : [root];
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
    launch = defaultLaunchDetached,
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
        let commands = env.data && Array.isArray(env.data.commands) ? env.data.commands : [];
        // A narrow query (≤ LIST_FULL_DETAIL_MAX matches) also fetches each command's parameters (T24-2), so the
        // model can call a typed command instead of falling back to a C# script. A failed full fetch keeps the compact list.
        if (commands.length > 0 && commands.length <= LIST_FULL_DETAIL_MAX) {
          const full = await runUnity([
            'command',
            '--query',
            typeof op.query === 'string' ? op.query : '',
            '--detail',
            'full',
            '--limit',
            String(LIST_FULL_DETAIL_MAX),
            ...suffix,
          ]);
          const stopFull = interrupted(full);
          if (stopFull) return stopFull;
          const fullEnv = parseEnvelope(full.stdout);
          if (fullEnv && fullEnv.success === true && fullEnv.data && Array.isArray(fullEnv.data.commands) && fullEnv.data.commands.length) {
            commands = fullEnv.data.commands;
          }
        }
        const lines = commands.map((/** @type {any} */ c) => describeListedCommand(c));
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
        // cwd is the project root too (runUnity), so a subcommand that defaults to the current directory is right either way.
        const res = await runUnity([...args, ...cliProjectArgs(args, P), '--format', 'json', '--non-interactive']);
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
          pruneEmptyScratchDirs(P);
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
          pruneEmptyScratchDirs(P);
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
          // Detached: the Editor must survive the helper stopping (Ctrl-C) — see launchDetached.
          const res = await launch(cli.path, ['open', P, '--non-interactive'], { cwd: P, signal });
          if (res.aborted || (signal && signal.aborted)) return { ok: false, text: CANCELLED };
          if (res.code !== 0) {
            return { ok: false, text: rawText(res) || `unity open exited with code ${res.code}`, exitCode: res.code ?? undefined };
          }
          const deadline = now() + EDITOR_OPEN_WAIT_MS;
          while (now() < deadline) {
            if (signal && signal.aborted) return { ok: false, text: CANCELLED };
            const s = await status();
            if (s.mine.some((/** @type {any} */ i) => !i.state || i.state === 'ready') && (await editorAnswers(runProcess, cli.path, P, signal))) {
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

/**
 * `unity.project list|open|create` (D54). Runs against the helper's projects folder, never a path the
 * App Builder sent: a name resolves to a folder DIRECTLY inside it (or one of the --unity paths), and
 * open/create make that project the CURRENT one every other job runs against.
 *
 * Opening a project that does not have the Unity Pipeline package adds it first (a manifest edit, no
 * Editor needed) — the Unity CLI reaches an Editor only through that package, so without it no other
 * Unity job could run. Opening does NOT add the Babylon Toolkit packages; its result says when they are
 * missing, and the model adds them with `unity_command package_add` per the Agent Reference.
 *
 * Creating a project runs the Agent Reference's whole Babylon Toolkit scaffold (D56, unity-exporter-cli.md
 * §4 + §4B.4): git check (a refusal when missing) → projects new → pipeline install → launch → unitygltf →
 * professionaledition → exporter compiled → bootstrap → npm install → starter scene → verify. A failed step
 * stops the job and names the step; the project is left in place, never deleted, and becomes current only
 * when every step succeeded.
 *
 * @param {BridgeDispatch} dispatch
 * @param {{
 *   workspace: import('./discover').Workspace,
 *   cli?: { path: string, version: string },
 *   emit: (event: BridgeJobEvent) => Promise<void>,
 *   signal?: AbortSignal,
 *   runProcess?: RunProcess,
 *   launch?: import('./run').LaunchDetached,
 *   log?: { op: (tier: string, label: string) => void },
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   openWaitMs?: number,
 *   createOpenWaitMs?: number,
 *   npm?: { file: string, args: string[] },
 *   onScaffold?: (active: boolean, root: string) => void,
 * }} deps
 * @returns {Promise<void>}
 */
async function executeUnityProject(dispatch, deps) {
  const {
    workspace,
    cli,
    emit,
    signal,
    runProcess = defaultRunProcess,
    launch = defaultLaunchDetached,
    log = defaultLog,
    now = Date.now,
    sleep = defaultSleep,
    openWaitMs = EDITOR_OPEN_WAIT_MS,
    createOpenWaitMs = CREATE_OPEN_WAIT_MS,
    npm = resolveNpm(),
    onScaffold,
  } = deps;
  const jobId = dispatch.jobId;
  if (!isSafeJobId(jobId)) return;
  const op = /** @type {any} */ (dispatch.op);
  /** @param {string} reason */
  const refuse = (reason) => emit({ jobId, type: 'refused', reason });

  if (!op || op.kind !== 'unity.project') return refuse('This runner only runs unity_project jobs.');
  const tier = helperTier(dispatch, {}, { noScripts: false });
  if (!tier.ok) return refuse(tier.reason);
  const folderName = workspace.projectsDirName;

  /** @param {{ name: string, root: string, unityVersion?: string, toolkitVersion?: string }} p */
  const describe = (p) => {
    const bits = [];
    if (p.unityVersion) bits.push(`Unity ${p.unityVersion}`);
    bits.push(p.toolkitVersion ? `Babylon Toolkit ${p.toolkitVersion}` : 'no Babylon Toolkit package');
    return bits.join(', ');
  };

  if (op.action === 'list') {
    await emit({ jobId, type: 'started' });
    log.op(tier.tier, labelOf(dispatch));
    const projects = workspace.refresh();
    const current = workspace.current();
    const lines = projects.map(
      (p) => `- ${p.name} — ${describe(p)}${current && current.root === p.root ? ' (current)' : ''}`
    );
    const head = lines.length
      ? `Projects folder "${folderName}" — ${lines.length} Unity project(s):\n${lines.join('\n')}`
      : `The projects folder "${folderName}" has no Unity projects yet — create one with unity_project action "create".`;
    const tail = current
      ? `\nCurrent project: "${current.name}".`
      : '\nNo project is open yet — open or create one with unity_project.';
    return emit({ jobId, type: 'final', result: { ok: true, text: capText(head + tail) } });
  }

  if (!cli) return refuse(NO_CLI);
  const name = /** @type {string} */ (op.name);

  /** @type {string} */
  let root;
  /** the project's own name (on macOS/Windows "real" may name the folder "Real") */
  let label = name;
  if (op.action === 'open') {
    const hit = typeof workspace.resolve === 'function' ? workspace.resolve(name) : (() => {
      const r = workspace.rootFor(name);
      return r ? { root: r } : null;
    })();
    if (hit && 'ambiguous' in hit) {
      const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      return refuse(
        `There is a Unity project named "${bare}" in more than one projects folder (${hit.ambiguous.map((f) => `"${f}"`).join(', ')}). Call unity_project again with the folder in the name, e.g. "${hit.ambiguous[0]}/${bare}".`
      );
    }
    const found = hit ? hit.root : undefined;
    if (!found) {
      return refuse(
        `There is no Unity project named "${name}" in the projects folder "${folderName}". Call unity_project with action "list" to see them, or "create" to make one.`
      );
    }
    root = found;
    label = path.basename(found);
  } else {
    const folder = workspace.projectsDir;
    let isFolder = false;
    try {
      isFolder = fs.statSync(folder).isDirectory();
    } catch {
      isFolder = false;
    }
    if (!isFolder) return refuse(`The projects folder "${folderName}" does not exist on this computer.`);
    root = path.join(folder, name);
    if (fs.existsSync(root)) {
      return refuse(
        `A folder named "${name}" already exists in the projects folder "${folderName}" — open it, or create the project under another name.`
      );
    }
  }

  if (op.action === 'create') {
    // D56: git first — Unity's Package Manager clones the two toolkit packages. Missing git is a refusal:
    // nothing has run and nothing was created.
    const git = await runProcess('git', ['--version'], { cwd: workspace.projectsDir, timeoutMs: 15_000, signal });
    if (signal && signal.aborted) return emit({ jobId, type: 'final', result: { ok: false, text: CANCELLED } });
    if (git.code !== 0 || git.timedOut) return refuse(GIT_MISSING);
  }

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
  /** @param {string[]} args @param {string} cwd @param {number} timeoutMs */
  const runUnity = (args, cwd, timeoutMs) => runProcess(cli.path, args, { cwd, timeoutMs, signal, onLine });

  /** @param {BridgeResultPayload} result */
  const finalize = (result) =>
    emit({
      jobId,
      type: 'final',
      result: signal && signal.aborted ? { ok: false, text: CANCELLED } : { ...result, text: capText(result.text) },
    });

  /** @param {RunResult} res @param {number} timeoutMs @returns {BridgeResultPayload|null} */
  const interrupted = (res, timeoutMs) => {
    if (res.aborted || (signal && signal.aborted)) return { ok: false, text: CANCELLED };
    if (res.timedOut) return { ok: false, text: `Timed out after ${Math.round(timeoutMs / 1000)} s — Unity may still finish the operation.` };
    return null;
  };

  /** the Editor instances `unity status` reports for `dir` */
  const instancesFor = async (/** @type {string} */ dir) => {
    const res = await runUnity(['status', '--format', 'json', '--non-interactive'], dir, ORDINARY_TIMEOUT_MS);
    const env = parseEnvelope(res.stdout);
    const instances = env && env.data && Array.isArray(env.data.instances) ? env.data.instances : [];
    return instances.filter((/** @type {any} */ i) => i && typeof i.project === 'string' && samePath(i.project, dir));
  };
  const isReady = (/** @type {any[]} */ mine) => mine.some((i) => !i.state || i.state === 'ready');

  let addedPipeline = false;
  /** The disclosure a result carries when this job edited the project's manifest. */
  const pipelineNote = (/** @type {string} */ label) =>
    `Added the Unity Pipeline package (com.unity.pipeline) to "${label}"'s Packages/manifest.json so the Unity command-line tool can reach the Editor.`;

  /**
   * Pipeline package → `unity open` → poll `unity status` until the Editor is ready. An `open` makes the
   * project current as soon as the Editor is launched; the create scaffold passes makeCurrent=false and
   * makes it current only when every step succeeded (D56).
   * @param {string} dir @param {string} label @param {number} [waitMs] @param {boolean} [makeCurrent]
   * Sets `addedPipeline` when it added the Pipeline package — the final result then discloses it.
   * @returns {Promise<BridgeResultPayload & { opened?: boolean }>}
   */
  const openAndWait = async (dir, label, waitMs = openWaitMs, makeCurrent = true) => {
    if (!packageVersion(dir, PIPELINE_PACKAGE)) {
      const res = await runUnity(
        ['pipeline', 'install', '--project-path', dir, '--format', 'json', '--non-interactive'],
        dir,
        ORDINARY_TIMEOUT_MS
      );
      const stop = interrupted(res, ORDINARY_TIMEOUT_MS);
      if (stop) return stop;
      const env = parseEnvelope(res.stdout);
      if (!env || env.success !== true) {
        const why = env ? firstError(env) : rawText(res) || `unity exited with code ${res.code}`;
        return { ok: false, text: `Could not add the Unity Pipeline package to "${label}" (the Unity command-line tool needs it to reach the Editor): ${why}` };
      }
      addedPipeline = true;
    }

    // Ready = listed as ready by `unity status` AND answering commands (editor_status, no "Server Busy").
    const readyNow = async () => isReady(await instancesFor(dir)) && (await editorAnswers(runProcess, cli.path, dir, signal));

    if (isReady(await instancesFor(dir))) {
      // Already open: no launch — but it only counts once it answers (it may still be settling).
      if (makeCurrent) workspace.setCurrent(dir);
      if (await editorAnswers(runProcess, cli.path, dir, signal)) {
        return { ok: true, text: `Unity is open with the project "${label}".`, opened: true };
      }
    } else {
      // Detached: the Editor must survive the helper stopping (Ctrl-C) — see launchDetached. Every other
      // Unity call stays in the helper's process group so a cancel can stop it.
      const res = await launch(cli.path, ['open', dir, '--non-interactive'], { cwd: dir, signal });
      if (res.aborted || (signal && signal.aborted)) return { ok: false, text: CANCELLED };
      if (res.code !== 0) {
        return { ok: false, text: rawText(res) || `unity open exited with code ${res.code}`, exitCode: res.code ?? undefined };
      }
      if (makeCurrent) workspace.setCurrent(dir);
    }

    const deadline = now() + waitMs;
    while (now() < deadline) {
      if (signal && signal.aborted) return { ok: false, text: CANCELLED };
      if (await readyNow()) {
        return { ok: true, text: `Unity is open with the project "${label}".`, opened: true };
      }
      await sleep(EDITOR_POLL_MS, signal);
    }
    return {
      ok: false,
      text: makeCurrent
        ? `Unity did not report the project "${label}" as ready within ${Math.round(waitMs / 1000)} s — it may still be importing assets. It is the current project; check with unity_editor status before the next Unity command.`
        : `Unity did not report the project "${label}" as ready within ${Math.round(waitMs / 1000)} s — it may still be importing assets.`,
    };
  };

  /** Why the Toolkit cannot export yet, or '' when both of its packages are in the project. */
  const missingToolkitLine = (/** @type {string} */ dir) => {
    const missing = TOOLKIT_PACKAGES.filter((p) => !hasPackage(dir, p.name)).map((p) => p.name);
    return missing.length
      ? ` It does not have the Babylon Toolkit packages yet (missing: ${missing.join(', ')}) — add them with unity_command package_add (see the Agent Reference) before exporting.`
      : '';
  };

  /**
   * D56 — the Agent Reference's "Create a Babylon Toolkit Unity Project" scaffold (unity-exporter-cli.md §4,
   * §4B.4, bt-new-unity-project.sh). Every step emits "n/10 …"; the first failure stops the job naming the
   * step, and the project stays where it is. §4B step 6 (copy a licence) is skipped on purpose: bridge
   * exports run under the automation grant (D47–D51), so no licence file is needed here. The two `.cs`
   * snippets are eval_file bodies (top-level statements), run exactly as the reference script runs them.
   * git was checked before the job started. The whole create is bounded at 30 min: every step's own
   * timeout is capped by what is left of that budget. The project becomes current only when every step
   * succeeded.
   * @returns {Promise<BridgeResultPayload>}
   */
  const scaffold = async () => {
    const started = now();
    const budgetEnd = started + CREATE_BUDGET_MS;
    /** @type {string[]} */
    const timings = [];
    let step = 0;
    let stepAt = started;
    /** @returns {boolean} false when the 30 min budget is spent before this step could start */
    const begin = (/** @type {number} */ n, /** @type {string} */ what) => {
      if (step) timings.push(`${step}/${SCAFFOLD_STEPS} ${seconds(now() - stepAt)}`);
      step = n;
      stepAt = now();
      lastProgress = now();
      emit({ jobId, type: 'progress', line: capText(`${n}/${SCAFFOLD_STEPS} ${what}`, 500) }).catch(() => {});
      return now() < budgetEnd;
    };
    const overBudget = () => `the create ran past its ${seconds(CREATE_BUDGET_MS)} budget.`;
    /** @param {string} text */
    const fail = (text) => ({
      ok: false,
      text:
        `Step ${step}/${SCAFFOLD_STEPS} (${STEP_NAMES[step]}) failed: ${text}` +
        (fs.existsSync(root)
          ? ` The project "${name}" was left in the projects folder "${folderName}" — nothing was deleted; open it with unity_project to continue.`
          : ' Nothing was created.'),
    });
    /** a step's own timeout, capped by what is left of the create's budget (never below 1 s) */
    const cap = (/** @type {number} */ ms) => Math.max(1_000, Math.min(ms, budgetEnd - now()));
    const quiet = (/** @type {string[]} */ args, timeoutMs = ORDINARY_TIMEOUT_MS) =>
      runProcess(cli.path, args, { cwd: root, timeoutMs: cap(timeoutMs), signal });
    const sfx = ['--project-path', root, '--format', 'json', '--non-interactive'];
    /** `unity command eval|eval_file <code|file>` — the form bt-new-unity-project.sh's `evs` / `ev` use. */
    const evalRun = async (/** @type {'eval'|'eval_file'} */ kind, /** @type {string} */ what) => {
      const res = await quiet(['command', kind, what, ...sfx]);
      if (res.aborted || (signal && signal.aborted)) return { ok: /** @type {false} */ (false), error: CANCELLED, cancelled: true };
      return evalOutcome(parseEnvelope(res.stdout));
    };
    const deadlineFor = (/** @type {number} */ ms) => Math.min(now() + ms, budgetEnd);
    const cancelled = () => Boolean(signal && signal.aborted);
    /** @param {{ ok: boolean, text: string }} r */
    const stopWith = (r) => (r.text === CANCELLED ? r : fail(r.text));

    /**
     * Poll `probe` every 5 s until it says done / failed, or the deadline. A probe that cannot reach the
     * Editor (a domain reload takes the Pipeline server down 15–25 s) is "not yet", never a failure.
     * @param {() => Promise<{ done?: boolean, fail?: string, value?: string }>} probe
     * @param {number} waitMs @param {string} what
     * @returns {Promise<{ ok: true, value?: string } | { ok: false, text: string }>}
     */
    const pollUntil = async (probe, waitMs, what) => {
      const deadline = deadlineFor(waitMs);
      for (;;) {
        if (cancelled()) return { ok: false, text: CANCELLED };
        const r = await probe();
        if (r.done) return { ok: true, value: r.value };
        if (r.fail) return { ok: false, text: r.fail };
        if (now() >= deadline) {
          return { ok: false, text: deadline === budgetEnd ? `${what} — ${overBudget()}` : `${what} timed out after ${seconds(waitMs)}.` };
        }
        await sleep(SCAFFOLD_POLL_MS, signal);
      }
    };

    /** undefined = not asked yet; the Pipeline's typed package_add is absent on older Pipeline versions (§4.1). */
    /** @type {boolean|undefined} */
    let hasPackageAdd;
    /**
     * §4.1: add one toolkit package by git URL, then poll until it resolved. One at a time — a second
     * package operation while one runs returns busy, so busy / unreachable are retried until the deadline.
     * @param {{ name: string, url: string }} pkg
     * @returns {Promise<{ ok: true } | { ok: false, text: string }>}
     */
    const addToolkitPackage = async (pkg) => {
      const deadline = deadlineFor(PACKAGE_WAIT_MS);
      let lastError = '';
      /** @type {string|undefined} */
      let accepted;
      while (hasPackageAdd !== false) {
        if (cancelled()) return { ok: false, text: CANCELLED };
        const res = await quiet(['command', 'package_add', ...sfx, '--timeout', '110', '--', '--identifier', pkg.url, '--confirm', 'true']);
        const env = parseEnvelope(res.stdout);
        const st = packageStatusOf(env);
        if (st && !/busy/i.test(st.text)) {
          accepted = st.status;
          hasPackageAdd = true;
          break;
        }
        lastError = st ? st.text : env ? firstError(env) : rawText(res) || `unity exited with code ${res.code}`;
        if (hasPackageAdd === undefined) {
          const q = parseEnvelope((await quiet(['command', '--query', 'package_add', '--detail', 'compact', ...sfx])).stdout);
          if (q && q.success === true) {
            const cmds = q.data && Array.isArray(q.data.commands) ? q.data.commands : [];
            hasPackageAdd = cmds.some((/** @type {any} */ c) => c && c.name === 'package_add');
            if (!hasPackageAdd) break;
          }
        }
        if (now() >= deadline) return { ok: false, text: `Unity did not accept the package add: ${lastError}` };
        await sleep(SCAFFOLD_POLL_MS, signal);
      }

      if (hasPackageAdd === false) {
        // §4.1 fallback: Unity's own Package Manager through eval, polled with separate calls (never loop
        // inside one eval — Client.Add only progresses on the Editor's update loop).
        const queued = await pollUntil(async () => {
          const r = await evalRun('eval', `UnityEditor.PackageManager.Client.Add("${pkg.url}"); return "queued";`);
          return r.ok ? { done: true } : {};
        }, PACKAGE_WAIT_MS, `Queuing ${pkg.name}`);
        if (!queued.ok) return queued;
        return pollUntil(async () => {
          const r = await evalRun('eval', `return UnityEditor.PackageManager.PackageInfo.FindForAssetPath("Packages/${pkg.name}/package.json") != null ? "READY" : "no";`);
          return r.ok && r.value.includes('READY') ? { done: true } : {};
        }, PACKAGE_WAIT_MS, `${pkg.name} resolve`);
      }

      if (accepted && /completed/i.test(accepted)) return { ok: true };
      if (accepted && /failed/i.test(accepted)) return { ok: false, text: 'the Package Manager reported failed.' };
      let seen = Boolean(accepted && /in_progress|running|baking/i.test(accepted));
      return pollUntil(async () => {
        const st = packageStatusOf(parseEnvelope((await quiet(['command', 'package_status', ...sfx])).stdout));
        if (!st) return {};
        if (/failed/i.test(st.status)) return { fail: `the Package Manager reported failed: ${capText(st.text, 400)}` };
        if (/completed/i.test(st.status)) return { done: true };
        if (/in_progress|running|baking/i.test(st.status)) seen = true;
        else if (/idle/i.test(st.status) && seen) return { fail: 'the package operation stopped without completing.' };
        return {};
      }, PACKAGE_WAIT_MS, `${pkg.name} install`);
    };

    // 1. projects new — wait for it to EXIT (ProjectVersion.txt is written last, §3)
    begin(1, `creating the Unity project "${name}"`);
    const newTimeout = cap(LONG_TIMEOUT_MS);
    const created = await runUnity(
      ['projects', 'new', name, '--path', workspace.projectsDir, '--format', 'json', '--non-interactive'],
      workspace.projectsDir,
      newTimeout
    );
    const stop1 = interrupted(created, newTimeout);
    if (stop1) return stop1.text === CANCELLED ? stop1 : fail(stop1.text);
    const env1 = parseEnvelope(created.stdout);
    if (!env1 || env1.success !== true || !isUnityProject(root)) {
      return fail(env1 && env1.success !== true ? firstError(env1) : rawText(created) || `unity projects new exited with code ${created.code}`);
    }
    const unityVersion = env1.data && typeof env1.data.version === 'string' ? env1.data.version : undefined;

    // 2. com.unity.pipeline (1/3) — no Editor needed
    if (!begin(2, `${PIPELINE_PACKAGE} (1/3)`)) return fail(overBudget());
    const pipeTimeout = cap(ORDINARY_TIMEOUT_MS);
    const pipe = await runUnity(['pipeline', 'install', '--project-path', root, '--format', 'json', '--non-interactive'], root, pipeTimeout);
    const stop2 = interrupted(pipe, pipeTimeout);
    if (stop2) return stopWith(stop2);
    const env2 = parseEnvelope(pipe.stdout);
    if (!env2 || env2.success !== true || !packageVersion(root, PIPELINE_PACKAGE)) {
      return fail(env2 && env2.success !== true ? firstError(env2) : rawText(pipe) || 'the manifest has no com.unity.pipeline entry.');
    }
    if (!(env2.data && env2.data.alreadyInstalled === true)) addedPipeline = true;

    // 3. launch the Editor (detached — it outlives the helper) and wait until it reports ready
    if (!begin(3, 'launching the Unity Editor')) return fail(overBudget());
    const opened = await openAndWait(root, name, Math.min(createOpenWaitMs, budgetEnd - now()), false);
    if (!opened.ok) return stopWith(opened);

    // 4 + 5. the two toolkit packages, one at a time, Khronos glTF first (§4.1)
    for (const [i, pkg] of TOOLKIT_PACKAGES.entries()) {
      if (!begin(4 + i, `${pkg.name} (${2 + i}/3)`)) return fail(overBudget());
      const added = await addToolkitPackage(pkg);
      if (!added.ok) return stopWith(added);
    }

    // 6. the real success condition: the exporter compiled into the domain (§4.1)
    if (!begin(6, 'waiting for the Babylon Toolkit exporter to compile')) return fail(overBudget());
    const compiled = await pollUntil(async () => {
      const r = await evalRun('eval', EXPORTER_COMPILED_CS);
      return r.ok && r.value.includes('READY') ? { done: true } : {};
    }, PACKAGE_WAIT_MS, 'The exporter compile');
    if (!compiled.ok) return stopWith(compiled);

    // 7. bootstrap — replicates CVPanel.OnEnable (writes package.json, §5.1 / §4B.4)
    if (!begin(7, 'bootstrap (Scene Exporter settings + package.json)')) return fail(overBudget());
    const boot = await evalRun('eval_file', BOOTSTRAP_CS);
    if (!boot.ok && 'cancelled' in boot) return { ok: false, text: CANCELLED };
    const packageJson = path.join(root, 'package.json');
    // eval gives up after ~5 s on the main thread while the work may still finish (§7.3) — package.json is the proof.
    if (!boot.ok && !(/timed out/i.test(boot.error) && fs.existsSync(packageJson))) return fail(boot.error);
    const bootText = boot.ok ? boot.value : "the bootstrap outlived eval's 5 s wait but wrote package.json";

    // 8. npm install in the project root — AFTER package.json, BEFORE any TypeScript build (§5.2). A failure is
    // reported, not fatal (the reference script does the same): only builds that compile scripts need it.
    if (!begin(8, 'npm install (TypeScript)')) return fail(overBudget());
    let npmText = 'npm install skipped — the project has no package.json';
    if (fs.existsSync(packageJson)) {
      const res = await runProcess(npm.file, npm.args, { cwd: root, timeoutMs: cap(NPM_TIMEOUT_MS), signal });
      if (cancelled()) return { ok: false, text: CANCELLED };
      npmText =
        res.code === 0 && !res.timedOut
          ? 'npm install: TypeScript installed'
          : `npm install FAILED (${res.timedOut ? 'timed out' : capText(rawText(res) || `exit code ${res.code}`, 300)})`;
    }

    // 9. starter scene + LightingSettings (§8.1)
    if (!begin(9, `starter scene ${STARTER_SCENE} + LightingSettings`)) return fail(overBudget());
    const scene = await evalRun('eval_file', NEWSCENE_CS);
    if (!scene.ok && 'cancelled' in scene) return { ok: false, text: CANCELLED };
    const sceneOnDisk = () => fs.existsSync(path.join(root, ...STARTER_SCENE.split('/')));
    if (!scene.ok && !(/timed out/i.test(scene.error) && sceneOnDisk())) return fail(scene.error);

    // 10. verify (§4.2 + the reference script's VERIFY line + the files on disk)
    if (!begin(10, 'verify')) return fail(overBudget());
    const list = parseEnvelope((await quiet(['pipeline', 'list', '--format', 'json', '--non-interactive'])).stdout);
    const inst = list && list.data && Array.isArray(list.data.instances) ? list.data.instances : [];
    const reachable = inst.some(
      (/** @type {any} */ i) => i && typeof i.projectPath === 'string' && samePath(i.projectPath, root) && i.pipelineServer && i.pipelineServer.isReachable === true
    );
    const pkgs = await evalRun('eval', PACKAGES_REGISTERED_CS);
    const asm = await evalRun('eval', EXPORTER_ASSEMBLY_CS);
    const info = await evalRun('eval', SCAFFOLD_VERIFY_CS);
    if (cancelled()) return { ok: false, text: CANCELLED };
    const tsc = fs.existsSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'));
    const sceneFile = sceneOnDisk();
    const pkgsOk = pkgs.ok && TOOLKIT_PACKAGES.every((p) => pkgs.value.includes(`${p.name}=True`));
    const verify = [
      `pipeline=${reachable ? 'reachable' : 'NOT reachable'}`,
      `packages: ${pkgs.ok ? pkgs.value.trim() : `ERR ${pkgs.error}`}`,
      `exporter=${asm.ok ? asm.value : `ERR ${asm.error}`}`,
      info.ok ? info.value : `ERR ${info.error}`,
      `package.json=${fs.existsSync(packageJson)} node_modules/typescript=${tsc} ${STARTER_SCENE}=${sceneFile}`,
    ].join(' | ');
    timings.push(`10/${SCAFFOLD_STEPS} ${seconds(now() - stepAt)}`);
    if (!(reachable && pkgsOk && asm.ok && sceneFile)) return fail(`VERIFY ${verify}`);

    workspace.setCurrent(root);
    const version = unityVersion ? ` with Unity ${unityVersion}` : '';
    return {
      ok: true,
      text:
        `Created the Unity project "${name}"${version} in the projects folder "${folderName}"; it is now the current project and Unity is open with it. ` +
        `Installed com.unity.pipeline, org.khronos.unitygltf and com.babylontoolkit.editor (the exporter compiled in); bootstrap: ${bootText}; ${npmText}; starter scene ${STARTER_SCENE} with LightingSettings. ` +
        `VERIFY ${verify}. Took ${seconds(now() - started)} (${timings.join(', ')}). Ready to export with bt_export_level.`,
    };
  };

  /** @type {BridgeResultPayload} */
  let result;
  try {
    if (op.action === 'open') {
      const { opened, ...payload } = await openAndWait(root, label);
      const current = opened ? workspace.current() : undefined;
      result = current
        ? { ok: true, text: `${payload.text} It is now the current project (${describe(current)}).${missingToolkitLine(root)}` }
        : payload;
    } else {
      // The dev-server probe never asks a project that is mid-scaffold (its Editor is importing and
      // reloading, and the Toolkit command is not compiled in yet).
      if (onScaffold) onScaffold(true, root);
      try {
        result = await scaffold();
      } finally {
        if (onScaffold) onScaffold(false, root);
      }
    }
  } catch (err) {
    result = { ok: false, text: `The Desktop Agent failed: ${err && err.message ? err.message : err}` };
  }
  // Never edit a user's manifest silently: say so whatever else happened (covers open and create).
  if (addedPipeline) result = { ...result, text: `${pipelineNote(label)} ${result.text}` };
  await finalize(result);
}

/** The scaffold's step names, as the failure text names them (index = step number). */
const STEP_NAMES = [
  '',
  'unity projects new',
  'com.unity.pipeline',
  'launch the Unity Editor',
  'org.khronos.unitygltf',
  'com.babylontoolkit.editor',
  'Babylon Toolkit exporter compile',
  'bootstrap',
  'npm install',
  'starter scene',
  'verify',
];

module.exports = {
  editorAnswers,
  executeUnityProject,
  resolveNpm,
  hasPackage,
  GIT_MISSING,
  TOOLKIT_PACKAGES,
  BOOTSTRAP_CS,
  NEWSCENE_CS,
  EXPORTER_COMPILED_CS,
  NO_PROJECT,
  EDITOR_OPEN_WAIT_MS,
  executeUnity, labelOf, parseEnvelope, parseJsonExact, CANCELLED, NO_CLI, ORDINARY_TIMEOUT_MS, LONG_TIMEOUT_MS };
