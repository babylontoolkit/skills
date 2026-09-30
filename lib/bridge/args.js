'use strict';

/**
 * Argument parser for `bt-agent bridge` (D46 — it runs before, and instead of, the installer's parser).
 *
 * @typedef {{
 *   command: 'run'|'logout'|'status'|'help',
 *   server?: string,
 *   unity: string[],
 *   blender?: string,
 *   noScripts: boolean,
 *   errors: string[],
 * }} BridgeArgs
 */

const SERVER_REQUIRED =
  '--server is required (the Unity Bridge dialog in the App Builder shows the exact command)';

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
  const out = { command: 'run', unity: [], noScripts: false, errors: [] };
  let flagServer;
  let help = false;
  /** @type {string|undefined} */
  let positional;

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
        if (v !== undefined) i += 1;
        flagServer = v;
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
      case 'logout':
      case 'status':
        if (positional) out.errors.push(`Unknown option: ${arg}`);
        else positional = arg;
        break;
      default:
        out.errors.push(`Unknown option: ${arg}`);
    }
  }

  out.command = help ? 'help' : /** @type {'logout'|'status'|undefined} */ (positional) || 'run';

  const raw = flagServer !== undefined ? flagServer : env.BTK_BRIDGE_SERVER;
  if (raw) {
    const server = raw.replace(/\/+$/, '');
    if (isAcceptableServer(server)) out.server = server;
    else out.errors.push(`refusing a non-HTTPS server: ${raw}`);
  } else if (out.command === 'run' || out.command === 'logout') {
    out.errors.push(SERVER_REQUIRED);
  }

  return out;
}

module.exports = { parseBridgeArgs, isAcceptableServer, SERVER_REQUIRED };
