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

const { readSettings, writeSettings, migrateSettings } = require('../lib/bridge/config');

test('the old single-server file is read as one entry in servers (migration on read)', (t) => {
  scratch(t);
  const file = bridgeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(CFG));
  assert.deepEqual(readSettings(), { servers: [CFG], projects: [], unity: [], noScripts: false });
  assert.deepEqual(readBridgeConfig(CFG.server), CFG);
  // the next write stores the new shape
  writeBridgeConfig({ server: 'http://localhost:5173', deviceId: 'dev_2', token: 'btkb_2' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.servers.map((c) => c.server), [CFG.server, 'http://localhost:5173']);
  assert.equal(onDisk.server, undefined);
});

test('settings round-trip: several servers, projects folders, unity paths, blender, noScripts', (t) => {
  scratch(t);
  const s = {
    servers: [CFG, { server: 'http://localhost:5173', deviceId: 'dev_2', token: 't2' }],
    projects: ['/Users/me/Unity', '/Volumes/Work/Unity'],
    unity: ['/Users/me/Other/Game'],
    blender: '/Applications/Blender.app/Contents/MacOS/Blender',
    noScripts: true,
  };
  writeSettings(s);
  assert.deepEqual(readSettings(), s);
  assert.deepEqual(readBridgeConfig('http://localhost:5173'), s.servers[1]);
});

test('removing one server keeps the others; removing all with no server deletes the file', (t) => {
  scratch(t);
  writeBridgeConfig(CFG);
  writeBridgeConfig({ server: 'http://localhost:5173', deviceId: 'd2', token: 't2' });
  deleteBridgeConfig(CFG.server);
  assert.equal(readBridgeConfig(CFG.server), null);
  assert.ok(readBridgeConfig('http://localhost:5173'));
  deleteBridgeConfig();
  assert.equal(fs.existsSync(bridgeConfigPath()), false);
});

test('migrateSettings drops malformed entries and duplicate servers', () => {
  const s = migrateSettings({
    servers: [CFG, { server: 'x' }, CFG, null],
    projects: ['/a', 3, ''],
    unity: 'nope',
    noScripts: 'yes',
  });
  assert.deepEqual(s, { servers: [CFG], projects: ['/a'], unity: [], noScripts: false });
});

// ── current project persistence (verifier item 11) ────────────────────────────────────────────

const { saveCurrentProject, restorableCurrentProject, readSettings: readAll, writeSettings: writeAll } = require('../lib/bridge/config');
const { createWorkspace } = require('../lib/bridge/unity/discover');

test('restorableCurrentProject: restored only when it still exists as a project DIRECTLY inside a configured projects folder', () => {
  const projects = new Set(['/u/Games/Kart']);
  const io = { isProject: (root) => projects.has(root) };
  assert.equal(restorableCurrentProject('/u/Games/Kart', ['/u/Games'], io), '/u/Games/Kart');
  // the folder was deleted → nothing
  assert.equal(restorableCurrentProject('/u/Games/Gone', ['/u/Games'], io), undefined);
  // outside every configured projects folder (the service was re-installed with another folder) → nothing
  assert.equal(restorableCurrentProject('/u/Games/Kart', ['/u/Other'], io), undefined);
  // nested deeper, relative, or absent → nothing
  assert.equal(restorableCurrentProject('/u/Games/Kart/Sub', ['/u/Games'], { isProject: () => true }), undefined);
  assert.equal(restorableCurrentProject('Kart', ['/u/Games'], { isProject: () => true }), undefined);
  assert.equal(restorableCurrentProject(undefined, ['/u/Games'], io), undefined);
});

test('saveCurrentProject writes currentProject into the settings file and keeps every other setting', (t) => {
  const home = scratch(t);
  const file = path.join(home, '.babylon-toolkit', 'bridge.json');
  writeAll({ servers: [{ server: 'https://a', deviceId: 'd', token: 't' }], projects: ['/u/Games'], unity: [], noScripts: true }, file);
  saveCurrentProject('/u/Games/Kart', file);
  const after = readAll(file);
  assert.equal(after.currentProject, '/u/Games/Kart');
  assert.deepEqual(after.servers, [{ server: 'https://a', deviceId: 'd', token: 't' }]);
  assert.deepEqual(after.projects, ['/u/Games']);
  assert.equal(after.noScripts, true);
  // a later write of other settings (a re-pair) keeps it
  const again = readAll(file);
  again.servers.push({ server: 'https://b', deviceId: 'd2', token: 't2' });
  writeAll(again, file);
  assert.equal(readAll(file).currentProject, '/u/Games/Kart');
});

test('the workspace reports a CHANGED current project to onCurrentChange (and not a repeat of the same one)', (t) => {
  const home = scratch(t);
  const seen = [];
  const ws = createWorkspace({ projectsDir: home, onCurrentChange: (root) => seen.push(root) });
  ws.setCurrent(path.join(home, 'Kart'));
  ws.setCurrent(path.join(home, 'Kart'));
  ws.setCurrent(path.join(home, 'Racer'));
  assert.equal(seen.length, 2);
  assert.ok(seen[0].endsWith(`${path.sep}Kart`));
  assert.ok(seen[1].endsWith(`${path.sep}Racer`));
});
