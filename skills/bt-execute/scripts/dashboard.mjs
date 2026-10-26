#!/usr/bin/env node
/**
 * Feature dashboard helper for bt-execute: the one way agents write a feature's dashboard data, the writer of the
 * live status, the gate that catches a skipped deliverable, and a watchdog for manual use.
 *
 * Every write reads the data file, parses its strict JSON, changes it and writes it back atomically (a temp file
 * renamed over the original), so the page can never load a half-written file and no hand edit can break it.
 *
 *   node dashboard.mjs live     <feature-folder> --task T19 --role implementer --activity "…" [--phase 7] [--step "…"]… [--reset] [--title "…"]
 *   node dashboard.mjs task     <feature-folder> <task-id> --set '{"status":"built","summary":"…"}' [--note "why an earlier result changed" --by T21] [--no-frame "why a visual task has no built frame"]
 *   node dashboard.mjs snapshot <feature-folder> <T7|P2|plan> --src snapshots/T7-01-stage.png --caption "…" [--title "…"] [--source unity]
 *                              (comparison: --before snapshots/a.png --after snapshots/b.png [--before-caption …] [--after-caption …];
 *                               progression: --frame "snapshots/x.png|stage|caption" repeated)
 *   node dashboard.mjs snapshot <feature-folder> comparison --before snapshots/plan-before.png --after snapshots/plan-after.png --caption "…"
 *                              (the After Action Report's one plan-wide before/after — replaces the previous one)
 *   node dashboard.mjs followup <feature-folder> --title "…" --detail "…" [--source "T2 verifier"] [--file path]…
 *                              (revise one: --id F2 [--title …] [--detail …] [--file …] --note "why it changed" [--by T4])
 *   node dashboard.mjs activity <feature-folder> "Phase 2 verified — T4–T6 PASS"
 *   node dashboard.mjs status   <feature-folder> in-progress|paused|complete|incomplete
 *   node dashboard.mjs check    <feature-folder>
 *   node dashboard.mjs watch    <feature-folder> [--watch <folder>]… [--interval-seconds 60] [--quiet-minutes 10] [--stall-minutes 30] [--max-hours 12]
 *
 * <feature-folder> is .agents/specs/<slug>. Timestamps come from this machine's local clock.
 *
 * The live file (`documents/<slug>_live.js`) is how the page shows the run is alive. Every `task --set` that changes a
 * task's `status` rewrites it from that change (the task, its phase, the role its status implies, one sentence on its
 * new state plus the summary's first sentence, and a step in its log), every `snapshot` adds a step, and every
 * `status` write records the run starting or ending. A `--set` without `status` leaves it untouched. Between those,
 * agents write `live` at each meaningful step (before anything slow, at each fix attempt), and `watch` — the
 * watchdog bt-execute launches in the background at run start — writes a heartbeat after 10 quiet minutes.
 *
 * Snapshots go in only through `snapshot`. `task --set` and `check` refuse any snapshot entry the page cannot show —
 * an image under `path` (or `file`, `image`, …) instead of `src`, or a `src` that is not a file under the feature
 * folder — because such an entry renders as "No snapshot".
 *
 * The snapshots are the story of how the plan was built, so frames are never left behind. A `task --set` that moves
 * a task to `built`, `verifying` or `done` is refused while `snapshots/` holds a `<task-id>-…` image no dashboard entry
 * shows — add each with `snapshot` first. Moving a visual task (kind live, game or unity) to `built` with no snapshot
 * at all is refused too, unless `--no-frame "<reason>"` records why it has nothing to show yet.
 *
 * Follow-ups — what a human should look at next — are added with `followup`, which numbers them `F1`, `F2`, … and
 * rewrites `documents/<slug>_followups.md`: each follow-up in full, the document bt-spec reads when the dashboard's
 * `/bt-spec Fix F1 and F3 from @…_followups.md` command is run. A follow-up written as plain text is repaired into
 * one with an id by every write, and `check` rewrites the document.
 *
 * `check` is the gate at every phase boundary and at run end. Beyond the snapshots it fails, listing every problem in
 * one message, when a deliverable was skipped: a `documents/<slug>_plan.md` without `dashboard.html`, the dashboard
 * data or the live file; dashboard tasks that differ from the plan's checklist (ids or order); a `complete` status
 * while the plan has an unticked box or without `documents/<slug>_summary.html`; a visual task (kind live, game or
 * unity) that is `done` with no snapshot of its own or progression frame tagged with its id; a task ticked in the plan
 * whose dashboard entry has no verifier result. With no plan in the folder, the plan checks are skipped. It also
 * fails on frames left behind in `snapshots/`: a built or finished task's `T<n>-…` images, a closed phase's `P<N>-…`
 * images and — once a run has ended — a `plan-before` image that no dashboard entry shows.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** How many entries a task's live step log keeps. */
const MAXIMUM_LIVE_STEPS = 12;
/** The prefix a live file starts with when the helper creates it. */
const LIVE_PREFIX = 'window.FEATURE_LIVE';
/** Who is working on a task in each status — the live file's `role` after a `task` write; anything else is the orchestrator. */
const ROLE_FOR_TASK_STATUS = { 'in-progress': 'implementer', built: 'implementer', verifying: 'verifier' };
/** How the live file names a snapshot target that is not a task or phase id. */
const SNAPSHOT_OWNER_NAMES = { plan: 'the After Action Report', comparison: 'the plan-wide before/after' };
/** Task kinds whose result is seen on screen, so a `done` task of this kind must have a snapshot. */
const VISUAL_TASK_KINDS = new Set(['live', 'game', 'unity']);
/** Task statuses that mean its builder is finished, so every frame saved for it belongs on the dashboard. */
const BUILT_TASK_STATUSES = new Set(['built', 'verifying', 'done']);
/** Phase statuses that mean a phase is closed, so every `P<N>-…` frame saved for it belongs on the dashboard. */
const CLOSED_PHASE_STATUSES = new Set(['done', 'partial', 'deferred']);
/** Run statuses that mean a run has ended and written its After Action Report. */
const RUN_ENDED_STATUSES = new Set(['paused', 'complete', 'incomplete']);
/** A follow-up id: `F1`, `F12`. */
const FOLLOW_UP_ID = /^F(\d+)$/;
/** A follow-up written as plain text that starts with its id: `"F3 — The banner stays up"`. */
const FOLLOW_UP_TEXT_WITH_ID = /^(F\d+)\s+[—–-]\s+([\s\S]*)$/;
/** The longest title a follow-up repaired from plain text keeps; the whole text stays in its detail. */
const MAXIMUM_FOLLOW_UP_TITLE = 100;
/** Image files a snapshot can show. */
const SNAPSHOT_IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif)$/i;
/** The plan-wide "before" frame, saved before T1 of the first run. */
const PLAN_BEFORE_FILE = /^plan-before\.(png|jpe?g|webp|gif|avif)$/i;
/** A plan checklist line: `- [ ] **T3.1** — …` or `- [x] T4 …`; captures the tick mark and the task id. */
const PLAN_CHECKLIST_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(?:\*\*)?(T\d+(?:\.\d+)*)\b/;
/** Folders the watchdog never descends into when looking for signs of work. */
const IGNORED_FOLDERS = new Set(['node_modules', '.git', 'Library', 'Temp', 'Logs', 'obj', 'dist', 'build', '.cache', 'profile']);
/** How deep the watchdog looks inside each watched folder. */
const MAXIMUM_SCAN_DEPTH = 5;
/** Task fields that are always lists — appended to, never replaced by a string. */
const TASK_LIST_FIELDS = ['files', 'decisions', 'snapshots', 'updates'];
/** Task fields that are an object or null. */
const TASK_OBJECT_FIELDS = ['tests', 'details'];
/** Statuses that mean a task is being worked on right now. */
const ACTIVE_TASK_STATUSES = new Set(['in-progress', 'built', 'verifying']);
/** Where a snapshot's image may come from. */
const SNAPSHOT_SOURCES = ['browser', 'unity', 'blender', 'reference'];
/** Keys agents reach for instead of `src`; the page reads none of them, so the image never shows. */
const WRONG_IMAGE_KEYS = ['path', 'file', 'image', 'url', 'href'];
/** The three snapshot shapes, quoted in every refusal so the writer can fix the entry in one go. */
const SNAPSHOT_SHAPES_HELP = [
  'still      { "title", "caption", "source", "src": "snapshots/T3-01-stage.png", "updates": [] }',
  'comparison { "title", "caption", "source", "before": { "src", "caption" }, "after": { "src", "caption" }, "updates": [] }',
  'progression { "title", "caption", "source", "frames": [{ "src", "stage", "caption", "task", "at" }], "updates": [] }',
  'Easier: node dashboard.mjs snapshot <feature-folder> <T3|P1|plan> --src snapshots/… --caption "…" builds the entry for you.',
].join('\n  ');

const [command, featureFolder, ...rest] = process.argv.slice(2);

/**
 * The feature's slug: the folder's name, as bt-spec creates it. A folder renamed after the fact keeps its files'
 * original names, so when `documents/<folder name>_dashboard.js` is missing and the folder holds exactly one
 * `documents/*_dashboard.js`, that file's prefix is the slug.
 * @param {string} folder The feature folder.
 * @returns {string}
 */
function featureSlug(folder) {
  const folderName = basename(folder.replace(/[\\/]+$/, ''));
  const documentsFolder = join(folder, 'documents');
  if (existsSync(join(documentsFolder, `${folderName}_dashboard.js`)) || !existsSync(documentsFolder)) return folderName;
  const dataFiles = readdirSync(documentsFolder).filter((name) => name.endsWith('_dashboard.js'));
  return dataFiles.length === 1 ? dataFiles[0].slice(0, -'_dashboard.js'.length) : folderName;
}

/**
 * Reads the paths of a feature folder's two data files.
 * @param {string} folder The feature folder, `.agents/specs/<slug>`.
 * @returns {{ slug: string, dashboardPath: string, livePath: string }}
 */
function dataPaths(folder) {
  const slug = featureSlug(folder);
  return {
    slug,
    dashboardPath: join(folder, 'documents', `${slug}_dashboard.js`),
    livePath: join(folder, 'documents', `${slug}_live.js`),
  };
}

/**
 * Parses a data file: one `window.NAME =` prefix followed by a strict-JSON value.
 * @param {string} path The data file.
 * @returns {{ prefix: string, data: any }}
 */
function readData(path) {
  const text = readFileSync(path, 'utf8');
  const separator = text.indexOf('=');
  if (separator < 0) throw new Error(`${path} has no "window.… =" prefix`);
  const body = text.slice(separator + 1).trim().replace(/;\s*$/, '');
  return { prefix: text.slice(0, separator).trim(), data: JSON.parse(body) };
}

/**
 * Writes a data file atomically: a temp file next to it, then renamed over it.
 * @param {string} path The data file.
 * @param {string} prefix Its `window.NAME` prefix.
 * @param {any} data The value to write.
 */
function writeData(path, prefix, data) {
  // Every dashboard write repairs snapshot entries first, so an image filed under `path` (or any key the page never
  // reads) can never reach the page as "No snapshot", whoever wrote it.
  if (data && Array.isArray(data.phases)) repairSnapshots(data);
  if (data && Array.isArray(data.decisions)) repairDecisions(data);
  if (data && Array.isArray(data.followUps)) repairFollowUps(data);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${prefix} = ${JSON.stringify(data, null, 2)};\n`, 'utf8');
  renameSync(temporaryPath, path);
}

/**
 * The local time as the dashboard expects it.
 * @param {Date} [moment] Defaults to now.
 * @returns {{ stamp: string, clock: string }} `YYYY-MM-DD HH:MM` and `HH:MM`.
 */
function localTime(moment = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
  return { stamp: `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${clock}`, clock };
}

/**
 * Reads `--name value` options; names listed in `repeatable` collect every occurrence.
 * @param {string[]} argumentList The remaining command-line arguments.
 * @param {string[]} [repeatable] Option names that may appear more than once.
 * @returns {{ options: Record<string, any>, positional: string[] }}
 */
function parseOptions(argumentList, repeatable = []) {
  const options = Object.fromEntries(repeatable.map((name) => [name, []]));
  const positional = [];
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    const next = argumentList[index + 1];
    const value = next === undefined || next.startsWith('--') ? true : argumentList[++index];
    if (repeatable.includes(name)) options[name].push(value);
    else options[name] = value;
  }
  return { options, positional };
}

/**
 * Reads the live file, or an empty one when it does not exist yet (the next write creates it).
 * @param {string} livePath The live file.
 * @returns {{ prefix: string, data: any }}
 */
function readLive(livePath) {
  return existsSync(livePath) ? readData(livePath) : { prefix: LIVE_PREFIX, data: {} };
}

/**
 * Rewrites the live status: what is happening this minute.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList Command options.
 */
function writeLive(folder, argumentList) {
  const { options } = parseOptions(argumentList, ['step']);
  const { livePath } = dataPaths(folder);
  const existing = readLive(livePath);
  const live = existing.data;
  const now = localTime();
  const taskChanged = options.task !== undefined && options.task !== live.task;
  const steps = options.reset || taskChanged ? [] : Array.isArray(live.steps) ? live.steps : [];
  for (const step of options.step) steps.push({ at: now.clock, text: String(step) });
  const updated = {
    updatedAt: now.stamp,
    phase: options.phase !== undefined ? Number(options.phase) : live.phase,
    task: options.task !== undefined ? String(options.task) : live.task || '',
    title: options.title !== undefined ? String(options.title) : options.task !== undefined ? '' : live.title || '',
    role: options.role !== undefined ? String(options.role) : live.role || 'orchestrator',
    activity: options.activity !== undefined ? String(options.activity) : live.activity || '',
    steps: steps.slice(-MAXIMUM_LIVE_STEPS),
    source: 'agent',
  };
  writeData(livePath, existing.prefix, updated);
}

/**
 * The first sentence of a text — up to the first `.`, `!` or `?` followed by a space or the end.
 * @param {string} [text] The text, e.g. a task summary.
 * @returns {string} The sentence, trimmed; the whole text when it has no sentence end; `""` for no text.
 */
function firstSentence(text) {
  const trimmed = String(text || '').trim();
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed);
  return match ? match[0] : trimmed;
}

/**
 * One plain-language sentence on a task's state, for the live file.
 * @param {any} task The task, after the change (its `status`, `title`, `attempts`, `deferredReason`).
 * @returns {string}
 */
function taskStatusSentence(task) {
  const name = task.title ? `${task.id} — ${task.title}` : task.id;
  const attempt = Number(task.attempts) || 1;
  const reason = String(task.deferredReason || '').trim().replace(/[.!?]+$/, '');
  switch (task.status) {
    case 'in-progress':
      return attempt > 1 ? `Fixing ${name} after a failed check (attempt ${attempt}).` : `Building ${name}.`;
    case 'built':
      return `${task.id} is built and its tests pass — waiting for the verifier.`;
    case 'verifying':
      return `The verifier is checking ${name}.`;
    case 'done':
      return `${task.id} passed verification and is done.`;
    case 'deferred':
      return reason ? `${task.id} was deferred: ${reason}.` : `${task.id} was deferred.`;
    case 'failed':
      return `${task.id} failed verification.`;
    case 'pending':
      return `${name} is waiting to start.`;
    default:
      return `${task.id} is now ${task.status}.`;
  }
}

/**
 * Rewrites the live file from a task's status change: its phase, the task, the role its status implies, one sentence
 * on its new state (plus the first sentence of the summary written with it), and that sentence appended to the task's
 * step log — a fresh log when the live file named another task. Creates the live file when it is missing.
 * @param {string} folder The feature folder.
 * @param {number} phaseNumber The number of the phase holding the task.
 * @param {any} task The task, after the change.
 * @param {string} [summary] The summary written in the same change, if any.
 */
function writeLiveForTask(folder, phaseNumber, task, summary) {
  const { livePath } = dataPaths(folder);
  const { prefix, data: live } = readLive(livePath);
  const now = localTime();
  const summarySentence = firstSentence(summary);
  const activity = summarySentence ? `${taskStatusSentence(task)} ${summarySentence}` : taskStatusSentence(task);
  const steps = live.task === task.id && Array.isArray(live.steps) ? live.steps : [];
  steps.push({ at: now.clock, text: activity });
  writeData(livePath, prefix, {
    updatedAt: now.stamp,
    phase: phaseNumber,
    task: task.id,
    title: '',
    role: ROLE_FOR_TASK_STATUS[task.status] || 'orchestrator',
    activity,
    steps: steps.slice(-MAXIMUM_LIVE_STEPS),
    source: 'agent',
  });
}

/**
 * Records a snapshot just added as a step in the live file, so the page sees the work moving between status changes
 * (frames are added as they are saved). The task, phase and role stay as they were.
 * @param {string} folder The feature folder.
 * @param {string} target The snapshot's target: a task, a phase, `plan` or `comparison`.
 * @param {string} caption The snapshot's caption.
 */
function writeLiveForSnapshot(folder, target, caption) {
  const { livePath } = dataPaths(folder);
  const { prefix, data: live } = readLive(livePath);
  const now = localTime();
  const owner = SNAPSHOT_OWNER_NAMES[target] || target;
  const activity = caption ? `Added a snapshot to ${owner} — ${caption}` : `Added a snapshot to ${owner}.`;
  const steps = Array.isArray(live.steps) ? live.steps : [];
  steps.push({ at: now.clock, text: activity });
  writeData(livePath, prefix, {
    ...live,
    updatedAt: now.stamp,
    task: live.task || '',
    role: live.role || 'orchestrator',
    activity,
    steps: steps.slice(-MAXIMUM_LIVE_STEPS),
    source: 'agent',
  });
}

/**
 * Rewrites the live file when the run's status changes: a run starting clears the last run's task and steps; a run
 * ending says so (the page hides the live file once the status is no longer in-progress).
 * @param {string} folder The feature folder.
 * @param {string} status The dashboard's new status.
 */
function writeLiveForRun(folder, status) {
  const { livePath } = dataPaths(folder);
  const { prefix, data: live } = readLive(livePath);
  const now = localTime();
  const starting = status === 'in-progress';
  const title = starting ? 'Run started — preparing the first task' : `Run ended — the plan is ${status}`;
  writeData(livePath, prefix, {
    updatedAt: now.stamp,
    phase: live.phase,
    task: '',
    title,
    role: 'orchestrator',
    activity: `${title}.`,
    steps: [{ at: now.clock, text: `${title}.` }],
    source: 'agent',
  });
}

/**
 * Finds a task anywhere in the dashboard data, with the phase that holds it.
 * @param {any} dashboard The dashboard data.
 * @param {string} taskId The task id, e.g. `T12.2`.
 * @returns {{ phase: any, task: any } | undefined}
 */
function findTaskWithPhase(dashboard, taskId) {
  for (const phase of dashboard.phases || []) {
    const task = (phase.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) return { phase, task };
  }
  return undefined;
}

/**
 * Finds a task anywhere in the dashboard data.
 * @param {any} dashboard The dashboard data.
 * @param {string} taskId The task id, e.g. `T12.2`.
 * @returns {any | undefined}
 */
function findTask(dashboard, taskId) {
  const found = findTaskWithPhase(dashboard, taskId);
  return found ? found.task : undefined;
}

/**
 * Merges fields into one task, optionally recording why an earlier result changed. A change that sets `status` also
 * rewrites the live file (see `writeLiveForTask`); any other change leaves it as it was. A move to `built`,
 * `verifying` or `done` is refused while the task's frames are left behind (see `frameHandOffProblem`).
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList The task id and options.
 */
function writeTask(folder, argumentList) {
  const { options, positional } = parseOptions(argumentList);
  const [taskId] = positional;
  if (!taskId || typeof options.set !== 'string') throw new Error('usage: task <feature-folder> <task-id> --set \'{"status":"built"}\'');
  const { dashboardPath } = dataPaths(folder);
  const { prefix, data } = readData(dashboardPath);
  const found = findTaskWithPhase(data, taskId);
  if (!found) throw new Error(`task ${taskId} is not in ${dashboardPath} — sync the dashboard with the plan first`);
  const { phase, task } = found;
  const changes = JSON.parse(options.set);
  checkTaskShape(changes);
  if (Array.isArray(changes.snapshots)) {
    const repairs = repairSnapshotList(changes.snapshots, `${taskId}.snapshots`);
    repairs.forEach((repair) => console.log(`repaired ${repair}`));
    const problems = changes.snapshots.flatMap((snapshot, index) => snapshotProblems(folder, snapshot, `${taskId}.snapshots[${index}]`));
    if (problems.length) throw new Error(snapshotRefusal(problems));
  }
  Object.assign(task, changes);
  const noFrameReason = typeof options['no-frame'] === 'string' ? options['no-frame'] : '';
  const handOffProblem = frameHandOffProblem(folder, data, task, changes.status, noFrameReason);
  if (handOffProblem) throw new Error(handOffProblem);
  const now = localTime();
  if (typeof options.note === 'string') {
    task.updates = Array.isArray(task.updates) ? task.updates : [];
    task.updates.push({ at: now.stamp, by: typeof options.by === 'string' ? options.by : taskId, note: options.note });
  }
  if (noFrameReason && changes.status === 'built') {
    data.activity = Array.isArray(data.activity) ? data.activity : [];
    data.activity.push({ at: now.stamp, text: `${taskId} built with no frame yet — ${noFrameReason}` });
  }
  data.updatedAt = now.stamp;
  writeData(dashboardPath, prefix, data);
  if (typeof changes.status === 'string') writeLiveForTask(folder, phase.number, task, changes.summary);
}

/**
 * Why a status change must wait for the task's frames, or `''` when it may go ahead. The snapshots are the story of
 * the build, so a task never moves past its builder while a frame saved for it (`snapshots/<task-id>-…`) is on no
 * dashboard entry, and a visual task is not `built` until its built frame is on the page — unless the builder gives
 * a reason it has nothing to show yet.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data, with the change already merged.
 * @param {any} task The task, with the change already merged.
 * @param {string | undefined} newStatus The status being written, if any.
 * @param {string} noFrameReason The `--no-frame` reason, or `''`.
 * @returns {string} The refusal message, or `''`.
 */
function frameHandOffProblem(folder, dashboard, task, newStatus, noFrameReason) {
  if (!BUILT_TASK_STATUSES.has(newStatus)) return '';
  const leftBehind = framesNamedFor(unshownSnapshotFiles(folder, dashboard), task.id);
  if (leftBehind.length) {
    return [
      `refused — ${task.id} cannot be "${newStatus}" while its frames are on disk but not on the dashboard (the snapshots tell the story of the build):`,
      ...leftBehind.map((name) => `  snapshots/${name}`),
      'Add them first, then repeat this write — a progression from one camera, or a still each:',
      `  node dashboard.mjs snapshot ${folder} ${task.id} --frame "snapshots/${leftBehind[0]}|<stage>|<what this stage added>" … --caption "…"`,
      `  node dashboard.mjs snapshot ${folder} ${task.id} --src snapshots/${leftBehind[0]} --caption "…"`,
    ].join('\n');
  }
  const isVisual = VISUAL_TASK_KINDS.has(task.kind);
  if (newStatus !== 'built' || !isVisual || noFrameReason || taskIdsWithSnapshots(dashboard).has(task.id)) return '';
  return [
    `refused — ${task.id} (kind ${task.kind}) is visual and has no snapshot, so the dashboard would show nothing of what was built.`,
    `Save its built frame (and the before / milestone frames you took) to snapshots/${task.id}-<NN>-<stage>.png, add them with`,
    `  node dashboard.mjs snapshot ${folder} ${task.id} --src snapshots/${task.id}-01-<stage>.png --caption "…"`,
    'then repeat this write. Only when it truly has nothing to show yet, add --no-frame "<why>" to this write.',
  ].join('\n');
}

/**
 * Refuses a change that would give a task field the wrong shape (a list replaced by a string, …), which would
 * break the page.
 * @param {Record<string, any>} changes The fields about to be merged into a task.
 */
function checkTaskShape(changes) {
  for (const field of TASK_LIST_FIELDS) {
    if (field in changes && !Array.isArray(changes[field])) throw new Error(`"${field}" must be a list — append to it, never assign a string`);
  }
  for (const field of TASK_OBJECT_FIELDS) {
    const value = changes[field];
    if (field in changes && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`"${field}" must be an object or null`);
  }
}

/**
 * Lists what is wrong with one snapshot entry: an unknown shape, an image under a key the page never reads
 * (`path` instead of `src` — the page then shows "No snapshot"), or an image file that is not on disk.
 * @param {string} folder The feature folder; `src` paths are relative to it.
 * @param {any} snapshot The entry.
 * @param {string} where Where the entry sits, for the message, e.g. `T3.snapshots[0]`.
 * @returns {string[]} One line per problem; empty when the entry renders.
 */
function snapshotProblems(folder, snapshot, where) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [`${where} is not an object`];
  const problems = [];
  const checkImage = (image, imageWhere) => {
    if (!image || typeof image !== 'object') {
      problems.push(`${imageWhere} is missing`);
      return;
    }
    const wrongKey = WRONG_IMAGE_KEYS.find((key) => key in image);
    if (wrongKey) problems.push(`${imageWhere} has "${wrongKey}" — the page reads only "src"; rename it`);
    if (typeof image.src !== 'string' || !image.src) {
      if (!wrongKey) problems.push(`${imageWhere} has no "src"`);
      return;
    }
    if (/^[a-z]+:/i.test(image.src)) return;
    if (!existsSync(join(folder, image.src))) problems.push(`${imageWhere}.src "${image.src}" is not a file under ${folder}`);
  };
  if (Array.isArray(snapshot.frames)) {
    if (!snapshot.frames.length) problems.push(`${where}.frames is empty`);
    snapshot.frames.forEach((frame, index) => checkImage(frame, `${where}.frames[${index}]`));
  } else if (snapshot.before !== undefined || snapshot.after !== undefined) {
    checkImage(snapshot.before, `${where}.before`);
    checkImage(snapshot.after, `${where}.after`);
  } else {
    checkImage(snapshot, where);
  }
  if (snapshot.source !== undefined && !SNAPSHOT_SOURCES.includes(snapshot.source)) {
    problems.push(`${where}.source "${snapshot.source}" must be one of ${SNAPSHOT_SOURCES.join(', ')}`);
  }
  if (snapshot.updates !== undefined && !Array.isArray(snapshot.updates)) problems.push(`${where}.updates must be a list`);
  return problems;
}

/**
 * Builds the refusal message for bad snapshot entries, quoting the shapes the page renders.
 * @param {string[]} problems What is wrong, one line each.
 * @returns {string}
 */
function snapshotRefusal(problems) {
  return `refused — these snapshots would show "No snapshot" on the page:\n  ${problems.join('\n  ')}\nThe shapes:\n  ${SNAPSHOT_SHAPES_HELP}`;
}

/**
 * Finds the snapshot list a target names: a task (`T3`, `T12.2`), a phase (`P2`) or the plan-wide After Action
 * Report (`plan`).
 * @param {any} dashboard The dashboard data.
 * @param {string} target The target.
 * @returns {any[]} The live list inside `dashboard`, created when it was missing.
 */
function snapshotListFor(dashboard, target) {
  if (target === 'plan') {
    dashboard.afterAction = dashboard.afterAction && typeof dashboard.afterAction === 'object' ? dashboard.afterAction : {};
    if (!Array.isArray(dashboard.afterAction.snapshots)) dashboard.afterAction.snapshots = [];
    return dashboard.afterAction.snapshots;
  }
  const phaseMatch = /^P(\d+)$/i.exec(target);
  const owner = phaseMatch
    ? (dashboard.phases || []).find((phase) => phase.number === Number(phaseMatch[1]))
    : findTask(dashboard, target);
  if (!owner) throw new Error(`no ${phaseMatch ? 'phase' : 'task'} "${target}" in the dashboard — sync it with the plan first`);
  if (!Array.isArray(owner.snapshots)) owner.snapshots = [];
  return owner.snapshots;
}

/**
 * Appends one snapshot — a still (`--src`), a comparison (`--before` and `--after`) or a progression (`--frame`,
 * repeated, each `src|stage|caption`) — to a task, a phase or the plan, building the shape the page renders and
 * refusing an image that is not on disk. The target `comparison` instead sets the After Action Report's one
 * plan-wide before/after. This is the way to add snapshots: nobody writes snapshot JSON by hand.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList The target and options.
 */
function writeSnapshot(folder, argumentList) {
  const { options, positional } = parseOptions(argumentList, ['frame']);
  const [target] = positional;
  const usage = 'usage: snapshot <feature-folder> <T3|P1|plan|comparison> (--src snapshots/x.png | --before snapshots/a.png --after snapshots/b.png | --frame "snapshots/x.png|stage|caption"…) --caption "…" [--title "…"] [--source browser|unity|blender|reference] [--before-caption "…"] [--after-caption "…"] [--task T3]';
  if (!target) throw new Error(usage);
  const isPlanComparison = target === 'comparison';
  if (isPlanComparison && !(typeof options.before === 'string' && typeof options.after === 'string')) {
    throw new Error('the plan-wide comparison takes --before snapshots/plan-before.png --after snapshots/plan-after.png');
  }
  const caption = typeof options.caption === 'string' ? options.caption : '';
  const snapshot = { title: typeof options.title === 'string' ? options.title : caption, caption, source: typeof options.source === 'string' ? options.source : 'browser' };
  if (typeof options.src === 'string') {
    snapshot.src = options.src;
  } else if (typeof options.before === 'string' && typeof options.after === 'string') {
    snapshot.before = { src: options.before, caption: typeof options['before-caption'] === 'string' ? options['before-caption'] : 'Before' };
    snapshot.after = { src: options.after, caption: typeof options['after-caption'] === 'string' ? options['after-caption'] : 'After' };
  } else if (options.frame.length) {
    const now = localTime();
    snapshot.frames = options.frame.map((frame) => {
      const [src, stage = '', frameCaption = ''] = String(frame).split('|');
      return { src, stage, caption: frameCaption, task: typeof options.task === 'string' ? options.task : target, at: now.clock };
    });
  } else {
    throw new Error(usage);
  }
  snapshot.updates = [];
  const problems = snapshotProblems(folder, snapshot, target);
  if (problems.length) throw new Error(snapshotRefusal(problems));
  const { dashboardPath } = dataPaths(folder);
  const { prefix, data } = readData(dashboardPath);
  if (isPlanComparison) {
    data.afterAction = data.afterAction && typeof data.afterAction === 'object' ? data.afterAction : {};
    data.afterAction.comparison = snapshot;
  } else {
    snapshotListFor(data, target).push(snapshot);
  }
  data.updatedAt = localTime().stamp;
  writeData(dashboardPath, prefix, data);
  writeLiveForSnapshot(folder, target, caption);
}

/**
 * Moves an image filed under a key the page never reads (`path`, `file`, `image`, `url`, `href`) to `src`.
 * @param {any} image A still, or a comparison's `before` / `after`, or a progression frame.
 * @param {string} where Where the image sits, for the repair report.
 * @returns {string[]} One line per repair made.
 */
function repairImage(image, where) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return [];
  const wrongKey = WRONG_IMAGE_KEYS.find((key) => typeof image[key] === 'string' && image[key]);
  if (!wrongKey) return [];
  if (typeof image.src !== 'string' || !image.src) image.src = image[wrongKey];
  WRONG_IMAGE_KEYS.forEach((key) => delete image[key]);
  return [`${where}: "${wrongKey}" → "src"`];
}

/**
 * Repairs every entry of one snapshot list in place, so each renders an image: a bare path string becomes a still,
 * an image under a wrong key moves to `src`, and an unknown `source` becomes `browser`.
 * @param {any[]} list The snapshot list.
 * @param {string} owner Where the list sits, e.g. `T3.snapshots`.
 * @returns {string[]} One line per repair made.
 */
function repairSnapshotList(list, owner) {
  const repairs = [];
  list.forEach((snapshot, index) => {
    const where = `${owner}[${index}]`;
    if (typeof snapshot === 'string' && snapshot) {
      list[index] = { title: '', caption: '', source: 'browser', src: snapshot, updates: [] };
      repairs.push(`${where}: a bare path → a still`);
      return;
    }
    repairs.push(...repairSnapshot(snapshot, where));
  });
  return repairs;
}

/**
 * Repairs one snapshot entry in place (see `repairSnapshotList`).
 * @param {any} snapshot A still, comparison or progression.
 * @param {string} where Where it sits.
 * @returns {string[]} One line per repair made.
 */
function repairSnapshot(snapshot, where) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const repairs = [];
  if (Array.isArray(snapshot.frames)) {
    snapshot.frames.forEach((frame, index) => repairs.push(...repairImage(frame, `${where}.frames[${index}]`)));
  } else if (snapshot.before !== undefined || snapshot.after !== undefined) {
    repairs.push(...repairImage(snapshot.before, `${where}.before`), ...repairImage(snapshot.after, `${where}.after`));
  } else {
    repairs.push(...repairImage(snapshot, where));
  }
  if (snapshot.source !== undefined && !SNAPSHOT_SOURCES.includes(snapshot.source)) {
    repairs.push(`${where}.source "${snapshot.source}" → "browser"`);
    snapshot.source = 'browser';
  }
  return repairs;
}

/**
 * Repairs every snapshot in the dashboard in place: the After Action Report's list and comparison, each phase's and
 * each task's list.
 * @param {any} dashboard The dashboard data.
 * @returns {string[]} One line per repair made.
 */
function repairSnapshots(dashboard) {
  const repairs = [];
  const repairList = (list, owner) => {
    if (Array.isArray(list)) repairs.push(...repairSnapshotList(list, owner));
  };
  if (dashboard.afterAction && typeof dashboard.afterAction === 'object') {
    repairList(dashboard.afterAction.snapshots, 'afterAction.snapshots');
    repairs.push(...repairSnapshot(dashboard.afterAction.comparison, 'afterAction.comparison'));
  }
  for (const phase of dashboard.phases || []) {
    repairList(phase.snapshots, `P${phase.number}.snapshots`);
    for (const task of phase.tasks || []) repairList(task.snapshots, `${task.id}.snapshots`);
  }
  return repairs;
}

/**
 * Repairs the plan-level decisions in place: a decision written as plain text (`"D3 — The filter is …"`) renders as
 * an empty row, so it becomes `{ "id": "D3", "text": "The filter is …", "updates": [] }`. A leading parenthesis after
 * the id (`"D9 (confirmed by the user) — …"`) stays in the text; text with no leading id keeps an empty id.
 * @param {any} dashboard The dashboard data.
 * @returns {string[]} One line per repair made.
 */
function repairDecisions(dashboard) {
  const repairs = [];
  if (!Array.isArray(dashboard.decisions)) return repairs;
  dashboard.decisions = dashboard.decisions.map((decision, index) => {
    if (typeof decision !== 'string') return decision;
    const match = decision.match(/^([A-Z]+\d+[a-z]?)(\s*\([^)]*\))?\s+[—–-]\s+([\s\S]*)$/);
    const id = match ? match[1] : '';
    const text = match ? `${match[2] ? `${match[2].trim()} ` : ''}${match[3]}` : decision;
    repairs.push(`decisions[${index}]: plain text → { "id": "${id}", "text" }`);
    return { id, text, updates: [] };
  });
  return repairs;
}

/**
 * The next free follow-up id: one past the highest `F<n>` in the list, so ids never repeat after one is revised.
 * @param {any[]} followUps The follow-ups so far.
 * @param {Set<string>} [alsoTaken] Ids claimed by entries not yet in the list.
 * @returns {string}
 */
function nextFollowUpId(followUps, alsoTaken = new Set()) {
  const taken = [...followUps.map((followUp) => followUp && followUp.id), ...alsoTaken];
  const highest = taken.reduce((maximum, id) => {
    const match = FOLLOW_UP_ID.exec(String(id || ''));
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return `F${highest + 1}`;
}

/**
 * A short title from a follow-up written as one block of text: its first sentence, cut at a word near
 * `MAXIMUM_FOLLOW_UP_TITLE` characters when longer. A sentence ends only where the next word starts with a capital,
 * so "the GO! banner" stays whole.
 * @param {string} text The follow-up's text.
 * @returns {string}
 */
function followUpTitleFrom(text) {
  const trimmed = String(text || '').trim();
  const sentenceMatch = /^[\s\S]*?[.!?](?=\s+[A-Z]|$)/.exec(trimmed);
  const sentence = sentenceMatch ? sentenceMatch[0] : trimmed;
  if (sentence.length <= MAXIMUM_FOLLOW_UP_TITLE) return sentence;
  const cut = sentence.lastIndexOf(' ', MAXIMUM_FOLLOW_UP_TITLE);
  return `${sentence.slice(0, cut > 0 ? cut : MAXIMUM_FOLLOW_UP_TITLE).replace(/[\s,;:—–-]+$/, '')}…`;
}

/**
 * The ids the follow-ups already carry — an entry's `id`, or the `F3 — ` a plain-text one starts with — so a repair
 * never hands out an id that a later entry in the list already has.
 * @param {any[]} followUps The follow-ups, possibly mixed with plain text.
 * @returns {Set<string>}
 */
function claimedFollowUpIds(followUps) {
  const ids = followUps.map((followUp) => {
    if (followUp && typeof followUp === 'object') return followUp.id;
    const match = FOLLOW_UP_TEXT_WITH_ID.exec(String(followUp));
    return match ? match[1] : '';
  });
  return new Set(ids.filter(Boolean));
}

/**
 * Repairs the follow-ups in place, so each has the id the dashboard's bt-spec commands name: a follow-up written as
 * plain text becomes `{ "id": "F3", "title", "detail", … }` (its own `F3 — ` prefix kept as the id, else the next free
 * one), and an entry without an id gets the next free one. Lists and `updates` are made lists.
 * @param {any} dashboard The dashboard data.
 * @returns {string[]} One line per repair made.
 */
function repairFollowUps(dashboard) {
  const repairs = [];
  if (!Array.isArray(dashboard.followUps)) return repairs;
  const claimed = claimedFollowUpIds(dashboard.followUps);
  dashboard.followUps = dashboard.followUps.map((followUp, index) => {
    if (typeof followUp === 'string') {
      const match = FOLLOW_UP_TEXT_WITH_ID.exec(followUp);
      const text = match ? match[2] : followUp;
      const id = match ? match[1] : nextFollowUpId([], claimed);
      claimed.add(id);
      const title = followUpTitleFrom(text);
      repairs.push(`followUps[${index}]: plain text → { "id": "${id}", "title", "detail" }`);
      return { id, title, detail: title === text ? '' : text, source: '', files: [], at: '', updates: [] };
    }
    if (!followUp || typeof followUp !== 'object') return followUp;
    if (!followUp.id) {
      followUp.id = nextFollowUpId([], claimed);
      claimed.add(followUp.id);
      repairs.push(`followUps[${index}]: no id → "${followUp.id}"`);
    }
    if (!Array.isArray(followUp.files)) followUp.files = [];
    if (!Array.isArray(followUp.updates)) followUp.updates = [];
    return followUp;
  }).filter((followUp) => followUp && typeof followUp === 'object');
  return repairs;
}

/**
 * This feature's folder as a path from the project root (`.agents/specs/<slug>`, or wherever the user moved it),
 * for the bt-spec commands. The helper runs from the project root, so a folder under it is named as it is.
 * @param {string} folder The feature folder.
 * @returns {string}
 */
function featureFolderFromRoot(folder) {
  const fromRoot = relative(process.cwd(), resolve(folder)).split('\\').join('/');
  return fromRoot.startsWith('.agents/') ? fromRoot : `.agents/specs/${dataPaths(folder).slug}`;
}

/**
 * Joins follow-up ids the way the bt-spec commands read: `F1`, `F1 and F2`, `F1, F2 and F3`.
 * @param {string[]} ids The ids.
 * @returns {string}
 */
function joinFollowUpIds(ids) {
  if (ids.length <= 1) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

/**
 * The follow-ups document bt-spec reads: the feature it came from, the commands that spec its follow-ups, and every
 * follow-up in full under its id.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data, follow-ups repaired.
 * @returns {string} Markdown.
 */
function followUpsDocument(folder, dashboard) {
  const { slug } = dataPaths(folder);
  const featureTitle = (dashboard.feature && dashboard.feature.title) || slug;
  const source = `@${featureFolderFromRoot(folder)}/documents/${slug}_followups.md`;
  const ids = dashboard.followUps.map((followUp) => followUp.id);
  const documents = (Array.isArray(dashboard.documents) ? dashboard.documents : [])
    .filter((document) => document && document.path && !/follow/i.test(document.label || ''))
    .map((document) => `${String(document.label).toLowerCase()} \`${document.path}\``);
  const lines = [
    `# Follow-ups — ${featureTitle}`,
    '',
    `What the bt-execute runs of **${featureTitle}** left for a human to look at next. Spec any of them on its own, or several together, with bt-spec:`,
    '',
    '```',
    `/bt-spec Fix ${ids[0]} from ${source}`,
    ...(ids.length > 1 ? [`/bt-spec Fix ${joinFollowUpIds(ids)} from ${source}`] : []),
    '```',
    '',
    `Where they came from: this feature's ${documents.length ? documents.join(', ') : 'plan and run log'} (paths relative to \`${featureFolderFromRoot(folder)}/\`).`,
    '',
    `> Written by bt-execute's dashboard helper from \`${slug}_dashboard.js\`. Add or revise a follow-up with \`dashboard.mjs followup\`, never by editing this file.`,
  ];
  for (const followUp of dashboard.followUps) {
    const raised = [followUp.at, followUp.source].filter(Boolean).join(' · ');
    lines.push('', `## ${followUp.id} — ${followUp.title || 'Untitled follow-up'}`, '');
    if (raised) lines.push(`- **Raised:** ${raised}`);
    if (followUp.files.length) lines.push(`- **Files:** ${followUp.files.map((file) => `\`${file}\``).join(', ')}`);
    for (const update of followUp.updates) lines.push(`- **Revised ${update.at || ''}${update.by ? ` by ${update.by}` : ''}:** ${update.note || ''}`);
    if (raised || followUp.files.length || followUp.updates.length) lines.push('');
    lines.push(followUp.detail || followUp.title || '');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Lists the follow-ups document among the dashboard's documents, once, so the page links it.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data.
 * @returns {boolean} Whether the list changed.
 */
function linkFollowUpsDocument(folder, dashboard) {
  const path = `documents/${dataPaths(folder).slug}_followups.md`;
  dashboard.documents = Array.isArray(dashboard.documents) ? dashboard.documents : [];
  if (dashboard.documents.some((document) => document && document.path === path)) return false;
  dashboard.documents.push({ label: 'Follow-ups', path });
  return true;
}

/**
 * Rewrites the follow-ups document from the dashboard data, atomically; nothing is written while there are none.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data, follow-ups repaired.
 */
function writeFollowUpsDocument(folder, dashboard) {
  if (!Array.isArray(dashboard.followUps) || !dashboard.followUps.length) return;
  const path = join(folder, 'documents', `${dataPaths(folder).slug}_followups.md`);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, followUpsDocument(folder, dashboard), 'utf8');
  renameSync(temporaryPath, path);
}

/**
 * Every snapshot entry in the dashboard with where it sits: the After Action Report, each phase and each task.
 * @param {any} dashboard The dashboard data.
 * @returns {{ snapshot: any, where: string }[]}
 */
function allSnapshots(dashboard) {
  const entries = [];
  const collect = (list, owner) => (Array.isArray(list) ? list : []).forEach((snapshot, index) => entries.push({ snapshot, where: `${owner}.snapshots[${index}]` }));
  if (dashboard.afterAction) {
    collect(dashboard.afterAction.snapshots, 'afterAction');
    const comparison = dashboard.afterAction.comparison;
    if (comparison) entries.push({ snapshot: comparison, where: 'afterAction.comparison' });
  }
  for (const phase of dashboard.phases || []) {
    collect(phase.snapshots, `P${phase.number}`);
    for (const task of phase.tasks || []) collect(task.snapshots, task.id);
  }
  return entries;
}

/**
 * The images one snapshot entry shows: a progression's frames, a comparison's two sides, or the still itself.
 * @param {any} snapshot A still, comparison or progression.
 * @returns {any[]} Objects that carry a `src`.
 */
function snapshotImages(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (Array.isArray(snapshot.frames)) return snapshot.frames;
  if (snapshot.before !== undefined || snapshot.after !== undefined) return [snapshot.before, snapshot.after];
  return [snapshot];
}

/**
 * The images in the feature folder's `snapshots/` that no dashboard entry shows — frames a builder or verifier saved
 * that never reached the page, so the story of the build is missing them.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data.
 * @returns {string[]} File names inside `snapshots/`, e.g. `T1-02-lit.png`.
 */
function unshownSnapshotFiles(folder, dashboard) {
  const snapshotsFolder = join(folder, 'snapshots');
  if (!existsSync(snapshotsFolder)) return [];
  const shownPaths = new Set(
    allSnapshots(dashboard)
      .flatMap(({ snapshot }) => snapshotImages(snapshot))
      .map((image) => (image && typeof image.src === 'string' ? image.src : ''))
      .filter((source) => source && !/^[a-z]+:/i.test(source))
      .map((source) => resolve(folder, source)),
  );
  return readdirSync(snapshotsFolder)
    .filter((name) => SNAPSHOT_IMAGE_FILE.test(name))
    .filter((name) => !shownPaths.has(resolve(snapshotsFolder, name)))
    .sort();
}

/**
 * The file names saved for one task or phase: those named `<id>-…` (`T7-02-lit.png`, `P2-01-blockout.png`).
 * `T1-` never matches `T10-…` or `T1.2-…`.
 * @param {string[]} fileNames File names inside `snapshots/`.
 * @param {string} ownerId A task id (`T7`, `T3.1`) or phase id (`P2`).
 * @returns {string[]}
 */
function framesNamedFor(fileNames, ownerId) {
  const prefix = `${ownerId}-`.toLowerCase();
  return fileNames.filter((name) => name.toLowerCase().startsWith(prefix));
}

/**
 * Appends one milestone to the activity log.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList The milestone text.
 */
function writeActivity(folder, argumentList) {
  const text = argumentList.join(' ').trim();
  if (!text) throw new Error('usage: activity <feature-folder> "text"');
  const { dashboardPath } = dataPaths(folder);
  const { prefix, data } = readData(dashboardPath);
  const now = localTime();
  data.activity = Array.isArray(data.activity) ? data.activity : [];
  data.activity.push({ at: now.stamp, text });
  data.updatedAt = now.stamp;
  writeData(dashboardPath, prefix, data);
}

/**
 * Adds a follow-up with the next free id (`F1`, `F2`, …), or revises one (`--id F2 … --note "why"`), then rewrites
 * the follow-ups document bt-spec reads. The dashboard offers `/bt-spec Fix F2 from @…_followups.md` for each, so a
 * follow-up carries enough to be specced alone: what is wrong, the evidence, where to look, what fixing it involves.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList Follow-up options.
 */
function writeFollowUp(folder, argumentList) {
  const { options } = parseOptions(argumentList, ['file']);
  const usage = 'usage: followup <feature-folder> --title "…" --detail "…" [--source "T2 verifier"] [--file path]…  (revise: --id F2 [--title …] [--detail …] [--file …] --note "why it changed" [--by T4])';
  const { dashboardPath } = dataPaths(folder);
  const { prefix, data } = readData(dashboardPath);
  data.followUps = Array.isArray(data.followUps) ? data.followUps : [];
  repairFollowUps(data);
  const now = localTime();
  const fields = {
    ...(typeof options.title === 'string' ? { title: options.title } : {}),
    ...(typeof options.detail === 'string' ? { detail: options.detail } : {}),
    ...(typeof options.source === 'string' ? { source: options.source } : {}),
    ...(options.file.length ? { files: options.file.map(String) } : {}),
  };
  const isRevision = typeof options.id === 'string';
  let followUpId;
  if (isRevision) {
    const followUp = data.followUps.find((candidate) => candidate.id === options.id);
    if (!followUp) throw new Error(`no follow-up "${options.id}" — the dashboard has ${data.followUps.map((candidate) => candidate.id).join(', ') || 'none'}`);
    if (typeof options.note !== 'string') throw new Error('revising a follow-up needs --note "why it changed" — an earlier result is never rewritten silently');
    Object.assign(followUp, fields);
    followUp.updates.push({ at: now.stamp, by: typeof options.by === 'string' ? options.by : followUp.id, note: options.note });
    followUpId = followUp.id;
  } else {
    if (!fields.title || !fields.detail) throw new Error(usage);
    followUpId = nextFollowUpId(data.followUps);
    data.followUps.push({ id: followUpId, title: '', detail: '', source: '', files: [], at: now.stamp, updates: [], ...fields });
  }
  linkFollowUpsDocument(folder, data);
  data.updatedAt = now.stamp;
  writeData(dashboardPath, prefix, data);
  writeFollowUpsDocument(folder, data);
  const followUpsSource = `@${featureFolderFromRoot(folder)}/documents/${dataPaths(folder).slug}_followups.md`;
  console.log(`${isRevision ? 'revised' : 'added'} ${followUpId} — spec it with: /bt-spec Fix ${followUpId} from ${followUpsSource}`);
}

/**
 * Sets the dashboard's run status, and records the run starting or ending in the live file.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList The new status.
 */
function writeStatus(folder, argumentList) {
  const [status] = argumentList;
  const allowed = ['planned', 'in-progress', 'paused', 'complete', 'incomplete'];
  if (!allowed.includes(status)) throw new Error(`status must be one of: ${allowed.join(', ')}`);
  const { dashboardPath } = dataPaths(folder);
  const { prefix, data } = readData(dashboardPath);
  data.status = status;
  data.updatedAt = localTime().stamp;
  writeData(dashboardPath, prefix, data);
  if (status !== 'planned') writeLiveForRun(folder, status);
}

/**
 * Reads a plan's checklist: every `- [ ]` / `- [x]` line that starts with a task id, in file order, skipping fenced
 * code blocks (a plan may quote a checklist as an example).
 * @param {string} planPath The plan file.
 * @returns {{ id: string, ticked: boolean }[]}
 */
function readPlanChecklist(planPath) {
  const tasks = [];
  let insideFence = false;
  for (const line of readFileSync(planPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    const match = insideFence ? null : PLAN_CHECKLIST_LINE.exec(line);
    if (match) tasks.push({ id: match[2], ticked: match[1] !== ' ' });
  }
  return tasks;
}

/**
 * The feature-folder files a written plan must have beside it.
 * @param {string} folder The feature folder.
 * @returns {string[]} One problem per missing file.
 */
function missingDeliverables(folder) {
  const { slug } = dataPaths(folder);
  const required = [
    ['dashboard.html', `copy it from bt-execute's templates/dashboard/ with {{slug}} replaced`],
    [join('documents', `${slug}_dashboard.js`), 'create it from templates/dashboard/dashboard.template.js and the plan'],
    [join('documents', `${slug}_live.js`), 'create it from templates/dashboard/live.template.js'],
  ];
  return required
    .filter(([file]) => !existsSync(join(folder, file)))
    .map(([file, remedy]) => `the plan has no ${file} — ${remedy}`);
}

/**
 * Compares the dashboard's tasks with the plan's checklist: tasks missing on either side, or the same tasks in a
 * different order.
 * @param {string[]} planIds The plan's task ids, in plan order.
 * @param {string[]} dashboardIds The dashboard's task ids, in page order.
 * @returns {string[]} One problem per kind of mismatch.
 */
function taskListProblems(planIds, dashboardIds) {
  const missing = planIds.filter((id) => !dashboardIds.includes(id));
  const extra = dashboardIds.filter((id) => !planIds.includes(id));
  const problems = [];
  if (missing.length) problems.push(`plan tasks missing from the dashboard: ${missing.join(', ')} — sync the dashboard with the plan`);
  if (extra.length) problems.push(`dashboard tasks the plan does not have: ${extra.join(', ')} — sync the dashboard with the plan`);
  if (problems.length) return problems;
  const position = planIds.findIndex((id, index) => dashboardIds[index] !== id);
  if (position >= 0) {
    problems.push(`the dashboard lists the tasks in a different order from the plan (position ${position + 1}: plan ${planIds[position]}, dashboard ${dashboardIds[position]}) — sync the dashboard with the plan`);
  }
  return problems;
}

/**
 * The plan checks: the dashboard's tasks match the checklist, a `complete` status is true and has its plan summary,
 * and every ticked task has a verifier result.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data.
 * @param {{ id: string, ticked: boolean }[]} planTasks The plan's checklist.
 * @returns {string[]} One line per problem.
 */
function planProblems(folder, dashboard, planTasks) {
  const { slug } = dataPaths(folder);
  const dashboardTasks = (dashboard.phases || []).flatMap((phase) => phase.tasks || []);
  const problems = taskListProblems(planTasks.map((task) => task.id), dashboardTasks.map((task) => task.id));
  if (dashboard.status === 'complete') {
    const unticked = planTasks.filter((task) => !task.ticked).map((task) => task.id);
    if (unticked.length) problems.push(`status is complete but the plan still has unticked tasks: ${unticked.join(', ')} — set paused or incomplete`);
    const summaryFile = join('documents', `${slug}_summary.html`);
    if (!existsSync(join(folder, summaryFile))) problems.push(`status is complete but ${summaryFile} is missing — write the plan summary`);
  }
  for (const planTask of planTasks.filter((task) => task.ticked)) {
    const dashboardTask = dashboardTasks.find((task) => task.id === planTask.id);
    if (dashboardTask && !dashboardTask.verifier) problems.push(`${planTask.id} is ticked in the plan but has no verifier result on the dashboard`);
  }
  return problems;
}

/**
 * The ids of tasks that have something on the page: a snapshot of their own, or a phase or After Action Report
 * progression frame tagged with their id.
 * @param {any} dashboard The dashboard data.
 * @returns {Set<string>}
 */
function taskIdsWithSnapshots(dashboard) {
  const sharedLists = [dashboard.afterAction && dashboard.afterAction.snapshots, ...(dashboard.phases || []).map((phase) => phase.snapshots)];
  const taskIds = new Set(
    sharedLists
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .flatMap((snapshot) => (snapshot && Array.isArray(snapshot.frames) ? snapshot.frames : []))
      .map((frame) => frame && frame.task),
  );
  for (const task of (dashboard.phases || []).flatMap((phase) => phase.tasks || [])) {
    if (Array.isArray(task.snapshots) && task.snapshots.length) taskIds.add(task.id);
  }
  return taskIds;
}

/**
 * Visual tasks marked `done` with nothing to show for it: no snapshot of their own and no phase or After Action
 * Report progression frame tagged with their id.
 * @param {any} dashboard The dashboard data.
 * @returns {string[]} One line per task.
 */
function visualTaskProblems(dashboard) {
  const taskIds = taskIdsWithSnapshots(dashboard);
  return (dashboard.phases || [])
    .flatMap((phase) => phase.tasks || [])
    .filter((task) => task.status === 'done' && VISUAL_TASK_KINDS.has(task.kind) && !taskIds.has(task.id))
    .map((task) => `${task.id} (kind ${task.kind}) is done with no snapshot — add the builder's frames and the verifier's comparison with \`dashboard.mjs snapshot\``);
}

/**
 * Frames left behind in `snapshots/`: a built or finished task's `T<n>-…` images, a closed phase's `P<N>-…` images,
 * and — once a run has ended — a `plan-before` image, that no dashboard entry shows.
 * @param {string} folder The feature folder.
 * @param {any} dashboard The dashboard data.
 * @returns {string[]} One line per task, phase or plan-wide frame.
 */
function unshownFrameProblems(folder, dashboard) {
  const unshown = unshownSnapshotFiles(folder, dashboard);
  if (!unshown.length) return [];
  const problems = [];
  const report = (ownerId, names) => {
    if (names.length) problems.push(`${ownerId} has frames on disk that no dashboard entry shows: ${names.map((name) => `snapshots/${name}`).join(', ')} — add each to ${ownerId} with \`dashboard.mjs snapshot\``);
  };
  for (const phase of dashboard.phases || []) {
    for (const task of (phase.tasks || []).filter((candidate) => BUILT_TASK_STATUSES.has(candidate.status))) report(task.id, framesNamedFor(unshown, task.id));
    if (CLOSED_PHASE_STATUSES.has(phase.status)) report(`P${phase.number}`, framesNamedFor(unshown, `P${phase.number}`));
  }
  if (RUN_ENDED_STATUSES.has(dashboard.status)) {
    for (const name of unshown.filter((candidate) => PLAN_BEFORE_FILE.test(candidate))) {
      problems.push(`snapshots/${name} is not in the After Action Report — make it the plan-wide "before": \`dashboard.mjs snapshot <feature-folder> comparison --before snapshots/${name} --after snapshots/plan-after.png --caption "…"\``);
    }
  }
  return problems;
}

/**
 * Builds the refusal message for skipped deliverables.
 * @param {string[]} problems What is missing or false, one line each.
 * @returns {string}
 */
function deliverableRefusal(problems) {
  return `refused — ${problems.length} deliverable problem${problems.length === 1 ? '' : 's'}:\n  ${problems.join('\n  ')}`;
}

/**
 * The gate at every phase boundary and at run end. Confirms both data files parse and every snapshot entry will show
 * its image, and — when the folder holds the plan — that no deliverable was skipped (see the header). Fails listing
 * every problem in one message.
 * @param {string} folder The feature folder.
 * @throws {Error} When a file does not parse, a snapshot entry is broken or a deliverable is missing or false.
 */
function checkData(folder) {
  const { slug, dashboardPath, livePath } = dataPaths(folder);
  const planPath = join(folder, 'documents', `${slug}_plan.md`);
  const planTasks = existsSync(planPath) ? readPlanChecklist(planPath) : null;
  const missing = planTasks ? missingDeliverables(folder) : [];
  if (missing.length && !existsSync(dashboardPath)) throw new Error(deliverableRefusal(missing));
  const { prefix, data } = readData(dashboardPath);
  if (existsSync(livePath)) readData(livePath);
  const repairs = repairSnapshots(data);
  const decisionRepairs = repairDecisions(data);
  const followUpRepairs = repairFollowUps(data);
  const hasFollowUps = Array.isArray(data.followUps) && data.followUps.length > 0;
  const linkedFollowUps = hasFollowUps && linkFollowUpsDocument(folder, data);
  if (repairs.length || decisionRepairs.length || followUpRepairs.length || linkedFollowUps) writeData(dashboardPath, prefix, data);
  if (hasFollowUps) writeFollowUpsDocument(folder, data);
  if (repairs.length) {
    console.log(`repaired ${repairs.length} snapshot entr${repairs.length === 1 ? 'y' : 'ies'} the page could not show:\n  ${repairs.join('\n  ')}`);
  }
  if (decisionRepairs.length) {
    console.log(`repaired ${decisionRepairs.length} decision${decisionRepairs.length === 1 ? '' : 's'} written as plain text:\n  ${decisionRepairs.join('\n  ')}`);
  }
  if (followUpRepairs.length) {
    console.log(`repaired ${followUpRepairs.length} follow-up${followUpRepairs.length === 1 ? '' : 's'} without an id:\n  ${followUpRepairs.join('\n  ')}`);
  }
  const snapshots = allSnapshots(data);
  const problems = snapshots.flatMap(({ snapshot, where }) => snapshotProblems(folder, snapshot, where));
  const deliverables = [...missing, ...visualTaskProblems(data), ...unshownFrameProblems(folder, data), ...(planTasks ? planProblems(folder, data, planTasks) : [])];
  const refusals = [problems.length ? snapshotRefusal(problems) : '', deliverables.length ? deliverableRefusal(deliverables) : ''].filter(Boolean);
  if (refusals.length) throw new Error(refusals.join('\n'));
  const planNote = planTasks ? `; the dashboard matches the plan's ${planTasks.length} tasks` : '';
  console.log(`ok: ${dashboardPath}${existsSync(livePath) ? ` and ${livePath}` : ''} parse; ${snapshots.length} snapshot entries all show an image${planNote}`);
}

/**
 * The most recently changed file under some folders, skipping dependency, build and cache folders.
 * @param {string[]} roots Folders to search.
 * @returns {{ path: string, modified: number } | null}
 */
function latestChange(roots) {
  let latest = null;
  const visit = (folder, depth) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAXIMUM_SCAN_DEPTH && !IGNORED_FOLDERS.has(entry.name)) visit(path, depth + 1);
        continue;
      }
      // The dashboard's own data files are written by this helper and the watchdog itself — not a sign of work.
      if (!entry.isFile() || entry.name.endsWith('.tmp') || /_(dashboard|live)\.js$/.test(entry.name)) continue;
      try {
        const modified = statSync(path).mtimeMs;
        if (!latest || modified > latest.modified) latest = { path, modified };
      } catch {
        /* file vanished between listing and stat — ignore it */
      }
    }
  };
  roots.forEach((root) => visit(root, 0));
  return latest;
}

/**
 * The live file's last write as a Date, or null when it cannot be read.
 * @param {string} stamp `YYYY-MM-DD HH:MM`.
 * @returns {Date | null}
 */
function parseStamp(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp || ''));
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

/**
 * The watchdog — bt-execute launches it in the background at run start, as the safety net behind the agents' own
 * live writes, so the page never shows a long silence while work goes on. While the dashboard says a run is in
 * progress it checks the live status every interval:
 *  - the live status names a task that is already finished while another task is active → it points the live
 *    status at the active task (the agent working on it has not written yet);
 *  - nothing has been written for `quiet-minutes` → it writes a heartbeat naming the latest file that changed in
 *    the watched folders, so the page shows the work is alive and where;
 *  - no file has changed for `stall-minutes` either → the heartbeat says the run may be stalled.
 * It exits by itself as soon as the dashboard status is anything but in-progress, or after `max-hours` (a run that
 * was killed leaves the status at in-progress, and the watchdog must not outlive it forever).
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList Watch options.
 */
async function watch(folder, argumentList) {
  const { options } = parseOptions(argumentList, ['watch']);
  const intervalSeconds = Number(options['interval-seconds'] || 60);
  const quietMinutes = Number(options['quiet-minutes'] || 10);
  const stallMinutes = Number(options['stall-minutes'] || 30);
  const stopAt = Date.now() + Number(options['max-hours'] || 12) * 3600000;
  const roots = [folder, ...options.watch.map(String)];
  const { dashboardPath, livePath } = dataPaths(folder);
  const projectRoot = process.cwd();
  console.log(`watchdog: watching ${roots.join(', ')} every ${intervalSeconds} s (quiet after ${quietMinutes} min, stalled after ${stallMinutes} min)`);

  for (;;) {
    if (Date.now() > stopAt) {
      console.log('watchdog: reached its maximum lifetime — exiting');
      return;
    }
    let dashboard;
    try {
      dashboard = readData(dashboardPath).data;
    } catch {
      dashboard = null; // caught mid-write or briefly missing — try again next round
    }
    if (dashboard && dashboard.status !== 'in-progress') {
      console.log(`watchdog: dashboard status is "${dashboard.status}" — the run is over, exiting`);
      return;
    }
    if (dashboard) repairWrittenSnapshots(dashboardPath);
    if (dashboard && existsSync(livePath)) {
      try {
        checkLive(dashboard, livePath, roots, projectRoot, quietMinutes, stallMinutes);
      } catch (error) {
        console.log(`watchdog: skipped a round — ${error.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

/**
 * Watchdog repair: a snapshot or decision an agent wrote around the helper (a hand edit, its own script) is repaired
 * within a minute, re-read just before the write so nothing the agent wrote meanwhile is lost.
 * @param {string} dashboardPath The dashboard data file.
 */
function repairWrittenSnapshots(dashboardPath) {
  try {
    const { prefix, data } = readData(dashboardPath);
    const repairs = [...repairSnapshots(data), ...repairDecisions(data)];
    if (!repairs.length) return;
    writeData(dashboardPath, prefix, data);
    console.log(`watchdog: repaired ${repairs.length} entr${repairs.length === 1 ? 'y' : 'ies'} — ${repairs.join('; ')}`);
  } catch (error) {
    console.log(`watchdog: snapshot repair skipped a round — ${error.message}`);
  }
}

/**
 * One watchdog round (see `watch`).
 * @param {any} dashboard The dashboard data.
 * @param {string} livePath The live file.
 * @param {string[]} roots Folders that show signs of work.
 * @param {string} projectRoot Paths are reported relative to this.
 * @param {number} quietMinutes Minutes without a live write before a heartbeat.
 * @param {number} stallMinutes Minutes without any file change before the stall warning.
 */
function checkLive(dashboard, livePath, roots, projectRoot, quietMinutes, stallMinutes) {
  const { prefix, data: live } = readData(livePath);
  const tasks = (dashboard.phases || []).flatMap((phase) => (phase.tasks || []).map((task) => ({ ...task, phaseNumber: phase.number })));
  const liveTask = tasks.find((task) => task.id === live.task);
  const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const now = new Date();
  const lastWrite = parseStamp(live.updatedAt);
  const quietFor = lastWrite ? Math.floor((now - lastWrite) / 60000) : Infinity;
  const pointsAtFinishedTask = liveTask && !ACTIVE_TASK_STATUSES.has(liveTask.status) && activeTasks.length > 0;
  if (!pointsAtFinishedTask && quietFor < quietMinutes) return;

  const change = latestChange(roots);
  const changedAgo = change ? Math.floor((now - change.modified) / 60000) : Infinity;
  const where = change ? `${relative(projectRoot, change.path) || change.path} at ${localTime(new Date(change.modified)).clock}` : 'no file changes found';
  const clock = localTime(now).clock;
  const steps = Array.isArray(live.steps) ? live.steps : [];
  let task = live.task;
  let activity;

  if (pointsAtFinishedTask) {
    const active = activeTasks[0];
    task = active.id;
    activity = `Working on ${active.id} — ${active.title}. The agent has not written its own status yet; latest activity: ${where}.`;
    steps.length = 0;
    steps.push({ at: clock, text: `Watchdog: the status still named ${live.task}, which is finished — ${active.id} is the task in progress.` });
  } else if (changedAgo >= stallMinutes) {
    activity = `No update for ${quietFor} min and no file has changed for ${changedAgo === Infinity ? 'the whole watch' : `${changedAgo} min`} — the run may be stalled or waiting on something.`;
    steps.push({ at: clock, text: `Watchdog: possible stall — last file change: ${where}.` });
  } else {
    activity = `Still working — no update from the agent for ${quietFor} min; latest activity: ${where}.`;
    steps.push({ at: clock, text: `Watchdog: still working — ${where}.` });
  }

  writeData(livePath, prefix, {
    ...live,
    updatedAt: localTime(now).stamp,
    phase: pointsAtFinishedTask ? activeTasks[0].phaseNumber : live.phase,
    task,
    title: '',
    role: pointsAtFinishedTask ? 'implementer' : live.role,
    activity,
    steps: steps.slice(-MAXIMUM_LIVE_STEPS),
    source: 'watchdog',
  });
  console.log(`watchdog ${clock}: ${activity}`);
}

const commands = { live: writeLive, task: writeTask, snapshot: writeSnapshot, followup: writeFollowUp, activity: writeActivity, status: writeStatus, check: checkData, watch };

if (!commands[command] || !featureFolder) {
  console.error('usage: node dashboard.mjs <live|task|snapshot|followup|activity|status|check|watch> <feature-folder> [options] — see the header of this file');
  process.exit(2);
}
try {
  await commands[command](featureFolder, rest);
} catch (error) {
  console.error(`dashboard.mjs ${command}: ${error.message}`);
  process.exit(1);
}
