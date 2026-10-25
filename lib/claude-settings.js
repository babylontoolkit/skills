'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Claude Code asks before reading a file outside the session's project. The local Agent Reference
 * lives in the home folder, so without an allow rule every session would stop at its first read.
 * This adds one read-only rule for that folder to Claude Code's settings — and removes only that
 * rule on uninstall.
 *
 * It also adds the no-sleep `PreToolUse` hook on `Bash` (`scripts/hooks/block-sleep.js`) the same way:
 * once, in an entry of its own, and on uninstall only that hook is removed.
 */

/** The no-sleep hook script shipped in this package. */
const BLOCK_SLEEP_SOURCE = path.join(__dirname, '..', 'scripts', 'hooks', 'block-sleep.js');

/** Claude Code hook event that runs before every tool call. */
const PRE_TOOL_USE = 'PreToolUse';

/** Tool the no-sleep hook watches. */
const BASH_MATCHER = 'Bash';

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

/**
 * Where the no-sleep hook lives once installed, and the settings command that runs it. The script is
 * copied to `<claude home>/toolkit/hooks/` — a stable folder beside (never inside) the Agent Reference,
 * which is replaced wholesale on update, and never the npm / npx package folder, which can vanish.
 * @param {string} claudeHome - Claude Code's folder, e.g. `~/.claude`.
 * @returns {{ source: string, script: string, command: string }} The shipped script, its installed
 *   copy, and `node "<installed copy>"` with forward slashes on every platform.
 */
function blockSleepHook(claudeHome) {
  const script = path.join(claudeHome, 'toolkit', 'hooks', path.basename(BLOCK_SLEEP_SOURCE));
  const command = `node "${script.split(path.sep).join('/')}"`;
  return { source: BLOCK_SLEEP_SOURCE, script, command };
}

/**
 * The `hooks` object and the event's entry list, when both have the shape Claude Code expects.
 * @param {object} settings - Parsed settings.
 * @param {string} event - Hook event name, e.g. `PreToolUse`.
 * @returns {{ hooks: object, entries: object[] }|null} Missing containers come back empty; null when a
 *   container holds something else, so the user's settings are never overwritten.
 */
function hookEntries(settings, event) {
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  const entries = hooks[event] === undefined ? [] : hooks[event];
  if (!Array.isArray(entries)) return null;
  return { hooks, entries };
}

/**
 * Whether one matcher entry runs `command`.
 * @param {object} entry - One `{ matcher, hooks: [...] }` entry.
 * @param {string} command - The hook command to look for.
 * @returns {boolean} True when one of its command hooks is exactly `command`.
 */
function entryRuns(entry, command) {
  return Boolean(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook && hook.type === 'command' && hook.command === command);
}

/**
 * Whether an entry list already runs `command` for `matcher`.
 * @param {object[]} entries - The event's matcher entries.
 * @param {string} matcher - Tool matcher, e.g. `Bash`.
 * @param {string} command - The hook command.
 * @returns {boolean} True when an entry for that matcher runs the command.
 */
function entriesRun(entries, matcher, command) {
  return entries.some((entry) => entry && entry.matcher === matcher && entryRuns(entry, command));
}

/**
 * Add a command hook in an entry of its own (a user's existing entries are never merged into).
 * A settings file that is not valid JSON, or whose `hooks` has another shape, is left alone.
 * @param {string} file - Claude Code `settings.json`.
 * @param {string} command - The hook command, e.g. `node "/abs/block-sleep.js"`.
 * @param {{ event?: string, matcher?: string, dryRun?: boolean }} [options] - Event (default
 *   `PreToolUse`), tool matcher (default `Bash`), and dry run (report only).
 * @returns {{ file: string, command: string, action: string, backup?: string|null, note?: string }}
 *   `action` is `created`, `updated`, `unchanged` or `skipped`. Side effect: writes the file and a `.bak`.
 */
function addHook(file, command, { event = PRE_TOOL_USE, matcher = BASH_MATCHER, dryRun = false } = {}) {
  let current;
  try {
    current = readSettings(file);
  } catch (error) {
    return { file, command, action: 'skipped', note: `not valid JSON (${error.message}) — add the ${event} ${matcher} hook ${command} yourself` };
  }
  const { settings, exists } = current;
  const found = hookEntries(settings, event);
  if (!found) return { file, command, action: 'skipped', note: `hooks.${event} is not in Claude Code's shape — add the ${matcher} hook ${command} yourself` };
  if (entriesRun(found.entries, matcher, command)) return { file, command, action: 'unchanged' };
  const action = exists ? 'updated' : 'created';
  if (dryRun) return { file, command, action };
  const entry = { matcher, hooks: [{ type: 'command', command }] };
  settings.hooks = { ...found.hooks, [event]: [...found.entries, entry] };
  const backup = writeSettings(file, settings, exists);
  return { file, command, action, backup };
}

/**
 * Remove the command hook, and nothing else: other hooks in its entry stay, and only the entry,
 * event list and `hooks` object that this removal emptied are tidied away.
 * @param {string} file - Claude Code `settings.json`.
 * @param {string} command - The hook command to remove.
 * @param {{ event?: string, dryRun?: boolean }} [options] - Event (default `PreToolUse`) and dry run.
 * @returns {{ file: string, command: string, action: string, backup?: string|null }} `action` is
 *   `removed`, `absent` or `skipped`. Side effect: writes the file and a `.bak`.
 */
function removeHook(file, command, { event = PRE_TOOL_USE, dryRun = false } = {}) {
  let current;
  try {
    current = readSettings(file);
  } catch {
    return { file, command, action: 'skipped' };
  }
  const { settings, exists } = current;
  const found = hookEntries(settings, event);
  if (!exists || !found || !found.entries.some((entry) => entryRuns(entry, command))) return { file, command, action: 'absent' };
  if (dryRun) return { file, command, action: 'removed' };

  const entries = [];
  for (const entry of found.entries) {
    if (!entryRuns(entry, command)) {
      entries.push(entry);
      continue;
    }
    const remaining = entry.hooks.filter((hook) => !(hook && hook.type === 'command' && hook.command === command));
    if (remaining.length > 0) entries.push({ ...entry, hooks: remaining });
  }
  if (entries.length > 0) settings.hooks[event] = entries;
  else delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  const backup = writeSettings(file, settings, exists);
  return { file, command, action: 'removed', backup };
}

/**
 * Whether the settings run `command` as a hook.
 * @param {string} file - Claude Code `settings.json`.
 * @param {string} command - The hook command.
 * @param {{ event?: string, matcher?: string }} [options] - Event (default `PreToolUse`) and matcher (default `Bash`).
 * @returns {boolean} True when an entry for the matcher runs the command; false for a missing or invalid file.
 */
function hasHook(file, command, { event = PRE_TOOL_USE, matcher = BASH_MATCHER } = {}) {
  try {
    const found = hookEntries(readSettings(file).settings, event);
    return Boolean(found) && entriesRun(found.entries, matcher, command);
  } catch {
    return false;
  }
}

module.exports = { addAllowRule, removeAllowRule, hasAllowRule, blockSleepHook, addHook, removeHook, hasHook };
