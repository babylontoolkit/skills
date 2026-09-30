'use strict';

const fs = require('fs');
const path = require('path');

const { stateDir } = require('../paths');

/**
 * The bridge settings (D42, D55): `~/.babylon-toolkit/bridge.json`, mode 0600.
 *
 * One file holds the credential for every App Builder this computer is paired with, plus the settings
 * the start-at-login service runs with (written by `--install-service`). A file in the old single-server
 * shape `{ server, deviceId, token }` is read as one entry in `servers`.
 *
 * @typedef {{ server: string, deviceId: string, token: string }} BridgeConfig one server's credential
 * @typedef {{
 *   servers: BridgeConfig[],
 *   projects: string[],
 *   unity: string[],
 *   blender?: string,
 *   noScripts: boolean,
 *   currentProject?: string,
 * }} BridgeSettings
 * `currentProject` — the absolute root of the Unity project opened or created last, so a restarted service
 * picks up where it left off instead of making the model reopen it (verifier, 2026-09-29).
 */

function bridgeConfigPath() {
  return path.join(stateDir('global'), 'bridge.json');
}

/** @returns {BridgeSettings} */
function emptySettings() {
  return { servers: [], projects: [], unity: [], noScripts: false };
}

/** @param {any} c @returns {c is BridgeConfig} */
function isCredential(c) {
  return Boolean(c) && typeof c.server === 'string' && typeof c.deviceId === 'string' && typeof c.token === 'string';
}

/** @param {unknown} v @returns {string[]} */
function strings(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.length > 0) : [];
}

/**
 * Normalises whatever is on disk into the current shape — including the old single-credential file.
 * @param {any} raw
 * @returns {BridgeSettings}
 */
function migrateSettings(raw) {
  const out = emptySettings();
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.servers)) {
    for (const c of raw.servers) {
      if (isCredential(c) && !out.servers.some((s) => s.server === c.server)) {
        out.servers.push({ server: c.server, deviceId: c.deviceId, token: c.token });
      }
    }
  } else if (isCredential(raw)) {
    out.servers.push({ server: raw.server, deviceId: raw.deviceId, token: raw.token });
  }
  out.projects = strings(raw.projects);
  out.unity = strings(raw.unity);
  if (typeof raw.blender === 'string' && raw.blender) out.blender = raw.blender;
  out.noScripts = raw.noScripts === true;
  if (typeof raw.currentProject === 'string' && raw.currentProject) out.currentProject = raw.currentProject;
  return out;
}

/**
 * The stored settings; an absent or unreadable file is empty settings (nothing paired).
 * @param {string} [file]
 * @returns {BridgeSettings}
 */
function readSettings(file = bridgeConfigPath()) {
  try {
    return migrateSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return emptySettings();
  }
}

/**
 * @param {BridgeSettings} settings
 * @param {string} [file]
 * @returns {string} the file written
 */
function writeSettings(settings, file = bridgeConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /** @type {Record<string, unknown>} */
  const out = {
    servers: settings.servers.map((c) => ({ server: c.server, deviceId: c.deviceId, token: c.token })),
    projects: settings.projects,
    unity: settings.unity,
    noScripts: settings.noScripts === true,
  };
  if (settings.blender) out.blender = settings.blender;
  if (settings.currentProject) out.currentProject = settings.currentProject;
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing one too.
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

/**
 * The stored credential for `server` — or, with no server, the first one. Null when not paired
 * (a credential for one App Builder is "not paired" for every other one).
 * @param {string} [server]
 * @param {string} [file]
 * @returns {BridgeConfig|null}
 */
function readBridgeConfig(server, file) {
  const { servers } = readSettings(file);
  const found = server === undefined ? servers[0] : servers.find((c) => c.server === server);
  return found ? { ...found } : null;
}

/**
 * Adds or replaces one server's credential, keeping every other setting.
 * @param {BridgeConfig} cfg
 * @param {string} [file]
 */
function writeBridgeConfig(cfg, file) {
  const settings = readSettings(file);
  settings.servers = settings.servers.filter((c) => c.server !== cfg.server);
  settings.servers.push({ server: cfg.server, deviceId: cfg.deviceId, token: cfg.token });
  return writeSettings(settings, file);
}

/**
 * Forgets one server's credential (or, with no server, the whole file).
 * @param {string} [server]
 * @param {string} [file]
 */
function deleteBridgeConfig(server, file = bridgeConfigPath()) {
  if (server === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!fs.existsSync(file)) return;
  const settings = readSettings(file);
  settings.servers = settings.servers.filter((c) => c.server !== server);
  writeSettings(settings, file);
}

/**
 * Remembers the current Unity project (the root), keeping every other setting. Never throws — losing this
 * only costs a reopen, and it must never fail the job that changed the project.
 * @param {string|undefined} root
 * @param {string} [file]
 */
function saveCurrentProject(root, file = bridgeConfigPath()) {
  try {
    const settings = readSettings(file);
    if ((settings.currentProject || undefined) === (root || undefined)) return;
    if (root) settings.currentProject = root;
    else delete settings.currentProject;
    writeSettings(settings, file);
  } catch {
    /* best effort */
  }
}

/**
 * The stored current project to restore on start: only when it still exists as a Unity project DIRECTLY inside
 * one of the configured projects folders (the only projects this helper serves, D54) — otherwise nothing.
 * @param {string|undefined} stored
 * @param {string[]} projectsDirs absolute
 * @param {{ isProject: (root: string) => boolean, real?: (p: string) => string }} io
 * @returns {string|undefined}
 */
function restorableCurrentProject(stored, projectsDirs, { isProject, real = (p) => p }) {
  if (typeof stored !== 'string' || !stored || !path.isAbsolute(stored)) return undefined;
  const root = real(stored);
  const parent = path.dirname(root);
  if (!projectsDirs.some((dir) => real(dir) === parent)) return undefined;
  return isProject(root) ? root : undefined;
}

module.exports = {
  saveCurrentProject,
  restorableCurrentProject,
  bridgeConfigPath,
  readSettings,
  writeSettings,
  migrateSettings,
  emptySettings,
  readBridgeConfig,
  writeBridgeConfig,
  deleteBridgeConfig,
};
