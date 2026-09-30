'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claimPairing, ensurePaired, notPairedText } = require('../lib/bridge/pairing');

/** A fake unauthenticated api for one server: answers /api/bridge/pair with `reply(body)`. */
function fakeApi(server, reply, calls) {
  return {
    server,
    async post(p, body) {
      calls.push({ server, path: p, body });
      return reply(body);
    },
  };
}

test('claim posts the code with this computer\'s name and os, and returns the token once', async () => {
  const calls = [];
  const api = fakeApi('https://b', () => ({ status: 200, body: { deviceId: 'dev_1', token: 'btkb_x' } }), calls);
  const r = await claimPairing(api, 'K7QM-2XWD', { deviceName: 'mac-mini', os: 'darwin' });
  assert.deepEqual(r, { ok: true, deviceId: 'dev_1', token: 'btkb_x' });
  assert.deepEqual(calls, [
    { server: 'https://b', path: '/api/bridge/pair', body: { action: 'claim', code: 'K7QM-2XWD', deviceName: 'mac-mini', os: 'darwin' } },
  ]);
});

test('an unknown / used / expired code (410) is reported with the server\'s message', async () => {
  const msg = 'That install code is not valid or has expired. Copy a fresh command from the Unity Bridge dialog.';
  const api = fakeApi('https://b', () => ({ status: 410, body: { message: msg } }), []);
  assert.deepEqual(await claimPairing(api, 'AAAA-BBBB', { deviceName: 'x', os: 'linux' }), { ok: false, message: msg });
  const unreachable = { server: 'https://b', post: async () => { throw new Error('ECONNREFUSED'); } };
  const r = await claimPairing(unreachable, 'AAAA-BBBB', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /ECONNREFUSED/);
});

test('ensurePaired with a code: every server claims it; an unpaired server that rejects is skipped', async () => {
  const calls = [];
  const saved = [];
  const replies = {
    'http://localhost:5173': () => ({ status: 200, body: { deviceId: 'dev_l', token: 'tl' } }),
    'https://staging': () => ({ status: 410, body: { message: 'expired' } }),
  };
  const r = await ensurePaired({
    servers: ['http://localhost:5173', 'https://staging'],
    code: 'K7QM-2XWD',
    stored: () => null,
    save: (cfg) => saved.push(cfg),
    makeApi: (s) => fakeApi(s, replies[s], calls),
    deviceName: 'mac',
    os: 'darwin',
  });
  assert.deepEqual(r.ready.map((c) => c.server), ['http://localhost:5173']);
  assert.deepEqual(r.paired, ['http://localhost:5173']);
  assert.deepEqual(r.rejected, [{ server: 'https://staging', message: 'expired' }]);
  assert.deepEqual(r.unpaired, []);
  assert.deepEqual(saved, [{ server: 'http://localhost:5173', deviceId: 'dev_l', token: 'tl' }]);
  assert.deepEqual(calls.map((c) => c.server), ['http://localhost:5173', 'https://staging']);
});

test('ensurePaired: a stored credential + a supplied code → the code is claimed and REPLACES it (D55 — pairs on the first run after a revoke)', async () => {
  const calls = [];
  const saved = [];
  const stored = { 'https://prod': { server: 'https://prod', deviceId: 'dev_old', token: 'revoked' } };
  const r = await ensurePaired({
    servers: ['https://prod'],
    code: 'NEW1-CODE',
    stored: (s) => stored[s] || null,
    save: (cfg) => saved.push(cfg),
    makeApi: (s) => fakeApi(s, () => ({ status: 200, body: { deviceId: 'dev_new', token: 'fresh' } }), calls),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(saved, [{ server: 'https://prod', deviceId: 'dev_new', token: 'fresh' }]);
  assert.deepEqual(r.ready, [{ server: 'https://prod', deviceId: 'dev_new', token: 'fresh' }]);
  assert.deepEqual(r.paired, ['https://prod']);
  assert.deepEqual(r.rejected, []);
});

test('ensurePaired: a stored credential + a REJECTED code → the stored one is kept and the rejection reported', async () => {
  const stored = { 'https://prod': { server: 'https://prod', deviceId: 'dev_p', token: 'tp' } };
  const r = await ensurePaired({
    servers: ['https://prod'],
    code: 'USED-CODE',
    stored: (s) => stored[s] || null,
    save: () => assert.fail('a rejected code saves nothing'),
    makeApi: (s) => fakeApi(s, () => ({ status: 410, body: { message: 'already used' } }), []),
  });
  assert.deepEqual(r.ready, [stored['https://prod']]);
  assert.deepEqual(r.paired, []);
  assert.deepEqual(r.rejected, [{ server: 'https://prod', message: 'already used', kept: true }]);
});

test('ensurePaired: a stored credential and NO code → kept as is, nothing posted (control)', async () => {
  const stored = { 'https://prod': { server: 'https://prod', deviceId: 'dev_p', token: 'tp' } };
  const r = await ensurePaired({
    servers: ['https://prod'],
    stored: (s) => stored[s] || null,
    save: () => assert.fail('nothing to save'),
    makeApi: () => assert.fail('no request'),
  });
  assert.deepEqual(r.ready, [stored['https://prod']]);
  assert.deepEqual(r.paired, []);
  assert.deepEqual(r.rejected, []);
});

test('ensurePaired without a code: an unpaired server is reported, nothing is posted', async () => {
  const calls = [];
  const r = await ensurePaired({
    servers: ['https://app.babylontoolkit.com'],
    stored: () => null,
    save: () => assert.fail('nothing to save'),
    makeApi: (s) => fakeApi(s, () => assert.fail('no request'), calls),
  });
  assert.deepEqual(r.unpaired, ['https://app.babylontoolkit.com']);
  assert.deepEqual(r.ready, []);
  assert.equal(calls.length, 0);
  assert.equal(
    notPairedText('https://app.babylontoolkit.com'),
    'Not paired with https://app.babylontoolkit.com — copy the install command from the Unity Bridge dialog in the App Builder.'
  );
});
