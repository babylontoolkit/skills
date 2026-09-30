'use strict';

/** Finds Blender on this computer (T25 step 1, D40). Read-only: it runs `blender --version` only. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** @typedef {(file: string, args: string[]) => string|undefined} Exec */

/** @type {Exec} */
function defaultExec(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} name e.g. "Blender 4.2" @returns {number[]} */
function versionOf(name) {
  const m = /(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1].split('.').map((n) => parseInt(n, 10) || 0) : [0];
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The highest-version `<Program Files>\Blender Foundation\Blender *\blender.exe`.
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
function windowsInstall(env) {
  const base = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
  let dirs;
  try {
    dirs = fs.readdirSync(base).filter((d) => /^Blender\b/i.test(d));
  } catch {
    return undefined;
  }
  dirs.sort((a, b) => compare(versionOf(b), versionOf(a)));
  for (const d of dirs) {
    const exe = path.win32.join(base, d, 'blender.exe');
    if (isFile(exe)) return exe;
  }
  return undefined;
}

/**
 * @param {{ explicit?: string, platform?: string, env?: Record<string, string|undefined>, exec?: Exec }} [opts]
 * @returns {{ path: string, version: string } | undefined}
 */
function discoverBlender({ explicit, platform = process.platform, env = process.env, exec = defaultExec } = {}) {
  /** @type {string[]} */
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  if (platform === 'darwin') candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  if (platform === 'win32') {
    const found = windowsInstall(env);
    if (found) candidates.push(found);
  }
  const which = exec(platform === 'win32' ? 'where' : 'which', ['blender']);
  const onPath = which && which.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (onPath) candidates.push(onPath);

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const out = exec(candidate, ['--version']);
    const line = out && out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    // The first --version line is "Blender 5.1.2"; report the number, or the UI and the model note read "Blender Blender 5.1.2".
    const version = line && (line.replace(/^Blender\s+/i, '') || line);
    if (version) return { path: candidate, version };
  }
  return undefined;
}

module.exports = { discoverBlender };
