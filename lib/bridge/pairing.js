'use strict';

const os = require('os');

const log = require('./log');

const REDEEM_INTERVAL_MS = 3000;
const EXPIRED = 'The pairing code expired. Run bt-agent bridge again.';

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Device-code pairing (D7): start a pairing, show the code, and poll `redeem` until a signed-in
 * user approves it in the builder's Connect dialog. The token is returned exactly once.
 *
 * @param {import('./api').BridgeApi} api an unauthenticated client
 * @param {{ deviceName?: string, os?: string, sleep?: (ms: number) => Promise<void>, signal?: AbortSignal, logger?: typeof log }} [opts]
 * @returns {Promise<{ deviceId: string, token: string }>}
 */
async function pairDevice(api, opts = {}) {
  const deviceName = (opts.deviceName || os.hostname() || 'computer').slice(0, 80);
  const platform = opts.os || process.platform;
  const sleep = opts.sleep || defaultSleep;
  const logger = opts.logger || log;

  const started = await api.post('/api/bridge/pair', { action: 'start', deviceName, os: platform }, opts.signal);
  const s = started.body || {};
  if (started.status !== 200 || typeof s.pairingId !== 'string' || typeof s.secret !== 'string') {
    throw new Error(
      `Could not start pairing (HTTP ${started.status})${s && s.message ? `: ${s.message}` : ''}`
    );
  }

  logger.box([
    'Pair this computer: open your project in the App Builder, click the cube icon',
    `in the chat box, and enter code ${s.code}. Expires in 10 minutes.`,
  ]);

  const deadline = typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : NaN;

  for (;;) {
    await sleep(REDEEM_INTERVAL_MS);
    if (opts.signal && opts.signal.aborted) throw abortError();

    let r;
    try {
      r = await api.post('/api/bridge/pair', { action: 'redeem', pairingId: s.pairingId, secret: s.secret }, opts.signal);
    } catch (err) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      // A dropped connection while waiting is not a reason to lose the pairing; keep asking.
      logger.error(`Pairing check failed (${err.message}); retrying.`);
      continue;
    }

    const b = r.body || {};
    if (r.status === 410 || b.status === 'expired') throw new Error(EXPIRED);
    if (r.status === 200 && b.status === 'approved' && typeof b.token === 'string') {
      return { deviceId: b.deviceId, token: b.token };
    }
    if (r.status !== 200) {
      logger.error(`Pairing check failed (HTTP ${r.status}${b.message ? `: ${b.message}` : ''}); retrying.`);
    }
    // Belt and braces: never wait forever on a code the server should already have expired.
    if (Number.isFinite(deadline) && Date.now() > deadline + 60_000) throw new Error(EXPIRED);
  }
}

function abortError() {
  const err = new Error('Pairing was cancelled.');
  err.name = 'AbortError';
  return err;
}

module.exports = { pairDevice, REDEEM_INTERVAL_MS, EXPIRED };
