'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { enableNetwork, applyCodexConfig, hasCodexNetwork } = require('../lib/codex-config');
const { install, uninstall } = require('../lib/install');
const { doctor } = require('../lib/doctor');
const { resolveTargets } = require('../lib/targets');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-network-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('creates the shipped config and is idempotent', (t) => {
  const file = path.join(scratch(t), '.codex/config.toml');
  assert.equal(applyCodexConfig(file).action, 'created');
  assert.equal(fs.readFileSync(file, 'utf8'), '[sandbox_workspace_write]\nnetwork_access = true\n');
  assert.equal(applyCodexConfig(file).action, 'unchanged');
  assert.equal(fs.existsSync(file + '.bak'), false);
  assert.equal(hasCodexNetwork(file), true);
});

test('merges false without changing comments, other tables or CRLF, backs up once', (t) => {
  const file = path.join(scratch(t), 'config.toml');
  const source = 'model = "example"\r\n[sandbox_workspace_write] # access\r\nwritable_roots = ["/tmp"]\r\nnetwork_access = false # chosen value\r\n[profiles.offline]\r\nnetwork_access = false\r\n';
  fs.writeFileSync(file, source);
  assert.equal(hasCodexNetwork(file), false);
  assert.equal(applyCodexConfig(file).action, 'updated');
  assert.equal(fs.readFileSync(file, 'utf8'), source.replace('false # chosen', 'true # chosen'));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), source);
  assert.equal(applyCodexConfig(file).action, 'unchanged');
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), source);
});

test('inserts into an existing section without duplicating it', () => {
  assert.equal(enableNetwork('[sandbox_workspace_write]\nwritable_roots = []\n[other]\nx = 1\n'),
    '[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = []\n[other]\nx = 1\n');
});

test('supports quoted names, root dotted keys and dotted siblings', () => {
  assert.equal(enableNetwork('["sandbox_workspace_write"]\n\'network_access\' = false\n'),
    '["sandbox_workspace_write"]\n\'network_access\' = true\n');
  assert.equal(enableNetwork('sandbox_workspace_write.network_access = false # root\n'),
    'sandbox_workspace_write.network_access = true # root\n');
  assert.equal(enableNetwork('sandbox_workspace_write.writable_roots = []\n[other]\nx = 1\n'),
    'sandbox_workspace_write.network_access = true\nsandbox_workspace_write.writable_roots = []\n[other]\nx = 1\n');
});

test('ignores comments, nested profile settings and multiline string lookalikes', () => {
  const source = '# [sandbox_workspace_write]\ninstructions = """\n[sandbox_workspace_write]\nnetwork_access = false\n"""\n[profiles.offline.sandbox_workspace_write]\nnetwork_access = false\n';
  const result = enableNetwork(source);
  assert.equal(result, source + '\n[sandbox_workspace_write]\nnetwork_access = true\n');
  assert.equal(enableNetwork(result), result);
});

test('unsupported inline tables fail without changing the file or making a backup', (t) => {
  const file = path.join(scratch(t), 'config.toml');
  const source = 'sandbox_workspace_write = { network_access = false }\n';
  fs.writeFileSync(file, source);
  assert.throws(() => applyCodexConfig(file), /Cannot safely merge/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(fs.existsSync(file + '.bak'), false);
});

test('dry run does not create a directory, change existing content, or back up', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, '[sandbox_workspace_write]\nnetwork_access = false\n');
  assert.equal(applyCodexConfig(file, { dryRun: true }).action, 'updated');
  assert.equal(hasCodexNetwork(file), false);
  assert.deepEqual(fs.readdirSync(dir), ['config.toml']);
  assert.equal(applyCodexConfig(path.join(dir, 'absent/config.toml'), { dryRun: true }).action, 'created');
  assert.deepEqual(fs.readdirSync(dir), ['config.toml']);
});

test('project install, doctor, reinstall and uninstall handle config consistently', (t) => {
  const projectRoot = scratch(t);
  const opts = { mode: 'project', projectRoot, ids: ['codex'], skills: false };
  assert.equal(install({ ...opts, dryRun: true }).config[0].action, 'created');
  assert.deepEqual(fs.readdirSync(projectRoot), []);
  assert.equal(install(opts).config[0].action, 'created');
  assert.equal(doctor(opts).ok, true);
  assert.equal(install(opts).config[0].action, 'unchanged');
  const file = path.join(projectRoot, '.codex/config.toml');
  fs.writeFileSync(file, '[sandbox_workspace_write]\nnetwork_access = false\n');
  assert.equal(doctor(opts).ok, false);
  install(opts);
  uninstall(opts);
  assert.equal(hasCodexNetwork(file), true);
  assert.equal(fs.existsSync(file + '.bak'), true);
});

test('target selection isolates other agents and deduplicates legacy Codex', (t) => {
  const projectRoot = scratch(t);
  assert.equal(install({ mode: 'project', projectRoot, ids: ['gemini'], skills: false }).config.length, 0);
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex')), false);
  const resolved = resolveTargets({ mode: 'project', projectRoot, ids: ['codex'], legacyCodex: true });
  assert.deepEqual(resolved.configFiles, [{ file: path.join(projectRoot, '.codex/config.toml'), targets: ['codex', 'codex-legacy'] }]);
  assert.equal(resolveTargets().configFiles[0].file, path.join(os.homedir(), '.codex/config.toml'));
});

test('global postinstall hook uses an isolated home and includes network setup', (t) => {
  const home = scratch(t);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/postinstall.js')], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_global: 'true' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /INSTALL OK/);
  assert.match(result.stdout, /network_access = true/);
  assert.equal(hasCodexNetwork(path.join(home, '.codex/config.toml')), true);
});
