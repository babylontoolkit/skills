'use strict';

/**
 * Finds the Unity CLI and the Unity projects this computer serves (T24 step 3, D51).
 *
 * Everything here is read-only: it reads a handful of text files and runs `unity --version`.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLKIT_PACKAGE = 'com.babylontoolkit.editor';
const PIPELINE_PACKAGE = 'com.unity.pipeline';

/**
 * @typedef {{ key: string, name: string, root: string, productGuid?: string, unityVersion?: string, toolkitVersion?: string, pipelineVersion?: string }} DiscoveredProject
 * @typedef {(file: string, args: string[]) => string|undefined} Exec  stdout, or undefined on any failure
 */

/** @type {Exec} */
function defaultExec(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 15_000,
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

/** @param {string} p */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p @returns {string|undefined} */
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** @param {string} p @returns {any} */
function readJson(p) {
  const text = readText(p);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {{ env: Record<string, string|undefined>, platform: string, exec: Exec }} opts
 * @returns {{ path: string, version: string } | undefined}
 */
function findUnityCli({ env, platform, exec }) {
  /** @type {string|undefined} */
  let cliPath;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const candidate = local ? path.win32.join(local, 'unity', 'bin', 'unity.exe') : undefined;
    if (candidate && isFile(candidate)) cliPath = candidate;
  } else {
    const home = env.HOME || os.homedir();
    const candidate = path.join(home, '.unity', 'bin', 'unity');
    if (isFile(candidate)) cliPath = candidate;
  }
  if (!cliPath) {
    const found = exec(platform === 'win32' ? 'where' : 'which', ['unity']);
    const first = found && found.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) cliPath = first;
  }
  if (!cliPath) return undefined;
  const version = (exec(cliPath, ['--version']) || '').trim().split(/\r?\n/)[0].trim();
  return { path: cliPath, version: version || 'unknown' };
}

/**
 * A package's version from the lock file, then the manifest; a `file:` (local/embedded) reference is
 * read from that package's own package.json, and an embedded package with no entry at all is read
 * from `Packages/<name>/package.json`.
 * @param {string} root
 * @param {string} name
 * @returns {string|undefined}
 */
function packageVersion(root, name) {
  const packagesDir = path.join(root, 'Packages');
  /** @param {unknown} value @returns {string|undefined} */
  const fromValue = (value) => {
    if (typeof value !== 'string') return undefined;
    if (/^\d/.test(value)) return value;
    if (value.startsWith('file:')) {
      const pkg = readJson(path.join(path.resolve(packagesDir, value.slice(5)), 'package.json'));
      if (pkg && typeof pkg.version === 'string' && /^\d/.test(pkg.version)) return pkg.version;
    }
    return undefined;
  };

  const lock = readJson(path.join(packagesDir, 'packages-lock.json'));
  const locked = lock && lock.dependencies && lock.dependencies[name];
  const fromLock = fromValue(locked && locked.version);
  if (fromLock) return fromLock;

  const manifest = readJson(path.join(packagesDir, 'manifest.json'));
  const fromManifest = fromValue(manifest && manifest.dependencies && manifest.dependencies[name]);
  if (fromManifest) return fromManifest;

  const embedded = readJson(path.join(packagesDir, name, 'package.json'));
  if (embedded && typeof embedded.version === 'string' && /^\d/.test(embedded.version)) return embedded.version;
  return undefined;
}

/**
 * @param {string} root an existing Unity project directory
 * @returns {DiscoveredProject}
 */
function describeProject(root) {
  const real = fs.realpathSync(root);
  /** @type {DiscoveredProject} */
  const project = {
    key: crypto.createHash('sha256').update(real).digest('hex').slice(0, 12),
    name: path.basename(real),
    root: real,
  };

  const versionText = readText(path.join(real, 'ProjectSettings', 'ProjectVersion.txt')) || '';
  const editor = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(versionText);
  if (editor) project.unityVersion = editor[1];

  const settings = readText(path.join(real, 'ProjectSettings', 'ProjectSettings.asset')) || '';
  const guid = /^\s*productGUID:\s*([0-9a-fA-F]{32})\s*$/m.exec(settings);
  if (guid) project.productGuid = guid[1].toLowerCase();

  const toolkit = packageVersion(real, TOOLKIT_PACKAGE);
  if (toolkit) project.toolkitVersion = toolkit;
  const pipeline = packageVersion(real, PIPELINE_PACKAGE);
  if (pipeline) project.pipelineVersion = pipeline;

  return project;
}

/** @param {string} dir */
function isUnityProject(dir) {
  return isDir(path.join(dir, 'Assets')) && isFile(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'));
}

/**
 * @param {{
 *   unityPaths?: string[],
 *   cwd?: string,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   exec?: Exec,
 * }} opts
 * @returns {{ cli?: { path: string, version: string }, projects: DiscoveredProject[], notProjects: string[] }}
 */
function discoverUnity({ unityPaths, cwd = process.cwd(), env = process.env, platform = process.platform, exec = defaultExec } = {}) {
  const explicit = Array.isArray(unityPaths) && unityPaths.length > 0;
  const candidates = explicit ? unityPaths.map((p) => path.resolve(cwd, p)) : [cwd];

  /** @type {DiscoveredProject[]} */
  const projects = [];
  /** @type {string[]} */
  const notProjects = [];
  for (const dir of candidates) {
    if (!isUnityProject(dir)) {
      if (explicit) notProjects.push(dir);
      continue;
    }
    const project = describeProject(dir);
    if (!projects.some((p) => p.key === project.key)) projects.push(project);
  }

  const cli = findUnityCli({ env, platform, exec });
  /** @type {{ cli?: { path: string, version: string }, projects: DiscoveredProject[], notProjects: string[] }} */
  const out = { projects, notProjects };
  if (cli) out.cli = cli;
  return out;
}

/**
 * `bt_devserver_status` prints `key : value` lines (with `--result-only`, as one JSON string).
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
function parseKeyValues(stdout) {
  let text = String(stdout || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') text = parsed;
    else if (parsed && typeof parsed === 'object') {
      const r = parsed.data && parsed.data.result !== undefined ? parsed.data.result : parsed.result;
      if (typeof r === 'string') text = r;
    }
  } catch {
    // plain text already
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * The exported `.gltf`/`.glb` scene names (at most 20) of a dev server root.
 * @param {string[]} roots candidate `<root>` directories, first readable wins
 * @returns {string[]}
 */
function listScenes(roots) {
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, 'scenes'));
    } catch {
      continue;
    }
    return names.filter((n) => /\.(gltf|glb)$/i.test(n)).sort().slice(0, 20);
  }
  return [];
}

/**
 * Hello's `devServer` for a project (T24 step 7). Any error → `{ running: false }`.
 * @param {{ cli?: { path: string }, project: { root: string }, runProcess: import('./run').RunProcess }} opts
 * @returns {Promise<import('../protocol').BridgeDevServerInfo>}
 */
async function probeDevServer({ cli, project, runProcess }) {
  if (!cli || !project) return { running: false };
  try {
    const res = await runProcess(
      cli.path,
      ['command', 'bt_devserver_status', '--project-path', project.root, '--result-only'],
      { cwd: project.root, timeoutMs: 5_000 }
    );
    if (res.timedOut || res.code !== 0) return { running: false };
    const kv = parseKeyValues(res.stdout);
    const started = /^(true|yes|1)$/i.test(kv.started || '');
    const port = parseInt(kv.port || '', 10);
    if (!started || !Number.isInteger(port) || port <= 0) return { running: false };
    /** @type {import('../protocol').BridgeDevServerInfo} */
    const info = { running: true, origin: `http://localhost:${port}` };
    if (kv.project) info.project = kv.project;
    if (kv.listen === 'loopback' || kv.listen === 'all') info.listen = kv.listen;
    const roots = [kv.root, path.join(project.root, 'Export'), path.join(project.root, 'export')].filter(Boolean);
    info.scenes = listScenes(/** @type {string[]} */ (roots));
    return info;
  } catch {
    return { running: false };
  }
}

module.exports = {
  discoverUnity,
  describeProject,
  packageVersion,
  isUnityProject,
  findUnityCli,
  probeDevServer,
  parseKeyValues,
};
