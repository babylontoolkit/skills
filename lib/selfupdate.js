'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { PACKAGE_ROOT } = require('./paths');
const pkg = require('../package.json');

const PACKAGE_NAME = pkg.name;
const CURRENT_VERSION = pkg.version;

/** Set on the re-executed child so the upgraded CLI does not try to upgrade again. */
const GUARD_ENV = 'BT_AGENT_SELF_UPDATED';

const IS_WINDOWS = process.platform === 'win32';

function segments(p) {
  return p.split(/[\\/]+/);
}

/**
 * Where is this copy of the CLI running from?
 *
 * `update` may only shell out to a package manager when the answer is a global
 * install. An npx run already fetched the newest version, a git checkout is the
 * developer's own working tree, and a project dependency belongs to that project's
 * lockfile — upgrading any of those globally would write files nobody asked for.
 */
function detectInstall() {
  const parts = segments(PACKAGE_ROOT);
  const lower = parts.map((s) => s.toLowerCase());

  if (fs.existsSync(path.join(PACKAGE_ROOT, '.git'))) {
    return { kind: 'dev', manager: null, root: PACKAGE_ROOT };
  }
  if (lower.some((s) => s === '_npx' || s === '.npx')) {
    return { kind: 'npx', manager: null, root: PACKAGE_ROOT };
  }

  const manager = lower.includes('pnpm') || lower.includes('.pnpm')
    ? 'pnpm'
    : lower.includes('.yarn') || lower.includes('yarn')
      ? 'yarn'
      : lower.includes('.bun')
        ? 'bun'
        : 'npm';

  return { kind: isGlobal() ? 'global' : 'local', manager, root: PACKAGE_ROOT };
}

/** True when PACKAGE_ROOT lives under this machine's global module directory. */
function isGlobal() {
  const roots = [];
  try {
    roots.push(String(execFileSync(npmBin(), ['root', '-g'], { encoding: 'utf8', timeout: 20000 })).trim());
  } catch {
    /* npm unavailable or slow — fall back to path shape below */
  }

  const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const here = norm(PACKAGE_ROOT);
  if (roots.some((r) => r && here.startsWith(norm(r) + path.sep.toLowerCase()))) return true;

  // pnpm/yarn/bun global stores never match `npm root -g`; recognise their shapes,
  // and treat anything outside the current project tree as global rather than local.
  const parts = segments(PACKAGE_ROOT).map((s) => s.toLowerCase());
  if (parts.includes('.pnpm') || parts.includes('.yarn') || parts.includes('.bun')) return true;
  return !here.startsWith(norm(process.cwd()) + path.sep.toLowerCase());
}

function npmBin() {
  return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

function managerBin(manager) {
  const name = manager === 'npm' ? 'npm' : manager;
  return IS_WINDOWS && name !== 'bun' ? `${name}.cmd` : name;
}

/** The exact command a user can copy/paste if the automatic upgrade fails. */
function upgradeCommand(manager, version) {
  const spec = `${PACKAGE_NAME}@${version || 'latest'}`;
  switch (manager) {
    case 'pnpm': return `pnpm add -g ${spec}`;
    case 'yarn': return `yarn global add ${spec}`;
    case 'bun': return `bun add -g ${spec}`;
    default: return `npm install -g ${spec}`;
  }
}

function upgradeArgs(manager, version) {
  const spec = `${PACKAGE_NAME}@${version || 'latest'}`;
  switch (manager) {
    case 'pnpm': return ['add', '-g', spec];
    case 'yarn': return ['global', 'add', spec];
    case 'bun': return ['add', '-g', spec];
    default: return ['install', '-g', spec];
  }
}

/** Compare two semver-ish versions. Pre-release tags sort before their release. */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) < (y.nums[i] || 0) ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Latest published version, from npm first so the user's registry, proxy and auth
 * settings are honoured, then from registry.npmjs.org if the npm CLI is missing.
 */
function fetchLatestVersion({ timeout = 20000 } = {}) {
  try {
    const out = execFileSync(npmBin(), ['view', PACKAGE_NAME, 'version'], {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const v = String(out).trim().split(/\s+/).pop();
    if (v) return { version: v };
  } catch (err) {
    const reason = (err && (err.stderr || err.message) ? String(err.stderr || err.message) : '').trim();
    const fallback = fetchLatestFromRegistrySync(timeout);
    if (fallback) return { version: fallback };
    return { error: reason.split('\n').filter(Boolean).pop() || 'could not reach the npm registry' };
  }
  return { error: 'npm returned no version' };
}

/** Registry lookup without the npm CLI. Runs in a helper process so it can be sync. */
function fetchLatestFromRegistrySync(timeout) {
  const script = `
    const https = require('https');
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(${JSON.stringify(PACKAGE_NAME)}).replace('%40','@') + '/latest';
    const req = https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { process.stdout.write(String(JSON.parse(body).version || '')); } catch { process.stdout.write(''); }
      });
    });
    req.setTimeout(${Math.max(1000, timeout)}, () => req.destroy());
    req.on('error', () => process.stdout.write(''));
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: timeout + 2000 });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Bring the installed package itself up to date.
 *
 * `update` used to be a pure alias for `install`: it re-copied the payload already
 * on disk, so it could never deliver a newer release and `npm install -g` was the
 * only way to actually update. This fetches the published version first, upgrades
 * the global package when there is a newer one, and reports what happened.
 *
 * Returns a status object; it never throws.
 */
function selfUpdate({ dryRun = false, timeout = 20000, log = () => {} } = {}) {
  const install = detectInstall();
  const base = { current: CURRENT_VERSION, install: install.kind, manager: install.manager };

  if (process.env[GUARD_ENV]) {
    return { ...base, status: 'skipped', reason: 'already upgraded in this run' };
  }
  if (install.kind !== 'global') {
    const why = {
      npx: 'running via npx — npx already fetched the latest version',
      dev: 'running from a git checkout — nothing to upgrade',
      local: 'installed as a project dependency — upgrade it through that project',
    }[install.kind];
    return { ...base, status: 'skipped', reason: why };
  }

  log(`Checking npm for a newer ${PACKAGE_NAME} (installed: ${CURRENT_VERSION})...`);
  const { version: latest, error } = fetchLatestVersion({ timeout });
  if (!latest) return { ...base, status: 'check-failed', reason: error };

  if (compareVersions(latest, CURRENT_VERSION) <= 0) {
    return { ...base, latest, status: 'current' };
  }

  const command = upgradeCommand(install.manager, latest);
  if (dryRun) return { ...base, latest, status: 'would-upgrade', command };

  log(`Upgrading ${CURRENT_VERSION} -> ${latest} (${command})`);
  try {
    execFileSync(managerBin(install.manager), upgradeArgs(install.manager, latest), {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 10 * 60 * 1000,
    });
  } catch (err) {
    const reason = err && err.message ? String(err.message).split('\n')[0] : 'upgrade command failed';
    return { ...base, latest, status: 'upgrade-failed', command, reason };
  }

  return { ...base, latest, status: 'upgraded', command };
}

/**
 * Hand control to the freshly installed CLI so the skills that get copied are the
 * new ones. The running process still has the previous release's modules in memory.
 */
function reexec(argv, version) {
  const { spawnSync } = require('child_process');
  const script = process.argv[1];
  if (!script || !fs.existsSync(script)) return null;

  const result = spawnSync(process.execPath, [script, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, [GUARD_ENV]: version || '1' },
  });
  if (result.error) return null;
  return typeof result.status === 'number' ? result.status : 1;
}

module.exports = {
  PACKAGE_NAME,
  CURRENT_VERSION,
  GUARD_ENV,
  detectInstall,
  compareVersions,
  fetchLatestVersion,
  upgradeCommand,
  selfUpdate,
  reexec,
};
