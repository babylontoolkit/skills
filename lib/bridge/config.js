'use strict';

const fs = require('fs');
const path = require('path');

const { stateDir } = require('../paths');

/**
 * The device credential (D42): `~/.babylon-toolkit/bridge.json`, mode 0600.
 * @typedef {{ server: string, deviceId: string, token: string }} BridgeConfig
 */

function bridgeConfigPath() {
  return path.join(stateDir('global'), 'bridge.json');
}

/**
 * The stored credential, or null when there is none, it is unreadable, or it belongs to another server
 * (a credential for one App Builder is "not paired" for every other one).
 * @param {string} [server]
 * @returns {BridgeConfig|null}
 */
function readBridgeConfig(server) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(bridgeConfigPath(), 'utf8'));
  } catch {
    return null;
  }
  if (
    !cfg ||
    typeof cfg.server !== 'string' ||
    typeof cfg.deviceId !== 'string' ||
    typeof cfg.token !== 'string'
  ) {
    return null;
  }
  if (server !== undefined && cfg.server !== server) return null;
  return { server: cfg.server, deviceId: cfg.deviceId, token: cfg.token };
}

/** @param {BridgeConfig} cfg */
function writeBridgeConfig(cfg) {
  const file = bridgeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing one too.
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

function deleteBridgeConfig() {
  fs.rmSync(bridgeConfigPath(), { force: true });
}

module.exports = { bridgeConfigPath, readBridgeConfig, writeBridgeConfig, deleteBridgeConfig };
