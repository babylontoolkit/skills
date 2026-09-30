'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBridgeArgs, DEFAULT_SERVER } = require('./args');
const {
  readSettings,
  writeSettings,
  deleteBridgeConfig,
  bridgeConfigPath,
  saveCurrentProject,
  restorableCurrentProject,
} = require('./config');
const { BridgeApi, UpdateRequiredError, NotPairedError } = require('./api');
const { ensurePaired, notPairedText } = require('./pairing');
const { runLoop, createJobQueue, STOPPED } = require('./loop');
const { BRIDGE_PROTOCOL_VERSION, isSafeJobId } = require('./protocol');
const log = require('./log');
const { discoverUnity, probeDevServer, createWorkspace, resolveProjectsFolder, isUnityProject } = require('./unity/discover');
const { executeUnity, executeUnityProject, NO_PROJECT } = require('./unity/ops');
const { runProcess: defaultRunProcess } = require('./unity/run');
const { discoverBlender } = require('./blender/discover');
const { executeBlender } = require('./blender/run');
const service = require('./service');
const { prettyPath } = require('../paths');
const { version } = require('../../package.json');

const USAGE = `
bt-agent bridge — connect this computer to the App Builder (Unity/Blender)

Usage
  bt-agent bridge --install-service --pair <code> --projects <folder>
                                                    Pair, then start the bridge now and whenever you log in
  bt-agent bridge --uninstall-service               Stop the bridge and stop starting it at login
  bt-agent bridge [--pair <code>] [options]         Run the bridge in this terminal until Ctrl-C
  bt-agent bridge status                            Show the App Builders this computer is paired with
  bt-agent bridge logout                            Unpair this computer and delete its credentials

The Unity Bridge dialog in the App Builder shows the whole command, install code included — copy it
from there. An install code is single-use and expires after 10 minutes.

Options
  --pair <code>        The install code from the Unity Bridge dialog (like K7QM-2XWD)
  --server <url>       The App Builder's address (default: ${DEFAULT_SERVER}). Repeat it to serve
                       several App Builders (each pairs with its own code). Also read from BTK_BRIDGE_SERVER.
                       status/logout: only this App Builder (default: all).
  --projects <folder>  A Unity projects folder (repeatable): the Unity folder inside your App Builder projects
                       folder (the Unity Bridge dialog fills it in). The App Builder opens and creates projects
                       in it; a folder that does not exist is created. REQUIRED for --install-service (a
                       reinstall without it keeps the stored folders). Default, only when running in this
                       terminal: this folder, or its parent when this folder is itself a Unity project.
  --unity <path>       Also serve this Unity project (repeatable); the first one starts as the current project
  --blender <path>     The Blender executable to use (default: discovered)
  --no-scripts         Never run C# or Python scripts on this computer, whatever Allow scripts says
  -h, --help           Show this help

What the App Builder may ask this computer to do
  allowed   List, open or create projects in the projects folder, read the project and make ordinary
            edits — runs straight away
  scripts   Run C# or Python scripts — only when you turn on Allow scripts for this computer in the
            App Builder's Unity Bridge dialog (on by default), and never with --no-scripts
  consent   Delete, move, rename, build or change project settings — asks you in the chat first

--install-service copies this helper to ~/.babylon-toolkit/service/ and starts it at login (macOS launchd,
Linux systemd user unit, Windows Startup folder), logging to ~/.babylon-toolkit/bridge.log. Run it again
to change the settings; it restarts the service. Installing or updating the Desktop Agent never starts
the bridge. Credentials and settings are stored in ${prettyPath(bridgeConfigPath())} (readable by you only).
`;

const DEV_SERVER_EVERY_MS = 30_000;

/**
 * Routes one dispatch to its runner (D54). `unity.project` works on the projects folder; every other
 * Unity, dev-server and Blender job runs against the CURRENT project and is refused when there is none.
 * @param {{
 *   workspace: import('./unity/discover').Workspace,
 *   cli?: { path: string, version: string },
 *   blender?: { path: string, version: string },
 *   noScripts: boolean,
 *   api?: import('./api').BridgeApi,
 *   runProcess?: import('./unity/run').RunProcess,
 *   launch?: import('./unity/run').LaunchDetached,
 *   log?: { info: (m: string) => void, op: (tier: string, label: string) => void, error?: (m: string) => void },
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   now?: () => number,
 *   onScaffold?: (active: boolean, root: string) => void,
 * }} ctx
 * @returns {import('./loop').Execute}
 */
function makeExecuteDispatch(ctx) {
  return async (dispatch, emit, signal, source) => {
    // Defence in depth behind loop.js: a job id names files under .bridge/, so an unsafe one never runs.
    if (!dispatch || !isSafeJobId(dispatch.jobId)) return;
    const kind = dispatch.op && dispatch.op.kind;
    const extras = {};
    if (ctx.log) extras.log = ctx.log;
    if (ctx.sleep) extras.sleep = ctx.sleep;
    if (ctx.now) extras.now = ctx.now;
    if (ctx.launch) extras.launch = ctx.launch;
    if (kind === 'unity.project') {
      if (ctx.onScaffold) extras.onScaffold = ctx.onScaffold;
      await executeUnityProject(dispatch, { workspace: ctx.workspace, cli: ctx.cli, emit, signal, runProcess: ctx.runProcess, ...extras });
      return;
    }
    const isUnity = typeof kind === 'string' && (kind.startsWith('unity.') || kind.startsWith('devserver.'));
    if (kind !== 'blender.script' && !isUnity) {
      await emit({ jobId: dispatch.jobId, type: 'refused', reason: 'This Desktop Agent cannot run that yet.' });
      return;
    }
    const project = ctx.workspace.current();
    if (!project) {
      await emit({ jobId: dispatch.jobId, type: 'refused', reason: NO_PROJECT });
      return;
    }
    const common = { project, emit, signal, noScripts: ctx.noScripts, runProcess: ctx.runProcess, ...extras };
    if (kind === 'blender.script') {
      await executeBlender(dispatch, { ...common, blender: ctx.blender });
      return;
    }
    // the App Builder the job came from (D55: one helper may serve several)
    const api = (source && source.api) || ctx.api;
    await executeUnity(dispatch, { ...common, cli: ctx.cli, api });
  };
}

/**
 * Hello's `devServer` for the CURRENT Unity project, refreshed at most every 30 s (and at once when the
 * current project changes). The probe's own rules (Toolkit ≥ 9.25.1, an unknown-command answer remembered
 * per project + Toolkit version for 5 minutes, never while `busy` — a create scaffold running) live in
 * probeDevServer; the memory lives here.
 * @param {{ cli?: { path: string }, current: () => { root: string, toolkitVersion?: string }|undefined, runProcess?: import('./unity/run').RunProcess, now?: () => number, busy?: (root: string) => boolean }} opts
 * @returns {() => Promise<import('./protocol').BridgeDevServerInfo|undefined>}
 */
function makeDevServerProbe({ cli, current, runProcess = defaultRunProcess, now = Date.now, busy }) {
  /** project root + Toolkit version → when its Editor answered "No command named 'bt_devserver_status'" (kept 5 min) */
  const memo = new Map();
  /** @type {import('./protocol').BridgeDevServerInfo|undefined} */
  let cached;
  /** @type {string|undefined} */
  let cachedRoot;
  let at = -Infinity;
  return async () => {
    const project = current();
    if (!cli || !project) return undefined;
    if (cached && cachedRoot === project.root && now() - at < DEV_SERVER_EVERY_MS) return cached;
    at = now();
    cachedRoot = project.root;
    cached = await probeDevServer({ cli, project, runProcess, memo, busy, now });
    return cached;
  };
}

/**
 * The hello this computer sends with every poll (D54). Only NAMES leave this computer: the projects
 * folder is sent as its basename, and each project without its local `root`.
 * @param {{
 *   workspace: import('./unity/discover').Workspace,
 *   cli?: { path: string, version: string },
 *   blender?: { path: string, version: string },
 *   noScripts: boolean,
 *   devServer: () => Promise<import('./protocol').BridgeDevServerInfo|undefined>,
 *   helperVersion?: string,
 *   os?: 'darwin'|'win32'|'linux',
 * }} opts
 * @returns {() => Promise<import('./protocol').BridgeHello>}
 */
function makeHello({ workspace, cli, blender, noScripts, devServer, helperVersion = version, os: helloOsValue = helloOs() }) {
  return async () => {
    const current = workspace.current();
    /** @type {import('./protocol').BridgeHello} */
    const h = {
      protocol: BRIDGE_PROTOCOL_VERSION,
      helperVersion,
      os: helloOsValue,
      projectsDir: workspace.projectsDirName,
      unityProjects: workspace.projects().map((p) => {
        const { root, ...wire } = p; // the local path never leaves this computer
        return wire;
      }),
      scriptsDisabledLocally: noScripts,
    };
    if (current) h.currentProject = current.name;
    if (cli) h.unityCli = cli;
    if (blender) h.blender = blender;
    const ds = await devServer();
    if (ds) h.devServer = ds;
    return h;
  };
}

/**
 * The start-up line naming the projects folder(s): `<n> in <folder>[, <folder>…]`, plus `, +<m> from
 * --unity` when --unity added projects from outside them — so an empty folder never reads as holding a project.
 * @param {{ projectsDir: string, projectsDirs?: string[], projects: unknown[], folderProjectCount: number }} unity
 * @returns {string}
 */
function projectsFolderLine({ projectsDir, projectsDirs, projects, folderProjectCount }) {
  const extra = projects.length - folderProjectCount;
  const where = projectsDirs && projectsDirs.length ? projectsDirs.join(', ') : projectsDir;
  return `Unity projects: ${folderProjectCount} in ${where}${extra > 0 ? `, +${extra} from --unity` : ''}.`;
}

/** @returns {'darwin'|'win32'|'linux'} */
function helloOs() {
  return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
}

/** @param {number} ms @param {AbortSignal} signal */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/**
 * Everything a bridge command touches outside this module, so tests can replace it.
 * @typedef {{
 *   env?: Record<string, string|undefined>,
 *   cwd?: string,
 *   settingsFile?: string,
 *   deviceName?: string,
 *   makeApi?: (server: string, token?: string) => any,
 *   logger?: { info: (m: string) => void, op: (t: string, l: string) => void, error: (m: string) => void },
 *   serviceDeps?: import('./service').ServiceDeps,
 *   discover?: typeof discoverUnity,
 *   findBlender?: typeof discoverBlender,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   logFile?: string,
 *   pidFile?: string,
 * }} CliDeps
 */

/** @param {CliDeps} deps */
function withDefaults(deps) {
  return {
    env: deps.env || process.env,
    cwd: deps.cwd || process.cwd(),
    settingsFile: deps.settingsFile || bridgeConfigPath(),
    deviceName: deps.deviceName || os.hostname() || 'computer',
    makeApi: deps.makeApi || ((/** @type {string} */ server, /** @type {string|undefined} */ token) => new BridgeApi(server, token)),
    logger: deps.logger || log,
    serviceDeps: deps.serviceDeps || service.hostDeps(),
    discover: deps.discover || discoverUnity,
    findBlender: deps.findBlender || discoverBlender,
  };
}

/**
 * Pairs every requested server (a supplied code always re-pairs — D55), stores the new credentials,
 * and reports the ones that could not be paired. Returns the credentials of the requested servers.
 * @param {import('./args').BridgeArgs} args
 * @param {ReturnType<typeof withDefaults>} d
 */
async function pairRequested(args, d) {
  const settings = readSettings(d.settingsFile);
  const result = await ensurePaired({
    servers: args.servers,
    code: args.pair,
    stored: (server) => settings.servers.find((c) => c.server === server) || null,
    save: (cfg) => {
      const now = readSettings(d.settingsFile);
      now.servers = now.servers.filter((c) => c.server !== cfg.server).concat([cfg]);
      writeSettings(now, d.settingsFile);
    },
    makeApi: (server) => d.makeApi(server),
    deviceName: d.deviceName,
    os: helloOs(),
  });
  for (const server of result.paired) d.logger.info(`Paired with ${server}.`);
  for (const r of result.rejected) {
    d.logger.error(`Could not pair with ${r.server}: ${r.message}${r.kept ? ' — keeping this computer\'s existing pairing.' : ''}`);
  }
  for (const server of result.unpaired) d.logger.error(notPairedText(server));
  return result;
}

/**
 * Runs one poll loop per paired App Builder, all sharing ONE job queue and ONE workspace (D55), until
 * every loop has ended. Returns each loop's exit.
 * @param {{
 *   creds: import('./config').BridgeConfig[],
 *   projects: string[],
 *   unity: string[],
 *   blender?: string,
 *   noScripts: boolean,
 *   signal: AbortSignal,
 *   sleep: (ms: number) => Promise<void>,
 *   foreground: boolean,
 * }} opts
 * @param {ReturnType<typeof withDefaults>} d
 * @returns {Promise<{ server: string, exit: import('./loop').LoopExit }[]>}
 */
async function serve(opts, d) {
  const logger = d.logger;
  const unity = d.discover({ unityPaths: opts.unity, projectsDir: opts.projects, cwd: d.cwd });
  for (const dir of unity.notProjects) logger.error(`Not a Unity project (no Assets/ and ProjectSettings/ProjectVersion.txt): ${dir}`);
  for (const dir of unity.missingDirs || (unity.projectsDirMissing ? [unity.projectsDir] : [])) {
    logger.error(`The projects folder does not exist: ${dir}`);
  }
  // A current project started inside wins; otherwise the one remembered from the last run, when it still exists
  // inside a configured projects folder (a restarted service must not make the model reopen it).
  const remembered = unity.currentRoot
    ? undefined
    : restorableCurrentProject(readSettings(d.settingsFile).currentProject, unity.projectsDirs || [unity.projectsDir], {
        isProject: isUnityProject,
        real: (p) => {
          try {
            return fs.realpathSync(p);
          } catch {
            return path.resolve(p);
          }
        },
      });
  const workspace = createWorkspace({
    projectsDir: unity.projectsDir,
    projectsDirs: unity.projectsDirs,
    extraRoots: unity.extraRoots,
    currentRoot: unity.currentRoot || remembered,
    projects: unity.projects,
    onCurrentChange: (root) => saveCurrentProject(root, d.settingsFile),
  });
  logger.info(projectsFolderLine(unity));
  const startCurrent = workspace.current();
  if (startCurrent) logger.info(`Current Unity project: ${startCurrent.name}.`);
  else logger.info('No current Unity project — the App Builder opens or creates one in the projects folder.');
  if (!unity.cli) logger.info('The Unity command-line tool (unity) was not found; Unity jobs will be refused until it is installed.');
  const blender = d.findBlender({ explicit: opts.blender });
  /** Unity projects whose create scaffold is running — the dev-server probe leaves them alone (D56). */
  const scaffolding = new Set();
  const onScaffold = (/** @type {boolean} */ active, /** @type {string} */ root) => void (active ? scaffolding.add(root) : scaffolding.delete(root));
  const real = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  // The scaffold names the folder before it exists; the workspace names projects by their real path.
  const busy = (/** @type {string} */ root) => [...scaffolding].some((r) => r === root || real(r) === real(root));
  const devServer = makeDevServerProbe({ cli: unity.cli, current: () => workspace.current(), busy });
  const hello = makeHello({ workspace, cli: unity.cli, blender, noScripts: opts.noScripts, devServer });
  const queue = createJobQueue({
    execute: makeExecuteDispatch({ workspace, cli: unity.cli, blender, noScripts: opts.noScripts, log: logger, onScaffold }),
    logger,
  });

  const stoppedText = opts.foreground ? STOPPED : 'The Unity Bridge service was stopped.';
  const loops = opts.creds.map(async (cred) => {
    const api = d.makeApi(cred.server, cred.token);
    if (typeof api.server !== 'string') api.server = cred.server;
    const exit = await runLoop({
      api,
      hello,
      queue,
      signal: opts.signal,
      sleep: opts.sleep,
      logger,
      stoppedText,
      clearConfig: () => deleteBridgeConfig(cred.server, d.settingsFile),
      onPolling: () =>
        logger.info(`Unity Bridge connected to ${cred.server} as ${d.deviceName}.${opts.foreground ? ' Press Ctrl-C to stop.' : ''}`),
    });
    if (exit.reason !== 'stopped') {
      logger.error(exit.message || `The Unity Bridge stopped serving ${cred.server}.`);
      if (exit.reason === 'update-required') logger.error('Update the Desktop Agent: copy the install command from the Unity Bridge dialog again.');
    }
    return { server: cred.server, exit };
  });
  const exits = await Promise.all(loops);
  queue.close();
  return exits;
}

/** D59: an install with no projects folder anywhere is refused before anything is paired or installed. */
const PROJECTS_FOLDER_REQUIRED =
  'Choose your Unity projects folder: add --projects <folder> (the Unity Bridge dialog puts it in the command).';

/**
 * The projects folders to store for the service (D59 — REQUIRED, never guessed from where the command runs):
 * `--projects` resolved absolute (a missing folder is created, a file is refused), else the folders already
 * stored by an earlier install (a reinstall keeps them), else a refusal. `--unity` replaces the stored extra
 * projects; a plain reinstall (neither flag) keeps them too.
 * @param {import('./args').BridgeArgs} args
 * @param {string} cwd
 * @param {{ projects: string[], unity: string[] }} stored
 * @returns {{ ok: true, projects: string[], unity: string[], created: string[] } | { ok: false, message: string }}
 */
function resolveServiceFolders(args, cwd, stored) {
  const unity = args.unity.map((u) => path.resolve(cwd, u));
  if (!args.projects.length) {
    if (!stored.projects.length) return { ok: false, message: PROJECTS_FOLDER_REQUIRED };
    return { ok: true, projects: stored.projects.slice(), unity: args.unity.length ? unity : stored.unity.slice(), created: [] };
  }

  /** @type {string[]} */
  const projects = [];
  /** @type {string[]} */
  const created = [];
  for (const p of args.projects) {
    const abs = path.resolve(cwd, p);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = undefined;
    }
    if (stat && !stat.isDirectory()) {
      return { ok: false, message: `The Unity projects folder is a file, not a folder: ${abs}` };
    }
    if (!stat) {
      try {
        fs.mkdirSync(abs, { recursive: true });
      } catch (err) {
        return { ok: false, message: `Could not create the Unity projects folder ${abs}: ${err instanceof Error ? err.message : String(err)}` };
      }
      created.push(abs);
    }
    const folder = resolveProjectsFolder({ projectsDir: abs, cwd }).folder;
    if (!projects.includes(folder)) projects.push(folder);
  }
  return { ok: true, projects, unity, created };
}

/** @param {import('./args').BridgeArgs} args @param {ReturnType<typeof withDefaults>} d */
async function installServiceCommand(args, d) {
  // D59: settle the projects folder BEFORE the install code is claimed — a refusal must not spend it.
  const folders = resolveServiceFolders(args, d.cwd, readSettings(d.settingsFile));
  if (!folders.ok) {
    d.logger.error(folders.message);
    return 1;
  }
  for (const dir of folders.created) d.logger.info(`Created ${prettyPath(dir)}.`);

  const paired = await pairRequested(args, d);
  if (!paired.ready.length) {
    d.logger.error('Nothing was installed: this computer is not paired with any App Builder yet.');
    return 1;
  }

  const settings = readSettings(d.settingsFile);
  settings.projects = folders.projects;
  settings.unity = folders.unity;
  if (args.blender) settings.blender = path.resolve(d.cwd, args.blender);
  else delete settings.blender;
  settings.noScripts = args.noScripts;
  writeSettings(settings, d.settingsFile);

  const installed = await service.installService(d.serviceDeps);
  d.logger.info(`Installed the Unity Bridge service: ${prettyPath(installed.registration)}`);
  d.logger.info(`Helper copied to ${prettyPath(installed.serviceDir)}`);
  d.logger.info(`App Builder${settings.servers.length === 1 ? '' : 's'}: ${settings.servers.map((c) => c.server).join(', ')}`);
  d.logger.info(`Unity projects folder${settings.projects.length === 1 ? '' : 's'}: ${settings.projects.map(prettyPath).join(', ')}`);
  if (settings.noScripts) d.logger.info('Scripts are disabled on this computer (--no-scripts).');
  d.logger.info(`Log: ${prettyPath(installed.logFile)}`);
  d.logger.info('Unity Bridge will start automatically when you log in. Remove it with: bt-agent bridge --uninstall-service');
  return 0;
}

/** @param {ReturnType<typeof withDefaults>} d */
function uninstallServiceCommand(d) {
  const { removed } = service.uninstallService(d.serviceDeps);
  if (!removed.length) d.logger.info('The Unity Bridge service is not installed.');
  else {
    for (const p of removed) d.logger.info(`Removed ${prettyPath(p)}`);
    d.logger.info('The Unity Bridge service is stopped and will not start at login. This computer stays paired (bt-agent bridge logout unpairs it).');
  }
  return 0;
}

/**
 * `bridge --service`: what the start-at-login service runs. Reads everything from the stored settings,
 * logs to the (size-capped) log file, and exits 0 once no App Builder is left to serve — so launchd /
 * systemd never restart a service that has nothing to do.
 * @param {ReturnType<typeof withDefaults>} d
 * @param {CliDeps} raw
 */
async function serviceModeCommand(d, raw) {
  const paths = service.servicePaths(d.serviceDeps);
  const logFile = raw.logFile || paths.logFile;
  if (!raw.logger) log.toFile(logFile);
  const pidFile = raw.pidFile || paths.pidFile;
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {
    // only Windows uses it, to stop the helper it started
  }
  try {
    const settings = readSettings(d.settingsFile);
    d.logger.info(`Unity Bridge service ${version} starting.`);
    if (!settings.servers.length) {
      d.logger.error('This computer is not paired with any App Builder — copy the install command from the Unity Bridge dialog again.');
      return 0;
    }
    return await withSignals(raw, async (signal, sleep) => {
      await serve(
        {
          creds: settings.servers,
          projects: settings.projects,
          unity: settings.unity,
          blender: settings.blender,
          noScripts: settings.noScripts,
          signal,
          sleep,
          foreground: false,
        },
        d
      );
      d.logger.info(signal.aborted ? 'Unity Bridge service stopped.' : 'No App Builder is left to serve; the Unity Bridge service is exiting.');
      return 0;
    });
  } finally {
    try {
      if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.rmSync(pidFile, { force: true });
    } catch {
      // gone already
    }
  }
}

/**
 * Runs `fn` with an abort signal wired to Ctrl-C / SIGTERM (or the injected one).
 * @template T
 * @param {CliDeps} raw
 * @param {(signal: AbortSignal, sleep: (ms: number) => Promise<void>) => Promise<T>} fn
 */
async function withSignals(raw, fn) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (raw.signal) {
    if (raw.signal.aborted) controller.abort();
    else raw.signal.addEventListener('abort', stop);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const sleep = raw.sleep || ((/** @type {number} */ ms) => abortableSleep(ms, controller.signal));
  try {
    return await fn(controller.signal, sleep);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (raw.signal) raw.signal.removeEventListener('abort', stop);
  }
}

/** @param {import('./args').BridgeArgs} args @param {ReturnType<typeof withDefaults>} d @param {CliDeps} raw */
async function runForegroundCommand(args, d, raw) {
  const paired = await pairRequested(args, d);
  if (!paired.ready.length) return 1;
  return withSignals(raw, async (signal, sleep) => {
    const exits = await serve(
      {
        creds: paired.ready,
        projects: args.projects,
        unity: args.unity,
        blender: args.blender,
        noScripts: args.noScripts,
        signal,
        sleep,
        foreground: true,
      },
      d
    );
    if (exits.every((e) => e.exit.reason === 'stopped')) {
      d.logger.info('\nUnity Bridge stopped.');
      return 0;
    }
    return 1;
  });
}

/** @param {import('./args').BridgeArgs} args @param {ReturnType<typeof withDefaults>} d */
function statusCommand(args, d) {
  const { servers } = readSettings(d.settingsFile);
  const shown = args.serverExplicit ? servers.filter((c) => args.servers.includes(c.server)) : servers;
  if (!shown.length) d.logger.info(args.serverExplicit ? `Not paired with ${args.servers.join(', ')}.` : 'Not paired.');
  for (const c of shown) d.logger.info(`Paired with ${c.server} as device ${c.deviceId}.`);
  const st = service.serviceStatus(d.serviceDeps);
  d.logger.info(
    `Service: ${st.installed ? `installed${st.running === true ? ', running' : st.running === false ? ', not running' : ''}` : 'not installed'}.`
  );
  return 0;
}

/** @param {import('./args').BridgeArgs} args @param {ReturnType<typeof withDefaults>} d */
async function logoutCommand(args, d) {
  const { servers } = readSettings(d.settingsFile);
  const targets = args.serverExplicit ? servers.filter((c) => args.servers.includes(c.server)) : servers;
  if (!targets.length) {
    d.logger.info(args.serverExplicit ? `Not paired with ${args.servers.join(', ')}.` : 'Not paired.');
    return 0;
  }
  for (const c of targets) {
    try {
      await d.makeApi(c.server, c.token).post('/api/bridge/result', { action: 'logout' });
    } catch {
      // The credential is deleted either way; the server revokes an unreachable device on its own terms.
    }
    deleteBridgeConfig(c.server, d.settingsFile);
    d.logger.info(`Logged out of ${c.server}.`);
  }
  // Nothing left to serve: the settings go too (the next --install-service writes them again).
  if (!readSettings(d.settingsFile).servers.length) deleteBridgeConfig(undefined, d.settingsFile);
  return 0;
}

/**
 * @param {string[]} argv arguments after `bridge`
 * @param {CliDeps} [raw] injected for tests
 * @returns {Promise<number>} exit code
 */
async function runBridgeCli(argv, raw = {}) {
  const d = withDefaults(raw);
  const args = parseBridgeArgs(argv, d.env);

  if (args.command === 'help') {
    d.logger.info(USAGE);
    return 0;
  }
  if (args.errors.length) {
    for (const e of args.errors) d.logger.error(e);
    d.logger.error('\nRun `bt-agent bridge --help` for usage.');
    return 2;
  }

  try {
    switch (args.command) {
      case 'status':
        return statusCommand(args, d);
      case 'logout':
        return await logoutCommand(args, d);
      case 'install-service':
        return await installServiceCommand(args, d);
      case 'uninstall-service':
        return uninstallServiceCommand(d);
      case 'service':
        return await serviceModeCommand(d, raw);
      default:
        return await runForegroundCommand(args, d, raw);
    }
  } catch (err) {
    if (err instanceof UpdateRequiredError) {
      d.logger.error(err.message);
      d.logger.error('Update the Desktop Agent: copy the install command from the Unity Bridge dialog again.');
      return 1;
    }
    if (err instanceof NotPairedError) {
      d.logger.error('The App Builder refused this computer. Copy the install command from the Unity Bridge dialog again.');
      return 1;
    }
    d.logger.error(err && err.message ? err.message : String(err));
    return 1;
  }
}

module.exports = {
  runBridgeCli,
  USAGE,
  serve,
  pairRequested,
  resolveServiceFolders,
  makeExecuteDispatch,
  makeDevServerProbe,
  makeHello,
  projectsFolderLine,
  NO_PROJECT,
};
