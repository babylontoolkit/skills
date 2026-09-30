'use strict';

const { NotPairedError, UpdateRequiredError } = require('./api');
const { deleteBridgeConfig } = require('./config');
const { capText, isSafeJobId } = require('./protocol');
const log = require('./log');

/** Network back-off: 1 s, 2 s, 5 s, 10 s, then 30 s thereafter; reset on the first success. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

const NOT_PAIRED = 'This device was removed from your account. Run bt-agent bridge again to pair it.';
const STOPPED = 'The Desktop Agent bridge was stopped (Ctrl-C).';
const STOPPED_BEFORE_START = 'The Desktop Agent bridge was stopped before this job started.';

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {import('./protocol').BridgeDispatch} BridgeDispatch
 * @typedef {import('./protocol').BridgeJobEvent} BridgeJobEvent
 * @typedef {(event: BridgeJobEvent) => Promise<void>} Emit
 * @typedef {(dispatch: BridgeDispatch, emit: Emit, signal: AbortSignal) => Promise<void>} Execute
 * @typedef {{ reason: 'stopped'|'not-paired'|'update-required', message?: string }} LoopExit
 */

/**
 * The bridge's long-poll loop (D4). Each poll carries a fresh `hello`; jobs are queued per Unity project
 * and each queue runs ONE job at a time (two operations on one Unity project must never interleave),
 * while jobs for different projects run side by side. Job execution is never awaited by the poll.
 *
 * @param {{
 *   api: { post: (path: string, body: unknown, signal?: AbortSignal) => Promise<{ status: number, body: any }> },
 *   hello: () => Promise<object>|object,
 *   execute: Execute,
 *   onCancel?: (jobId: string) => void,
 *   onPolling?: () => void,
 *   signal: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   logger?: typeof log,
 *   clearConfig?: () => void,
 *   stoppedText?: string,
 * }} opts
 * @returns {Promise<LoopExit>}
 */
async function runLoop({
  api,
  hello,
  execute,
  onCancel,
  onPolling,
  signal,
  sleep = defaultSleep,
  logger = log,
  clearConfig = deleteBridgeConfig,
  stoppedText = STOPPED,
}) {
  /** @type {Map<string, BridgeDispatch[]>} queued, not yet started, per unityProjectKey */
  const queues = new Map();
  /** @type {Set<string>} keys whose queue is currently running a job */
  const busy = new Set();
  /** @type {Map<string, AbortController>} running jobs */
  const running = new Map();
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();

  /** @type {Emit} */
  const emit = async (event) => {
    try {
      const r = await api.post('/api/bridge/result', { events: [event] });
      if (r.status !== 200) logger.error(`Could not report job ${event.jobId} (HTTP ${r.status}).`);
    } catch (err) {
      logger.error(`Could not report job ${event.jobId}: ${err.message}`);
    }
  };

  /** @param {string} key */
  const drain = (key) => {
    if (busy.has(key) || signal.aborted) return;
    const queue = queues.get(key);
    const dispatch = queue && queue.shift();
    if (!dispatch) {
      queues.delete(key);
      return;
    }
    busy.add(key);
    const controller = new AbortController();
    running.set(dispatch.jobId, controller);
    const task = (async () => {
      try {
        await execute(dispatch, emit, controller.signal);
      } catch (err) {
        // An executor that throws must still settle the job, or the chat waits on it.
        await emit({
          jobId: dispatch.jobId,
          type: 'final',
          result: { ok: false, text: capText(`The Desktop Agent failed: ${err && err.message ? err.message : err}`) },
        });
      } finally {
        running.delete(dispatch.jobId);
        busy.delete(key);
        drain(key);
      }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  };

  /** @param {string} jobId */
  const cancel = (jobId) => {
    const controller = running.get(jobId);
    if (controller) controller.abort();
    for (const [key, queue] of queues) {
      const i = queue.findIndex((d) => d.jobId === jobId);
      if (i >= 0) queue.splice(i, 1);
      if (!queue.length && !busy.has(key)) queues.delete(key);
    }
    if (onCancel) onCancel(jobId);
  };

  let failures = 0;
  let announced = false;
  let warnedUnsafeId = false;
  /** @type {LoopExit} */
  let exit = { reason: 'stopped' };

  while (!signal.aborted) {
    try {
      const h = await hello();
      if (!announced) {
        announced = true;
        if (onPolling) onPolling();
      }
      const r = await api.post('/api/bridge/poll', { hello: h }, signal);
      if (r.status !== 200) {
        const message = r.body && r.body.message ? `: ${r.body.message}` : '';
        throw new Error(`poll failed (HTTP ${r.status}${message})`);
      }
      failures = 0;

      const body = r.body || {};
      for (const c of Array.isArray(body.cancels) ? body.cancels : []) {
        if (c && typeof c.jobId === 'string') cancel(c.jobId);
      }
      for (const dispatch of Array.isArray(body.jobs) ? body.jobs : []) {
        if (!dispatch || typeof dispatch.jobId !== 'string') continue;
        if (!isSafeJobId(dispatch.jobId)) {
          // The id names files on this computer; one that is not a plain token is never run, and is
          // not echoed back either (D3). The server's pickup timeout cancels it.
          if (!warnedUnsafeId) {
            warnedUnsafeId = true;
            logger.error('Ignored a job from the App Builder whose id is not a plain token.');
          }
          continue;
        }
        const key = typeof dispatch.unityProjectKey === 'string' ? dispatch.unityProjectKey : '';
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(dispatch);
        drain(key);
      }
    } catch (err) {
      if (err instanceof NotPairedError) {
        clearConfig();
        exit = { reason: 'not-paired', message: NOT_PAIRED };
        break;
      }
      if (err instanceof UpdateRequiredError) {
        exit = { reason: 'update-required', message: err.message };
        break;
      }
      if (signal.aborted) break;
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures += 1;
      logger.error(`Lost the App Builder (${err.message}); retrying in ${wait / 1000}s.`);
      await sleep(wait);
    }
  }

  // Stopping: settle everything this device holds so nothing in the chat waits on it.
  // A revoked device cannot report anything (every post is a 401); the server settles its jobs itself.
  const canReport = exit.reason !== 'not-paired';
  const text = exit.reason === 'stopped' ? stoppedText : exit.message || stoppedText;
  const settles = [];
  for (const [jobId, controller] of running) {
    controller.abort();
    if (canReport) settles.push(emit({ jobId, type: 'final', result: { ok: false, text } }));
  }
  for (const queue of queues.values()) {
    for (const d of queue) {
      if (canReport) settles.push(emit({ jobId: d.jobId, type: 'refused', reason: STOPPED_BEFORE_START }));
    }
  }
  queues.clear();
  await Promise.all(settles);

  return exit;
}

module.exports = { runLoop, BACKOFF_MS, NOT_PAIRED, STOPPED };
