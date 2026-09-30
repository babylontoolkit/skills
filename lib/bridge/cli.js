'use strict';

const os = require('os');

const { parseBridgeArgs } = require('./args');
const { readBridgeConfig, writeBridgeConfig, deleteBridgeConfig, bridgeConfigPath } = require('./config');
const { BridgeApi, UpdateRequiredError, NotPairedError } = require('./api');
const { pairDevice } = require('./pairing');
const { runLoop, STOPPED } = require('./loop');
const { BRIDGE_PROTOCOL_VERSION, isSafeJobId } = require('./protocol');
const log = require('./log');
const { discoverUnity, probeDevServer } = require('./unity/discover');
const { executeUnity } = require('./unity/ops');
const { runProcess: defaultRunProcess } = require('./unity/run');
const { discoverBlender } = require('./blender/discover');
const { executeBlender } = require('./blender/run');
const { prettyPath } = require('../paths');
const { version } = require('../../package.json');

const USAGE = `
bt-agent bridge — connect this computer to the App Builder (Unity/Blender)

Usage
  bt-agent bridge --server <url> [options]   Pair (first run) and serve until Ctrl-C
  bt-agent bridge status                     Show which App Builder this computer is paired with
  bt-agent bridge logout --server <url>      Unpair this computer and delete its credential

Options
  --server <url>       The App Builder's address (https://, or http://localhost for development).
                       Also read from BTK_BRIDGE_SERVER. The Unity Bridge dialog shows the exact command.
  --unity <path>       A Unity project to serve (repeatable; default: discovered from this folder)
  --blender <path>     The Blender executable to use (default: discovered)
  --no-scripts         Never run scripts on this computer, whatever the App Builder allows
  -h, --help           Show this help

What the App Builder may ask this computer to do
  allowed   Read the project and make ordinary edits — runs straight away
  scripts   Run C# or Python scripts — only when you allowed scripts for the project (never with --no-scripts)
  consent   Delete, move, rename, build or change project settings — asks you in the chat first

The bridge runs only while this command runs. Installing or updating the Desktop Agent never starts it.
The device credential is stored in ${prettyPath(bridgeConfigPath())} (readable by you only).
`;

const NOT_SERVING = 'This computer is not serving that Unity project any more — run bt-agent bridge in it.';
const DEV_SERVER_EVERY_MS = 30_000;

/**
 * Routes one dispatch to its runner (T24 step 9, T25 step 3). A dispatch for a Unity project this
 * computer does not serve is refused before anything runs.
 * @param {{
 *   projects: Array<{ key: string, name: string, root: string, productGuid?: string, toolkitVersion?: string }>,
 *   cli?: { path: string, version: string },
 *   blender?: { path: string, version: string },
 *   noScripts: boolean,
 *   api?: import('./api').BridgeApi,
 *   runProcess?: import('./unity/run').RunProcess,
 * }} ctx
 * @returns {import('./loop').Execute}
 */
function makeExecuteDispatch(ctx) {
  return async (dispatch, emit, signal) => {
    // Defence in depth behind loop.js: a job id names files under .bridge/, so an unsafe one never runs.
    if (!dispatch || !isSafeJobId(dispatch.jobId)) return;
    const project = ctx.projects.find((p) => p.key === dispatch.unityProjectKey);
    if (!project) {
      await emit({ jobId: dispatch.jobId, type: 'refused', reason: NOT_SERVING });
      return;
    }
    const kind = dispatch.op && dispatch.op.kind;
    const common = { project, emit, signal, noScripts: ctx.noScripts, runProcess: ctx.runProcess };
    if (kind === 'blender.script') {
      await executeBlender(dispatch, { ...common, blender: ctx.blender });
      return;
    }
    if (typeof kind === 'string' && (kind.startsWith('unity.') || kind.startsWith('devserver.'))) {
      await executeUnity(dispatch, { ...common, cli: ctx.cli, api: ctx.api });
      return;
    }
    await emit({ jobId: dispatch.jobId, type: 'refused', reason: 'This Desktop Agent cannot run that yet.' });
  };
}

/**
 * Hello's `devServer` for the FIRST Unity project, refreshed at most every 30 s (T24 step 7).
 * @param {{ cli?: { path: string }, project?: { root: string }, runProcess?: import('./unity/run').RunProcess, now?: () => number }} opts
 * @returns {() => Promise<import('./protocol').BridgeDevServerInfo|undefined>}
 */
function makeDevServerProbe({ cli, project, runProcess = defaultRunProcess, now = Date.now }) {
  /** @type {import('./protocol').BridgeDevServerInfo|undefined} */
  let cached;
  let at = -Infinity;
  return async () => {
    if (!cli || !project) return undefined;
    if (now() - at < DEV_SERVER_EVERY_MS && cached) return cached;
    at = now();
    cached = await probeDevServer({ cli, project, runProcess });
    return cached;
  };
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
 * @param {string[]} argv arguments after `bridge`
 * @returns {Promise<number>} exit code
 */
async function runBridgeCli(argv) {
  const args = parseBridgeArgs(argv);

  if (args.command === 'help') {
    log.info(USAGE);
    return 0;
  }
  if (args.errors.length) {
    for (const e of args.errors) log.error(e);
    log.error('\nRun `bt-agent bridge --help` for usage.');
    return 2;
  }

  if (args.command === 'status') {
    const cfg = readBridgeConfig(args.server);
    if (!cfg) log.info(args.server ? `Not paired with ${args.server}.` : 'Not paired.');
    else log.info(`Paired with ${cfg.server} as device ${cfg.deviceId}.`);
    return 0;
  }

  const server = /** @type {string} */ (args.server);

  if (args.command === 'logout') {
    const cfg = readBridgeConfig(server);
    if (!cfg) {
      log.info(`Not paired with ${server}.`);
      return 0;
    }
    try {
      await new BridgeApi(server, cfg.token).post('/api/bridge/result', { action: 'logout' });
    } catch {
      // The credential is deleted either way; the server revokes an unreachable device on its own terms.
    }
    deleteBridgeConfig();
    log.info('Logged out.');
    return 0;
  }

  // run
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const sleep = (/** @type {number} */ ms) => abortableSleep(ms, controller.signal);
  const deviceName = os.hostname() || 'computer';

  try {
    let cfg = readBridgeConfig(server);
    if (!cfg) {
      let paired;
      try {
        paired = await pairDevice(new BridgeApi(server), {
          deviceName,
          os: helloOs(),
          sleep,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          log.info('\nPairing cancelled.');
          return 0;
        }
        throw err;
      }
      cfg = { server, deviceId: paired.deviceId, token: paired.token };
      writeBridgeConfig(cfg);
      log.info(`Paired. The credential is in ${prettyPath(bridgeConfigPath())}.`);
    }

    const unity = discoverUnity({ unityPaths: args.unity, cwd: process.cwd() });
    for (const dir of unity.notProjects) log.error(`Not a Unity project (no Assets/ and ProjectSettings/ProjectVersion.txt): ${dir}`);
    if (!unity.projects.length) log.info('No Unity project found here — run bt-agent bridge in a Unity project folder, or pass --unity <path>.');
    else if (!unity.cli) log.info('The Unity command-line tool (unity) was not found; Unity jobs will be refused until it is installed.');
    const blender = discoverBlender({ explicit: args.blender });
    const api = new BridgeApi(server, cfg.token);
    const devServer = makeDevServerProbe({ cli: unity.cli, project: unity.projects[0] });

    const hello = async () => {
      /** @type {import('./protocol').BridgeHello} */
      const h = {
        protocol: BRIDGE_PROTOCOL_VERSION,
        helperVersion: version,
        os: helloOs(),
        unityProjects: unity.projects.map((p) => {
          const { root, ...wire } = p; // the local path never leaves this computer
          return wire;
        }),
        scriptsDisabledLocally: args.noScripts,
      };
      if (unity.cli) h.unityCli = unity.cli;
      if (blender) h.blender = blender;
      const ds = await devServer();
      if (ds) h.devServer = ds;
      return h;
    };

    const exit = await runLoop({
      api,
      hello,
      execute: makeExecuteDispatch({
        projects: unity.projects,
        cli: unity.cli,
        blender,
        noScripts: args.noScripts,
        api,
      }),
      signal: controller.signal,
      sleep,
      stoppedText: STOPPED,
      onPolling: () =>
        log.info(`Unity Bridge connected to ${server} as ${deviceName}. Press Ctrl-C to stop.`),
    });

    if (exit.reason === 'stopped') {
      log.info('\nUnity Bridge stopped.');
      return 0;
    }
    log.error(exit.message || 'The Unity Bridge stopped.');
    if (exit.reason === 'update-required') log.error('Update the Desktop Agent: bt-agent update');
    return 1;
  } catch (err) {
    if (err instanceof UpdateRequiredError) {
      log.error(err.message);
      log.error('Update the Desktop Agent: bt-agent update');
      return 1;
    }
    if (err instanceof NotPairedError) {
      log.error('The App Builder refused this device. Run bt-agent bridge again to pair it.');
      return 1;
    }
    log.error(err.message);
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

module.exports = { runBridgeCli, USAGE, makeExecuteDispatch, makeDevServerProbe, NOT_SERVING };
