'use strict';

const fs = require('fs');
const path = require('path');

const { manifestPath } = require('./paths');

/**
 * Record of what this tool wrote, so update and uninstall can touch only its own
 * files. Without it the only way to clean up is a blanket `rm -rf bt-*`, which
 * also deletes skills the user authored themselves.
 */
function read(mode, projectRoot) {
  const file = manifestPath(mode, projectRoot);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function write(mode, projectRoot, data) {
  const file = manifestPath(mode, projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

function remove(mode, projectRoot) {
  const file = manifestPath(mode, projectRoot);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Skill folder names previously installed into `dir`, per the manifest. */
function trackedSkills(manifest, dir) {
  if (!manifest || !manifest.skillDirs) return [];
  const entry = manifest.skillDirs.find((d) => d.dir === dir);
  return entry ? entry.skills.slice() : [];
}

module.exports = { read, write, remove, trackedSkills };
