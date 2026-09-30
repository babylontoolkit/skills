'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeBlender, PREAMBLE, NO_BLENDER } = require('../lib/bridge/blender/run');
const { discoverBlender } = require('../lib/bridge/blender/discover');

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
  unityProjectKey: 'k1',
  allowScripts: true,
  consentGranted: false,
  ...extra,
});

async function run(t, op, { answer, blender = BLENDER, P = project(t) } = {}) {
  const calls = [];
  const events = [];
  await executeBlender(dispatchOf(op), {
    project: P,
    blender,
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

test('output ../x.obj → refused, nothing run', async (t) => {
  const { calls, refused } = await run(t, { outputs: ['../x.obj'] });
  assert.ok(refused);
  assert.equal(calls.length, 0);
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
