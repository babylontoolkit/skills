'use strict';

/**
 * `unity_project create` = the Agent Reference's Babylon Toolkit scaffold (D56, unity-exporter-cli.md §4 +
 * §4B.4). Every Unity call is a fake; the clock and sleeps are injected, so a 30 min create runs in ms.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  executeUnity,
  executeUnityProject,
  GIT_MISSING,
  BOOTSTRAP_CS,
  NEWSCENE_CS,
  EXPORTER_COMPILED_CS,
} = require('../lib/bridge/unity/ops');
const { createWorkspace } = require('../lib/bridge/unity/discover');
const { SCRIPTS_OFF } = require('../lib/bridge/unity/guard');

const CLI = { path: '/fake/unity', version: '1.0.0' };
const NPM = { file: '/fake/node', args: ['/fake/npm-cli.js', 'install'] };
const GLTF_URL = 'https://github.com/babylontoolkit/unitygltf.git';
const TOOLKIT_URL = 'https://github.com/babylontoolkit/professionaledition.git';

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-scaffold-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (result) => JSON.stringify({ success: true, data: { result }, errors: [] });
const bad = (message) => JSON.stringify({ success: false, data: {}, errors: [{ message }] });

/**
 * A fake Unity (and git, and npm) for the scaffold. Every call is recorded; `overrides(args, file)` may
 * answer a call first (return undefined to fall through to the happy path).
 */
function fakeScaffold({ overrides = () => undefined, writePackageJson = true } = {}) {
  const calls = [];
  const ready = new Set();
  const answer = (file, args) => {
    const o = overrides(args, file);
    if (o !== undefined) return o;
    if (file === 'git') return { stdout: 'git version 2.44.0' };
    if (file === NPM.file) return { stdout: 'added 1 package' };
    if (args[0] === 'projects' && args[1] === 'new') {
      const dir = path.join(args[args.indexOf('--path') + 1], args[2]);
      fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\n');
      return { stdout: JSON.stringify({ success: true, data: { path: dir, version: '6000.5.10f1' }, errors: [] }) };
    }
    if (args[0] === 'pipeline' && args[1] === 'install') {
      const dir = args[args.indexOf('--project-path') + 1];
      fs.mkdirSync(path.join(dir, 'Packages'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.8.0-exp.1' } }));
      return { stdout: JSON.stringify({ success: true, data: { alreadyInstalled: false }, errors: [] }) };
    }
    if (args[0] === 'pipeline' && args[1] === 'list') {
      const instances = [...ready].map((p) => ({ projectPath: p, pipelineServer: { isReachable: true } }));
      return { stdout: JSON.stringify({ success: true, data: { instances }, errors: [] }) };
    }
    if (args[0] === 'open') {
      ready.add(args[1]);
      return { stdout: '' };
    }
    if (args[0] === 'status') {
      const instances = [...ready].map((p) => ({ project: p, state: 'ready' }));
      return { stdout: JSON.stringify({ success: true, data: { instances }, errors: [] }) };
    }
    if (args[0] === 'command') {
      const dir = args[args.indexOf('--project-path') + 1];
      if (args[1] === 'package_add') return { stdout: ok({ status: 'in_progress' }) };
      if (args[1] === 'package_status') return { stdout: ok({ status: 'completed' }) };
      if (args[1] === 'eval_file' && args[2] === BOOTSTRAP_CS) {
        if (writePackageJson) fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        return { stdout: ok(writePackageJson ? 'packageJson=written exportRoot=Export' : 'packageJson=present') };
      }
      if (args[1] === 'eval_file' && args[2] === NEWSCENE_CS) {
        fs.mkdirSync(path.join(dir, 'Assets', 'Scenes'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Assets', 'Scenes', 'Level01.unity'), '%YAML');
        return { stdout: ok('scene=Assets/Scenes/Level01.unity lighting=ok') };
      }
      if (args[1] === 'eval') {
        const code = args[2];
        if (code === EXPORTER_COMPILED_CS) return { stdout: ok('READY') };
        if (code.includes('new[]{"org.khronos.unitygltf","com.babylontoolkit.editor"}')) {
          return { stdout: ok('org.khronos.unitygltf=True; com.babylontoolkit.editor=True; ') };
        }
        if (code.includes('typeof(CanvasTools.CanvasToolsExporter).Assembly')) return { stdout: ok('CanvasTools, Version=9.28.0.0') };
        if (code.includes('ToolkitManager.IsPro()')) return { stdout: ok('pro=False tsc=True exportRoot=Export scene=Assets/Scenes/Level01.unity') };
        return { stdout: ok('queued') };
      }
    }
    return { stdout: ok({}) };
  };
  const record = (launched) => async (file, args, opts = {}) => {
    calls.push({ file, args, opts, launched });
    const r = (await answer(file, args)) || {};
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...r };
  };
  return { calls, runProcess: record(false), launch: record(true) };
}

/** A compact, readable name for a recorded call. */
function label(c) {
  const a = c.args;
  if (c.file === 'git') return 'git --version';
  if (c.file === NPM.file) return `npm install (cwd ${path.basename(c.opts.cwd)})`;
  if (a[0] === 'projects') return `unity projects new ${a[2]}`;
  if (a[0] === 'pipeline') return `unity pipeline ${a[1]}`;
  if (a[0] === 'open') return `unity open (detached=${c.launched})`;
  if (a[0] === 'status') return 'unity status';
  if (a[0] === 'command' && a[1] === '--query') return `unity command --query ${a[2]}`;
  if (a[0] === 'command' && a[1] === 'editor_status') return 'unity editor_status';
  if (a[0] === 'command' && a[1] === 'package_add') return `package_add ${a[a.indexOf('--identifier') + 1]}`;
  if (a[0] === 'command' && a[1] === 'package_status') return 'package_status';
  if (a[0] === 'command' && a[1] === 'eval_file') return `eval_file ${path.basename(a[2])}`;
  if (a[0] === 'command' && a[1] === 'eval') {
    const code = a[2];
    if (code === EXPORTER_COMPILED_CS) return 'eval exporter-compiled?';
    const add = /Client\.Add\("([^"]+)"\)/.exec(code);
    if (add) return `eval Client.Add ${add[1]}`;
    const find = /FindForAssetPath\("Packages\/([^/]+)\/package\.json"\) != null \? "READY"/.exec(code);
    if (find) return `eval ${find[1]} resolved?`;
    if (code.includes('new[]{')) return 'eval packages-registered';
    if (code.includes('Assembly.FullName')) return 'eval exporter-assembly';
    if (code.includes('IsPro')) return 'eval verify';
  }
  return a.join(' ');
}

async function create(t, { name = 'ScaffoldCheck', fake = fakeScaffold(), folder = scratch(t), allowScripts = true } = {}) {
  const workspace = createWorkspace({ projectsDir: folder });
  const events = [];
  const scaffoldCalls = [];
  let clock = 0;
  await executeUnityProject(
    { jobId: 'job1', op: { kind: 'unity.project', action: 'create', name }, allowScripts, consentGranted: false },
    {
      workspace,
      cli: CLI,
      emit: async (e) => void events.push(e),
      runProcess: fake.runProcess,
      launch: fake.launch,
      log: { info() {}, op() {}, error() {} },
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      npm: NPM,
      onScaffold: (active, root) => scaffoldCalls.push([active, root]),
    }
  );
  return {
    folder,
    root: path.join(folder, name),
    workspace,
    events,
    scaffoldCalls,
    calls: fake.calls,
    labels: fake.calls.map(label),
    final: events.find((e) => e.type === 'final'),
    refused: events.find((e) => e.type === 'refused'),
    progress: events.filter((e) => e.type === 'progress').map((e) => e.line),
  };
}

test('create: the full scaffold in the Agent Reference order — git first, glTF before the toolkit, current only at the end', async (t) => {
  const r = await create(t);
  assert.deepEqual(r.labels, [
    'git --version',
    'unity projects new ScaffoldCheck',
    'unity pipeline install',
    'unity status',
    'unity open (detached=true)',
    'unity status',
    'unity editor_status',
    `package_add ${GLTF_URL}`,
    'package_status',
    `package_add ${TOOLKIT_URL}`,
    'package_status',
    'eval exporter-compiled?',
    'eval_file bt-bootstrap.cs',
    'npm install (cwd ScaffoldCheck)',
    'eval_file bt-newscene.cs',
    'unity pipeline list',
    'eval packages-registered',
    'eval exporter-assembly',
    'eval verify',
  ]);
  const newCall = r.calls[1];
  assert.deepEqual(newCall.args, ['projects', 'new', 'ScaffoldCheck', '--path', r.folder, '--format', 'json', '--non-interactive']);
  assert.equal(newCall.opts.timeoutMs, 1_800_000, 'projects new is waited for (long operation)');
  for (const c of r.calls.filter((x) => x.args[1] === 'package_add')) {
    assert.deepEqual(c.args.slice(c.args.indexOf('--')), ['--', '--identifier', c.args[c.args.indexOf('--identifier') + 1], '--confirm', 'true']);
  }
  assert.ok(r.calls.every((c) => !c.args.includes('--yes')));
  assert.ok(r.calls.every((c) => !(c.args[0] === 'license' || c.args[0] === 'auth')), 'never touches the Unity licence or sign-in');
  assert.equal(r.calls.filter((c) => c.launched).length, 1, 'only the Editor launch is detached');
  assert.equal(r.calls.find((c) => c.file === NPM.file).opts.cwd, r.root);

  assert.deepEqual(
    r.progress.map((l) => l.split(' ')[0]),
    ['1/10', '2/10', '3/10', '4/10', '5/10', '6/10', '7/10', '8/10', '9/10', '10/10']
  );
  assert.equal(r.final.result.ok, true);
  assert.match(r.final.result.text, /^Added the Unity Pipeline package \(com\.unity\.pipeline\) to "ScaffoldCheck"/);
  assert.match(r.final.result.text, /Created the Unity project "ScaffoldCheck" with Unity 6000\.5\.10f1/);
  assert.match(r.final.result.text, /npm install: TypeScript installed/);
  assert.equal(r.workspace.current().name, 'ScaffoldCheck');
  assert.deepEqual(r.scaffoldCalls, [[true, r.root], [false, r.root]]);
});

test('D58: create with Allow scripts OFF still runs the helper\'s own scaffold scripts through every step', async (t) => {
  const r = await create(t, { allowScripts: false });
  assert.equal(r.refused, undefined);
  assert.ok(r.labels.includes('eval_file bt-bootstrap.cs'), 'the bootstrap is the helper\'s own script, not the model\'s');
  assert.ok(r.labels.includes('eval_file bt-newscene.cs'));
  assert.equal(r.labels.at(-1), 'eval verify');
  assert.equal(r.progress.length, 10);
  assert.equal(r.final.result.ok, true);
  assert.equal(r.workspace.current().name, 'ScaffoldCheck');
});

test('D58 control: a MODEL-supplied unity_run_script with Allow scripts OFF is refused and nothing runs', async (t) => {
  const { root } = await create(t, { allowScripts: true }); // a real current project to run it against
  const events = [];
  const calls = [];
  await executeUnity(
    { jobId: 'job_s', op: { kind: 'unity.script', source: 'class A { static void Run() {} }', entry: 'A.Run' }, allowScripts: false, consentGranted: false },
    {
      project: { root, name: 'ScaffoldCheck' },
      cli: CLI,
      emit: async (e) => void events.push(e),
      runProcess: async (...a) => void calls.push(a),
      log: { info() {}, op() {}, error() {} },
    }
  );
  assert.equal(events.find((e) => e.type === 'refused').reason, SCRIPTS_OFF);
  assert.equal(calls.length, 0);
});

test('create: git missing → refused before anything runs; nothing is created', async (t) => {
  const fake = fakeScaffold({ overrides: (_a, file) => (file === 'git' ? { code: null, stderr: 'spawn git ENOENT' } : undefined) });
  const r = await create(t, { fake });
  assert.equal(r.refused.reason, GIT_MISSING);
  assert.deepEqual(r.labels, ['git --version']);
  assert.equal(r.events.some((e) => e.type === 'started'), false);
  assert.equal(fs.existsSync(r.root), false);
  assert.equal(r.workspace.current(), undefined);
});

test('create: package_status "failed" on the toolkit package → the job fails naming step 5; nothing after it runs; not current', async (t) => {
  let adds = 0;
  const fake = fakeScaffold({
    overrides: (args) => {
      if (args[0] === 'command' && args[1] === 'package_add') adds += 1;
      if (args[0] === 'command' && args[1] === 'package_status' && adds === 2) {
        return { stdout: ok({ status: 'failed', error: 'Unable to add package [professionaledition.git]: git clone failed' }) };
      }
      return undefined;
    },
  });
  const r = await create(t, { fake });
  assert.equal(r.final.result.ok, false);
  assert.match(r.final.result.text, /Step 5\/10 \(com\.babylontoolkit\.editor\) failed: the Package Manager reported failed: .*git clone failed/);
  assert.match(r.final.result.text, /was left in the projects folder .* nothing was deleted/);
  assert.equal(r.labels.includes('eval exporter-compiled?'), false);
  assert.equal(r.labels.some((l) => l.startsWith('eval_file')), false);
  assert.equal(r.calls.some((c) => c.file === NPM.file), false);
  assert.equal(r.workspace.current(), undefined, 'a failed create never becomes current');
  assert.equal(fs.existsSync(r.root), true, 'the project is never deleted');
  assert.deepEqual(r.scaffoldCalls.at(-1), [false, r.root]);
});

test('create: the exporter never compiles → step 6 fails after its 15 min bound (fake clock)', async (t) => {
  const fake = fakeScaffold({
    overrides: (args) => (args[1] === 'eval' && args[2] === EXPORTER_COMPILED_CS ? { stdout: ok('no') } : undefined),
  });
  const r = await create(t, { fake });
  assert.match(r.final.result.text, /Step 6\/10 \(Babylon Toolkit exporter compile\) failed: The exporter compile timed out after 15m00s\./);
  assert.equal(r.workspace.current(), undefined);
});

test('create: no package.json after the bootstrap → npm install is skipped (never run) and the create still succeeds', async (t) => {
  const r = await create(t, { fake: fakeScaffold({ writePackageJson: false }) });
  assert.equal(r.calls.some((c) => c.file === NPM.file), false);
  assert.ok(r.progress.some((l) => l.startsWith('8/10 npm install')));
  assert.equal(r.final.result.ok, true);
  assert.match(r.final.result.text, /npm install skipped — the project has no package\.json/);
});

test('create: a Pipeline without package_add → Client.Add through eval, glTF first, each polled until resolved', async (t) => {
  const fake = fakeScaffold({
    overrides: (args) => {
      if (args[0] === 'command' && args[1] === 'package_add') return { stdout: bad("No command named 'package_add'."), code: 1 };
      if (args[0] === 'command' && args[1] === '--query') return { stdout: JSON.stringify({ success: true, data: { commands: [] }, errors: [] }) };
      if (args[1] === 'eval' && /FindForAssetPath\("Packages\/[^/]+\/package\.json"\) != null \? "READY"/.test(args[2])) return { stdout: ok('READY') };
      return undefined;
    },
  });
  const r = await create(t, { fake });
  const pkgPart = r.labels.slice(r.labels.indexOf('unity editor_status') + 1, r.labels.indexOf('eval exporter-compiled?'));
  assert.deepEqual(pkgPart, [
    `package_add ${GLTF_URL}`,
    'unity command --query package_add',
    `eval Client.Add ${GLTF_URL}`,
    'eval org.khronos.unitygltf resolved?',
    `eval Client.Add ${TOOLKIT_URL}`,
    'eval com.babylontoolkit.editor resolved?',
  ]);
  assert.equal(r.final.result.ok, true);
});

test('create: a projects new that fails → step 1 named, nothing created, not current', async (t) => {
  const fake = fakeScaffold({
    overrides: (args) => (args[0] === 'projects' ? { code: 1, stdout: bad('No Unity Editor is installed.') } : undefined),
  });
  const r = await create(t, { fake });
  assert.equal(r.final.result.text, 'Step 1/10 (unity projects new) failed: No Unity Editor is installed. Nothing was created.');
  assert.equal(r.workspace.current(), undefined);
});

test('open of an existing project still only ensures the Pipeline package and reports the missing Toolkit packages', async (t) => {
  const folder = scratch(t);
  const dir = path.join(folder, 'Existing');
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\n');
  const fake = fakeScaffold();
  const workspace = createWorkspace({ projectsDir: folder });
  const events = [];
  let clock = 0;
  const openIt = () =>
    executeUnityProject(
      { jobId: 'job2', op: { kind: 'unity.project', action: 'open', name: 'Existing' }, allowScripts: true, consentGranted: false },
      { workspace, cli: CLI, emit: async (e) => void events.push(e), runProcess: fake.runProcess, launch: fake.launch, log: { op() {} }, now: () => clock, sleep: async (ms) => void (clock += ms) }
    );
  await openIt();
  assert.deepEqual(fake.calls.map(label), ['unity pipeline install', 'unity status', 'unity open (detached=true)', 'unity status', 'unity editor_status']);
  const text = events.find((e) => e.type === 'final').result.text;
  assert.match(text, /missing: org\.khronos\.unitygltf, com\.babylontoolkit\.editor/);
  assert.equal(workspace.current().name, 'Existing');

  // control: with both toolkit packages in the manifest, nothing is reported missing
  const manifest = path.join(dir, 'Packages', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.dependencies['org.khronos.unitygltf'] = GLTF_URL;
  m.dependencies['com.babylontoolkit.editor'] = TOOLKIT_URL;
  fs.writeFileSync(manifest, JSON.stringify(m));
  events.length = 0;
  await openIt();
  assert.ok(!events.find((e) => e.type === 'final').result.text.includes('missing:'));
});

test('the embedded bt-bootstrap.cs / bt-newscene.cs are verbatim copies of the Agent Reference scripts (below the header)', () => {
  const pins = {
    'bt-bootstrap.cs': '7970a089b7600e344e8c2ac482d1480bcd8d9567853fc8248f0e792d8b66f824',
    'bt-newscene.cs': '00829f0a2eb162dcf63d56f54a69e16dd1d5decd3c7addcfef41e34af3d2ff97',
  };
  const marker = '// ---- verbatim from here ----\n';
  for (const [file, sha] of Object.entries(pins)) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bridge', 'unity', 'scaffold', file), 'utf8');
    assert.ok(text.startsWith(`// SOURCE: AgentReference references/scripts/${file}`), `${file} names its source`);
    const body = text.slice(text.indexOf(marker) + marker.length);
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), sha, `${file} matches the recorded copy`);
    // When the AgentReference clone sits beside this repo, the copy must still match it byte for byte.
    const source = path.join(__dirname, '..', '..', 'AgentReference', 'references', 'scripts', file);
    if (fs.existsSync(source)) assert.equal(body, fs.readFileSync(source, 'utf8'), `${file} is in sync with ${source}`);
  }
});
