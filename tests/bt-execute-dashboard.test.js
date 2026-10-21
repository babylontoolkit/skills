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

test('task --set refuses a snapshot written with "path" instead of "src", and writes nothing', () => {
  const folder = makeFeatureFolder();
  const result = runHelper(['task', folder, 'T1', '--set', JSON.stringify({ snapshots: [{ path: 'snapshots/T1-01-before.png', caption: 'Before' }] })]);
  assert.equal(result.status, 1);
  assert.match(result.output, /has "path" — the page reads only "src"/);
  assert.match(result.output, /dashboard\.mjs snapshot/);
  assert.deepEqual(readDashboard(folder).phases[0].tasks[0].snapshots, []);
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

test('check fails on a broken snapshot entry already in the file and passes once it is fixed', () => {
  const folder = makeFeatureFolder();
  const dashboardPath = path.join(folder, 'documents', `${SLUG}_dashboard.js`);
  const dashboard = readDashboard(folder);
  dashboard.phases[0].tasks[0].snapshots = [{ path: 'snapshots/T1-01-before.png', caption: 'Before' }];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const broken = runHelper(['check', folder]);
  assert.equal(broken.status, 1);
  assert.match(broken.output, /T1\.snapshots\[0\] has "path"/);
  dashboard.phases[0].tasks[0].snapshots = [{ title: 'Before', src: 'snapshots/T1-01-before.png', updates: [] }];
  fs.writeFileSync(dashboardPath, `window.FEATURE_DASHBOARD = ${JSON.stringify(dashboard)};\n`);
  const fixed = runHelper(['check', folder]);
  assert.equal(fixed.status, 0, fixed.output);
  assert.match(fixed.output, /1 snapshot entries all show an image/);
});

test('the dashboard page repairs an image written under "path" so it still shows', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'skills', 'bt-execute', 'templates', 'dashboard', 'dashboard.html'), 'utf8');
  assert.match(page, /const imageKeys = \['path', 'file', 'image', 'url'\]/);
  assert.match(page, /repairImage\(snapshot\.before\)/);
});
