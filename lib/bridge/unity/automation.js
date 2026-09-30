'use strict';

/**
 * Unity automation grants (D51). Before every `bt_*` Unity command the helper makes sure it holds a
 * grant for that project with more than 2 h left (fetching `POST /api/bridge/grant` otherwise), then
 * hands it to the Editor with `unity command bt_automation --grant <grant>` — every time, since grants
 * live in Editor memory only and an Editor restart forgets them.
 *
 * The grant is kept in THIS process's memory only. It is never written to disk, never logged, never
 * put in a progress line or a job result. A refused or unavailable grant never fails the job: the
 * export then runs under the user's own Babylon Toolkit licence.
 */

const REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;

/** The reason in an "automation unavailable" log line is cut to this many characters. */
const MAX_LOGGED_REASON = 200;

/**
 * @typedef {{ post: (path: string, body: unknown, signal?: AbortSignal) => Promise<{ status: number, body: any }> }} GrantApi
 * @typedef {(args: string[]) => Promise<import('./run').RunResult>} RunUnity
 * @typedef {{ info: (msg: string) => void }} InfoLog
 */

/** @param {unknown} value @returns {number} epoch ms, or NaN */
function toEpochMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

/** @param {string} text @param {string|undefined} grant */
function scrub(text, grant) {
  const s = String(text || '');
  return grant ? s.split(grant).join('[grant]') : s;
}

/** A fresh, independent grant store (tests use their own; the helper uses the module one). */
function createAutomation() {
  /** @type {Map<string, { grant: string, expiresAtMs: number }>} */
  const held = new Map();
  /** @type {Set<string>} */
  const warned = new Set();

  /**
   * @param {{ productGuid?: string, root?: string }} project
   * @param {{ api: GrantApi, runUnity: RunUnity, now?: () => number, log: InfoLog }} deps
   * @returns {Promise<'on'|'off'>}
   */
  async function ensureAutomation(project, { api, runUnity, now = Date.now, log }) {
    const guid = project && project.productGuid;
    if (!guid) return 'off';

    /**
     * Logged once per DISTINCT message for a key — a later, different failure is still reported — and the
     * message is capped (the Pipeline's "no such command" error lists every available command).
     * @param {string} key @param {string} message
     */
    const once = (key, message) => {
      const flat = String(message).replace(/\s+/g, ' ').trim();
      const shown = flat.length > MAX_LOGGED_REASON ? flat.slice(0, MAX_LOGGED_REASON - 1) + '…' : flat;
      const seen = `${key}\0${shown}`;
      if (warned.has(seen)) return;
      warned.add(seen);
      log.info(`Unity automation unavailable: ${shown} — exports use your own Babylon Toolkit licence.`);
    };

    let entry = held.get(guid);
    if (!entry || entry.expiresAtMs - now() < REFRESH_BEFORE_MS) {
      held.delete(guid);
      entry = undefined;
      try {
        const r = await api.post('/api/bridge/grant', { productGuid: guid });
        const grant = r && r.body && typeof r.body.grant === 'string' ? r.body.grant : '';
        const expiresAtMs = toEpochMs(r && r.body && r.body.expiresAt);
        if (r.status === 200 && grant && Number.isFinite(expiresAtMs)) {
          entry = { grant, expiresAtMs };
          held.set(guid, entry);
        } else {
          const message =
            (r && r.body && typeof r.body.message === 'string' && r.body.message) ||
            `the App Builder answered HTTP ${r ? r.status : '?'}`;
          once(`grant:${guid}`, scrub(message, grant));
          return 'off';
        }
      } catch (err) {
        once(`grant:${guid}`, err && err.message ? err.message : String(err));
        return 'off';
      }
    }

    const grant = entry.grant;
    try {
      const res = await runUnity([
        'command',
        'bt_automation',
        '--grant',
        grant,
        '--project-path',
        /** @type {string} */ (project.root),
        '--format',
        'json',
        '--non-interactive',
      ]);
      let ok = res.code === 0 && !res.timedOut;
      let detail = '';
      try {
        const env = JSON.parse(res.stdout);
        ok = env && env.success === true;
        const first = env && Array.isArray(env.errors) && env.errors[0];
        detail = (first && first.message) || '';
      } catch {
        detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).pop() || '';
      }
      if (ok) return 'on';
      once(`run:${guid}`, scrub(detail || 'the Unity Editor refused the grant', grant));
      return 'off';
    } catch (err) {
      once(`run:${guid}`, scrub(err && err.message ? err.message : String(err), grant));
      return 'off';
    }
  }

  return { ensureAutomation, reset: () => (held.clear(), warned.clear()) };
}

const shared = createAutomation();

module.exports = {
  ensureAutomation: shared.ensureAutomation,
  resetAutomation: shared.reset,
  createAutomation,
  REFRESH_BEFORE_MS,
  MAX_LOGGED_REASON,
};
