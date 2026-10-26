'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, '..', 'skills', 'bt-execute', 'scripts', 'dashboard.mjs');
const SLUG = 'demo-feature';

/**
 * Builds a throwaway feature folder with one phase, one task and one real snapshot image.
 * @returns {string} The feature folder.
 */
function makeFeatureFolder() {
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dashboard-')), SLUG);
  fs.mkdirSync(path.join(folder, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'snapshots'));
  fs.writeFileSync(path.join(folder, 'snapshots', 'T1-01-before.png'), 'png');
  fs.writeFileSync(path.join(folder, 'snapshots', 'T1-02-after.png'), 'png');
  const dashboard = {
    status: 'in-progress',
    afterAction: { snapshots: [], comparison: null },
    phases: [{ number: 1, snapshots: [], tasks: [{ id: 'T1', status: 'in-progress', snapshots: [], updates: [] }] }],
  };
  fs.writeFileSync(path.join(folder, 'documents', `${SLUG}_dashboard.js`), `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  return folder;
}

/**
 * Runs the helper.
 * @param {string[]} commandArguments The command and its arguments.
 * @returns {{ status: number, output: string }}
 */
function runHelper(commandArguments) {
  const result = spawnSync(process.execPath, [HELPER, ...commandArguments], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Reads the dashboard data back.
 * @param {string} folder The feature folder.
 * @returns {any}
 */
function readDashboard(folder) {
  const text = fs.readFileSync(path.join(folder, 'documents', `${SLUG}_dashboard.js`), 'utf8');
  return JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
}

test('task --set repairs a snapshot written with "path" instead of "src", so it still shows', () => {
  const folder = makeFeatureFolder();
  const result = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ snapshots: [{ path: 'snapshots/T1-01-before.png', caption: 'Before', source: 'headless Chrome' }, 'snapshots/T1-02-after.png'] })]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /repaired T1\.snapshots\[0\]: "path" → "src"/);
  const [still, barePath] = readDashboard(folder).phases[0].tasks[0].snapshots;
  assert.deepEqual([still.src, 'path' in still, still.source], ['snapshots/T1-01-before.png', false, 'browser']);
  assert.equal(barePath.src, 'snapshots/T1-02-after.png');
});

test('every dashboard write repairs snapshots already in the file, whichever command writes', () => {
  const folder = makeFeatureFolder();
  const dashboardPath = path.join(folder, 'documents', `${SLUG}_dashboard.js`);
  const dashboard = readDashboard(folder);
  dashboard.afterAction.comparison = { title: 'Pair', before: { file: 'snapshots/T1-01-before.png' }, after: { url: 'snapshots/T1-02-after.png' } };
  dashboard.phases[0].snapshots = [{ frames: [{ image: 'snapshots/T1-01-before.png', stage: 'One' }] }];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  assert.equal(runHelper(['activity', folder, 'Phase 1 verified']).status, 0);
  const written = readDashboard(folder);
  assert.deepEqual([written.afterAction.comparison.before.src, written.afterAction.comparison.after.src], ['snapshots/T1-01-before.png', 'snapshots/T1-02-after.png']);
  assert.equal(written.phases[0].snapshots[0].frames[0].src, 'snapshots/T1-01-before.png');
});

test('task --set refuses a snapshot whose image is not on disk', () => {
  const folder = makeFeatureFolder();
  const result = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ snapshots: [{ title: 'Missing', src: 'snapshots/nope.png' }] })]);
  assert.equal(result.status, 1);
  assert.match(result.output, /is not a file under/);
});

test('task --set accepts a still and a comparison with real images', () => {
  const folder = makeFeatureFolder();
  const snapshots = [
    { title: 'Still', caption: '', source: 'browser', src: 'snapshots/T1-01-before.png', updates: [] },
    { title: 'Pair', caption: '', source: 'browser', before: { src: 'snapshots/T1-01-before.png', caption: 'Before' }, after: { src: 'snapshots/T1-02-after.png', caption: 'After' }, updates: [] },
  ];
  const result = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ snapshots })]);
  assert.equal(result.status, 0, result.output);
  assert.equal(readDashboard(folder).phases[0].tasks[0].snapshots.length, 2);
});

test('snapshot appends a still, a comparison and a progression in the shapes the page renders', () => {
  const folder = makeFeatureFolder();
  assert.equal(runHelper(['snapshot', folder, 'T1', '--src', 'snapshots/T1-01-before.png', '--caption', 'Before', '--source', 'unity']).status, 0);
  assert.equal(runHelper(['snapshot', folder, 'P1', '--before', 'snapshots/T1-01-before.png', '--after', 'snapshots/T1-02-after.png', '--caption', 'Change']).status, 0);
  assert.equal(runHelper(['snapshot', folder, 'plan', '--frame', 'snapshots/T1-01-before.png|Blockout|First pass', '--frame', 'snapshots/T1-02-after.png|Lit|Lighting', '--caption', 'Story']).status, 0);
  const dashboard = readDashboard(folder);
  const [still] = dashboard.phases[0].tasks[0].snapshots;
  assert.deepEqual([still.src, still.caption, still.source], ['snapshots/T1-01-before.png', 'Before', 'unity']);
  const [comparison] = dashboard.phases[0].snapshots;
  assert.deepEqual([comparison.before.src, comparison.after.src], ['snapshots/T1-01-before.png', 'snapshots/T1-02-after.png']);
  const [progression] = dashboard.afterAction.snapshots;
  assert.deepEqual(progression.frames.map((frame) => frame.stage), ['Blockout', 'Lit']);
});

test('snapshot refuses a missing image and an unknown target', () => {
  const folder = makeFeatureFolder();
  assert.match(runHelper(['snapshot', folder, 'T1', '--src', 'snapshots/nope.png']).output, /is not a file under/);
  assert.match(runHelper(['snapshot', folder, 'T9', '--src', 'snapshots/T1-01-before.png']).output, /no task "T9"/);
});

test('check repairs a wrong image key in the file, and fails only on an image that is not on disk', () => {
  const folder = makeFeatureFolder();
  const dashboardPath = path.join(folder, 'documents', `${SLUG}_dashboard.js`);
  const dashboard = readDashboard(folder);
  dashboard.phases[0].tasks[0].snapshots = [{ path: 'snapshots/T1-01-before.png', caption: 'Before' }];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const repaired = runHelper(['check', folder]);
  assert.equal(repaired.status, 0, repaired.output);
  assert.match(repaired.output, /repaired 1 snapshot entry/);
  assert.match(repaired.output, /1 snapshot entries all show an image/);
  assert.equal(readDashboard(folder).phases[0].tasks[0].snapshots[0].src, 'snapshots/T1-01-before.png');
  dashboard.phases[0].tasks[0].snapshots = [{ title: 'Gone', src: 'snapshots/missing.png', updates: [] }];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const missing = runHelper(['check', folder]);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /is not a file under/);
});

test('check and every write turn a decision written as plain text into the object the page renders', () => {
  const folder = makeFeatureFolder();
  const dashboardPath = path.join(folder, 'documents', `${SLUG}_dashboard.js`);
  const dashboard = readDashboard(folder);
  const kept = { id: 'T1', text: 'Deferred after 3 attempts', source: 'auto-pilot', updates: [] };
  dashboard.decisions = ['D1 — Pad slots are first-free.', 'D9 (confirmed by the user, 2026-10-21) — Every racer deploys it.', 'No id here', kept];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const result = runHelper(['check', folder]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /repaired 3 decisions written as plain text/);
  assert.deepEqual(readDashboard(folder).decisions, [
    { id: 'D1', text: 'Pad slots are first-free.', updates: [] },
    { id: 'D9', text: '(confirmed by the user, 2026-10-21) Every racer deploys it.', updates: [] },
    { id: '', text: 'No id here', updates: [] },
    kept,
  ]);
  dashboard.decisions = ['D2 — Written around the helper.'];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  assert.equal(runHelper(['activity', folder, 'Phase 1 verified']).status, 0);
  assert.deepEqual(readDashboard(folder).decisions, [{ id: 'D2', text: 'Written around the helper.', updates: [] }]);
});

/**
 * Rewrites one task's fields directly in the data file, as a test setup step.
 * @param {string} folder The feature folder.
 * @param {Record<string, any>} fields The fields to merge into T1.
 */
function setFirstTask(folder, fields) {
  const dashboard = readDashboard(folder);
  Object.assign(dashboard.phases[0].tasks[0], fields);
  fs.writeFileSync(path.join(folder, 'documents', `${SLUG}_dashboard.js`), `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
}

test('task refuses built, verifying and done while frames saved for the task are not on the dashboard', () => {
  const folder = makeFeatureFolder();
  fs.writeFileSync(path.join(folder, 'snapshots', 'T10-01-other.png'), 'png');
  for (const status of ['built', 'verifying', 'done']) {
    const refused = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ status })]);
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, new RegExp(`T1 cannot be "${status}" while its frames are on disk`));
    assert.match(refused.output, /snapshots\/T1-01-before\.png/);
    assert.doesNotMatch(refused.output, /T10-01-other/);
  }
  assert.equal(readDashboard(folder).phases[0].tasks[0].status, 'in-progress');
  assert.equal(runHelper(['snapshot', folder, 'T1', '--src', 'snapshots/T1-01-before.png', '--caption', 'Before']).status, 0);
  const stillOneLeft = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ status: 'built' })]);
  assert.equal(stillOneLeft.status, 1);
  assert.match(stillOneLeft.output, /snapshots\/T1-02-after\.png/);
  assert.doesNotMatch(stillOneLeft.output, /T1-01-before/);
  assert.equal(runHelper(['snapshot', folder, 'T1', '--src', 'snapshots/T1-02-after.png', '--caption', 'After']).status, 0);
  const built = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ status: 'built' })]);
  assert.equal(built.status, 0, built.output);
  assert.equal(readDashboard(folder).phases[0].tasks[0].status, 'built');
});

test('a visual task is not built with no snapshot, unless --no-frame records why', () => {
  const folder = makeFeatureFolder();
  fs.rmSync(path.join(folder, 'snapshots', 'T1-01-before.png'));
  fs.rmSync(path.join(folder, 'snapshots', 'T1-02-after.png'));
  setFirstTask(folder, { kind: 'game' });
  const refused = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ status: 'built' })]);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.output, /T1 \(kind game\) is visual and has no snapshot/);
  const reason = 'the change shows only in a two-browser network race; the verifier captures it';
  const built = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ status: 'built' }), '--no-frame', reason]);
  assert.equal(built.status, 0, built.output);
  const dashboard = readDashboard(folder);
  assert.equal(dashboard.phases[0].tasks[0].status, 'built');
  assert.match(dashboard.activity.at(-1).text, /T1 built with no frame yet — the change shows only/);
});

test('check fails on frames left behind by a finished task, a closed phase and an unused plan-before', () => {
  const folder = makeFeatureFolder();
  fs.writeFileSync(path.join(folder, 'snapshots', 'P1-01-overview.png'), 'png');
  fs.writeFileSync(path.join(folder, 'snapshots', 'plan-before.png'), 'png');
  fs.writeFileSync(path.join(folder, 'snapshots', 'plan-after.png'), 'png');
  const dashboard = readDashboard(folder);
  dashboard.status = 'paused';
  dashboard.phases[0].status = 'done';
  dashboard.phases[0].tasks[0].status = 'done';
  fs.writeFileSync(path.join(folder, 'documents', `${SLUG}_dashboard.js`), `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const failed = runHelper(['check', folder]);
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /T1 has frames on disk that no dashboard entry shows: snapshots\/T1-01-before\.png, snapshots\/T1-02-after\.png/);
  assert.match(failed.output, /P1 has frames on disk that no dashboard entry shows: snapshots\/P1-01-overview\.png/);
  assert.match(failed.output, /snapshots\/plan-before\.png is not in the After Action Report/);
  assert.equal(runHelper(['snapshot', folder, 'T1', '--frame', 'snapshots/T1-01-before.png|Before|Start', '--frame', 'snapshots/T1-02-after.png|Built|Done', '--caption', 'T1']).status, 0);
  assert.equal(runHelper(['snapshot', folder, 'P1', '--src', 'snapshots/P1-01-overview.png', '--caption', 'Overview']).status, 0);
  assert.equal(runHelper(['snapshot', folder, 'comparison', '--before', 'snapshots/plan-before.png', '--after', 'snapshots/plan-after.png', '--caption', 'The plan']).status, 0);
  const passed = runHelper(['check', folder]);
  assert.equal(passed.status, 0, passed.output);
  const comparison = readDashboard(folder).afterAction.comparison;
  assert.deepEqual([comparison.before.src, comparison.after.src], ['snapshots/plan-before.png', 'snapshots/plan-after.png']);
});

test('check leaves a plan-before alone while the run is still going, and frames of tasks still being built', () => {
  const folder = makeFeatureFolder();
  fs.writeFileSync(path.join(folder, 'snapshots', 'plan-before.png'), 'png');
  const result = runHelper(['check', folder]);
  assert.equal(result.status, 0, result.output);
});

test('every snapshot added is a step in the live file, so the page sees the work between status changes', () => {
  const folder = makeFeatureFolder();
  assert.equal(runHelper(['task', folder, 'T1', '--set', JSON.stringify({ status: 'in-progress' })]).status, 0);
  assert.equal(runHelper(['snapshot', folder, 'T1', '--src', 'snapshots/T1-01-before.png', '--caption', 'The track before the fix']).status, 0);
  const text = fs.readFileSync(path.join(folder, 'documents', `${SLUG}_live.js`), 'utf8');
  const live = JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
  assert.deepEqual([live.task, live.role, live.source], ['T1', 'implementer', 'agent']);
  assert.equal(live.activity, 'Added a snapshot to T1 — The track before the fix');
  assert.deepEqual(live.steps.map((step) => step.text), ['Building T1.', 'Added a snapshot to T1 — The track before the fix']);
});

/**
 * Reads the follow-ups document the helper writes.
 * @param {string} folder The feature folder.
 * @returns {string}
 */
function readFollowUpsDocument(folder) {
  return fs.readFileSync(path.join(folder, 'documents', `${SLUG}_followups.md`), 'utf8');
}

test('followup numbers each follow-up and writes the document bt-spec reads', () => {
  const folder = makeFeatureFolder();
  const first = runHelper(['followup', folder, '--title', 'GO! banner stays up on clients', '--detail', 'Seen 15–27 s into every client race.', '--source', 'T2 verifier', '--file', 'src/hud/Banner.tsx']);
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /added F1 — spec it with: \/bt-spec Fix F1 from @\.agents\/specs\/demo-feature\/documents\/demo-feature_followups\.md/);
  assert.equal(runHelper(['followup', folder, '--title', 'Late compiles on the host', '--detail', '29–52 records after the reveal.']).status, 0);
  const dashboard = readDashboard(folder);
  assert.deepEqual(dashboard.followUps.map((followUp) => followUp.id), ['F1', 'F2']);
  assert.deepEqual(dashboard.followUps[0].files, ['src/hud/Banner.tsx']);
  assert.ok(dashboard.documents.some((document) => document.path === `documents/${SLUG}_followups.md`));
  const document = readFollowUpsDocument(folder);
  assert.match(document, /\/bt-spec Fix F1 and F2 from @\.agents\/specs\/demo-feature\/documents\/demo-feature_followups\.md/);
  assert.match(document, /## F1 — GO! banner stays up on clients\n\n- \*\*Raised:\*\* .* · T2 verifier\n- \*\*Files:\*\* `src\/hud\/Banner\.tsx`\n\nSeen 15–27 s into every client race\./);
  assert.match(document, /## F2 — Late compiles on the host/);
  const missingDetail = runHelper(['followup', folder, '--title', 'No detail']);
  assert.equal(missingDetail.status, 1);
  assert.match(missingDetail.output, /usage: followup/);
});

test('followup revises one only with a note, and the document shows the revision', () => {
  const folder = makeFeatureFolder();
  assert.equal(runHelper(['followup', folder, '--title', 'Held items cast shadows', '--detail', '0.2–3 draws a frame.']).status, 0);
  const silent = runHelper(['followup', folder, '--id', 'F1', '--detail', 'Changed']);
  assert.equal(silent.status, 1);
  assert.match(silent.output, /needs --note/);
  assert.match(runHelper(['followup', folder, '--id', 'F9', '--note', 'x']).output, /no follow-up "F9" — the dashboard has F1/);
  const revised = runHelper(['followup', folder, '--id', 'F1', '--detail', 'Up to 3 draws a frame.', '--note', 'Measured on all tracks', '--by', 'T4']);
  assert.equal(revised.status, 0, revised.output);
  const [followUp] = readDashboard(folder).followUps;
  assert.equal(followUp.detail, 'Up to 3 draws a frame.');
  assert.equal(followUp.updates[0].note, 'Measured on all tracks');
  assert.match(readFollowUpsDocument(folder), /\*\*Revised .* by T4:\*\* Measured on all tracks/);
});

test('check turns plain-text follow-ups into numbered ones without reusing an id, and writes the document', () => {
  const folder = makeFeatureFolder();
  const dashboard = readDashboard(folder);
  dashboard.followUps = [
    'Network client page: the GO! banner and the Start bar stay on screen 15–27 s into the race. Seen in every client frame.',
    'F1 — Already numbered by hand',
    { title: 'An entry with no id', detail: 'It still gets one.' },
  ];
  fs.writeFileSync(path.join(folder, 'documents', `${SLUG}_dashboard.js`), `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const result = runHelper(['check', folder]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /repaired 3 follow-ups without an id/);
  const [plain, numbered, unnumbered] = readDashboard(folder).followUps;
  assert.deepEqual([plain.id, numbered.id, unnumbered.id], ['F2', 'F1', 'F3']);
  assert.equal(plain.title, 'Network client page: the GO! banner and the Start bar stay on screen 15–27 s into the race.');
  assert.match(plain.detail, /Seen in every client frame\./);
  assert.equal(numbered.title, 'Already numbered by hand');
  assert.match(readFollowUpsDocument(folder), /\/bt-spec Fix F2, F1 and F3 from/);
});

/**
 * Builds a project with a source feature that has two follow-ups and a new, specified feature beside it.
 * @returns {{ root: string, source: string, target: string }}
 */
function makeFollowUpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-followups-'));
  const makeFeature = (group, slug, data) => {
    const folder = path.join(root, '.agents', group, slug);
    fs.mkdirSync(path.join(folder, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'documents', `${slug}_dashboard.js`), `window.FEATURE_DASHBOARD = ${JSON.stringify(data)};\n`);
    return folder;
  };
  const source = makeFeature('complete', 'kart-shadows', { status: 'complete', feature: { title: 'Kart Shadows', slug: 'kart-shadows' }, phases: [], followUps: ['The GO! banner stays up on clients.', 'Held items cast their own shadows.'] });
  const target = makeFeature('specs', 'banner-fix', { status: 'specified', feature: { title: 'Banner Fix', slug: 'banner-fix' }, phases: [], documents: [] });
  return { root, source, target };
}

/**
 * Reads any feature's dashboard data.
 * @param {string} folder The feature folder.
 * @returns {any}
 */
function readFeature(folder) {
  const slug = path.basename(folder);
  const text = fs.readFileSync(path.join(folder, 'documents', `${slug}_dashboard.js`), 'utf8');
  return JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
}

test('addresses marks the source follow-ups specced, and the feature\'s progress follows them to done', () => {
  const { source, target } = makeFollowUpProject();
  const linked = runHelper(['addresses', target, '--source', source, '--ids', 'F1']);
  assert.equal(linked.status, 0, linked.output);
  let [banner, items] = readFeature(source).followUps;
  assert.deepEqual([banner.status, banner.addressedBy.folder, banner.addressedBy.title], ['specced', '.agents/specs/banner-fix', 'Banner Fix']);
  assert.equal(items.status, undefined);
  const feature = readFeature(target);
  assert.deepEqual(feature.feature.addresses, [{ folder: '.agents/complete/kart-shadows', slug: 'kart-shadows', ids: ['F1'] }]);
  assert.ok(feature.documents.some((document) => document.label === 'Source follow-ups' && document.path === '../../complete/kart-shadows/documents/kart-shadows_followups.md'));
  assert.equal(runHelper(['status', target, 'in-progress']).status, 0);
  assert.equal(readFeature(source).followUps[0].status, 'in-progress');
  assert.equal(runHelper(['status', target, 'complete']).status, 0);
  [banner, items] = readFeature(source).followUps;
  assert.equal(banner.status, 'done');
  assert.match(banner.addressedBy.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(banner.updates, [], 'progress is dated on addressedBy, never logged as a revision');
  const document = fs.readFileSync(path.join(source, 'documents', 'kart-shadows_followups.md'), 'utf8');
  assert.match(document, /- \*\*Status:\*\* Done — addressed by Banner Fix \(`\.agents\/specs\/banner-fix`\)/);
  assert.match(document, /\/bt-spec Fix F2 from @\.agents\/complete\/kart-shadows/);
  assert.doesNotMatch(document, /Fix F1 from/);
});

test('addresses refuses an id the source does not have, and finds a source the user moved', () => {
  const { root, source, target } = makeFollowUpProject();
  const refused = runHelper(['addresses', target, '--source', source, '--ids', 'F1,F9']);
  assert.equal(refused.status, 1);
  assert.match(refused.output, /has no follow-up F9 — it has F1, F2/);
  assert.equal(runHelper(['addresses', target, '--source', source, '--ids', 'F1,F2']).status, 0);
  const moved = path.join(root, '.agents', 'archived', 'shadows', 'kart-shadows');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(source, moved);
  const planned = readFeature(target);
  planned.status = 'planned';
  fs.writeFileSync(path.join(target, 'documents', 'banner-fix_dashboard.js'), `window.FEATURE_DASHBOARD = ${JSON.stringify(planned)};\n`);
  const checked = runHelper(['check', target]);
  assert.match(checked.output, /kart-shadows: F1 and F2 now planned/);
  assert.deepEqual(readFeature(moved).followUps.map((followUp) => followUp.status), ['planned', 'planned']);
  assert.equal(readFeature(target).feature.addresses[0].folder, '.agents/archived/shadows/kart-shadows');
});

test('the dashboard page shows an addressed follow-up\'s state and link instead of its spec command', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'skills', 'bt-execute', 'templates', 'dashboard', 'dashboard.html'), 'utf8');
  assert.match(page, /\$\{isOpen \? copyableCommand\(followUpCommand\(\[followUp\.id\]\)\) : ''\}/);
  assert.match(page, /Addressed by <a href=/);
});

test('a renamed feature folder still finds its data files by their own slug', () => {
  const folder = makeFeatureFolder();
  const renamed = path.join(path.dirname(folder), 'renamed-folder');
  fs.renameSync(folder, renamed);
  const result = runHelper(['followup', renamed, '--title', 'Still found', '--detail', 'The files keep the old slug.']);
  assert.equal(result.status, 0, result.output);
  assert.ok(fs.existsSync(path.join(renamed, 'documents', `${SLUG}_followups.md`)));
  assert.equal(readDashboard(renamed).followUps[0].id, 'F1');
});

test('a Quick Plan that cites follow-ups in its plan is linked by check, and its progress reaches the source', () => {
  const { source, target } = makeFollowUpProject();
  const quickPlan = readFeature(target);
  quickPlan.status = 'planned';
  quickPlan.feature.origin = 'quick-plan';
  fs.writeFileSync(path.join(target, 'documents', 'banner-fix_dashboard.js'), `window.FEATURE_DASHBOARD = ${JSON.stringify(quickPlan)};\n`);
  fs.writeFileSync(path.join(target, 'documents', 'banner-fix_plan.md'), '# Plan — Banner Fix\n\nQuick Plan for follow-up **F2** of Kart Shadows\n(`.agents/specs/kart-shadows/documents/kart-shadows_followups.md`).\n\nF1 is not part of this plan.\n');
  const checked = runHelper(['check', target]);
  assert.match(checked.output, /linked from the plan: banner-fix takes on F2 of \.agents\/complete\/kart-shadows/);
  const linked = readFeature(target);
  assert.deepEqual(linked.feature.addresses, [{ folder: '.agents/complete/kart-shadows', slug: 'kart-shadows', ids: ['F2'] }]);
  assert.deepEqual(readFeature(source).followUps.map((followUp) => followUp.status), [undefined, 'planned']);
  assert.equal(runHelper(['status', target, 'complete']).status, 0);
  assert.equal(readFeature(source).followUps[1].status, 'done');
});

test('the dashboard page offers a bt-spec or Quick Plan command per follow-up and for those ticked together', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'skills', 'bt-execute', 'templates', 'dashboard', 'dashboard.html'), 'utf8');
  assert.match(page, /return `\/\$\{skill\} Fix \$\{joined\} from \$\{followUpsReference\(\)\}`/);
  assert.match(page, /spec: \{ skill: 'bt-spec'/);
  assert.match(page, /plan: \{ skill: 'bt-plan'/);
  assert.match(page, /data\.followUps = asFollowUps\(asList\(data\.followUps\)\)/);
  assert.match(page, /data-follow-up="/);
});

test('snapshot comparison needs both sides', () => {
  const folder = makeFeatureFolder();
  const result = runHelper(['snapshot', folder, 'comparison', '--src', 'snapshots/T1-01-before.png']);
  assert.equal(result.status, 1);
  assert.match(result.output, /plan-wide comparison takes --before/);
});

test('the dashboard page shows a decision written as plain text instead of an empty row', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'skills', 'bt-execute', 'templates', 'dashboard', 'dashboard.html'), 'utf8');
  assert.match(page, /data\.decisions = asList\(data\.decisions\)\.map\(asDecision\)/);
});

test('the dashboard page repairs an image written under "path" so it still shows', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'skills', 'bt-execute', 'templates', 'dashboard', 'dashboard.html'), 'utf8');
  assert.match(page, /const imageKeys = \['path', 'file', 'image', 'url'\]/);
  assert.match(page, /repairImage\(snapshot\.before\)/);
});
