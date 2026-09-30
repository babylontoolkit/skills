'use strict';

/**
 * Unity Bridge wire protocol.
 *
 * Port of the App Builder's `app/lib/bridge/protocol.ts` — keep the constants identical (D3).
 * The types live there as TypeScript; here they are described in JSDoc only.
 */

const BRIDGE_POLL_HOLD_MS = 25_000;
const BRIDGE_PRESENCE_MS = 45_000;
const BRIDGE_PICKUP_TIMEOUT_MS = 30_000;
const BRIDGE_SYNC_WAIT_MS = 60_000;
const BRIDGE_JOB_WAIT_MAX_S = 90;
const BRIDGE_CONSENT_TIMEOUT_MS = 120_000;
const BRIDGE_JOB_RETENTION_MS = 600_000;
const BRIDGE_LAST_SEEN_WRITE_MS = 60_000;
const BRIDGE_MAX_RESULT_CHARS = 20_000;
const BRIDGE_MAX_IMAGE_BASE64 = 400_000;
const BRIDGE_MAX_CAPTURE_PX = 1024;
const BRIDGE_TOOLKIT_MIN_VERSION = '9.25.1';
const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * @typedef {{ key: string, name: string, productGuid?: string, unityVersion?: string, toolkitVersion?: string, pipelineVersion?: string }} BridgeUnityProject
 * @typedef {{ running: boolean, origin?: string, root?: string, project?: string, listen?: 'loopback'|'all', scenes?: string[] }} BridgeDevServerInfo
 * @typedef {{
 *   protocol: number,
 *   helperVersion: string,
 *   os: 'darwin'|'win32'|'linux',
 *   unityCli?: { path: string, version: string },
 *   blender?: { path: string, version: string },
 *   projectsDir: string,
 *   unityProjects: BridgeUnityProject[],
 *   currentProject?: string,
 *   devServer?: BridgeDevServerInfo,
 *   scriptsDisabledLocally: boolean,
 * }} BridgeHello
 *   (`projectsDir` is the BASENAME of the projects folder — a full local path never leaves this computer;
 *   `currentProject` names the project every Unity/Blender job runs against, D54.)
 * @typedef {{ kind: string, [key: string]: unknown }} BridgeOperation
 *   (includes `{ kind: 'unity.project', action: 'list'|'open'|'create', name?: string }`, D54)
 * @typedef {{ jobId: string, op: BridgeOperation, allowScripts: boolean, consentGranted: boolean }} BridgeDispatch
 * @typedef {{ jobId: string, cancel: true }} BridgeCancel
 * @typedef {{ jobs: BridgeDispatch[], cancels: BridgeCancel[] }} BridgePollResponse
 * @typedef {{ ok: boolean, text: string, image?: { base64: string, mimeType: 'image/png' }, exitCode?: number }} BridgeResultPayload
 * @typedef {{ jobId: string, type: 'started' }
 *   | { jobId: string, type: 'progress', line: string }
 *   | { jobId: string, type: 'final', result: BridgeResultPayload }
 *   | { jobId: string, type: 'refused', reason: string }} BridgeJobEvent
 */

/**
 * A job id is used in file names on this computer (`.bridge/…/<jobId>`), so the helper accepts only
 * this shape whatever the server sent (D3). The App Builder mints `brg_<time>_<hex>`.
 */
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} jobId @returns {jobId is string} */
function isSafeJobId(jobId) {
  return typeof jobId === 'string' && SAFE_JOB_ID.test(jobId);
}

/**
 * Keep the TAIL; announce truncation.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function capText(text, max = BRIDGE_MAX_RESULT_CHARS) {
  return text.length <= max ? text : `…(earlier output truncated)\n${text.slice(text.length - max)}`;
}

module.exports = {
  BRIDGE_POLL_HOLD_MS,
  BRIDGE_PRESENCE_MS,
  BRIDGE_PICKUP_TIMEOUT_MS,
  BRIDGE_SYNC_WAIT_MS,
  BRIDGE_JOB_WAIT_MAX_S,
  BRIDGE_CONSENT_TIMEOUT_MS,
  BRIDGE_JOB_RETENTION_MS,
  BRIDGE_LAST_SEEN_WRITE_MS,
  BRIDGE_MAX_RESULT_CHARS,
  BRIDGE_MAX_IMAGE_BASE64,
  BRIDGE_MAX_CAPTURE_PX,
  BRIDGE_TOOLKIT_MIN_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  capText,
  SAFE_JOB_ID,
  isSafeJobId,
};
