'use strict';

const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function homeDir() {
  return os.homedir();
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p) {
  if (!p) return null;
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir(), p.slice(2));
  return p;
}

/**
 * Resolve a target-matrix path.
 * Global paths are `~`-prefixed; project paths are relative to the project root.
 */
function resolveTargetPath(p, mode, projectRoot) {
  if (!p) return null;
  return mode === 'project' ? path.resolve(projectRoot, p) : path.resolve(expandHome(p));
}

/** Directory inside this package holding the shipped skill folders. */
function payloadDir() {
  return path.join(PACKAGE_ROOT, 'skills');
}

/** Canonical Agent Persona source file shipped with this package. */
function personaFile() {
  return path.join(PACKAGE_ROOT, 'persona.md');
}

function stateDir(mode, projectRoot) {
  return mode === 'project'
    ? path.join(projectRoot, '.babylon-toolkit')
    : path.join(homeDir(), '.babylon-toolkit');
}

function manifestPath(mode, projectRoot) {
  return path.join(stateDir(mode, projectRoot), 'install-manifest.json');
}

/** Shorten an absolute path back to `~/...` for readable output. */
function prettyPath(p) {
  if (!p) return '';
  const home = homeDir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

module.exports = {
  PACKAGE_ROOT,
  homeDir,
  expandHome,
  resolveTargetPath,
  payloadDir,
  personaFile,
  stateDir,
  manifestPath,
  prettyPath,
};
