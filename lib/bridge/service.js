'use strict';

/**
 * The start-at-login service (D55). `bt-agent bridge --install-service` copies this zero-dependency
 * package to `~/.babylon-toolkit/service/` (so the service never points into an ephemeral npx cache) and
 * registers `node <service>/bin/bt-agent.js bridge --service` to start when the user logs in:
 *
 *   macOS    a launchd agent   ~/Library/LaunchAgents/com.babylontoolkit.bridge.plist
 *   Linux    a systemd user unit ~/.config/systemd/user/babylon-toolkit-bridge.service
 *   Windows  a Startup-folder script  %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\babylon-toolkit-bridge.vbs
 *
 * Opt-in only: install/update/postinstall never call this. Every side effect goes through injected
 * `fs`/`exec`/`spawn`/`kill`, so the tests never register a real service.
 */

const nodeFs = require('fs');
const path = require('path');
const { spawnSync, spawn: nodeSpawn } = require('child_process');

const { PACKAGE_ROOT } = require('../paths');

const LAUNCHD_LABEL = 'com.babylontoolkit.bridge';
const SYSTEMD_UNIT = 'babylon-toolkit-bridge.service';
const STARTUP_SCRIPT = 'babylon-toolkit-bridge.vbs';
/** What the service copy carries — the package minus the skills payload the bridge never reads. */
const PACKAGE_PARTS = ['package.json', 'bin', 'lib'];
const BOOTSTRAP_ATTEMPTS = 5;

/**
 * @typedef {{ code: number|null, stdout: string, stderr: string }} ExecResult
 * @typedef {(file: string, args: string[]) => ExecResult} ServiceExec
 * @typedef {(file: string, args: string[], opts: object) => { unref: () => void }} ServiceSpawn
 * @typedef {{
 *   platform: string,
 *   home: string,
 *   uid?: number,
 *   execPath: string,
 *   env: Record<string, string|undefined>,
 *   fs?: typeof nodeFs,
 *   exec?: ServiceExec,
 *   spawn?: ServiceSpawn,
 *   kill?: (pid: number, signal?: string|number) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   packageRoot?: string,
 * }} ServiceDeps
 */

/** @type {ServiceExec} */
function defaultExec(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return { code: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

/** @type {ServiceSpawn} */
function defaultSpawn(file, args, opts) {
  return nodeSpawn(file, args, opts);
}

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {{ home: string }} d */
function stateDirOf({ home }) {
  return path.join(home, '.babylon-toolkit');
}

/**
 * Every path the service uses, for one platform.
 * @param {{ platform: string, home: string, env: Record<string, string|undefined> }} d
 */
function servicePaths(d) {
  const state = stateDirOf(d);
  /** @type {string|undefined} */
  let registration;
  if (d.platform === 'darwin') registration = path.join(d.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  else if (d.platform === 'win32') {
    const appData = d.env.APPDATA || path.join(d.home, 'AppData', 'Roaming');
    registration = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', STARTUP_SCRIPT);
  } else if (d.platform === 'linux') {
    const config = d.env.XDG_CONFIG_HOME || path.join(d.home, '.config');
    registration = path.join(config, 'systemd', 'user', SYSTEMD_UNIT);
  }
  return {
    stateDir: state,
    serviceDir: path.join(state, 'service'),
    logFile: path.join(state, 'bridge.log'),
    pidFile: path.join(state, 'bridge.pid'),
    registration,
  };
}

/**
 * The service's command line: this Node, the COPIED package's entry point, `bridge --service`.
 * @param {{ execPath: string, serviceDir: string }} d
 */
function serviceArgv({ execPath, serviceDir }) {
  return [execPath, path.join(serviceDir, 'bin', 'bt-agent.js'), 'bridge', '--service'];
}

/** @param {string} s */
function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The launchd agent (macOS).
 * @param {{ argv: string[], path: string, home: string, logFile: string }} d
 */
function launchdPlist({ argv, path: pathEnv, home, logFile }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>30</integer>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xml(pathEnv)}</string>`,
    '    <key>HOME</key>',
    `    <string>${xml(home)}</string>`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * One systemd word: double-quoted, with `\` and `"` escaped, `%` (specifiers) and `$` (variables) doubled.
 * @param {string} s
 */
function systemdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/**
 * The systemd user unit (Linux).
 * @param {{ argv: string[], path: string, home: string }} d
 */
function systemdUnit({ argv, path: pathEnv, home }) {
  return [
    '[Unit]',
    'Description=Babylon Toolkit Unity Bridge',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${argv.map(systemdQuote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=30',
    `Environment=${systemdQuote(`PATH=${pathEnv}`)}`,
    `Environment=${systemdQuote(`HOME=${home}`)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * The Startup-folder script (Windows): runs the command line hidden (window style 0), not waiting.
 * @param {{ argv: string[] }} d
 */
function startupScript({ argv }) {
  const commandLine = argv.map((a) => `"${a}"`).join(' ');
  return [
    "' Babylon Toolkit Unity Bridge - starts the Desktop Agent helper when you log in.",
    "' Remove it with: bt-agent bridge --uninstall-service",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
}

/**
 * Copies the package to `to` atomically: into a temp dir beside it, then renamed into place (the old
 * copy is moved aside first and deleted last), so a failed copy never leaves a half-written service.
 * @param {{ fs: typeof nodeFs, from: string, to: string }} d
 */
function copyPackage({ fs, from, to }) {
  const tmp = `${to}.tmp-${process.pid}`;
  const old = `${to}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const part of PACKAGE_PARTS) {
      fs.cpSync(path.join(from, part), path.join(tmp, part), { recursive: true });
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
  const had = fs.existsSync(to);
  if (had) fs.renameSync(to, old);
  fs.renameSync(tmp, to);
  if (had) fs.rmSync(old, { recursive: true, force: true });
}

/** @param {ServiceDeps} d */
function resolved(d) {
  return {
    fs: d.fs || nodeFs,
    exec: d.exec || defaultExec,
    spawn: d.spawn || defaultSpawn,
    kill: d.kill || ((pid, sig) => process.kill(pid, sig)),
    sleep: d.sleep || defaultSleep,
    packageRoot: d.packageRoot || PACKAGE_ROOT,
    uid: typeof d.uid === 'number' ? d.uid : typeof process.getuid === 'function' ? process.getuid() : 0,
  };
}

/**
 * Stops the helper a Windows Startup script started (the pid it recorded). No-op elsewhere / when none.
 * @param {typeof nodeFs} fs @param {string} pidFile @param {(pid: number, signal?: string|number) => void} kill
 */
function stopRecordedPid(fs, pidFile, kill) {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      kill(pid);
    } catch {
      // already gone
    }
  }
  fs.rmSync(pidFile, { force: true });
}

/**
 * Copies the package, writes the registration and starts the service now. Re-running it updates the
 * copy and restarts the service (idempotent).
 * @param {ServiceDeps} deps
 * @returns {Promise<{ registration: string, serviceDir: string, logFile: string, argv: string[] }>}
 */
async function installService(deps) {
  const { fs, exec, spawn, kill, sleep, packageRoot, uid } = resolved(deps);
  const paths = servicePaths(deps);
  if (!paths.registration) throw new Error(`Starting the Unity Bridge at login is not supported on ${deps.platform}.`);
  const registration = paths.registration;

  fs.mkdirSync(paths.stateDir, { recursive: true });
  copyPackage({ fs, from: packageRoot, to: paths.serviceDir });
  const argv = serviceArgv({ execPath: deps.execPath, serviceDir: paths.serviceDir });
  const pathEnv = deps.env.PATH || '';
  fs.mkdirSync(path.dirname(registration), { recursive: true });

  if (deps.platform === 'darwin') {
    fs.writeFileSync(registration, launchdPlist({ argv, path: pathEnv, home: deps.home, logFile: paths.logFile }), { mode: 0o644 });
    exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]); // not loaded yet is fine
    // `bootout` returns before launchd has finished tearing the old instance down; bootstrap can
    // briefly fail with an I/O error, so it is retried.
    let last = { code: 0, stdout: '', stderr: '' };
    for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
      last = exec('launchctl', ['bootstrap', `gui/${uid}`, registration]);
      if (last.code === 0) break;
      if (attempt < BOOTSTRAP_ATTEMPTS) await sleep(1000);
    }
    if (last.code !== 0) {
      throw new Error(`launchctl bootstrap failed (exit ${last.code}): ${(last.stderr || last.stdout).trim()}`);
    }
  } else if (deps.platform === 'linux') {
    const existed = fs.existsSync(registration);
    fs.writeFileSync(registration, systemdUnit({ argv, path: pathEnv, home: deps.home }), { mode: 0o644 });
    for (const args of [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', SYSTEMD_UNIT],
      ...(existed ? [['--user', 'restart', SYSTEMD_UNIT]] : []),
    ]) {
      const r = exec('systemctl', args);
      if (r.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
    }
  } else {
    stopRecordedPid(fs, paths.pidFile, kill);
    fs.writeFileSync(registration, startupScript({ argv }));
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, cwd: deps.home });
    child.unref();
  }

  return { registration, serviceDir: paths.serviceDir, logFile: paths.logFile, argv };
}

/**
 * Stops and unregisters the service and deletes its copy of the package. The credential is kept
 * (`bt-agent bridge logout` removes it).
 * @param {ServiceDeps} deps
 * @returns {{ removed: string[] }}
 */
function uninstallService(deps) {
  const { fs, exec, kill, uid } = resolved(deps);
  const paths = servicePaths(deps);
  /** @type {string[]} */
  const removed = [];
  const reg = paths.registration;

  if (deps.platform === 'darwin') {
    exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
  } else if (deps.platform === 'linux') {
    if (reg && fs.existsSync(reg)) exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  } else if (deps.platform === 'win32') {
    stopRecordedPid(fs, paths.pidFile, kill);
  }
  if (reg && fs.existsSync(reg)) {
    fs.rmSync(reg, { force: true });
    removed.push(reg);
  }
  if (deps.platform === 'linux' && removed.length) exec('systemctl', ['--user', 'daemon-reload']);
  if (fs.existsSync(paths.serviceDir)) {
    fs.rmSync(paths.serviceDir, { recursive: true, force: true });
    removed.push(paths.serviceDir);
  }
  fs.rmSync(paths.pidFile, { force: true });
  return { removed };
}

/**
 * Is the service installed, and (where it is cheap to ask) running?
 * @param {ServiceDeps} deps
 * @returns {{ installed: boolean, running: boolean|null, registration?: string }}
 */
function serviceStatus(deps) {
  const { fs, exec, kill, uid } = resolved(deps);
  const paths = servicePaths(deps);
  const reg = paths.registration;
  const installed = Boolean(reg && fs.existsSync(reg));
  if (!installed) return { installed, running: null, registration: reg };
  /** @type {boolean|null} */
  let running = null;
  try {
    if (deps.platform === 'darwin') {
      const r = exec('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
      running = r.code === 0 && /\bstate\s*=\s*running\b/.test(r.stdout);
    } else if (deps.platform === 'linux') {
      const r = exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
      running = r.stdout.trim() === 'active';
    } else {
      const pid = parseInt(fs.readFileSync(paths.pidFile, 'utf8'), 10);
      kill(pid, 0);
      running = true;
    }
  } catch {
    running = deps.platform === 'win32' ? false : null;
  }
  return { installed, running, registration: reg };
}

/** The deps for this process. @returns {ServiceDeps} */
function hostDeps() {
  const os = require('os');
  return { platform: process.platform, home: os.homedir(), execPath: process.execPath, env: process.env };
}

module.exports = {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  STARTUP_SCRIPT,
  PACKAGE_PARTS,
  servicePaths,
  serviceArgv,
  launchdPlist,
  systemdUnit,
  startupScript,
  copyPackage,
  installService,
  uninstallService,
  serviceStatus,
  hostDeps,
};
