'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runLoop, BACKOFF_MS, NOT_PAIRED } = require('../lib/bridge/loop');
const { NotPairedError } = require('../lib/bridge/api');
const { writeBridgeConfig, bridgeConfigPath } = require('../lib/bridge/config');

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
    unityProjectKey: 'k1',
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

test('jobs for one Unity project run one at a time', async () => {
  const controller = new AbortController();
  const job = (id) => ({ jobId: id, op: { kind: 'unity.list' }, unityProjectKey: 'k', allowScripts: false, consentGranted: false });
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

test('a removed device ends the loop and deletes the credential', async (t) => {
  scratch(t);
  writeBridgeConfig({ server: 'https://x', deviceId: 'd', token: 't' });
  assert.equal(fs.existsSync(bridgeConfigPath()), true);

  const controller = new AbortController();
  const api = fakeApi([async () => {
    throw new NotPairedError();
  }], controller);

  const exit = await runLoop({
    api,
    hello,
    signal: controller.signal,
    sleep: async () => {},
    logger: quiet,
    execute: async () => {},
  });

  assert.deepEqual(exit, { reason: 'not-paired', message: NOT_PAIRED });
  assert.equal(fs.existsSync(bridgeConfigPath()), false);
  assert.equal(controller.signal.aborted, false);
});

test('stopping settles a running job so the chat never waits on it', async () => {
  const controller = new AbortController();
  const dispatch = { jobId: 'job_r', op: { kind: 'unity.list' }, unityProjectKey: 'k', allowScripts: false, consentGranted: false };
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
  const evil = { jobId: '../../Assets', op: { kind: 'unity.list' }, unityProjectKey: 'k', allowScripts: false, consentGranted: false };
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
