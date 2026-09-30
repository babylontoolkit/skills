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
const { compareVersions } = require('./guard');
const { BRIDGE_TOOLKIT_MIN_VERSION } = require('../protocol');

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
 * from `Packages/<name>/package.json`. A git package (D56 installs the Babylon Toolkit packages from git
 * URLs) records the URL, not a version, in both files — its version is read from the copy UPM unpacked
 * under `Library/PackageCache/<name>@<hash>/package.json`.
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

  const isGit = (/** @type {unknown} */ v) => typeof v === 'string' && /(^git\+|^git@|\.git(#.*)?$)/.test(v);
  if (isGit(locked && locked.version) || isGit(manifest && manifest.dependencies && manifest.dependencies[name])) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, 'Library', 'PackageCache')).filter((e) => e.startsWith(`${name}@`)).sort();
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const cached = readJson(path.join(root, 'Library', 'PackageCache', e, 'package.json'));
      if (cached && typeof cached.version === 'string' && /^\d/.test(cached.version)) return cached.version;
    }
  }
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

/** Hello's project list is bounded; a folder with more Unity projects than this lists the first by name. */
const MAX_LISTED_PROJECTS = 100;
const REDISCOVER_EVERY_MS = 30_000;

/** @param {string} p @returns {string} */
function realOrResolved(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * The Unity projects DIRECTLY inside `folder` (one level, D54), sorted by name. Hidden folders are skipped.
 * @param {string} folder
 * @returns {DiscoveredProject[]}
 */
function listProjectsIn(folder) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  /** @type {DiscoveredProject[]} */
  const out = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    const dir = path.join(folder, name);
    if (!isUnityProject(dir)) continue;
    out.push(describeProject(dir));
    if (out.length >= MAX_LISTED_PROJECTS) break;
  }
  return out;
}

/**
 * Where the Unity projects live (D54): `--projects <folder>` when given; otherwise the current directory,
 * unless it is itself a Unity project — then its parent is the folder and it is the current project.
 * @param {{ projectsDir?: string, cwd: string }} opts
 * @returns {{ folder: string, currentRoot?: string }}
 */
function resolveProjectsFolder({ projectsDir, cwd }) {
  if (projectsDir) return { folder: realOrResolved(path.resolve(cwd, projectsDir)) };
  const here = realOrResolved(cwd);
  if (isUnityProject(here)) return { folder: path.dirname(here), currentRoot: here };
  return { folder: here };
}

/**
 * @param {{
 *   unityPaths?: string[],
 *   projectsDir?: string|string[],
 *   cwd?: string,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   exec?: Exec,
 * }} opts
 * `projectsDir` may name several folders (D55 — `--projects` is repeatable); the first is where
 * `unity_project create` makes new projects, and projects are listed across all of them.
 * @returns {{
 *   cli?: { path: string, version: string },
 *   projectsDir: string,
 *   projectsDirs: string[],
 *   missingDirs: string[],
 *   projectsDirMissing: boolean,
 *   projects: DiscoveredProject[],
 *   folderProjectCount: number,
 *   extraRoots: string[],
 *   currentRoot?: string,
 *   notProjects: string[],
 * }}
 */
function discoverUnity({
  unityPaths,
  projectsDir,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  exec = defaultExec,
} = {}) {
  const requested = (Array.isArray(projectsDir) ? projectsDir : projectsDir ? [projectsDir] : []).filter(Boolean);
  /** @type {string[]} */
  const folders = [];
  /** @type {string|undefined} */
  let currentRoot;
  if (requested.length) {
    for (const dir of requested) {
      const folder = resolveProjectsFolder({ projectsDir: dir, cwd }).folder;
      if (!folders.includes(folder)) folders.push(folder);
    }
  } else {
    const here = resolveProjectsFolder({ cwd });
    folders.push(here.folder);
    currentRoot = here.currentRoot;
  }

  /** @type {string[]} */
  const extraRoots = [];
  /** @type {string[]} */
  const notProjects = [];
  for (const p of Array.isArray(unityPaths) ? unityPaths : []) {
    const dir = path.resolve(cwd, p);
    if (!isUnityProject(dir)) {
      notProjects.push(dir);
      continue;
    }
    const real = realOrResolved(dir);
    if (!extraRoots.includes(real)) extraRoots.push(real);
  }
  // The first --unity project is current (D54); it wins over the folder the helper was started in.
  if (extraRoots.length) currentRoot = extraRoots[0];

  const listed = folders.flatMap((f) => listProjectsIn(f));
  const projects = mergeProjects(listed, extraRoots);
  const cli = findUnityCli({ env, platform, exec });
  const missingDirs = folders.filter((f) => !isDir(f));
  /** @type {ReturnType<typeof discoverUnity>} */
  const out = {
    projectsDir: folders[0],
    projectsDirs: folders,
    missingDirs,
    projectsDirMissing: missingDirs.length > 0,
    projects,
    // how many of `projects` are IN the projects folder; the rest came from --unity paths
    folderProjectCount: listed.length,
    extraRoots,
    notProjects,
  };
  if (currentRoot) out.currentRoot = currentRoot;
  if (cli) out.cli = cli;
  return out;
}

/**
 * @param {DiscoveredProject[]} listed
 * @param {string[]} extraRoots
 * @returns {DiscoveredProject[]}
 */
function mergeProjects(listed, extraRoots) {
  const projects = [...listed];
  for (const root of extraRoots) {
    if (!isUnityProject(root)) continue;
    const project = describeProject(root);
    if (!projects.some((p) => p.key === project.key)) projects.push(project);
  }
  return projects;
}

/**
 * The helper's in-memory view of the projects folder and the CURRENT project (D54). The current project
 * is set by `unity.project open|create` (or at start-up from the folder / the first --unity path); every
 * other Unity and Blender job runs against it. The workspace writes nothing itself; `onCurrentChange` lets the
 * caller persist the current project (bridge.json) so a restarted service keeps it.
 *
 * With several projects folders (D55) projects are listed across all of them; a name found in more
 * than one is ambiguous and must be given as `<folder>/<name>` (see `resolve`).
 *
 * @param {{
 *   projectsDir: string,
 *   projectsDirs?: string[],
 *   extraRoots?: string[],
 *   currentRoot?: string,
 *   projects?: DiscoveredProject[],
 *   onCurrentChange?: (root: string) => void,
 *   now?: () => number,
 *   everyMs?: number,
 *   platform?: string,
 * }} opts
 */
function createWorkspace({
  projectsDir,
  projectsDirs,
  extraRoots = [],
  currentRoot,
  projects,
  onCurrentChange,
  now = Date.now,
  everyMs = REDISCOVER_EVERY_MS,
  platform = process.platform,
}) {
  /** @type {string[]} */
  const folders = [];
  for (const f of projectsDirs && projectsDirs.length ? projectsDirs : [projectsDir]) {
    const real = realOrResolved(f);
    if (!folders.includes(real)) folders.push(real);
  }
  const folder = folders[0];
  /** @type {DiscoveredProject[]} */
  let cache = projects ? [...projects] : [];
  let at = projects ? now() : -Infinity;
  /** @type {string|undefined} */
  let current = currentRoot ? realOrResolved(currentRoot) : undefined;
  const caseless = platform === 'darwin' || platform === 'win32';

  const refresh = () => {
    cache = mergeProjects(folders.flatMap((f) => listProjectsIn(f)), extraRoots);
    at = now();
    return cache;
  };

  const list = () => (now() - at >= everyMs ? refresh() : cache);

  /** @param {string} s */
  const plain = (s) => typeof s === 'string' && s.length > 0 && !s.startsWith('.') && !s.includes('/') && !s.includes('\\') && !s.includes('..');

  /**
   * Candidates for a name among `known`: exact matches, else (macOS/Windows) case-insensitive ones.
   * @param {DiscoveredProject[]} known @param {string} name
   */
  const matching = (known, name) => {
    const exact = known.filter((p) => p.name === name);
    if (exact.length || !caseless) return exact;
    const lower = name.toLowerCase();
    return known.filter((p) => p.name.toLowerCase() === lower);
  };

  /**
   * The project a name means — one of the DISCOVERED projects only (directly inside a projects folder,
   * or a --unity path), never a path. `<folder>/<name>` picks the projects folder by its name when the
   * same project name exists in more than one.
   * @param {string} name
   * @returns {{ root: string } | { ambiguous: string[] } | null}
   */
  const resolve = (name) => {
    if (typeof name !== 'string' || !name) return null;
    const known = refresh();
    const slash = name.indexOf('/');
    if (slash > 0) {
      const folderName = name.slice(0, slash);
      const projectName = name.slice(slash + 1);
      if (!plain(folderName) || !plain(projectName)) return null;
      const sameFolder = (/** @type {string} */ f) =>
        path.basename(f) === folderName || (caseless && path.basename(f).toLowerCase() === folderName.toLowerCase());
      const inFolder = known.filter((p) => folders.some((f) => sameFolder(f) && path.dirname(p.root) === f));
      const found = matching(inFolder, projectName);
      return found.length ? { root: found[0].root } : null;
    }
    if (!plain(name)) return null;
    const found = matching(known, name);
    if (!found.length) return null;
    if (found.length === 1) return { root: found[0].root };
    return { ambiguous: [...new Set(found.map((p) => path.basename(path.dirname(p.root))))] };
  };

  return {
    /** the FIRST projects folder's absolute path — where new projects are created (never sent to the App Builder) */
    projectsDir: folder,
    /** every projects folder, absolute */
    projectsDirs: folders,
    /** the projects folders' names — the only part of them hello carries */
    projectsDirName: folders.map((f) => path.basename(f)).join(', '),
    refresh,
    /** the known projects, re-discovered at most every 30 s */
    projects: list,
    /** @returns {DiscoveredProject|undefined} */
    current() {
      if (!current) return undefined;
      const found = list().find((p) => p.root === current);
      if (found) return found;
      if (!isUnityProject(current)) return undefined;
      return describeProject(current);
    },
    /** @param {string} root */
    setCurrent(root) {
      const next = realOrResolved(root);
      const changed = next !== current;
      current = next;
      refresh();
      // persisted by the caller (bridge.json) so a restarted service keeps the current project
      if (changed && onCurrentChange) onCurrentChange(next);
    },
    resolve,
    /**
     * The project directory a name means (see `resolve`); undefined when unknown OR ambiguous.
     * @param {string} name
     * @returns {string|undefined}
     */
    rootFor(name) {
      const r = resolve(name);
      return r && 'root' in r ? r.root : undefined;
    },
  };
}

/** @typedef {ReturnType<typeof createWorkspace>} Workspace */

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

/** An answer that says the Editor has no such command (the Toolkit is missing, too old, or not compiled in). */
const UNKNOWN_COMMAND = /no command named|unknown command/i;

/**
 * How long an unknown-command answer is remembered (verifier, 2026-09-29): long enough that a project without
 * the Toolkit command is not asked on every hello, short enough that a project whose Toolkit was just added
 * (package_add — the Editor still compiling when first asked) recovers without restarting the helper.
 */
const UNKNOWN_COMMAND_MEMORY_MS = 5 * 60_000;

/**
 * Hello's `devServer` for a project (T24 step 7). Any error → `{ running: false }`.
 *
 * `bt_devserver_status` is a Babylon Toolkit command, and asking an Editor that does not have it prints
 * "No command named 'bt_devserver_status'" into the user's Unity console on every hello. So it is asked
 * only when the project's Toolkit is at least BRIDGE_TOOLKIT_MIN_VERSION (the version that has it); an
 * unknown-command answer is remembered in `memo` for that project + Toolkit version and not asked again
 * until the version changes or UNKNOWN_COMMAND_MEMORY_MS passes; and a project whose create scaffold is still running (`busy`) is never
 * asked. Every skipped case is `{ running: false }` with no Unity call.
 * @param {{
 *   cli?: { path: string },
 *   project: { root: string, toolkitVersion?: string },
 *   runProcess: import('./run').RunProcess,
 *   memo?: Map<string, number>,
 *   busy?: (root: string) => boolean,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<import('../protocol').BridgeDevServerInfo>}
 */
async function probeDevServer({ cli, project, runProcess, memo, busy, now = Date.now }) {
  if (!cli || !project) return { running: false };
  if (busy && busy(project.root)) return { running: false };
  const toolkit = project.toolkitVersion;
  if (!toolkit || compareVersions(toolkit, BRIDGE_TOOLKIT_MIN_VERSION) < 0) return { running: false };
  const key = `${project.root}\0${toolkit}`;
  if (memo && memo.has(key)) {
    if (now() - /** @type {number} */ (memo.get(key)) < UNKNOWN_COMMAND_MEMORY_MS) return { running: false };
    memo.delete(key);
  }
  try {
    const res = await runProcess(
      cli.path,
      ['command', 'bt_devserver_status', '--project-path', project.root, '--result-only'],
      { cwd: project.root, timeoutMs: 5_000 }
    );
    if (UNKNOWN_COMMAND.test(`${res.stdout || ''}\n${res.stderr || ''}`)) {
      if (memo) {
        // one entry per project: a newer Toolkit version replaces the old one
        for (const k of [...memo.keys()]) if (k.startsWith(`${project.root}\0`)) memo.delete(k);
        memo.set(key, now());
      }
      return { running: false };
    }
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
  createWorkspace,
  listProjectsIn,
  resolveProjectsFolder,
  MAX_LISTED_PROJECTS,
  REDISCOVER_EVERY_MS,
  describeProject,
  packageVersion,
  isUnityProject,
  findUnityCli,
  probeDevServer,
  UNKNOWN_COMMAND_MEMORY_MS,
  parseKeyValues,
};
