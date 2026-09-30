'use strict';

const { NotPairedError, UpdateRequiredError } = require('./api');
const { deleteBridgeConfig } = require('./config');
const { capText, isSafeJobId } = require('./protocol');
const log = require('./log');

/** Network back-off: 1 s, 2 s, 5 s, 10 s, then 30 s thereafter; reset on the first success. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/** @param {string} server */
const notPairedText = (server) =>
  `This computer is not paired with ${server} — copy the install command from the Unity Bridge dialog again.`;
const NOT_PAIRED = notPairedText('the App Builder');
const STOPPED = 'The Desktop Agent bridge was stopped (Ctrl-C).';
const STOPPED_BEFORE_START = 'The Desktop Agent bridge was stopped before this job started.';

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {import('./protocol').BridgeDispatch} BridgeDispatch
 * @typedef {import('./protocol').BridgeJobEvent} BridgeJobEvent
 * @typedef {(event: BridgeJobEvent) => Promise<void>} Emit
 * @typedef {{ api?: any, server?: string }} JobSource the App Builder a job came from
 * @typedef {(dispatch: BridgeDispatch, emit: Emit, signal: AbortSignal, source?: JobSource) => Promise<void>} Execute
 * @typedef {{ reason: 'stopped'|'not-paired'|'update-required', message?: string }} LoopExit
 */

/**
 * THE job queue (D54, D55). Every job works on the helper's CURRENT project and `unity_project open`
 * changes which one that is, so jobs run ONE at a time, in arrival order — and with several App Builders
 * (one poll loop each) they still share this one queue, so two builders can never drive Unity at once.
 * Each job remembers its owner (the loop that received it) and reports through that loop's `emit`.
 *
 * @param {{ execute: Execute, logger?: typeof log }} opts
 */
function createJobQueue({ execute, logger = log }) {
  /** @typedef {{ dispatch: BridgeDispatch, emit: Emit, owner: object, source?: JobSource }} Entry */
  /** @type {Entry[]} */
  const queue = [];
  /** @type {(Entry & { controller: AbortController })|null} */
  let current = null;
  let closed = false;
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();

  const drain = () => {
    if (current || closed) return;
    const entry = queue.shift();
    if (!entry) return;
    const controller = new AbortController();
    const running = { ...entry, controller };
    current = running;
    const task = (async () => {
      try {
        await execute(entry.dispatch, entry.emit, controller.signal, entry.source);
      } catch (err) {
        // An executor that throws must still settle the job, or the chat waits on it.
        await entry.emit({
          jobId: entry.dispatch.jobId,
          type: 'final',
          result: { ok: false, text: capText(`The Desktop Agent failed: ${err && err.message ? err.message : err}`) },
        });
      } finally {
        if (current === running) current = null;
        drain();
      }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  };

  return {
    /** @param {object} owner @param {BridgeDispatch} dispatch @param {Emit} emit @param {JobSource} [source] */
    enqueue(owner, dispatch, emit, source) {
      if (closed) return;
      queue.push({ owner, dispatch, emit, source });
      drain();
    },
    /** Cancels a job of `owner` (running or queued). @param {object} owner @param {string} jobId */
    cancel(owner, jobId) {
      if (current && current.owner === owner && current.dispatch.jobId === jobId) current.controller.abort();
      const i = queue.findIndex((e) => e.owner === owner && e.dispatch.jobId === jobId);
      if (i >= 0) queue.splice(i, 1);
    },
    /**
     * Stops everything `owner` holds: its running job is aborted and settled with `text`, its queued jobs
     * are refused — both only when `canReport` (a revoked device cannot report; its server settles them).
     * @param {object} owner @param {{ text: string, canReport: boolean }} how
     */
    async stopOwner(owner, { text, canReport }) {
      const settles = [];
      if (current && current.owner === owner) {
        current.controller.abort();
        if (canReport) settles.push(current.emit({ jobId: current.dispatch.jobId, type: 'final', result: { ok: false, text } }));
      }
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const e = queue[i];
        if (e.owner !== owner) continue;
        queue.splice(i, 1);
        if (canReport) settles.push(e.emit({ jobId: e.dispatch.jobId, type: 'refused', reason: STOPPED_BEFORE_START }));
      }
      await Promise.all(settles);
    },
    /** Nothing new starts after this. */
    close() {
      closed = true;
    },
    /** how many jobs are queued or running (tests) */
    size() {
      return queue.length + (current ? 1 : 0);
    },
    logger,
  };
}

/** @typedef {ReturnType<typeof createJobQueue>} JobQueue */

/**
 * The bridge's long-poll loop for ONE App Builder (D4). Each poll carries a fresh `hello`; jobs go into
 * the shared queue (one is made when none is passed) and are never awaited by the poll.
 *
 * @param {{
 *   api: { server?: string, post: (path: string, body: unknown, signal?: AbortSignal) => Promise<{ status: number, body: any }> },
 *   hello: () => Promise<object>|object,
 *   execute?: Execute,
 *   queue?: JobQueue,
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
  queue,
  onCancel,
  onPolling,
  signal,
  sleep = defaultSleep,
  logger = log,
  clearConfig,
  stoppedText = STOPPED,
}) {
  const server = typeof api.server === 'string' ? api.server : 'the App Builder';
  const jobs = queue || createJobQueue({ execute: /** @type {Execute} */ (execute), logger });
  const owner = {};
  /** @type {JobSource} */
  const source = { api, server };
  const forget = clearConfig || (() => deleteBridgeConfig(typeof api.server === 'string' ? api.server : undefined));

  /** @type {Emit} */
  const emit = async (event) => {
    try {
      const r = await api.post('/api/bridge/result', { events: [event] });
      if (r.status !== 200) logger.error(`Could not report job ${event.jobId} (HTTP ${r.status}).`);
    } catch (err) {
      logger.error(`Could not report job ${event.jobId}: ${err.message}`);
    }
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
        if (c && typeof c.jobId === 'string') {
          jobs.cancel(owner, c.jobId);
          if (onCancel) onCancel(c.jobId);
        }
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
        jobs.enqueue(owner, dispatch, emit, source);
      }
    } catch (err) {
      if (err instanceof NotPairedError) {
        try {
          forget();
        } catch {
          // the credential is dead either way
        }
        exit = { reason: 'not-paired', message: notPairedText(server) };
        break;
      }
      if (err instanceof UpdateRequiredError) {
        exit = { reason: 'update-required', message: err.message };
        break;
      }
      if (signal.aborted) break;
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures += 1;
      logger.error(`Lost ${server} (${err.message}); retrying in ${wait / 1000}s.`);
      await sleep(wait);
    }
  }

  // Stopping: settle everything this loop holds so nothing in the chat waits on it.
  // A revoked device cannot report anything (every post is a 401); the server settles its jobs itself.
  const text = exit.reason === 'stopped' ? stoppedText : exit.message || stoppedText;
  await jobs.stopOwner(owner, { text, canReport: exit.reason !== 'not-paired' });

  return exit;
}

module.exports = { runLoop, createJobQueue, notPairedText, BACKOFF_MS, NOT_PAIRED, STOPPED, STOPPED_BEFORE_START };
