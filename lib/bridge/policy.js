'use strict';

/**
 * Port of the App Builder's tiers.ts + validate.ts. THIS copy is the wall on the user's machine
 * (D3): it is enforced whatever the server sent. Change both copies and both test tables together.
 *
 * App sources: `app/lib/bridge/tiers.ts` and `app/lib/bridge/validate.ts`. Test tables:
 * `tests/bridge-policy.test.js` (copied from `tiers.spec.ts` / `validate.spec.ts`).
 *
 * Anything unknown is `consent` — the default-deny direction (D14).
 */

const { BRIDGE_MAX_CAPTURE_PX, capText } = require('./protocol');

/**
 * @typedef {'allowed'|'scripts'|'consent'|'refused'} BridgeTier
 * @typedef {{ tier: BridgeTier, reason?: string }} TierDecision
 * @typedef {import('./protocol').BridgeOperation} BridgeOperation
 */

// ── tiers.ts ────────────────────────────────────────────────────────────────────────────────────

const SCRIPT_COMMANDS = new Set(['run_script', 'eval', 'eval_file']);
const CONSENT_COMMANDS = new Set([
  'set_import_settings',
  'delete_gameobject',
  'delete_asset',
  'move_asset',
  'rename_asset',
  'package_remove',
  'package_resolve',
  'set_player_settings',
  'set_quality_settings',
  'set_physics_settings',
  'set_tags_layers',
  'set_lighting_settings',
  'set_navmesh_settings',
  'set_build_settings',
  'build_player',
]);
const CONSENT_COMMAND_PATTERN = /^(delete|remove|move|rename|clear|reset|uninstall)_/;
const ALLOWED_COMMAND_PATTERN =
  /^(get|find|list|search|create|add|set|instantiate|open|save|import|bake|capture|screenshot|console|editor|package_add|package_status|wait_for|recompile|run_tests|bt_|select|apply|assign|attach|duplicate|load|play|stop|pause|refresh|describe|inspect)/;

/** @type {Record<string, string>} */
const REFUSED_CLI = {
  command: 'use the unity_command tool',
  cmd: 'use the unity_command tool',
  open: 'use the unity_editor tool',
  close: 'use the unity_editor tool',
  run: 'not available through the Unity Bridge',
  shell: 'not available through the Unity Bridge',
  license: 'Unity licences are never touched by the Unity Bridge',
  auth: 'Unity sign-in is never touched by the Unity Bridge',
  mcp: 'not available through the Unity Bridge',
  skill: 'not available through the Unity Bridge',
  job: 'use the bridge_job tool',
};

/** first arg → allowed second args ('*' = any). @type {Record<string, string[] | '*'>} */
const ALLOWED_CLI = {
  status: '*',
  logs: '*',
  recompile: '*',
  test: '*',
  templates: '*',
  releases: '*',
  doctor: '*',
  docs: '*',
  list: '*',
  editors: ['list', 'path', 'running'],
  projects: ['info', 'verify'],
  vcs: ['diff', 'blame', 'status'],
  assets: ['export'],
  pipeline: ['list', 'list-versions', 'status'],
};

const CONSENT_CLI = new Set([
  'install',
  'uninstall',
  'install-modules',
  'self-update',
  'build',
  'projects',
  'vcs',
  'assets',
  'pipeline',
]); // reached only when not ALLOWED above

/** @type {Record<'allowed'|'scripts'|'consent', number>} */
const RANK = { allowed: 0, scripts: 1, consent: 2 };

/** @param {object} record @param {string} key */
function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** @param {string} name @returns {TierDecision} */
function classifyCommandName(name) {
  if (SCRIPT_COMMANDS.has(name)) return { tier: 'scripts' };
  if (CONSENT_COMMANDS.has(name) || CONSENT_COMMAND_PATTERN.test(name)) return { tier: 'consent' };
  if (ALLOWED_COMMAND_PATTERN.test(name)) return { tier: 'allowed' };
  return { tier: 'consent', reason: 'unrecognised command — asking first' };
}

/** @param {string} name @param {Record<string, unknown>|undefined} params @returns {TierDecision} */
function classifyCommand(name, params) {
  if (name === 'batch') {
    const commands = params && typeof params === 'object' ? params.commands : undefined;
    if (!Array.isArray(commands)) {
      return { tier: 'consent', reason: 'a batch without a commands list — asking first' };
    }

    /** @type {TierDecision} */
    let highest = { tier: 'allowed' };
    for (const entry of commands) {
      const innerName = entry && typeof entry === 'object' ? entry.name : undefined;
      if (typeof innerName !== 'string') {
        return { tier: 'consent', reason: 'a batch entry without a command name — asking first' };
      }
      // A nested batch is never unwrapped: it is classified by its name alone (unrecognised → consent).
      /** @type {TierDecision} */
      const inner = innerName === 'batch' ? { tier: 'consent' } : classifyCommandName(innerName);
      if (RANK[/** @type {'allowed'} */ (inner.tier)] > RANK[/** @type {'allowed'} */ (highest.tier)]) {
        highest = inner;
      }
    }
    return highest;
  }
  return classifyCommandName(name);
}

/** @param {unknown} args @returns {TierDecision} */
function classifyCli(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { tier: 'refused', reason: 'an empty Unity CLI command' };
  }
  const [first, second] = args;
  if (hasOwn(REFUSED_CLI, first)) return { tier: 'refused', reason: REFUSED_CLI[first] };
  // Printing help changes nothing — but only after the refusal check, so ['shell','--help'] stays refused.
  if (args.some((arg) => arg === '--help' || arg === '-h')) return { tier: 'allowed' };
  if (hasOwn(ALLOWED_CLI, first)) {
    const allowed = ALLOWED_CLI[first];
    // A bare command group (['editors']) prints its help/list, so it is allowed like its read-only verbs.
    if (allowed === '*' || second === undefined || (typeof second === 'string' && allowed.includes(second))) {
      return { tier: 'allowed' };
    }
  }
  if (CONSENT_CLI.has(first)) return { tier: 'consent' };
  return { tier: 'consent' };
}

/**
 * @param {BridgeOperation} op
 * @returns {TierDecision}
 */
function classifyOperation(op) {
  switch (op && op.kind) {
    case 'unity.command':
      return classifyCommand(/** @type {string} */ (op.name), /** @type {any} */ (op.params));
    case 'unity.cli':
      return classifyCli(op.args);
    case 'unity.script':
    case 'blender.script':
      return { tier: 'scripts' };
    case 'unity.project':
    case 'unity.list':
    case 'unity.capture':
    case 'unity.editor':
    case 'devserver.start':
    case 'devserver.status':
      return { tier: 'allowed' };
    default:
      return { tier: 'consent', reason: 'unrecognised operation — asking first' };
  }
}

// ── validate.ts ─────────────────────────────────────────────────────────────────────────────────

const PATH_PARAMS = new Set(['output', 'folder', 'save_path', 'file', 'outputPath']);

/**
 * Param keys a `unity.command` may never carry (D41): they name the Unity CLI's own options, so a model
 * could otherwise turn a parameter into `--yes` or re-point `--project-path`. The helper also passes
 * every param after `--`, where the CLI stops reading options. `timeout` and `format` are NOT here: real
 * commands declare them (`eval`, `run_tests`, `get_serialized_fields`), and after `--` they reach the
 * command, never the CLI.
 */
const RESERVED_PARAM_KEYS = new Set(['yes', 'project-path', 'non-interactive', 'result-only', 'detach', 'project']);

const MAX_SOURCE_CHARS = 200_000;
const MAX_CLI_ARG_CHARS = 512;
const MAX_BLENDER_PATHS = 32;
const COMMAND_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCRIPT_ENTRY = /^[A-Za-z_][\w.]*\.[A-Za-z_]\w*$/;
/** A Unity project folder name inside the projects folder (D54) — never a path; no trailing dot/space (Windows rewrites them). */
const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_-])?$/;
const PROJECT_ACTIONS = new Set(['list', 'open', 'create']);

/** @param {unknown} name @returns {boolean} */
function isValidProjectName(name) {
  return typeof name === 'string' && PROJECT_NAME.test(name) && !name.includes('..');
}

/**
 * true for '/x', '\\x', '~/x', 'C:\\x', 'C:/x', or any value with a '..' path segment.
 * @param {string} value
 * @returns {boolean}
 */
function isUnsafePath(value) {
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) return true;
  // A drive root or a drive path ('C:', 'C:/x', 'C:\\x') — never any 'x:' prefix ('t:Texture' is a search).
  if (/^[A-Za-z]:([\\/]|$)/.test(value)) return true;
  return value.split(/[\\/]/).some((segment) => segment === '..');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} value @param {number} min @param {number} max */
function isIntegerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** @param {unknown} source @returns {string|null} */
function checkSource(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return 'The script source is empty — pass the full script text.';
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return `The script source is ${source.length} characters; the limit is ${MAX_SOURCE_CHARS}.`;
  }
  return null;
}

/** @param {string} label @param {unknown} list @returns {string|null} */
function checkPathList(label, list) {
  if (!Array.isArray(list) || list.length > MAX_BLENDER_PATHS || list.some((item) => typeof item !== 'string')) {
    return `${label} must be a list of at most ${MAX_BLENDER_PATHS} Unity-project-relative paths.`;
  }
  const unsafe = list.find(isUnsafePath);
  if (unsafe !== undefined) {
    return `${label} contains "${unsafe}" — use a Unity-project-relative path (no leading /, \\, ~, drive letter or "..").`;
  }
  return null;
}

/**
 * null when valid, else a sentence for the model.
 * @param {BridgeOperation} op
 * @returns {string|null}
 */
function validateOperation(op) {
  switch (op && op.kind) {
    case 'unity.command': {
      if (typeof op.name !== 'string' || !COMMAND_NAME.test(op.name)) {
        return 'The command name must be a lower-case Unity command name such as "set_transform" — call unity_list_commands to see them.';
      }
      if (!isPlainObject(op.params)) return 'The command params must be a JSON object.';
      for (const [key, value] of Object.entries(op.params)) {
        if (!PARAM_KEY.test(key)) {
          return `The command parameter name "${key}" is not valid — use the parameter names unity_list_commands shows.`;
        }
        if (RESERVED_PARAM_KEYS.has(key)) {
          return `The command parameter "${key}" is not allowed — it is reserved for the Unity Bridge itself.`;
        }
        if (PATH_PARAMS.has(key) && typeof value === 'string' && isUnsafePath(value)) {
          return `The "${key}" path "${value}" is not allowed — use a Unity-project-relative path (for scratch output, .bridge/out/…).`;
        }
      }
      return null;
    }

    case 'unity.cli': {
      if (!Array.isArray(op.args)) return 'The Unity CLI arguments must be a list of strings.';
      for (const arg of op.args) {
        if (typeof arg !== 'string' || arg.length > MAX_CLI_ARG_CHARS) {
          return `Every Unity CLI argument must be a string of at most ${MAX_CLI_ARG_CHARS} characters.`;
        }
        if (arg.includes('\0')) return 'A Unity CLI argument may not contain a NUL character.';
        if (isUnsafePath(arg)) {
          return `The Unity CLI argument "${arg}" is not allowed — use a Unity-project-relative path.`;
        }
      }
      return null;
    }

    case 'unity.script': {
      const sourceError = checkSource(op.source);
      if (sourceError) return sourceError;
      if (typeof op.entry !== 'string' || !SCRIPT_ENTRY.test(op.entry)) {
        return 'The script entry must be a static method written as Class.Method (for example "BridgeScript.Run").';
      }
      return null;
    }

    case 'unity.capture': {
      if (!isIntegerIn(op.width, 64, BRIDGE_MAX_CAPTURE_PX) || !isIntegerIn(op.height, 64, BRIDGE_MAX_CAPTURE_PX)) {
        return `The capture width and height must be whole numbers between 64 and ${BRIDGE_MAX_CAPTURE_PX}.`;
      }
      return null;
    }

    case 'blender.script': {
      const sourceError = checkSource(op.source);
      if (sourceError) return sourceError;
      const inputsError = checkPathList('inputs', op.inputs);
      if (inputsError) return inputsError;
      const outputsError = checkPathList('outputs', op.outputs);
      if (outputsError) return outputsError;
      if (!isIntegerIn(op.timeoutSeconds, 10, 3600)) {
        return 'The Blender timeoutSeconds must be a whole number between 10 and 3600.';
      }
      return null;
    }

    case 'unity.project': {
      if (typeof op.action !== 'string' || !PROJECT_ACTIONS.has(op.action)) return 'unity_project action must be list, open or create.';
      if (op.action === 'list') return null;
      if (op.name === undefined || op.name === null || op.name === '') return `unity_project needs a project name for ${op.action}.`;
      // `open` may name the projects folder too — `<folder>/<name>` — when a name exists in more than one (D55).
      const parts = op.action === 'open' && typeof op.name === 'string' && op.name.split('/').length === 2 ? op.name.split('/') : [op.name];
      if (!parts.every(isValidProjectName)) {
        return `The Unity project name "${op.name}" is not valid — use letters, numbers, spaces, dots, dashes or underscores.`;
      }
      return null;
    }

    case 'devserver.start': {
      if (op.port !== undefined && !isIntegerIn(op.port, 1025, 65535)) {
        return 'The dev server port must be a whole number between 1025 and 65535.';
      }
      return null;
    }

    default:
      return null;
  }
}

// ── pricing.ts (the long-operation half only: it sets the helper's timeouts, D41) ────────────────

const LONG_COMMANDS = new Set([
  'bt_export_level',
  'bt_export_prefab',
  'bt_export_animation',
  'bt_build_project',
  'bake_lighting',
  'bake_navmesh',
  'bake_navmesh_surfaces',
  'bake_occlusion_culling',
  'run_tests',
]);
const LONG_CLI = new Set(['test', 'build', 'recompile']);

/** @param {BridgeOperation} op @returns {boolean} */
function isLongOperation(op) {
  if (op.kind === 'unity.command') {
    if (LONG_COMMANDS.has(/** @type {string} */ (op.name))) return true;
    const params = /** @type {any} */ (op.params);
    if (op.name === 'batch' && params && Array.isArray(params.commands)) {
      return params.commands.some((/** @type {any} */ c) => c && LONG_COMMANDS.has(c.name));
    }
    return false;
  }
  if (op.kind === 'unity.cli') return Array.isArray(op.args) && LONG_CLI.has(op.args[0]);
  if (op.kind === 'unity.project') return op.action === 'create' || op.action === 'open';
  if (op.kind === 'blender.script') return typeof op.timeoutSeconds === 'number' && op.timeoutSeconds > 120;
  return false;
}

module.exports = {
  SCRIPT_COMMANDS,
  CONSENT_COMMANDS,
  CONSENT_COMMAND_PATTERN,
  ALLOWED_COMMAND_PATTERN,
  REFUSED_CLI,
  ALLOWED_CLI,
  CONSENT_CLI,
  PATH_PARAMS,
  RESERVED_PARAM_KEYS,
  LONG_COMMANDS,
  LONG_CLI,
  PROJECT_NAME,
  isValidProjectName,
  classifyOperation,
  isUnsafePath,
  validateOperation,
  isLongOperation,
  capText,
};
