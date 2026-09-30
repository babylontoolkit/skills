'use strict';

/**
 * The start-at-login service (D55). Every side effect goes through injected exec/spawn/kill and a scratch
 * HOME — these tests never register a real launchd agent, systemd unit or Startup script.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const service = require('../lib/bridge/service');
const { appendLogLine } = require('../lib/bridge/log');
const { runBridgeCli } = require('../lib/bridge/cli');
const { readSettings, writeSettings, readBridgeConfig } = require('../lib/bridge/config');
const { PACKAGE_ROOT } = require('../lib/paths');

function scratchHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-svc-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Fake host: records every exec/spawn/kill; `codes` maps `file args…` prefixes to exit codes. */
function fakeHost(home, platform, { codes = {}, stdout = {} } = {}) {
  const execs = [];
  const spawns = [];
  const kills = [];
  const sleeps = [];
  const deps = {
    platform,
    home,
    uid: 501,
    execPath: '/usr/local/bin/node',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', APPDATA: path.join(home, 'AppData', 'Roaming') },
    exec: (file, args) => {
      execs.push([file, ...args]);
      const key = [file, ...args].join(' ');
      const hit = Object.keys(codes).find((k) => key.startsWith(k));
      let code = hit === undefined ? 0 : codes[hit];
      if (Array.isArray(code)) code = code.length ? code.shift() : 0;
      const out = Object.keys(stdout).find((k) => key.startsWith(k));
      return { code, stdout: out === undefined ? '' : stdout[out], stderr: code ? 'boom' : '' };
    },
    spawn: (file, args, opts) => {
      spawns.push({ file, args, opts });
      return { unref() {} };
    },
    kill: (pid, sig) => kills.push([pid, sig]),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    packageRoot: PACKAGE_ROOT,
  };
  return { deps, execs, spawns, kills, sleeps };
}

test('macOS: writes the exact launchd plist, copies the package, and boots it out then in', async (t) => {
  const home = scratchHome(t);
  const { deps, execs } = fakeHost(home, 'darwin');
  const r = await service.installService(deps);

  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.babylontoolkit.bridge.plist');
  const svc = path.join(home, '.babylon-toolkit', 'service');
  const log = path.join(home, '.babylon-toolkit', 'bridge.log');
  assert.equal(r.registration, plist);
  assert.equal(r.serviceDir, svc);
  assert.deepEqual(r.argv, ['/usr/local/bin/node', path.join(svc, 'bin', 'bt-agent.js'), 'bridge', '--service']);
  assert.equal(
    fs.readFileSync(plist, 'utf8'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.babylontoolkit.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>${svc}/bin/bt-agent.js</string>
    <string>bridge</string>
    <string>--service</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`
  );
  assert.deepEqual(execs, [
    ['launchctl', 'bootout', 'gui/501/com.babylontoolkit.bridge'],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  // the service runs from its own copy, never from an npx cache: package.json, bin/ and lib/ only
  assert.deepEqual(fs.readdirSync(svc).sort(), ['bin', 'lib', 'package.json']);
  assert.ok(fs.existsSync(path.join(svc, 'lib', 'bridge', 'cli.js')));
});

test('the copied package is self-sufficient: `bridge --help` runs from ~/.babylon-toolkit/service', async (t) => {
  const home = scratchHome(t);
  const { deps } = fakeHost(home, 'darwin');
  const r = await service.installService(deps);
  const out = spawnSync(process.execPath, [r.argv[1], 'bridge', '--help'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /--install-service/);
});

test('a plist value with XML characters is escaped', () => {
  const xml = service.launchdPlist({ argv: ['/a & b/<node>'], path: '/x', home: '/h', logFile: '/l' });
  assert.ok(xml.includes('<string>/a &amp; b/&lt;node&gt;</string>'));
});

test('macOS: a bootstrap that races the bootout is retried; one that keeps failing is an error', async (t) => {
  const home = scratchHome(t);
  const flaky = fakeHost(home, 'darwin', { codes: { 'launchctl bootout': 3, 'launchctl bootstrap': [5, 5, 0] } });
  await service.installService(flaky.deps);
  assert.equal(flaky.execs.filter((e) => e[1] === 'bootstrap').length, 3);
  assert.deepEqual(flaky.sleeps, [1000, 1000]);

  const broken = fakeHost(home, 'darwin', { codes: { 'launchctl bootstrap': 5 } });
  await assert.rejects(service.installService(broken.deps), /launchctl bootstrap failed \(exit 5\)/);
  assert.equal(broken.execs.filter((e) => e[1] === 'bootstrap').length, 5);
});

test('re-installing replaces the service copy atomically (no temp or old folder left, stale files gone)', async (t) => {
  const home = scratchHome(t);
  const { deps } = fakeHost(home, 'darwin');
  await service.installService(deps);
  const svc = path.join(home, '.babylon-toolkit', 'service');
  fs.writeFileSync(path.join(svc, 'stale.txt'), 'old');
  await service.installService(deps);
  assert.equal(fs.existsSync(path.join(svc, 'stale.txt')), false);
  assert.deepEqual(
    fs.readdirSync(path.join(home, '.babylon-toolkit')).filter((n) => n.startsWith('service')),
    ['service']
  );
});

test('Linux: writes the exact systemd user unit, reloads and enables --now; a re-install restarts it', async (t) => {
  const home = scratchHome(t);
  const { deps, execs } = fakeHost(home, 'linux');
  const r = await service.installService(deps);
  const unit = path.join(home, '.config', 'systemd', 'user', 'babylon-toolkit-bridge.service');
  const svc = path.join(home, '.babylon-toolkit', 'service');
  assert.equal(r.registration, unit);
  assert.equal(
    fs.readFileSync(unit, 'utf8'),
    `[Unit]
Description=Babylon Toolkit Unity Bridge
After=network-online.target

[Service]
ExecStart="/usr/local/bin/node" "${svc}/bin/bt-agent.js" "bridge" "--service"
Restart=on-failure
RestartSec=30
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="HOME=${home}"

[Install]
WantedBy=default.target
`
  );
  assert.deepEqual(execs, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'babylon-toolkit-bridge.service'],
  ]);
  execs.length = 0;
  await service.installService(deps);
  assert.deepEqual(execs, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'babylon-toolkit-bridge.service'],
    ['systemctl', '--user', 'restart', 'babylon-toolkit-bridge.service'],
  ]);
});

test('systemd words escape quotes, backslashes, % specifiers and $ variables', () => {
  const unit = service.systemdUnit({ argv: ['/p a/n"o\\de%$X'], path: '/b', home: '/h' });
  assert.ok(unit.includes('ExecStart="/p a/n\\"o\\\\de%%$$X"'));
});

test('Windows: writes the hidden Startup-folder script and starts the helper now, detached', async (t) => {
  const home = scratchHome(t);
  const { deps, spawns, execs } = fakeHost(home, 'win32');
  deps.execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const r = await service.installService(deps);
  const vbs = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'babylon-toolkit-bridge.vbs');
  assert.equal(r.registration, vbs);
  const script = path.join(home, '.babylon-toolkit', 'service', 'bin', 'bt-agent.js');
  assert.equal(
    fs.readFileSync(vbs, 'utf8'),
    [
      "' Babylon Toolkit Unity Bridge - starts the Desktop Agent helper when you log in.",
      "' Remove it with: bt-agent bridge --uninstall-service",
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""${script}"" ""bridge"" ""--service""", 0, False`,
      '',
    ].join('\r\n')
  );
  assert.deepEqual(execs, []);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(spawns[0].args, [script, 'bridge', '--service']);
  assert.equal(spawns[0].opts.detached, true);
  assert.equal(spawns[0].opts.stdio, 'ignore');
  assert.equal(spawns[0].opts.windowsHide, true);
});

test('Windows: a re-install stops the helper the previous one started (its recorded pid)', async (t) => {
  const home = scratchHome(t);
  const { deps, kills } = fakeHost(home, 'win32');
  fs.mkdirSync(path.join(home, '.babylon-toolkit'), { recursive: true });
  fs.writeFileSync(path.join(home, '.babylon-toolkit', 'bridge.pid'), '4242');
  await service.installService(deps);
  assert.deepEqual(kills, [[4242, undefined]]);
  assert.equal(fs.existsSync(path.join(home, '.babylon-toolkit', 'bridge.pid')), false);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: uninstall stops and unregisters the service and deletes its copy — the credential stays`, async (t) => {
    const home = scratchHome(t);
    const { deps, execs } = fakeHost(home, platform);
    const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
    writeSettings({ servers: [{ server: 'https://b', deviceId: 'd', token: 't' }], projects: [], unity: [], noScripts: false }, settingsFile);
    const r = await service.installService(deps);
    execs.length = 0;

    const u = service.uninstallService(deps);
    assert.deepEqual(u.removed, [r.registration, r.serviceDir]);
    assert.equal(fs.existsSync(r.registration), false);
    assert.equal(fs.existsSync(r.serviceDir), false);
    assert.ok(readBridgeConfig('https://b', settingsFile));
    if (platform === 'darwin') assert.deepEqual(execs, [['launchctl', 'bootout', 'gui/501/com.babylontoolkit.bridge']]);
    if (platform === 'linux') {
      assert.deepEqual(execs, [
        ['systemctl', '--user', 'disable', '--now', 'babylon-toolkit-bridge.service'],
        ['systemctl', '--user', 'daemon-reload'],
      ]);
    }
    if (platform === 'win32') assert.deepEqual(execs, []);
    // nothing left to remove the second time
    assert.deepEqual(service.uninstallService(deps).removed, []);
  });
}

test('status: not installed; installed + running (launchctl print); installed, systemctl inactive', async (t) => {
  const home = scratchHome(t);
  const mac = fakeHost(home, 'darwin', { stdout: { 'launchctl print': 'gui/501/com.babylontoolkit.bridge = {\n\tstate = running\n' } });
  assert.deepEqual(service.serviceStatus(mac.deps).installed, false);
  assert.equal(mac.execs.length, 0);
  await service.installService(mac.deps);
  const st = service.serviceStatus(mac.deps);
  assert.equal(st.installed, true);
  assert.equal(st.running, true);

  const linux = fakeHost(home, 'linux', { stdout: { 'systemctl --user is-active': 'inactive\n' }, codes: { 'systemctl --user is-active': 3 } });
  await service.installService(linux.deps);
  assert.deepEqual(service.serviceStatus(linux.deps), {
    installed: true,
    running: false,
    registration: path.join(home, '.config', 'systemd', 'user', 'babylon-toolkit-bridge.service'),
  });
});

test('the log rotates at the cap: bridge.log becomes bridge.log.1 (replacing the previous one)', (t) => {
  const home = scratchHome(t);
  const file = path.join(home, 'logs', 'bridge.log');
  appendLogLine({ file, line: 'a'.repeat(10), maxBytes: 20 });
  appendLogLine({ file, line: 'b'.repeat(10), maxBytes: 20 });
  assert.equal(fs.readFileSync(file, 'utf8'), `${'a'.repeat(10)}\n${'b'.repeat(10)}\n`);
  assert.equal(fs.existsSync(`${file}.1`), false);
  appendLogLine({ file, line: 'c', maxBytes: 20 });
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), `${'a'.repeat(10)}\n${'b'.repeat(10)}\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'c\n');
  for (let i = 0; i < 3; i += 1) appendLogLine({ file, line: 'd'.repeat(10), maxBytes: 20 });
  assert.ok(fs.readFileSync(`${file}.1`, 'utf8').startsWith('c\n'));
});

// ── the CLI commands, with every host effect injected ──────────────────────────────────────────

function capture() {
  const lines = [];
  return {
    lines,
    logger: { info: (m) => lines.push(`info ${m}`), op: () => {}, error: (m) => lines.push(`error ${m}`) },
  };
}

function makeUnityFolder(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
  return dir;
}

test('--install-service --pair: claims the code, writes the settings, installs the service (exit 0)', async (t) => {
  const home = scratchHome(t);
  const projects = path.join(home, 'Unity Projects');
  fs.mkdirSync(projects);
  const game = makeUnityFolder(projects, 'Game');
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const host = fakeHost(home, 'darwin');
  const posts = [];
  const { lines, logger } = capture();
  const code = await runBridgeCli(
    ['--install-service', '--pair', 'K7QM-2XWD', '--server', 'http://localhost:5173', '--no-scripts', '--projects', projects, '--unity', game],
    {
      env: {},
      cwd: home,
      settingsFile,
      deviceName: 'studio-mac',
      logger,
      serviceDeps: host.deps,
      makeApi: (server) => ({
        server,
        post: async (p, body) => {
          posts.push({ server, p, body });
          return { status: 200, body: { deviceId: 'dev_9', token: 'btkb_9' } };
        },
      }),
    }
  );
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(posts, [
    { server: 'http://localhost:5173', p: '/api/bridge/pair', body: { action: 'claim', code: 'K7QM-2XWD', deviceName: 'studio-mac', os: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux' } },
  ]);
  assert.deepEqual(readSettings(settingsFile), {
    servers: [{ server: 'http://localhost:5173', deviceId: 'dev_9', token: 'btkb_9' }],
    projects: [projects],
    unity: [game],
    noScripts: true,
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.babylontoolkit.bridge.plist')));
  assert.ok(lines.includes('info Unity Bridge will start automatically when you log in. Remove it with: bt-agent bridge --uninstall-service'));
  assert.ok(lines.some((l) => l.startsWith('info Log: ')));
});

test('--install-service with a rejected code installs nothing (exit 1) and says why', async (t) => {
  const home = scratchHome(t);
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const host = fakeHost(home, 'darwin');
  const { lines, logger } = capture();
  const msg = 'That install code is not valid or has expired. Copy a fresh command from the Unity Bridge dialog.';
  const code = await runBridgeCli(['--install-service', '--pair', 'AAAA-BBBB', '--projects', home], {
    env: {},
    cwd: home,
    settingsFile,
    logger,
    serviceDeps: host.deps,
    makeApi: (server) => ({ server, post: async () => ({ status: 410, body: { message: msg } }) }),
  });
  assert.equal(code, 1);
  assert.ok(lines.includes(`error Could not pair with https://app.babylontoolkit.com: ${msg}`));
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.babylontoolkit.bridge.plist')), false);
  assert.equal(host.execs.length, 0);
  assert.equal(fs.existsSync(settingsFile), false);
});

// ── D59: the Unity projects folder is REQUIRED at install, never guessed from where the command runs ──

/** A claim that always succeeds, recording every post. */
function claimingApi(posts) {
  return (server) => ({
    server,
    post: async (p, body) => {
      posts.push({ server, p, body });
      return { status: 200, body: { deviceId: 'dev_9', token: 'btkb_9' } };
    },
  });
}

const PLIST = (home) => path.join(home, 'Library', 'LaunchAgents', 'com.babylontoolkit.bridge.plist');

test('D59: --install-service with no --projects and nothing stored refuses — nothing claimed, nothing installed', async (t) => {
  const home = scratchHome(t);
  makeUnityFolder(home, 'Game'); // even inside a folder of Unity projects, the cwd is never guessed
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const host = fakeHost(home, 'darwin');
  const posts = [];
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--install-service', '--pair', 'K7QM-2XWD'], {
    env: {},
    cwd: path.join(home, 'Game'),
    settingsFile,
    logger,
    serviceDeps: host.deps,
    makeApi: claimingApi(posts),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'error Choose your Unity projects folder: add --projects <folder> (the Unity Bridge dialog puts it in the command).',
  ]);
  assert.deepEqual(posts, []);
  assert.deepEqual(host.execs, []);
  assert.equal(fs.existsSync(PLIST(home)), false);
  assert.equal(fs.existsSync(settingsFile), false);
});

test('D59: a --projects folder that does not exist is created and reported, then stored', async (t) => {
  const home = scratchHome(t);
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const target = path.join(home, 'Unity Projects', 'Nested');
  const host = fakeHost(home, 'darwin');
  const posts = [];
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--install-service', '--pair', 'K7QM-2XWD', '--projects', target], {
    env: {},
    cwd: home,
    settingsFile,
    logger,
    serviceDeps: host.deps,
    makeApi: claimingApi(posts),
  });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(fs.statSync(target).isDirectory());
  assert.ok(lines.includes(`info Created ${target}.`), lines.join('\n'));
  assert.deepEqual(readSettings(settingsFile).projects, [target]);
  assert.equal(posts.length, 1);
  assert.ok(fs.existsSync(PLIST(home)));
});

test('D59: a relative --projects is resolved against the cwd; an existing folder is not reported as created', async (t) => {
  const home = scratchHome(t);
  fs.mkdirSync(path.join(home, 'Games'));
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--install-service', '--pair', 'K7QM-2XWD', '--projects', 'Games'], {
    env: {},
    cwd: home,
    settingsFile,
    logger,
    serviceDeps: fakeHost(home, 'darwin').deps,
    makeApi: claimingApi([]),
  });
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(readSettings(settingsFile).projects, [path.join(home, 'Games')]);
  assert.ok(!lines.some((l) => l.startsWith('info Created ')));
});

test('D59: a --projects path that is a FILE is refused, naming it — nothing claimed, nothing installed', async (t) => {
  const home = scratchHome(t);
  const file = path.join(home, 'not-a-folder.txt');
  fs.writeFileSync(file, 'x');
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const host = fakeHost(home, 'darwin');
  const posts = [];
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--install-service', '--pair', 'K7QM-2XWD', '--projects', file], {
    env: {},
    cwd: home,
    settingsFile,
    logger,
    serviceDeps: host.deps,
    makeApi: claimingApi(posts),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [`error The Unity projects folder is a file, not a folder: ${file}`]);
  assert.deepEqual(posts, []);
  assert.deepEqual(host.execs, []);
  assert.equal(fs.existsSync(PLIST(home)), false);
  assert.equal(fs.existsSync(settingsFile), false);
});

test('D59 control: a reinstall without --projects keeps the stored folders (and the stored --unity projects)', async (t) => {
  const home = scratchHome(t);
  const stored = path.join(home, 'Stored Projects');
  fs.mkdirSync(stored);
  const extra = makeUnityFolder(home, 'Extra');
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  writeSettings(
    { servers: [{ server: 'https://app.babylontoolkit.com', deviceId: 'd1', token: 't1' }], projects: [stored], unity: [extra], noScripts: false },
    settingsFile
  );
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--install-service', '--pair', 'K7QM-2XWD'], {
    env: {},
    cwd: elsewhere,
    settingsFile,
    logger,
    serviceDeps: fakeHost(home, 'darwin').deps,
    makeApi: claimingApi([]),
  });
  assert.equal(code, 0, lines.join('\n'));
  const after = readSettings(settingsFile);
  assert.deepEqual(after.projects, [stored]);
  assert.deepEqual(after.unity, [extra]);
  assert.ok(lines.includes(`info Unity projects folder: ${stored}`), lines.join('\n'));
});

test('D59 control: a foreground run without --install-service keeps the cwd default', async (t) => {
  const home = scratchHome(t);
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  writeSettings({ servers: [{ server: 'https://app.babylontoolkit.com', deviceId: 'd1', token: 't1' }], projects: [], unity: [], noScripts: false }, settingsFile);
  const calls = [];
  const controller = new AbortController();
  const { logger } = capture();
  const code = await runBridgeCli([], {
    env: {},
    cwd: home,
    settingsFile,
    logger,
    signal: controller.signal,
    serviceDeps: fakeHost(home, 'darwin').deps,
    discover: (opts) => {
      calls.push(opts);
      controller.abort(); // stop the loop as soon as the folder question has been asked
      return { projectsDir: home, projectsDirs: [home], missingDirs: [], projectsDirMissing: false, projects: [], folderProjectCount: 0, extraRoots: [], notProjects: [] };
    },
    findBlender: () => undefined,
    sleep: async () => {},
    makeApi: (server) => ({ server, post: async () => ({ status: 200, body: { jobs: [] } }) }),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].projectsDir, []);
  assert.equal(calls[0].cwd, home);
});

test('a plain run with no stored pairing and no --pair: the "Not paired" line, exit 1, nothing posted', async (t) => {
  const home = scratchHome(t);
  const { lines, logger } = capture();
  const code = await runBridgeCli([], {
    env: {},
    cwd: home,
    settingsFile: path.join(home, 'bridge.json'),
    logger,
    serviceDeps: fakeHost(home, 'darwin').deps,
    makeApi: () => ({ post: async () => assert.fail('no request') }),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'error Not paired with https://app.babylontoolkit.com — copy the install command from the Unity Bridge dialog in the App Builder.',
  ]);
});

test('--service: every App Builder revoked → each loop stops, credentials removed, exit 0 (launchd will not restart)', async (t) => {
  const home = scratchHome(t);
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  writeSettings(
    {
      servers: [
        { server: 'https://a.example', deviceId: 'da', token: 'ta' },
        { server: 'http://localhost:5173', deviceId: 'dl', token: 'tl' },
      ],
      projects: [home],
      unity: [],
      noScripts: false,
    },
    settingsFile
  );
  const { NotPairedError } = require('../lib/bridge/api');
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--service'], {
    env: {},
    cwd: '/',
    settingsFile,
    logger,
    pidFile: path.join(home, 'bridge.pid'),
    serviceDeps: fakeHost(home, 'darwin').deps,
    discover: () => ({ projectsDir: home, projectsDirs: [home], missingDirs: [], projectsDirMissing: false, projects: [], folderProjectCount: 0, extraRoots: [], notProjects: [] }),
    findBlender: () => undefined,
    sleep: async () => {},
    makeApi: (server) => ({
      server,
      post: async () => {
        throw new NotPairedError();
      },
    }),
  });
  assert.equal(code, 0);
  assert.deepEqual(readSettings(settingsFile).servers, []);
  assert.ok(lines.includes('error This computer is not paired with https://a.example — copy the install command from the Unity Bridge dialog again.'));
  assert.ok(lines.includes('error This computer is not paired with http://localhost:5173 — copy the install command from the Unity Bridge dialog again.'));
  assert.ok(lines.includes('info No App Builder is left to serve; the Unity Bridge service is exiting.'));
  assert.equal(fs.existsSync(path.join(home, 'bridge.pid')), false);
});

test('--service with nothing paired exits 0 at once', async (t) => {
  const home = scratchHome(t);
  const { lines, logger } = capture();
  const code = await runBridgeCli(['--service'], {
    env: {},
    settingsFile: path.join(home, 'none.json'),
    logger,
    pidFile: path.join(home, 'bridge.pid'),
    serviceDeps: fakeHost(home, 'darwin').deps,
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.startsWith('error This computer is not paired with any App Builder')));
});

test('--uninstall-service keeps the pairing; logout (all) removes every credential and the settings file', async (t) => {
  const home = scratchHome(t);
  const settingsFile = path.join(home, '.babylon-toolkit', 'bridge.json');
  const host = fakeHost(home, 'darwin');
  writeSettings(
    { servers: [{ server: 'https://a.example', deviceId: 'da', token: 'ta' }, { server: 'http://localhost:5173', deviceId: 'dl', token: 'tl' }], projects: [home], unity: [], noScripts: false },
    settingsFile
  );
  await service.installService(host.deps);
  const { lines, logger } = capture();
  const deps = {
    env: {},
    settingsFile,
    logger,
    serviceDeps: host.deps,
    makeApi: (server, token) => ({ server, post: async (p, body) => (logouts.push([server, token, p, body]), { status: 200, body: {} }) }),
  };
  const logouts = [];
  assert.equal(await runBridgeCli(['--uninstall-service'], deps), 0);
  assert.equal(readSettings(settingsFile).servers.length, 2);
  assert.ok(lines.some((l) => l.includes('will not start at login')));

  assert.equal(await runBridgeCli(['logout', '--server', 'http://localhost:5173'], deps), 0);
  assert.deepEqual(readSettings(settingsFile).servers.map((c) => c.server), ['https://a.example']);
  assert.equal(await runBridgeCli(['logout'], deps), 0);
  assert.equal(fs.existsSync(settingsFile), false);
  assert.deepEqual(logouts, [
    ['http://localhost:5173', 'tl', '/api/bridge/result', { action: 'logout' }],
    ['https://a.example', 'ta', '/api/bridge/result', { action: 'logout' }],
  ]);
});
