'use strict';

// These cases MUST stay equal to the App Builder's `app/lib/bridge/tiers.spec.ts` and
// `app/lib/bridge/validate.spec.ts` (D3): the two copies of the policy are pinned by the same named
// cases. Change both spec files and this table together.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyOperation, isUnsafePath, validateOperation, isLongOperation, capText } = require('../lib/bridge/policy');

/** @param {string} name @param {Record<string, unknown>} [params] */
const command = (name, params = {}) => ({ kind: 'unity.command', name, params });
/** @param {...string} args */
const cli = (...args) => ({ kind: 'unity.cli', args });

// ── tiers.spec.ts › classifyOperation: [name, op, expected tier, reason check?] ───────────────────
const TIER_CASES = [
  ['unity.command bt_export_level → allowed', command('bt_export_level'), 'allowed'],
  ['set_transform → allowed', command('set_transform'), 'allowed'],
  ['run_script → scripts', command('run_script'), 'scripts'],
  ['set_import_settings → consent', command('set_import_settings'), 'consent'],
  ['delete_foo → consent', command('delete_foo'), 'consent'],
  ['unknown_thing → consent with reason', command('unknown_thing'), 'consent', { equals: 'unrecognised command — asking first' }],
  [
    'batch of [create_gameobject, delete_gameobject] → consent',
    command('batch', { commands: [{ name: 'create_gameobject' }, { name: 'delete_gameobject' }] }),
    'consent',
  ],
  [
    'batch of allowed commands → allowed (control)',
    command('batch', { commands: [{ name: 'create_gameobject' }, { name: 'set_transform' }] }),
    'allowed',
  ],
  ['batch without commands → consent', command('batch'), 'consent'],
  ['batch without commands → consent (entry without a name)', command('batch', { commands: [{ nope: 1 }] }), 'consent'],
  ["unity.cli ['license','return'] → refused", cli('license', 'return'), 'refused'],
  ["['status'] → allowed", cli('status'), 'allowed'],
  ["['projects','info'] → allowed", cli('projects', 'info'), 'allowed'],
  ["['projects','clean'] → consent", cli('projects', 'clean'), 'consent'],
  ["unity.cli ['editors'] → allowed", cli('editors'), 'allowed'],
  ["unity.cli ['projects','new','--help'] → allowed", cli('projects', 'new', '--help'), 'allowed'],
  ["unity.cli ['license','return','-h'] → refused", cli('license', 'return', '-h'), 'refused'],
  ["unity.cli ['license','status'] → refused", cli('license', 'status'), 'refused'],
  ["unity.cli ['auth','logout'] → refused", cli('auth', 'logout'), 'refused'],
  ["unity.cli ['shell','--help'] → refused", cli('shell', '--help'), 'refused'],
  ['[\'shell\'] → refused, reason mentions "not available"', cli('shell'), 'refused', { contains: 'not available' }],
  ["['open'] → refused, reason mentions unity_editor", cli('open'), 'refused', { contains: 'unity_editor' }],
  ['[] → refused', cli(), 'refused'],
  ['blender.script → scripts', { kind: 'blender.script', source: 'x', inputs: [], outputs: [], timeoutSeconds: 60 }, 'scripts'],
  ['unity.editor close → allowed', { kind: 'unity.editor', action: 'close' }, 'allowed'],
  ['unity.project list → allowed', { kind: 'unity.project', action: 'list' }, 'allowed'],
  ['unity.project open → allowed', { kind: 'unity.project', action: 'open', name: 'My Game' }, 'allowed'],
  ['unity.project create → allowed', { kind: 'unity.project', action: 'create', name: 'My Game' }, 'allowed'],
];

for (const [name, op, tier, reason] of TIER_CASES) {
  test(`classifyOperation: ${name}`, () => {
    const decision = classifyOperation(op);
    assert.equal(decision.tier, tier);
    if (reason && reason.equals) assert.equal(decision.reason, reason.equals);
    if (reason && reason.contains) assert.ok(String(decision.reason).includes(reason.contains));
  });
}

// ── validate.spec.ts › isUnsafePath: [value, expected] ────────────────────────────────────────────
const PATH_CASES = [
  ['/etc', true],
  ['~/x', true],
  ['C:\\x', true],
  ['a/../b', true],
  ['Assets/x.png', false],
  ['t:Texture', false], // a search filter, not a drive
  ['C:', true],
  ['C:/x', true],
  ['C:\\x', true],
];

for (const [value, expected] of PATH_CASES) {
  test(`isUnsafePath(${JSON.stringify(value)}) → ${expected}`, () => {
    assert.equal(isUnsafePath(value), expected);
  });
}

// ── validate.spec.ts › validateOperation: [name, op, expected ('sentence' | null)] ────────────────
const VALIDATE_CASES = [
  ["unity.command screenshot {output:'/tmp/a.png'} → a sentence", command('screenshot', { output: '/tmp/a.png' }), 'sentence'],
  ["{output:'.bridge/out/a.png'} → null", command('screenshot', { output: '.bridge/out/a.png' }), null],
  ["{target:'/Directional Light'} (not a path param) → null", command('set_transform', { target: '/Directional Light' }), null],
  ...['yes', 'project-path', 'non-interactive', 'result-only', 'detach', 'project'].map((key) => [
    `reserved param key ${key} → sentence`,
    command('set_transform', { [key]: true }),
    'sentence',
  ]),
  ...['--yes', '1abc', 'a b', 'x'.repeat(65)].map((key) => [
    `invalid param key ${key} → sentence`,
    command('set_transform', { [key]: 1 }),
    'sentence',
  ]),
  ["{format:'yaml', timeout:5} (real command params) → null", command('get_serialized_fields', { format: 'yaml', timeout: 5 }), null],
  ['unity.capture 2048 → sentence', { kind: 'unity.capture', view: 'game', width: 2048, height: 512 }, 'sentence'],
  ["unity.script entry 'Build' (no dot) → sentence", { kind: 'unity.script', source: 'class A {}', entry: 'Build' }, 'sentence'],
  ['unity.project open with no name → sentence', { kind: 'unity.project', action: 'open' }, 'sentence'],
  ['unity.project create with no name → sentence', { kind: 'unity.project', action: 'create' }, 'sentence'],
  ["unity.project open '../x' → sentence", { kind: 'unity.project', action: 'open', name: '../x' }, 'sentence'],
  ["unity.project create '../x' → sentence", { kind: 'unity.project', action: 'create', name: '../x' }, 'sentence'],
  ["unity.project create 'a..b' → sentence", { kind: 'unity.project', action: 'create', name: 'a..b' }, 'sentence'],
  ["unity.project create 'x.' (trailing dot) → sentence", { kind: 'unity.project', action: 'create', name: 'x.' }, 'sentence'],
  ["unity.project create 'Real ' (trailing space) → sentence", { kind: 'unity.project', action: 'create', name: 'Real ' }, 'sentence'],
  ["unity.project open 'My Game' → null", { kind: 'unity.project', action: 'open', name: 'My Game' }, null],
  ["unity.project create 'My Game' → null", { kind: 'unity.project', action: 'create', name: 'My Game' }, null],
  ["unity.project create 'Level_01-v2.0a' → null", { kind: 'unity.project', action: 'create', name: 'Level_01-v2.0a' }, null],
  ["unity.project list → null", { kind: 'unity.project', action: 'list' }, null],
  ["unity.project list with name '../ignored' → null", { kind: 'unity.project', action: 'list', name: '../ignored' }, null],
  ["unity.project open 'Archive/Kart' → null", { kind: 'unity.project', action: 'open', name: 'Archive/Kart' }, null],
  ["unity.project create 'Archive/Kart' → sentence", { kind: 'unity.project', action: 'create', name: 'Archive/Kart' }, 'sentence'],
  ["unity.project open 'A/../Kart' → sentence", { kind: 'unity.project', action: 'open', name: 'A/../Kart' }, 'sentence'],
  ["unity.project open 'a/b/c' → sentence", { kind: 'unity.project', action: 'open', name: 'a/b/c' }, 'sentence'],
  ["unity.project action 'delete' → sentence", { kind: 'unity.project', action: 'delete' }, 'sentence'],
];

for (const [name, op, expected] of VALIDATE_CASES) {
  test(`validateOperation: ${name}`, () => {
    const result = validateOperation(op);
    if (expected === null) assert.equal(result, null);
    else {
      assert.equal(typeof result, 'string');
      assert.ok(result.length > 10);
    }
  });
}

// ── the exact unity_project sentences (identical in the app's validate.ts) ──────────────────────
test('validateOperation: unity_project sentences are the shared ones', () => {
  assert.equal(validateOperation({ kind: 'unity.project', action: 'delete' }), 'unity_project action must be list, open or create.');
  assert.equal(validateOperation({ kind: 'unity.project', action: 'create' }), 'unity_project needs a project name for create.');
  assert.equal(
    validateOperation({ kind: 'unity.project', action: 'create', name: 'a/b' }),
    'The Unity project name "a/b" is not valid — use letters, numbers, spaces, dots, dashes or underscores.'
  );
});

test('isLongOperation: unity.project create and open are long, list is not', () => {
  assert.equal(isLongOperation({ kind: 'unity.project', action: 'create', name: 'A' }), true);
  assert.equal(isLongOperation({ kind: 'unity.project', action: 'open', name: 'A' }), true);
  assert.equal(isLongOperation({ kind: 'unity.project', action: 'list' }), false);
});

// ── validate.spec.ts › capText ────────────────────────────────────────────────────────────────────
test('capText: 25_000 chars → starts with the truncation notice and ends with the last char', () => {
  const capped = capText('a'.repeat(24_999) + 'Z');
  assert.ok(capped.startsWith('…(earlier output truncated)'));
  assert.ok(capped.endsWith('Z'));
});

// ── Helper-only cases (not in the app specs; the rule itself is the app's) ───────────────────────
test('a nested batch is never unwrapped → consent', () => {
  const op = command('batch', { commands: [{ name: 'batch', params: { commands: [{ name: 'get_x' }] } }] });
  assert.equal(classifyOperation(op).tier, 'consent');
});

test('unity_project open accepts "<folder>/<name>" (D55); create and traversal never do', () => {
  assert.equal(validateOperation({ kind: 'unity.project', action: 'open', name: 'Archive/Kart' }), null);
  assert.notEqual(validateOperation({ kind: 'unity.project', action: 'create', name: 'Archive/Kart' }), null);
  assert.notEqual(validateOperation({ kind: 'unity.project', action: 'open', name: '../Kart' }), null);
  assert.notEqual(validateOperation({ kind: 'unity.project', action: 'open', name: 'A/../Kart' }), null);
  assert.notEqual(validateOperation({ kind: 'unity.project', action: 'open', name: 'a/b/c' }), null);
});
