'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeBlender, PREAMBLE, NO_BLENDER } = require('../lib/bridge/blender/run');
const { discoverBlender } = require('../lib/bridge/blender/discover');
const { SCRIPTS_OFF, SCRIPTS_DISABLED_LOCALLY } = require('../lib/bridge/unity/guard');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-blender-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(t) {
  const root = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.join(root, 'Assets'));
  return { key: 'k1', name: 'P', root };
}

const BLENDER = { path: '/fake/blender', version: '4.2.0' };
const quietLog = { op: () => {} };

/** @param {any} op @param {any} [extra] */
const dispatchOf = (op, extra = {}) => ({
  jobId: 'job1',
  op: { kind: 'blender.script', source: 'print(1)', inputs: [], outputs: [], timeoutSeconds: 60, ...op },
 
  allowScripts: true,
  consentGranted: false,
  ...extra,
});

async function run(t, op, { answer, blender = BLENDER, P = project(t), extra, noScripts } = {}) {
  const calls = [];
  const events = [];
  await executeBlender(dispatchOf(op, extra), {
    project: P,
    blender,
    noScripts,
    emit: async (e) => void events.push(e),
    log: quietLog,
    runProcess: async (file, args, opts) => {
      calls.push({ file, args, opts, script: fs.readFileSync(args[5], 'utf8'), io: JSON.parse(fs.readFileSync(args[7], 'utf8')) });
      const r = answer ? await answer(args, opts, P) : undefined;
      return { code: 0, stdout: 'done', stderr: '', timedOut: false, aborted: false, ...(r || {}) };
    },
  });
  return { P, calls, events, final: events.find((e) => e.type === 'final'), refused: events.find((e) => e.type === 'refused') };
}

test('argv order is exactly --background --factory-startup --python-exit-code 1 --python <script> -- <io>', async (t) => {
  const { P, calls, final } = await run(t, { inputs: ['Assets/In.fbx'], outputs: ['Assets/Out.glb'] }, {
    answer: (args, opts, p) => void fs.writeFileSync(path.join(p.root, 'Assets', 'Out.glb'), 'x'),
  });
  const jobDir = path.join(P.root, '.bridge', 'blender', 'job1');
  assert.equal(calls[0].file, BLENDER.path);
  assert.deepEqual(calls[0].args, [
    '--background',
    '--factory-startup',
    '--python-exit-code',
    '1',
    '--python',
    path.join(jobDir, 'script.py'),
    '--',
    path.join(jobDir, 'io.json'),
  ]);
  assert.equal(calls[0].script, PREAMBLE + '\nprint(1)');
  assert.deepEqual(calls[0].io, { inputs: [path.join(P.root, 'Assets', 'In.fbx')], outputs: [path.join(P.root, 'Assets', 'Out.glb')] });
  assert.equal(calls[0].opts.timeoutMs, 60_000);
  assert.equal(final.result.ok, true);
});

test('a declared output that is not written → ok:false naming it', async (t) => {
  const { final } = await run(t, { outputs: ['Assets/Missing.obj'] });
  assert.equal(final.result.ok, false);
  assert.ok(final.result.text.startsWith('Blender finished but did not write: Assets/Missing.obj'));
});

test('an existing Assets/Knight.fbx output → Assets/Knight.fbx~ exists before the run', async (t) => {
  const P = project(t);
  const knight = path.join(P.root, 'Assets', 'Knight.fbx');
  fs.writeFileSync(knight, 'old');
  let backedUp = false;
  const { final } = await run(t, { outputs: ['Assets/Knight.fbx'] }, {
    P,
    answer: () => {
      backedUp = fs.readFileSync(`${knight}~`, 'utf8') === 'old';
      fs.writeFileSync(knight, 'new');
    },
  });
  assert.equal(backedUp, true);
  assert.equal(final.result.ok, true);
});

test('declaring Knight.fbx AND Knight.fbx~ as outputs → one backup (Knight.fbx~ = old bytes), never Knight.fbx~~', async (t) => {
  const P = project(t);
  const knight = path.join(P.root, 'Assets', 'Knight.fbx');
  fs.writeFileSync(knight, 'old');
  let seen = null;
  await run(t, { outputs: ['Assets/Knight.fbx', 'Assets/Knight.fbx~'] }, {
    P,
    answer: () => {
      seen = { backup: fs.readFileSync(`${knight}~`, 'utf8'), doubled: fs.existsSync(`${knight}~~`) };
      fs.writeFileSync(knight, 'new');
    },
  });
  assert.deepEqual(seen, { backup: 'old', doubled: false });
});

test('a Knight.fbx~ left by an earlier job and declared as an output is never backed up to Knight.fbx~~', async (t) => {
  const P = project(t);
  const tilde = path.join(P.root, 'Assets', 'Knight.fbx~');
  fs.writeFileSync(tilde, 'earlier backup');
  let doubled = null;
  await run(t, { outputs: ['Assets/Knight.fbx~'] }, {
    P,
    answer: () => {
      doubled = fs.existsSync(`${tilde}~`);
      fs.writeFileSync(tilde, 'rewritten');
    },
  });
  assert.equal(doubled, false);
});

test('output ../x.obj → refused, nothing run', async (t) => {
  const { calls, refused } = await run(t, { outputs: ['../x.obj'] });
  assert.ok(refused);
  assert.equal(calls.length, 0);
});

test('D58: Allow scripts off → refused with the dialog sentence; Blender never runs', async (t) => {
  const { calls, refused } = await run(t, {}, { extra: { allowScripts: false } });
  assert.equal(
    refused.reason,
    'Scripts are off for this computer — the user can turn on Allow scripts in the Unity Bridge dialog (the cube icon in the App Builder).'
  );
  assert.equal(refused.reason, SCRIPTS_OFF);
  assert.equal(calls.length, 0);
});

test('D58: --no-scripts → its own sentence, even with Allow scripts on; Blender never runs', async (t) => {
  for (const allowScripts of [true, false]) {
    const { calls, refused } = await run(t, {}, { extra: { allowScripts }, noScripts: true });
    assert.equal(refused.reason, 'Scripts are disabled on this computer (--no-scripts) — the Allow scripts switch has no effect; the user must re-run the install command from the Unity Bridge dialog without --no-scripts.');
    assert.equal(refused.reason, SCRIPTS_DISABLED_LOCALLY);
    assert.equal(calls.length, 0);
  }
});

test('D58 control: Allow scripts on and no --no-scripts → Blender runs', async (t) => {
  const { calls, refused, final } = await run(t, {}, { extra: { allowScripts: true }, noScripts: false });
  assert.equal(refused, undefined);
  assert.equal(calls.length, 1);
  assert.equal(final.result.ok, true);
});

test('no Blender → refused with the --blender hint', async (t) => {
  const { calls, refused } = await run(t, {}, { blender: null });
  assert.equal(refused.reason, NO_BLENDER);
  assert.ok(refused.reason.includes('--blender'));
  assert.equal(calls.length, 0);
});

test('a non-zero exit code → ok:false', async (t) => {
  const { final } = await run(t, {}, { answer: () => ({ code: 1, stderr: 'Traceback' }) });
  assert.equal(final.result.ok, false);
  assert.ok(final.result.text.includes('Traceback'));
});

test('discoverBlender: an explicit path comes first; its version is the number from the first --version line', (t) => {
  const dir = scratch(t);
  const exe = path.join(dir, 'blender');
  fs.writeFileSync(exe, '');
  const exec = (file, args) => (args[0] === '--version' ? 'Blender 4.2.1\n\tbuild date: x\n' : undefined);
  assert.deepEqual(discoverBlender({ explicit: exe, platform: 'linux', env: {}, exec }), { path: exe, version: '4.2.1' });
  assert.equal(discoverBlender({ platform: 'linux', env: {}, exec }), undefined);
});

test('a ../../Assets jobId never reaches runProcess and deletes nothing', async (t) => {
  const P = project(t);
  fs.writeFileSync(path.join(P.root, 'Assets', 'Keep.txt'), 'x');
  const calls = [];
  const events = [];
  await executeBlender(
    { ...dispatchOf({ outputs: ['Assets/Out.obj'] }), jobId: '../../Assets' },
    { project: P, blender: BLENDER, emit: async (e) => void events.push(e), log: quietLog, runProcess: async (...a) => void calls.push(a) }
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
  assert.ok(fs.existsSync(path.join(P.root, 'Assets', 'Keep.txt')));
});

test('after a Blender job, the empty .bridge/blender and .bridge folders are removed; other content stays', async (t) => {
  const { P } = await run(t, {});
  assert.equal(fs.existsSync(path.join(P.root, '.bridge')), false);
  const P2 = project(t);
  fs.mkdirSync(path.join(P2.root, '.bridge', 'out'), { recursive: true });
  fs.writeFileSync(path.join(P2.root, '.bridge', 'out', 'keep.png'), 'x');
  await run(t, {}, { P: P2 });
  assert.equal(fs.existsSync(path.join(P2.root, '.bridge', 'blender')), false);
  assert.equal(fs.readFileSync(path.join(P2.root, '.bridge', 'out', 'keep.png'), 'utf8'), 'x');
});
