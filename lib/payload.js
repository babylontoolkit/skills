'use strict';

const fs = require('fs');
const path = require('path');

const { payloadDir } = require('./paths');

const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Enumerate the skills this package actually ships.
 *
 * Everything downstream — install, stale cleanup, and verification — derives from
 * this. Nothing hardcodes a skill list, so a newly added skill is installed and
 * verified without touching any code.
 */
function listSkills() {
  const root = payloadDir();
  if (!fs.existsSync(root)) throw new Error(`Skills payload missing from package: ${root}`);

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED.has(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      src: path.join(root, name),
      files: walk(path.join(root, name)),
    }))
    .filter((s) => s.files.includes('SKILL.md'));
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

module.exports = { listSkills, copyDir };
