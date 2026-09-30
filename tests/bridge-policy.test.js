'use strict';

// These cases MUST stay equal to the App Builder's `app/lib/bridge/tiers.spec.ts` and
// `app/lib/bridge/validate.spec.ts` (D3): the two copies of the policy are pinned by the same named
// cases. Change both spec files and this table together.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyOperation, isUnsafePath, validateOperation, capText } = require('../lib/bridge/policy');

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
  ["unity.cli ['license','return'] → consent", cli('license', 'return'), 'consent'],
  ["['status'] → allowed", cli('status'), 'allowed'],
  ["['projects','info'] → allowed", cli('projects', 'info'), 'allowed'],
  ["['projects','clean'] → consent", cli('projects', 'clean'), 'consent'],
  ['[\'shell\'] → refused, reason mentions "not available"', cli('shell'), 'refused', { contains: 'not available' }],
  ["['open'] → refused, reason mentions unity_editor", cli('open'), 'refused', { contains: 'unity_editor' }],
  ['[] → refused', cli(), 'refused'],
  ['blender.script → scripts', { kind: 'blender.script', source: 'x', inputs: [], outputs: [], timeoutSeconds: 60 }, 'scripts'],
  ['unity.editor close → allowed', { kind: 'unity.editor', action: 'close' }, 'allowed'],
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
