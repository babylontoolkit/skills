'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bridgeConfigPath,
  readBridgeConfig,
  writeBridgeConfig,
  deleteBridgeConfig,
} = require('../lib/bridge/config');

/** A scratch HOME (and USERPROFILE, for Windows) so nothing touches the real ~/.babylon-toolkit. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-config-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const CFG = { server: 'https://builder.example', deviceId: 'dev_1', token: 'btkb_secret' };

test('writes and reads back the credential', (t) => {
  const dir = scratch(t);
  assert.equal(bridgeConfigPath(), path.join(dir, '.babylon-toolkit', 'bridge.json'));
  assert.equal(readBridgeConfig(), null);
  writeBridgeConfig(CFG);
  assert.deepEqual(readBridgeConfig(), CFG);
  assert.deepEqual(readBridgeConfig(CFG.server), CFG);
  deleteBridgeConfig();
  assert.equal(readBridgeConfig(), null);
});

test('the credential file is readable by its owner only', { skip: process.platform === 'win32' }, (t) => {
  scratch(t);
  const file = bridgeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  writeBridgeConfig(CFG);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a credential for another server is not a pairing for this one', (t) => {
  scratch(t);
  writeBridgeConfig(CFG);
  assert.equal(readBridgeConfig('https://other.example'), null);
});

test('an unparsable file is not paired', (t) => {
  scratch(t);
  const file = bridgeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.equal(readBridgeConfig(), null);
});
