'use strict';

const os = require('os');

/**
 * Install-code pairing (D55 — the ONLY pairing flow). The signed-in user mints a single-use code in the
 * App Builder's Unity Bridge dialog; the command it shows carries the code (`--pair K7QM-2XWD`), and this
 * helper claims it. Nothing is ever read from, or shown in, a terminal — which is what lets a
 * start-at-login service pair at all.
 */

/** @param {string} server */
const notPairedText = (server) =>
  `Not paired with ${server} — copy the install command from the Unity Bridge dialog in the App Builder.`;

/**
 * Claims one install code with one App Builder. The token is returned exactly once.
 * @param {import('./api').BridgeApi} api an unauthenticated client for that server
 * @param {string} code
 * @param {{ deviceName?: string, os?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: true, deviceId: string, token: string } | { ok: false, message: string }>}
 */
async function claimPairing(api, code, opts = {}) {
  const deviceName = (opts.deviceName || os.hostname() || 'computer').slice(0, 80);
  const platform = opts.os || process.platform;
  let r;
  try {
    r = await api.post('/api/bridge/pair', { action: 'claim', code, deviceName, os: platform }, opts.signal);
  } catch (err) {
    return { ok: false, message: `could not reach it (${err && err.message ? err.message : err})` };
  }
  const b = r.body || {};
  if (r.status === 200 && typeof b.deviceId === 'string' && typeof b.token === 'string') {
    return { ok: true, deviceId: b.deviceId, token: b.token };
  }
  const why = typeof b.message === 'string' && b.message ? b.message : `HTTP ${r.status}`;
  return { ok: false, message: why };
}

/**
 * Makes sure every requested server has a credential. A supplied `code` is ALWAYS claimed (D55): success
 * replaces any stored credential; a rejection keeps the stored one (`kept: true`) and is reported. With no
 * code, a stored credential is kept as is. One code pairs with the App Builder that minted it, so with
 * several servers the user runs the command once per App Builder.
 *
 * @param {{
 *   servers: string[],
 *   code?: string,
 *   stored: (server: string) => import('./config').BridgeConfig|null,
 *   save: (cfg: import('./config').BridgeConfig) => void,
 *   makeApi: (server: string) => import('./api').BridgeApi,
 *   deviceName?: string,
 *   os?: string,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{
 *   ready: import('./config').BridgeConfig[],
 *   paired: string[],
 *   rejected: { server: string, message: string, kept?: true }[],
 *   unpaired: string[],
 * }>}
 * `ready` — every server that now has a credential; `paired` — the ones this call paired; `rejected` —
 * the code was refused (or the server unreachable); `unpaired` — no credential and no code.
 */
async function ensurePaired({ servers, code, stored, save, makeApi, deviceName, os: platform, signal }) {
  /** @type {import('./config').BridgeConfig[]} */
  const ready = [];
  /** @type {string[]} */
  const paired = [];
  /** @type {{ server: string, message: string, kept?: true }[]} */
  const rejected = [];
  /** @type {string[]} */
  const unpaired = [];
  for (const server of servers) {
    const existing = stored(server);
    if (!code) {
      if (existing) ready.push(existing);
      else unpaired.push(server);
      continue;
    }
    // A supplied code ALWAYS re-pairs (D55): after a revoke the stored token is dead, and the dialog's command must
    // pair on its first run. The server replaces this computer's old pairing, so a re-claim never eats a device slot.
    const claim = await claimPairing(makeApi(server), code, { deviceName, os: platform, signal });
    if (!claim.ok) {
      if (existing) {
        ready.push(existing);
        rejected.push({ server, message: claim.message, kept: true });
      } else {
        rejected.push({ server, message: claim.message });
      }
      continue;
    }
    const cfg = { server, deviceId: claim.deviceId, token: claim.token };
    save(cfg);
    ready.push(cfg);
    paired.push(server);
  }
  return { ready, paired, rejected, unpaired };
}

module.exports = { claimPairing, ensurePaired, notPairedText };
