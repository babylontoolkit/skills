'use strict';

/**
 * The helper's own wall (D3, D14, D15, D20, D39): tiers, paths, the toolkit version floor and the
 * unsaved-work guard. Enforced whatever the App Builder sent.
 */

const path = require('path');
const { classifyOperation, validateOperation, isUnsafePath } = require('../policy');
const { BRIDGE_TOOLKIT_MIN_VERSION } = require('../protocol');

const SCRIPTS_OFF =
  'Scripts are switched off (Allow scripts in the App Builder, or --no-scripts on this machine).';
const CONSENT_MISSING = 'consent was not granted';

/**
 * Numeric major.minor.patch compare; pre-release suffixes are ignored.
 * @param {string} a @param {string} b @returns {number} <0, 0, >0
 */
function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) =>
    String(v)
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The name of the toolkit command an operation runs, if any (`bt_*`).
 * @param {import('../protocol').BridgeOperation} op
 * @returns {string|undefined}
 */
function toolkitCommandOf(op) {
  if (op.kind === 'unity.command' && typeof op.name === 'string' && op.name.startsWith('bt_')) return op.name;
  if (op.kind === 'devserver.start') return 'bt_devserver_start';
  if (op.kind === 'devserver.status') return 'bt_devserver_status';
  return undefined;
}

/**
 * @param {import('../protocol').BridgeDispatch} dispatch
 * @param {{ toolkitVersion?: string }} project
 * @param {{ noScripts?: boolean }} [opts]
 * @returns {{ ok: true, tier: string } | { ok: false, reason: string }}
 */
function helperTier(dispatch, project, { noScripts = false } = {}) {
  const op = dispatch && dispatch.op;
  if (!op || typeof op !== 'object') return { ok: false, reason: 'The job carried no operation.' };

  const invalid = validateOperation(op);
  if (invalid) return { ok: false, reason: invalid };

  const decision = classifyOperation(op);
  if (decision.tier === 'refused') {
    return { ok: false, reason: `Refused on this computer: ${decision.reason || 'not available through the Unity Bridge'}.` };
  }
  if (decision.tier === 'scripts' && (!dispatch.allowScripts || noScripts)) return { ok: false, reason: SCRIPTS_OFF };
  if (decision.tier === 'consent' && !dispatch.consentGranted) return { ok: false, reason: CONSENT_MISSING };

  const bt = toolkitCommandOf(op);
  const v = project && project.toolkitVersion;
  if (bt && v && compareVersions(v, BRIDGE_TOOLKIT_MIN_VERSION) < 0) {
    return {
      ok: false,
      reason: `Babylon Toolkit ${v} is older than ${BRIDGE_TOOLKIT_MIN_VERSION}, which the bt_* commands need. Upgrade the com.babylontoolkit.editor package.`,
    };
  }
  return { ok: true, tier: decision.tier };
}

/**
 * A Unity-project-relative path resolved under `root`, or null when it would escape it (D20).
 * Any `X:` prefix is refused too: a Windows drive-relative `C:x` resolves outside the project.
 * @param {string} root
 * @param {unknown} rel
 * @returns {string|null}
 */
function resolveProjectPath(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return null;
  if (isUnsafePath(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return null;
  return abs;
}

/**
 * @param {unknown} node
 * @param {string[]} found
 * @param {number} depth
 */
function walkDirty(node, found, depth) {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkDirty(item, found, depth + 1);
    return;
  }
  const o = /** @type {Record<string, unknown>} */ (node);
  if (o.dirty === true || o.isDirty === true) {
    const label = typeof o.path === 'string' && o.path ? o.path : typeof o.name === 'string' ? o.name : undefined;
    if (label && !found.includes(label)) found.push(label);
  }
  for (const value of Object.values(o)) walkDirty(value, found, depth + 1);
}

/**
 * D39: which open scenes have unsaved changes. `runUnity(args)` runs the Unity CLI for THIS project
 * (it adds nothing — the args are complete).
 * @param {(args: string[]) => Promise<import('./run').RunResult>} runUnity
 * @param {string} projectRoot
 * @returns {Promise<{ names: string[] } | { error: string }>}
 */
async function dirtyScenes(runUnity, projectRoot) {
  let res;
  try {
    res = await runUnity([
      'command',
      'list_open_scenes',
      '--project-path',
      projectRoot,
      '--format',
      'json',
      '--non-interactive',
    ]);
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).pop();
    return { error: res.timedOut ? 'Unity did not answer in time' : detail || `exit code ${res.code}` };
  }
  if (parsed && parsed.success === false) {
    const first = Array.isArray(parsed.errors) && parsed.errors[0];
    return { error: (first && first.message) || 'Unity could not list the open scenes' };
  }
  /** @type {string[]} */
  const names = [];
  walkDirty(parsed, names, 0);
  return { names };
}

/**
 * The D39 refusal sentence, or null when nothing is unsaved.
 * @param {{ names: string[] } | { error: string }} state
 * @returns {string|null}
 */
function unsavedWorkReason(state) {
  if ('error' in state) {
    return `Could not check Unity for unsaved changes (${state.error}). Save them with unity_command save_all if they are yours, or ask the user.`;
  }
  if (!state.names.length) return null;
  return `Unity has unsaved changes in ${state.names.join(', ')}. Save them with unity_command save_all if they are yours, or ask the user.`;
}

module.exports = {
  helperTier,
  resolveProjectPath,
  dirtyScenes,
  unsavedWorkReason,
  compareVersions,
  toolkitCommandOf,
  SCRIPTS_OFF,
  CONSENT_MISSING,
};
