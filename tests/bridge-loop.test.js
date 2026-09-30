'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runLoop, createJobQueue, BACKOFF_MS, NOT_PAIRED, notPairedText } = require('../lib/bridge/loop');
const { NotPairedError } = require('../lib/bridge/api');
const { writeBridgeConfig, bridgeConfigPath, readBridgeConfig } = require('../lib/bridge/config');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-loop-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const quiet = { info() {}, op() {}, error() {}, box() {} };
const hello = () => ({ protocol: 1 });

/**
 * A fake api: `polls` is a list of handlers, consumed in order; results are recorded. Once they run out,
 * the next poll parks until `endWhen` settles (like a held long-poll), then stops the loop.
 */
function fakeApi(polls, controller, endWhen = Promise.resolve()) {
  const calls = [];
  return {
    calls,
    async post(p, body) {
      calls.push({ path: p, body });
      if (p === '/api/bridge/result') return { status: 200, body: { delivered: 1 } };
      const next = polls.shift();
      if (!next) {
        await endWhen;
        await new Promise((r) => setImmediate(r));
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return next();
    },
  };
}

test('a polled job is executed once and its event is posted', async () => {
  const controller = new AbortController();
  const dispatch = {
    jobId: 'job_1',
    op: { kind: 'unity.list' },
   
    allowScripts: false,
    consentGranted: false,
  };
  const executed = [];
  let finished;
  const done = new Promise((r) => (finished = r));
  const api = fakeApi([async () => ({ status: 200, body: { jobs: [dispatch], cancels: [] } })], controller, done);

  await runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async () => {},
    logger: quiet,
    execute: async (d, emit) => {
      executed.push(d);
      await emit({ jobId: d.jobId, type: 'final', result: { ok: true, text: 'done' } });
      finished();
    },
  });
  await done;

  assert.deepEqual(executed, [dispatch]);
  const results = api.calls.filter((c) => c.path === '/api/bridge/result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].body, {
    events: [{ jobId: 'job_1', type: 'final', result: { ok: true, text: 'done' } }],
  });
  assert.deepEqual(api.calls[0], { path: '/api/bridge/poll', body: { hello: { protocol: 1 } } });
});

test('jobs run one at a time, in arrival order — there is one queue, not one per project (D54)', async () => {
  const controller = new AbortController();
  const job = (id) => ({ jobId: id, op: { kind: 'unity.list' }, allowScripts: false, consentGranted: false });
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let bothDone;
  const done = new Promise((r) => (bothDone = r));
  const api = fakeApi(
    [async () => ({ status: 200, body: { jobs: [job('a'), job('b')], cancels: [] } })],
    controller,
    done
  );

  const loop = runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async () => {},
    logger: quiet,
    execute: async (d) => {
      order.push(`start ${d.jobId}`);
      if (d.jobId === 'a') await gate;
      order.push(`end ${d.jobId}`);
      if (d.jobId === 'b') bothDone();
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['start a']);
  release();
  await done;
  await loop;
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
});

test('network errors back off 1s, 2s, 5s and reset on success', async () => {
  const controller = new AbortController();
  const fail = async () => {
    throw new Error('ECONNREFUSED');
  };
  const api = fakeApi([fail, fail, fail, async () => ({ status: 200, body: { jobs: [], cancels: [] } })], controller);
  const sleeps = [];

  const exit = await runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: quiet,
    execute: async () => {},
  });

  assert.deepEqual(sleeps, [1000, 2000, 5000]);
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 5000, 10000, 30000]);
  assert.equal(exit.reason, 'stopped');
});

test('a removed device ends the loop and deletes THAT server\'s credential only', async (t) => {
  scratch(t);
  writeBridgeConfig({ server: 'https://x', deviceId: 'd', token: 't' });
  writeBridgeConfig({ server: 'http://localhost:5173', deviceId: 'd2', token: 't2' });
  assert.equal(fs.existsSync(bridgeConfigPath()), true);

  const controller = new AbortController();
  const api = fakeApi([async () => {
    throw new NotPairedError();
  }], controller);
  api.server = 'https://x';

  const exit = await runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async () => {},
    logger: quiet,
    execute: async () => {},
  });

  assert.deepEqual(exit, {
    reason: 'not-paired',
    message: 'This computer is not paired with https://x — copy the install command from the Unity Bridge dialog again.',
  });
  assert.equal(exit.message, notPairedText('https://x'));
  assert.ok(NOT_PAIRED.startsWith('This computer is not paired with'));
  assert.equal(readBridgeConfig('https://x'), null);
  assert.ok(readBridgeConfig('http://localhost:5173'));
  assert.equal(controller.signal.aborted, false);
});

test('stopping settles a running job so the chat never waits on it', async () => {
  const controller = new AbortController();
  const dispatch = { jobId: 'job_r', op: { kind: 'unity.list' }, allowScripts: false, consentGranted: false };
  let started;
  const isStarted = new Promise((r) => (started = r));
  const polls = [
    async () => ({ status: 200, body: { jobs: [dispatch], cancels: [] } }),
    async () => {
      await isStarted;
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  ];
  const api = fakeApi(polls, controller);

  await runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async () => {},
    logger: quiet,
    stoppedText: 'The Desktop Agent bridge was stopped (Ctrl-C).',
    execute: (d, emit, signal) =>
      new Promise((resolve) => {
        started();
        signal.addEventListener('abort', resolve);
      }),
  });

  const events = api.calls.filter((c) => c.path === '/api/bridge/result').map((c) => c.body.events[0]);
  assert.deepEqual(events, [
    { jobId: 'job_r', type: 'final', result: { ok: false, text: 'The Desktop Agent bridge was stopped (Ctrl-C).' } },
  ]);
});

test('a job whose id is not a plain token (../../Assets) is dropped before it is queued — never executed, never echoed', async (t) => {
  const P = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-loop-proj-'));
  t.after(() => fs.rmSync(P, { recursive: true, force: true }));
  fs.mkdirSync(path.join(P, 'Assets'));
  const controller = new AbortController();
  const evil = { jobId: '../../Assets', op: { kind: 'unity.list' }, allowScripts: false, consentGranted: false };
  const good = { ...evil, jobId: 'brg_abc_123' };
  let goodDone;
  const done = new Promise((r) => (goodDone = r));
  const api = fakeApi([async () => ({ status: 200, body: { jobs: [evil, good], cancels: [] } })], controller, done);
  const executed = [];
  const errors = [];
  await runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async () => {},
    logger: { ...quiet, error: (m) => errors.push(m) },
    execute: async (d) => {
      executed.push(d.jobId);
      goodDone();
    },
  });
  assert.deepEqual(executed, ['brg_abc_123']);
  assert.ok(!JSON.stringify(api.calls.filter((c) => c.path === '/api/bridge/result')).includes('../../Assets'));
  assert.equal(errors.filter((e) => e.includes('not a plain token')).length, 1);
  assert.ok(fs.existsSync(path.join(P, 'Assets')));
});

/** A fake api for one server in a multi-server run: `jobs` are dispatched on its first poll, then it parks. */
function serverApi(server, jobs, stop) {
  const results = [];
  let polled = false;
  return {
    server,
    results,
    async post(p, body) {
      if (p === '/api/bridge/result') {
        results.push(...body.events);
        return { status: 200, body: {} };
      }
      if (!polled) {
        polled = true;
        return { status: 200, body: { jobs, cancels: [] } };
      }
      await stop;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  };
}

test('several App Builders: one loop each, ONE shared queue — jobs never run side by side, each reports to its own server (D55)', async () => {
  const controller = new AbortController();
  const job = (id) => ({ jobId: id, op: { kind: 'unity.list' }, allowScripts: true, consentGranted: false });
  let allDone;
  const done = new Promise((r) => (allDone = r));
  const stop = done.then(() => controller.abort());
  const a = serverApi('http://localhost:5173', [job('a1'), job('a2')], stop);
  const b = serverApi('https://app.babylontoolkit.com', [job('b1')], stop);
  let running = 0;
  let maxRunning = 0;
  const order = [];
  const queue = createJobQueue({
    logger: quiet,
    execute: async (d, emit, signal, source) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(`${source.server} ${d.jobId}`);
      await new Promise((r) => setTimeout(r, 5));
      await emit({ jobId: d.jobId, type: 'final', result: { ok: true, text: source.server } });
      running -= 1;
      if (order.length === 3) allDone();
    },
  });
  const common = { hello, queue, signal: controller.signal, sleep: async () => {}, logger: quiet };
  const exits = await Promise.all([runLoop({ ...common, api: a }), runLoop({ ...common, api: b })]);

  assert.equal(maxRunning, 1);
  assert.equal(order.length, 3);
  assert.deepEqual(exits.map((e) => e.reason), ['stopped', 'stopped']);
  assert.deepEqual(a.results.map((e) => [e.jobId, e.result.text]).sort(), [['a1', 'http://localhost:5173'], ['a2', 'http://localhost:5173']]);
  assert.deepEqual(b.results.map((e) => [e.jobId, e.result.text]), [['b1', 'https://app.babylontoolkit.com']]);
});

test('a 401 from one App Builder stops only ITS loop and drops only its queued jobs; the other keeps serving', async () => {
  const controller = new AbortController();
  const cleared = [];
  let bJobRan;
  const bRan = new Promise((r) => (bJobRan = r));
  const job = (id) => ({ jobId: id, op: { kind: 'unity.list' }, allowScripts: true, consentGranted: false });
  // A: dispatches a job, then is revoked on its next poll
  let aPolls = 0;
  const aResults = [];
  const a = {
    server: 'https://revoked.example',
    async post(p, body) {
      if (p === '/api/bridge/result') {
        aResults.push(...body.events);
        return { status: 200, body: {} };
      }
      aPolls += 1;
      if (aPolls === 1) return { status: 200, body: { jobs: [job('a1')], cancels: [] } };
      throw new NotPairedError();
    },
  };
  // B: keeps polling (empty) until its job ran after A's loop ended
  let aEnded;
  const aGone = new Promise((r) => (aEnded = r));
  let bPolls = 0;
  const bResults = [];
  const b = {
    server: 'https://still-paired.example',
    async post(p, body) {
      if (p === '/api/bridge/result') {
        bResults.push(...body.events);
        return { status: 200, body: {} };
      }
      bPolls += 1;
      if (bPolls === 1) {
        await aGone;
        return { status: 200, body: { jobs: [job('b1')], cancels: [] } };
      }
      await bRan;
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  };
  let releaseA;
  const aHeld = new Promise((r) => (releaseA = r));
  const queue = createJobQueue({
    logger: quiet,
    execute: async (d, emit, signal) => {
      if (d.jobId === 'a1') {
        await Promise.race([aHeld, new Promise((r) => signal.addEventListener('abort', r))]);
        return;
      }
      await emit({ jobId: d.jobId, type: 'final', result: { ok: true, text: 'ok' } });
      bJobRan();
    },
  });
  const common = { hello, queue, signal: controller.signal, sleep: async () => {}, logger: quiet };
  const aLoop = runLoop({ ...common, api: a, clearConfig: () => cleared.push(a.server) }).then((exit) => {
    aEnded();
    return exit;
  });
  const bLoop = runLoop({ ...common, api: b, clearConfig: () => cleared.push(b.server) });
  const [aExit, bExit] = await Promise.all([aLoop, bLoop]);
  releaseA();

  assert.equal(aExit.reason, 'not-paired');
  assert.equal(aExit.message, notPairedText('https://revoked.example'));
  assert.equal(bExit.reason, 'stopped');
  assert.deepEqual(cleared, ['https://revoked.example']);
  // the revoked server is never reported to (every post would be a 401); B's job still ran
  assert.deepEqual(aResults, []);
  assert.deepEqual(bResults.map((e) => e.jobId), ['b1']);
});
