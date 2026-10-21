#!/usr/bin/env node
/**
 * Feature dashboard helper for bt-execute: the one way agents write a feature's dashboard data, plus the
 * watchdog that keeps the live status honest while an agent is busy with a long task.
 *
 * Every write reads the data file, parses its strict JSON, changes it and writes it back atomically (a temp file
 * renamed over the original), so the page can never load a half-written file and no hand edit can break it.
 *
 *   node dashboard.mjs live     <feature-folder> --task T19 --role implementer --activity "…" [--phase 7] [--step "…"]… [--reset] [--title "…"]
 *   node dashboard.mjs task     <feature-folder> <task-id> --set '{"status":"built","summary":"…"}' [--note "why an earlier result changed" --by T21]
 *   node dashboard.mjs snapshot <feature-folder> <T7|P2|plan> --src snapshots/T7-01-stage.png --caption "…" [--title "…"] [--source unity]
 *                              (comparison: --before snapshots/a.png --after snapshots/b.png [--before-caption …] [--after-caption …];
 *                               progression: --frame "snapshots/x.png|stage|caption" repeated)
 *   node dashboard.mjs activity <feature-folder> "Phase 2 verified — T4–T6 PASS"
 *   node dashboard.mjs status   <feature-folder> in-progress|paused|complete|incomplete
 *   node dashboard.mjs check    <feature-folder>
 *   node dashboard.mjs watch    <feature-folder> [--watch <folder>]… [--interval-seconds 60] [--quiet-minutes 10] [--stall-minutes 30] [--max-hours 12]
 *
 * <feature-folder> is .agents/specs/<slug>. Timestamps come from this machine's local clock.
 *
 * Snapshots go in only through `snapshot`. `task --set` and `check` refuse any snapshot entry the page cannot show —
 * an image under `path` (or `file`, `image`, …) instead of `src`, or a `src` that is not a file under the feature
 * folder — because such an entry renders as "No snapshot".
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

/** How many entries a task's live step log keeps. */
const MAXIMUM_LIVE_STEPS = 12;
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
 * Reads the paths of a feature folder's two data files.
 * @param {string} folder The feature folder, `.agents/specs/<slug>`.
 * @returns {{ slug: string, dashboardPath: string, livePath: string }}
 */
function dataPaths(folder) {
  const slug = basename(folder.replace(/[\\/]+$/, ''));
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
 * Rewrites the live status: what is happening this minute.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList Command options.
 */
function writeLive(folder, argumentList) {
  const { options } = parseOptions(argumentList, ['step']);
  const { livePath } = dataPaths(folder);
  const existing = existsSync(livePath) ? readData(livePath) : { prefix: 'window.FEATURE_LIVE', data: {} };
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
 * Finds a task anywhere in the dashboard data.
 * @param {any} dashboard The dashboard data.
 * @param {string} taskId The task id, e.g. `T12.2`.
 * @returns {any | undefined}
 */
function findTask(dashboard, taskId) {
  for (const phase of dashboard.phases || []) {
    const task = (phase.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) return task;
  }
  return undefined;
}

/**
 * Merges fields into one task, optionally recording why an earlier result changed.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList The task id and options.
 */
function writeTask(folder, argumentList) {
  const { options, positional } = parseOptions(argumentList);
  const [taskId] = positional;
  if (!taskId || typeof options.set !== 'string') throw new Error('usage: task <feature-folder> <task-id> --set \'{"status":"built"}\'');
  const { dashboardPath } = dataPaths(folder);
  const { prefix, data } = readData(dashboardPath);
  const task = findTask(data, taskId);
  if (!task) throw new Error(`task ${taskId} is not in ${dashboardPath} — sync the dashboard with the plan first`);
  const changes = JSON.parse(options.set);
  checkTaskShape(changes);
  if (Array.isArray(changes.snapshots)) {
    const problems = changes.snapshots.flatMap((snapshot, index) => snapshotProblems(folder, snapshot, `${taskId}.snapshots[${index}]`));
    if (problems.length) throw new Error(snapshotRefusal(problems));
  }
  Object.assign(task, changes);
  const now = localTime();
  if (typeof options.note === 'string') {
    task.updates = Array.isArray(task.updates) ? task.updates : [];
    task.updates.push({ at: now.stamp, by: typeof options.by === 'string' ? options.by : taskId, note: options.note });
  }
  data.updatedAt = now.stamp;
  writeData(dashboardPath, prefix, data);
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
 * refusing an image that is not on disk. This is the way to add snapshots: nobody writes snapshot JSON by hand.
 * @param {string} folder The feature folder.
 * @param {string[]} argumentList The target and options.
 */
function writeSnapshot(folder, argumentList) {
  const { options, positional } = parseOptions(argumentList, ['frame']);
  const [target] = positional;
  const usage = 'usage: snapshot <feature-folder> <T3|P1|plan> (--src snapshots/x.png | --before snapshots/a.png --after snapshots/b.png | --frame "snapshots/x.png|stage|caption"…) --caption "…" [--title "…"] [--source browser|unity|blender|reference] [--before-caption "…"] [--after-caption "…"] [--task T3]';
  if (!target) throw new Error(usage);
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
  snapshotListFor(data, target).push(snapshot);
  data.updatedAt = localTime().stamp;
  writeData(dashboardPath, prefix, data);
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
 * Sets the dashboard's run status.
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
}

/**
 * Confirms both data files parse and every snapshot entry will show its image; fails listing each one that would
 * show "No snapshot".
 * @param {string} folder The feature folder.
 * @throws {Error} When a file does not parse or a snapshot entry is broken.
 */
function checkData(folder) {
  const { dashboardPath, livePath } = dataPaths(folder);
  const { data } = readData(dashboardPath);
  if (existsSync(livePath)) readData(livePath);
  const snapshots = allSnapshots(data);
  const problems = snapshots.flatMap(({ snapshot, where }) => snapshotProblems(folder, snapshot, where));
  if (problems.length) throw new Error(snapshotRefusal(problems));
  console.log(`ok: ${dashboardPath}${existsSync(livePath) ? ` and ${livePath}` : ''} parse; ${snapshots.length} snapshot entries all show an image`);
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
      // The dashboard's own data files are written by agents and the watchdog itself — not a sign of work.
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
 * The watchdog. While the dashboard says a run is in progress it checks the live status every interval:
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

const commands = { live: writeLive, task: writeTask, snapshot: writeSnapshot, activity: writeActivity, status: writeStatus, check: checkData, watch };

if (!commands[command] || !featureFolder) {
  console.error('usage: node dashboard.mjs <live|task|snapshot|activity|status|check|watch> <feature-folder> [options] — see the header of this file');
  process.exit(2);
}
try {
  await commands[command](featureFolder, rest);
} catch (error) {
  console.error(`dashboard.mjs ${command}: ${error.message}`);
  process.exit(1);
}
