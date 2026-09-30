'use strict';

/**
 * Argument parser for `bt-agent bridge` (D46 — it runs before, and instead of, the installer's parser).
 *
 * @typedef {'run'|'install-service'|'uninstall-service'|'service'|'logout'|'status'|'help'} BridgeCommand
 * @typedef {{
 *   command: BridgeCommand,
 *   servers: string[],
 *   serverExplicit: boolean,
 *   server?: string,
 *   pair?: string,
 *   projects: string[],
 *   unity: string[],
 *   blender?: string,
 *   noScripts: boolean,
 *   errors: string[],
 * }} BridgeArgs
 *
 * `servers` is every App Builder this run talks to: the `--server` flags (repeatable), else
 * `BTK_BRIDGE_SERVER`, else the production App Builder (D55 — end users never type a URL).
 * `serverExplicit` says whether the user named them; `status` and `logout` without one mean "all".
 * `server` is `servers[0]`, kept for callers that only ever talk to one.
 */

/**
 * The production App Builder (D55, owner 2026-09-29: "why do I have to specify the server url?").
 * This is the Desktop Agent package, not the app — the app's no-hardcoded-URL rule does not govern it.
 */
const DEFAULT_SERVER = 'https://app.babylontoolkit.com';

/** An install code as the Unity Bridge dialog shows it: `XXXX-XXXX` (case and the dash are forgiven). */
const PAIR_CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

const MODE_FLAGS = /** @type {const} */ ({
  '--install-service': 'install-service',
  '--uninstall-service': 'uninstall-service',
  '--service': 'service',
});

/**
 * `https://…` anywhere, or plain http to this machine only. Anything else would send the device
 * token in clear text.
 * @param {string} server
 * @returns {boolean}
 */
function isAcceptableServer(server) {
  let url;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/**
 * @param {string[]} argv arguments after `bridge`
 * @param {Record<string, string|undefined>} [env]
 * @returns {BridgeArgs}
 */
function parseBridgeArgs(argv, env = process.env) {
  /** @type {BridgeArgs} */
  const out = { command: 'run', servers: [], serverExplicit: false, projects: [], unity: [], noScripts: false, errors: [] };
  /** @type {string[]} */
  const flagServers = [];
  let help = false;
  /** @type {string|undefined} */
  let positional;
  /** @type {BridgeCommand|undefined} */
  let mode;

  /** @param {string} flag @param {number} i */
  const valueOf = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith('-')) {
      out.errors.push(`${flag} needs a value`);
      return undefined;
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--server': {
        const v = valueOf(arg, i + 1);
        if (v !== undefined) {
          i += 1;
          flagServers.push(v);
        }
        break;
      }
      case '--pair': {
        const v = valueOf(arg, i + 1);
        if (v !== undefined) {
          i += 1;
          if (PAIR_CODE.test(v.trim())) out.pair = v.trim().toUpperCase();
          else out.errors.push(`--pair needs the install code from the Unity Bridge dialog (like K7QM-2XWD), not "${v}"`);
        }
        break;
      }
      case '--projects': {
        const v = valueOf(arg, i + 1);
        if (v !== undefined) {
          i += 1;
          out.projects.push(v);
        }
        break;
      }
      case '--unity': {
        const v = valueOf(arg, i + 1);
        if (v !== undefined) {
          i += 1;
          out.unity.push(v);
        }
        break;
      }
      case '--blender': {
        const v = valueOf(arg, i + 1);
        if (v !== undefined) {
          i += 1;
          out.blender = v;
        }
        break;
      }
      case '--no-scripts':
        out.noScripts = true;
        break;
      case '--install-service':
      case '--uninstall-service':
      case '--service': {
        const m = MODE_FLAGS[arg];
        if (mode && mode !== m) out.errors.push(`${arg} cannot be combined with --${mode}`);
        else mode = m;
        break;
      }
      case 'logout':
      case 'status':
        if (positional) out.errors.push(`Unknown option: ${arg}`);
        else positional = arg;
        break;
      default:
        out.errors.push(`Unknown option: ${arg}`);
    }
  }

  if (positional && mode) out.errors.push(`${positional} cannot be combined with --${mode}`);
  out.command = help ? 'help' : mode || /** @type {'logout'|'status'|undefined} */ (positional) || 'run';

  /** @type {string[]} */
  let raw = flagServers;
  if (!raw.length && env.BTK_BRIDGE_SERVER) raw = [env.BTK_BRIDGE_SERVER];
  out.serverExplicit = raw.length > 0;
  if (!raw.length) raw = [DEFAULT_SERVER];
  for (const r of raw) {
    const server = r.replace(/\/+$/, '');
    if (!isAcceptableServer(server)) out.errors.push(`refusing a non-HTTPS server: ${r}`);
    else if (!out.servers.includes(server)) out.servers.push(server);
  }
  out.server = out.servers[0];

  return out;
}

module.exports = { parseBridgeArgs, isAcceptableServer, DEFAULT_SERVER, PAIR_CODE };
