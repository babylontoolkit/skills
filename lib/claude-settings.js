'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Claude Code asks before reading a file outside the session's project. The local Agent Reference
 * lives in the home folder, so without an allow rule every session would stop at its first read.
 * This adds one read-only rule for that folder to Claude Code's settings — and removes only that
 * rule on uninstall.
 */

function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, exists: false };
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return { settings: {}, exists: true };
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings are not a JSON object');
  return { settings, exists: true };
}

function writeSettings(file, settings, exists) {
  let backup = null;
  if (exists) {
    backup = `${file}.bak`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return backup;
}

/** Add `rule` to `permissions.allow`. A settings file that is not valid JSON is left alone. */
function addAllowRule(file, rule, { dryRun = false } = {}) {
  let current;
  try {
    current = readSettings(file);
  } catch (error) {
    return { file, rule, action: 'skipped', note: `not valid JSON (${error.message}) — add ${rule} to permissions.allow yourself` };
  }
  const { settings, exists } = current;
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (allow.includes(rule)) return { file, rule, action: 'unchanged' };
  if (dryRun) return { file, rule, action: exists ? 'updated' : 'created' };
  settings.permissions = { ...permissions, allow: [...allow, rule] };
  const backup = writeSettings(file, settings, exists);
  return { file, rule, action: exists ? 'updated' : 'created', backup };
}

/** Remove `rule` from `permissions.allow`, and nothing else. */
function removeAllowRule(file, rule, { dryRun = false } = {}) {
  let current;
  try {
    current = readSettings(file);
  } catch {
    return { file, rule, action: 'skipped' };
  }
  const { settings, exists } = current;
  const allow = settings.permissions && Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  if (!exists || !allow.includes(rule)) return { file, rule, action: 'absent' };
  if (dryRun) return { file, rule, action: 'removed' };
  settings.permissions.allow = allow.filter((entry) => entry !== rule);
  const backup = writeSettings(file, settings, exists);
  return { file, rule, action: 'removed', backup };
}

function hasAllowRule(file, rule) {
  try {
    const allow = (readSettings(file).settings.permissions || {}).allow;
    return Array.isArray(allow) && allow.includes(rule);
  } catch {
    return false;
  }
}

module.exports = { addAllowRule, removeAllowRule, hasAllowRule };
