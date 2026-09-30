'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeUnity, executeUnityProject, CANCELLED, NO_PROJECT } = require('../lib/bridge/unity/ops');
const { resolveProjectPath, SCRIPTS_OFF, SCRIPTS_DISABLED_LOCALLY } = require('../lib/bridge/unity/guard');
const { discoverUnity, probeDevServer, createWorkspace, UNKNOWN_COMMAND_MEMORY_MS } = require('../lib/bridge/unity/discover');
const { createAutomation, MAX_LOGGED_REASON } = require('../lib/bridge/unity/automation');
const { makeExecuteDispatch, makeHello, makeDevServerProbe } = require('../lib/bridge/cli');
const { BRIDGE_PROTOCOL_VERSION } = require('../lib/bridge/protocol');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bridge-unity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal Unity project in a scratch dir. */
function unityProject(t, extra = {}) {
  const root = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.join(root, 'Assets'));
  fs.mkdirSync(path.join(root, 'ProjectSettings'));
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\n');
  return { key: 'k1', name: path.basename(root), root, toolkitVersion: '9.28.0', productGuid: 'f'.repeat(32), ...extra };
}

const envelope = (result, success = true, errors = []) =>
  JSON.stringify({ success, command: 'command', data: { result }, errors, warnings: [] });

/**
 * A fake runProcess: `answer(args)` returns a partial RunResult (or throws); every call is recorded.
 * `launch` is the fake detached launcher (`unity open`): its calls land in the same list, marked
 * `launched: true`, so a test can tell which calls would have outlived the helper.
 * @param {(args: string[], opts: any) => any} [answer]
 */
function fakeRun(answer = () => ({ stdout: envelope({}) })) {
  const calls = [];
  const runProcess = async (file, args, opts = {}) => {
    calls.push({ file, args, opts, launched: false });
    const r = (await answer(args, opts)) || {};
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...r };
  };
  const launch = async (file, args, opts = {}) => {
    calls.push({ file, args, opts, launched: true });
    const r = (await answer(args, opts)) || {};
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...r };
  };
  return { calls, runProcess, launch };
}

function collector() {
  const events = [];
  return { events, emit: async (e) => void events.push(e) };
}

const quietLog = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(m), op: (tier, label) => lines.push(`op ${tier} ${label}`), error: (m) => lines.push(m) };
};

const CLI = { path: '/fake/unity', version: '1.0.0' };
const dispatchOf = (op, extra = {}) => ({ jobId: 'job1', op, allowScripts: false, consentGranted: false, ...extra });

async function run(t, op, { extra, answer, project, api, automation, noScripts, signal } = {}) {
  const P = project || unityProject(t);
  const { calls, runProcess, launch } = fakeRun(answer);
  const { events, emit } = collector();
  const log = quietLog();
  const auto = automation || createAutomation();
  await executeUnity(dispatchOf(op, extra), {
    project: P,
    cli: CLI,
    emit,
    signal,
    noScripts,
    runProcess,
    launch,
    api,
    ensureAutomation: auto.ensureAutomation,
    log,
  });
  return { P, calls, events, log };
}

const final = (events) => events.find((e) => e.type === 'final');
const refused = (events) => events.find((e) => e.type === 'refused');

test('set_transform → command args, --project-path P, never --yes', async (t) => {
  const { P, calls, events } = await run(t, { kind: 'unity.command', name: 'set_transform', params: { target: '/A', position: [0, 1, 0] } });
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 2), ['command', 'set_transform']);
  // The command's params ride after `--`, so none can become an option of the CLI itself (D41).
  const dd = args.indexOf('--');
  assert.deepEqual(args.slice(dd + 1), ['--target', '/A', '--position', '[0,1,0]']);
  assert.ok(args.indexOf('--project-path') < dd && args.indexOf('--timeout') < dd);
  const i = args.indexOf('--project-path');
  assert.equal(args[i + 1], P.root);
  assert.ok(args.includes('--non-interactive'));
  assert.ok(args.includes('--format'));
  assert.ok(!args.includes('--yes'));
  assert.equal(args[args.indexOf('--timeout') + 1], '110');
  assert.equal(final(events).result.ok, true);
  assert.deepEqual(events.map((e) => e.type), ['started', 'final']);
});

test('unity.cli logs → no --project-path (it reads the Hub log and rejects that option); recompile keeps it (control)', async (t) => {
  const logs = await run(t, { kind: 'unity.cli', args: ['logs', '--tail', '50'] });
  assert.deepEqual(logs.calls[0].args.slice(0, 3), ['logs', '--tail', '50']);
  assert.ok(!logs.calls[0].args.includes('--project-path'));
  const rc = await run(t, { kind: 'unity.cli', args: ['recompile'] });
  const i = rc.calls[0].args.indexOf('--project-path');
  assert.ok(i > 0);
  assert.equal(rc.calls[0].args[i + 1], rc.P.root);
});

test('unity.cli projects info|verify|clean|upgrade and test → the project as a trailing POSITIONAL, never --project-path (T24-1); cwd is the project root', async (t) => {
  for (const args of [['projects', 'info'], ['projects', 'verify'], ['projects', 'clean'], ['projects', 'upgrade'], ['test'], ['test', '--mode', 'EditMode']]) {
    const r = await run(t, { kind: 'unity.cli', args }, { extra: { consentGranted: true } });
    const a = r.calls[0].args;
    assert.ok(!a.includes('--project-path'), `${args.join(' ')} must not get --project-path`);
    assert.deepEqual(a.slice(0, args.length + 1), [...args, r.P.root], args.join(' '));
    assert.equal(r.calls[0].opts.cwd, r.P.root);
  }
  // control: a positional the model already gave is not doubled
  const own = await run(t, { kind: 'unity.cli', args: ['projects', 'info', 'Other'] });
  assert.deepEqual(own.calls[0].args.slice(0, 4), ['projects', 'info', 'Other', '--format']);
  // control: `list` takes the option
  const list = await run(t, { kind: 'unity.cli', args: ['list'] });
  assert.equal(list.calls[0].args[list.calls[0].args.indexOf('--project-path') + 1], list.P.root);
});

test('unity.list with ≤ 5 matches also fetches --detail full and prints each parameter (T24-2); > 5 stays compact (control)', async (t) => {
  const listEnv = (commands) => JSON.stringify({ success: true, data: { commands }, errors: [] });
  const compact = [{ name: 'set_transform', description: 'Set a transform' }];
  const full = [
    {
      name: 'set_transform',
      description: 'Set a transform',
      parameters: [
        { name: 'target', type: 'String', required: true, description: 'Hierarchy path' },
        { name: 'space', type: 'String', required: false, defaultValue: 'world', description: 'world or local' },
      ],
    },
  ];
  const narrow = await run(t, { kind: 'unity.list', query: 'transform' }, {
    answer: (args) => ({ stdout: listEnv(args[args.indexOf('--detail') + 1] === 'full' ? full : compact) }),
  });
  assert.deepEqual(narrow.calls.map((c) => c.args[c.args.indexOf('--detail') + 1]), ['compact', 'full']);
  const text = final(narrow.events).result.text;
  assert.ok(text.includes('--target <String> (required) — Hierarchy path'), text);
  assert.ok(text.includes('--space <String> (optional, default "world") — world or local'), text);
  const many = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, description: 'd' }));
  const wide = await run(t, { kind: 'unity.list', query: 'c' }, { answer: () => ({ stdout: listEnv(many) }) });
  assert.equal(wide.calls.length, 1);
  assert.ok(!final(wide.events).result.text.includes('--'));
});

test('bt_export_level with a dirty open scene → refused naming it, and no export call', async (t) => {
  const { calls, events } = await run(t, { kind: 'unity.command', name: 'bt_export_level', params: {} }, {
    answer: (args) =>
      args[1] === 'list_open_scenes' ? { stdout: envelope({ scenes: [{ path: 'Assets/A.unity', isDirty: true }] }) } : { stdout: envelope({}) },
  });
  const r = refused(events);
  assert.ok(r && r.reason.includes('Assets/A.unity'));
  assert.ok(r.reason.includes('save_all'));
  assert.ok(!calls.some((c) => c.args[1] === 'bt_export_level'));
  assert.ok(!events.some((e) => e.type === 'started'));
});

test('an unreadable open-scene list refuses the export with the reason', async (t) => {
  const { calls, events } = await run(t, { kind: 'unity.command', name: 'bt_export_level', params: {} }, {
    answer: (args) => (args[1] === 'list_open_scenes' ? { code: 1, stdout: '', stderr: 'No Unity Editor is running' } : { stdout: envelope({}) }),
  });
  assert.ok(refused(events).reason.includes('No Unity Editor is running'));
  assert.ok(!calls.some((c) => c.args[1] === 'bt_export_level'));
});

test('unity.editor close also runs the unsaved-work guard', async (t) => {
  const { calls, events } = await run(t, { kind: 'unity.editor', action: 'close' }, {
    answer: (args) => (args[1] === 'list_open_scenes' ? { stdout: envelope({ scenes: [{ name: 'Main', dirty: true }] }) } : { stdout: envelope({}) }),
  });
  assert.ok(refused(events).reason.includes('Main'));
  assert.ok(!calls.some((c) => c.args[0] === 'close'));
});

test('run_script: outer success true but data.result.success false → ok false; the .cs is written then removed', async (t) => {
  let sawFile = false;
  const { P, calls, events } = await run(
    t,
    { kind: 'unity.script', source: 'public static class S { public static void Run() {} }', entry: 'S.Run' },
    {
      extra: { allowScripts: true },
      answer: (args, opts) => {
        const rel = args[args.indexOf('--file') + 1];
        sawFile = fs.existsSync(path.join(opts.cwd, rel));
        return { stdout: envelope({ success: false, error: 'boom' }) };
      },
    }
  );
  assert.equal(sawFile, true);
  assert.equal(calls[0].args[1], 'run_script');
  assert.equal(calls[0].args[calls[0].args.indexOf('--entry') + 1], 'S.Run');
  assert.equal(final(events).result.ok, false);
  assert.equal(fs.existsSync(path.join(P.root, '.bridge', 'scripts', 'job1.cs')), false);
});

test('a capture → image.base64 set, and the scratch PNG is removed', async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { P, calls, events } = await run(t, { kind: 'unity.capture', view: 'game', width: 512, height: 256 }, {
    answer: (args) => {
      fs.writeFileSync(args[args.indexOf('--output') + 1], png);
      return { stdout: envelope({ path: 'x' }) };
    },
  });
  const f = final(events).result;
  assert.equal(f.ok, true);
  assert.equal(f.image.base64, png.toString('base64'));
  assert.equal(f.image.mimeType, 'image/png');
  assert.equal(calls[0].args[1], 'screenshot');
  assert.equal(calls[0].args[calls[0].args.indexOf('--width') + 1], '512');
  assert.equal(fs.existsSync(path.join(P.root, '.bridge', 'out', 'job1.png')), false);
});

test('a capture over the image cap retries once at half size, then fails "capture too large"', async (t) => {
  const big = Buffer.alloc(400_000); // base64 > 400_000 chars
  const { calls, events } = await run(t, { kind: 'unity.capture', view: 'scene', width: 1024, height: 1024 }, {
    answer: (args) => {
      fs.writeFileSync(args[args.indexOf('--output') + 1], big);
      return { stdout: envelope({}) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--width') + 1], '512');
  assert.equal(final(events).result.text, 'capture too large');
});

test('a consent-tier op without consentGranted → refused, nothing run', async (t) => {
  const { calls, events } = await run(t, { kind: 'unity.command', name: 'delete_gameobject', params: { target: '/A' } });
  assert.equal(refused(events).reason, 'consent was not granted');
  assert.equal(calls.length, 0);
});

test('a consent-tier op WITH consentGranted runs (control)', async (t) => {
  const { calls, events } = await run(t, { kind: 'unity.command', name: 'delete_gameobject', params: { target: '/A' } }, { extra: { consentGranted: true } });
  assert.equal(calls.length, 1);
  assert.equal(final(events).result.ok, true);
});

test('D58: Allow scripts off → refused naming the dialog switch; nothing runs', async (t) => {
  const op = { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' };
  const a = await run(t, op);
  assert.equal(
    refused(a.events).reason,
    'Scripts are off for this computer — the user can turn on Allow scripts in the Unity Bridge dialog (the cube icon in the App Builder).'
  );
  assert.equal(refused(a.events).reason, SCRIPTS_OFF);
  assert.equal(a.calls.length, 0);
});

test('D58: --no-scripts → its own sentence, and it wins over the switch whichever way the switch is', async (t) => {
  const op = { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' };
  for (const allowScripts of [true, false]) {
    const b = await run(t, op, { extra: { allowScripts }, noScripts: true });
    assert.equal(refused(b.events).reason, 'Scripts are disabled on this computer (--no-scripts) — the Allow scripts switch has no effect; the user must re-run the install command from the Unity Bridge dialog without --no-scripts.');
    assert.equal(refused(b.events).reason, SCRIPTS_DISABLED_LOCALLY);
    assert.equal(b.calls.length, 0);
  }
});

test('D58 control: Allow scripts on and no --no-scripts → the script runs', async (t) => {
  const op = { kind: 'unity.script', source: 'class A { static void Run() {} }', entry: 'A.Run' };
  const c = await run(t, op, { extra: { allowScripts: true }, noScripts: false });
  assert.equal(refused(c.events), undefined);
  assert.ok(c.calls.length >= 1);
  assert.equal(final(c.events).result.ok, true);
});

test('toolkit 9.12.0 + bt_status → refused with the upgrade sentence', async (t) => {
  const project = unityProject(t, { toolkitVersion: '9.12.0' });
  const { calls, events } = await run(t, { kind: 'unity.command', name: 'bt_status', params: {} }, { project });
  assert.ok(refused(events).reason.includes('older than 9.25.1'));
  assert.equal(calls.length, 0);
});

test('cancel → the final text contains "Cancel requested"', async (t) => {
  const controller = new AbortController();
  const { events } = await run(t, { kind: 'unity.command', name: 'bake_lighting', params: {} }, {
    signal: controller.signal,
    answer: async (args, opts) => {
      controller.abort();
      return { aborted: Boolean(opts.signal && opts.signal.aborted), code: null };
    },
  });
  assert.ok(final(events).result.text.includes('Cancel requested'));
  assert.equal(final(events).result.text, CANCELLED);
});

test('a long command gets the 1800 s timeouts', async (t) => {
  const { calls } = await run(t, { kind: 'unity.command', name: 'bake_lighting', params: {} });
  assert.equal(calls[0].args[calls[0].args.indexOf('--timeout') + 1], '1800');
  assert.equal(calls[0].opts.timeoutMs, 1_800_000);
});

test('screenshot with no output → P/.bridge/out/<jobId>.png; a path param resolves under P', async (t) => {
  const a = await run(t, { kind: 'unity.command', name: 'screenshot', params: {} });
  assert.equal(a.calls[0].args[a.calls[0].args.indexOf('--output') + 1], path.join(a.P.root, '.bridge', 'out', 'job1.png'));
  const b = await run(t, { kind: 'unity.command', name: 'save_scene_as', params: { save_path: 'Assets/B.unity' } });
  assert.equal(b.calls[0].args[b.calls[0].args.indexOf('--save_path') + 1], path.join(b.P.root, 'Assets', 'B.unity'));
});

test('an unsafe path param is refused before anything runs', async (t) => {
  const { calls, events } = await run(t, { kind: 'unity.command', name: 'screenshot', params: { output: '../x.png' } });
  assert.ok(refused(events));
  assert.equal(calls.length, 0);
});

test('stderr lines become progress events, at most one per 500 ms', async (t) => {
  const { events } = await run(t, { kind: 'unity.command', name: 'set_transform', params: {} }, {
    answer: (args, opts) => {
      opts.onLine('first');
      opts.onLine('second');
      return { stdout: envelope({}) };
    },
  });
  const progress = events.filter((e) => e.type === 'progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].line, 'first');
});

test('resolveProjectPath: ../x → null, Assets/x → under P, drive-relative C:x → null', () => {
  const P = path.resolve(os.tmpdir(), 'proj');
  assert.equal(resolveProjectPath(P, '../x'), null);
  assert.equal(resolveProjectPath(P, 'Assets/x'), path.join(P, 'Assets', 'x'));
  assert.equal(resolveProjectPath(P, 'C:x'), null);
  assert.equal(resolveProjectPath(P, '/etc/passwd'), null);
  assert.equal(resolveProjectPath(P, 'Assets/../../x'), null);
});

test('discovery: ProjectVersion.txt + packages-lock.json + ProjectSettings.asset → versions and productGuid', (t) => {
  const root = path.join(fs.realpathSync(scratch(t)), 'Game');
  fs.mkdirSync(path.join(root, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectSettings'));
  fs.mkdirSync(path.join(root, 'Packages'));
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\nm_EditorVersionWithRevision: 6000.5.10f1 (x)\n');
  fs.writeFileSync(
    path.join(root, 'ProjectSettings', 'ProjectSettings.asset'),
    '%YAML 1.1\nPlayerSettings:\n  m_ObjectHideFlags: 0\n  productGUID: F435F3E6AE3B441248AE556FC2EF566E\n  AndroidProfiler: 0\n'
  );
  fs.writeFileSync(
    path.join(root, 'Packages', 'packages-lock.json'),
    JSON.stringify({ dependencies: { 'com.babylontoolkit.editor': { version: '9.28.0' }, 'com.unity.pipeline': { version: '0.8.0-exp.1' } } })
  );
  const exec = (file, args) => (args[0] === '--version' ? '1.0.0-beta.11\n' : file === 'which' ? '/usr/local/bin/unity\n' : undefined);
  const found = discoverUnity({ cwd: root, env: { HOME: root }, platform: 'darwin', exec });
  assert.equal(found.projects.length, 1);
  const p = found.projects[0];
  assert.equal(p.unityVersion, '6000.5.10f1');
  assert.equal(p.productGuid, 'f435f3e6ae3b441248ae556fc2ef566e');
  assert.equal(p.toolkitVersion, '9.28.0');
  assert.equal(p.pipelineVersion, '0.8.0-exp.1');
  assert.equal(p.name, path.basename(root));
  assert.match(p.key, /^[0-9a-f]{12}$/);
  assert.deepEqual(found.cli, { path: '/usr/local/bin/unity', version: '1.0.0-beta.11' });
});

test('discovery: an embedded toolkit (file: lock entry) is read from its own package.json; a non-project --unity path is reported', (t) => {
  const root = path.join(fs.realpathSync(scratch(t)), 'Game');
  fs.mkdirSync(path.join(root, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectSettings'));
  fs.mkdirSync(path.join(root, 'Packages', 'com.babylontoolkit.editor'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
  fs.writeFileSync(path.join(root, 'Packages', 'com.babylontoolkit.editor', 'package.json'), JSON.stringify({ version: '9.26.0' }));
  fs.writeFileSync(
    path.join(root, 'Packages', 'packages-lock.json'),
    JSON.stringify({ dependencies: { 'com.babylontoolkit.editor': { version: 'file:com.babylontoolkit.editor' } } })
  );
  const other = scratch(t);
  const found = discoverUnity({ unityPaths: [root, other], cwd: root, env: { HOME: root }, platform: 'darwin', exec: () => undefined });
  assert.equal(found.projects[0].toolkitVersion, '9.26.0');
  assert.equal(found.projects[0].productGuid, undefined);
  assert.deepEqual(found.notProjects, [other]);
  assert.equal(found.cli, undefined);
});

test('devServer probe: key : value lines → origin + scenes; any error → running:false', async (t) => {
  const root = fs.realpathSync(scratch(t));
  const exportDir = path.join(root, 'export');
  fs.mkdirSync(path.join(exportDir, 'scenes'), { recursive: true });
  for (const n of ['Level01.gltf', 'Level02.glb', 'Level01.bin']) fs.writeFileSync(path.join(exportDir, 'scenes', n), '');
  const text = `started   : True\nsupported : True\nroot      : ${exportDir}\nport      : 8888\nproject   : Babylon Toolkit\nlisten    : all`;
  const project = { root, toolkitVersion: '9.28.0' };
  const ok = await probeDevServer({ cli: CLI, project, runProcess: async () => ({ code: 0, stdout: JSON.stringify(text), stderr: '', timedOut: false }) });
  assert.deepEqual(ok, { running: true, origin: 'http://localhost:8888', project: 'Babylon Toolkit', listen: 'all', scenes: ['Level01.gltf', 'Level02.glb'] });
  const stopped = await probeDevServer({ cli: CLI, project, runProcess: async () => ({ code: 0, stdout: 'started : False\nport : 0', stderr: '', timedOut: false }) });
  assert.deepEqual(stopped, { running: false });
  const broken = await probeDevServer({ cli: CLI, project, runProcess: async () => { throw new Error('x'); } });
  assert.deepEqual(broken, { running: false });
});

// ── automation grants (D51) ───────────────────────────────────────────────────────────────────

function fakeApi(answer) {
  const posts = [];
  return {
    posts,
    post: async (p, body) => {
      posts.push({ path: p, body });
      return answer(p, body);
    },
  };
}

const exportAnswer = (args) =>
  args[1] === 'list_open_scenes' ? { stdout: envelope({ scenes: [{ path: 'Assets/A.unity', isDirty: false }] }) } : { stdout: envelope({ ok: true }) };

test('automation: the grant is handed to Unity BEFORE the export, and never appears in events or results', async (t) => {
  const GRANT = 'g-secret-grant-token';
  const api = fakeApi(() => ({ status: 200, body: { grant: GRANT, expiresAt: Date.now() + 12 * 3600_000 } }));
  const automation = createAutomation();
  const { calls, events, log } = await run(t, { kind: 'unity.command', name: 'bt_export_level', params: {} }, { api, automation, answer: exportAnswer });
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0].path, '/api/bridge/grant');
  assert.equal(api.posts[0].body.productGuid, 'f'.repeat(32));
  const iGrant = calls.findIndex((c) => c.args[1] === 'bt_automation');
  const iExport = calls.findIndex((c) => c.args[1] === 'bt_export_level');
  assert.ok(iGrant >= 0 && iExport > iGrant);
  assert.deepEqual(calls[iGrant].args.slice(0, 4), ['command', 'bt_automation', '--grant', GRANT]);
  assert.equal(calls[iGrant].opts.onLine, undefined);
  assert.ok(!JSON.stringify(events).includes(GRANT));
  assert.ok(!log.lines.join('\n').includes(GRANT));
  assert.equal(final(events).result.ok, true);
});

test('automation: a second bt_* job within the grant life → no second POST (but bt_automation runs again)', async (t) => {
  const api = fakeApi(() => ({ status: 200, body: { grant: 'g', expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() } }));
  const automation = createAutomation();
  const project = unityProject(t);
  const a = await run(t, { kind: 'unity.command', name: 'bt_export_level', params: {} }, { api, automation, project, answer: exportAnswer });
  const b = await run(t, { kind: 'unity.command', name: 'bt_status', params: {} }, { api, automation, project, answer: exportAnswer });
  assert.equal(api.posts.length, 1);
  assert.ok(a.calls.some((c) => c.args[1] === 'bt_automation'));
  assert.ok(b.calls.some((c) => c.args[1] === 'bt_automation'));
});

test('automation: a grant with under 2 h left is refreshed', async (t) => {
  const api = fakeApi(() => ({ status: 200, body: { grant: 'g', expiresAt: Date.now() + 3600_000 } }));
  const automation = createAutomation();
  const project = unityProject(t);
  await run(t, { kind: 'unity.command', name: 'bt_status', params: {} }, { api, automation, project });
  await run(t, { kind: 'unity.command', name: 'bt_status', params: {} }, { api, automation, project });
  assert.equal(api.posts.length, 2);
});

test('automation: the api answers 403 → the export still runs, and the log says exports use your own licence (once)', async (t) => {
  const api = fakeApi(() => ({ status: 403, body: { error: true, message: 'No active subscription or credits.' } }));
  const automation = createAutomation();
  const project = unityProject(t);
  const a = await run(t, { kind: 'unity.command', name: 'bt_export_level', params: {} }, { api, automation, project, answer: exportAnswer });
  assert.ok(a.calls.some((c) => c.args[1] === 'bt_export_level'));
  assert.ok(!a.calls.some((c) => c.args[1] === 'bt_automation'));
  assert.equal(final(a.events).result.ok, true);
  assert.ok(a.log.lines.some((l) => l.includes('exports use your own Babylon Toolkit licence')));
  const b = await run(t, { kind: 'unity.command', name: 'bt_export_level', params: {} }, { api, automation, project, answer: exportAnswer });
  assert.ok(!b.log.lines.some((l) => l.includes('exports use your own Babylon Toolkit licence')));
});

test('automation: the log line is capped at ~200 chars, and a DIFFERENT later failure is still logged (once each)', async () => {
  const automation = createAutomation();
  const lines = [];
  const log = { info: (m) => lines.push(m) };
  const project = { productGuid: 'g'.repeat(32), root: '/p/A' };
  const api = fakeApi(() => ({ status: 200, body: { grant: 'gg', expiresAt: Date.now() + 12 * 3600_000 } }));
  const huge = `No command named 'bt_automation'. Available: ${Array.from({ length: 300 }, (_, i) => `cmd_${i}`).join(', ')}`;
  let message = huge;
  const runUnity = async () => ({ code: 1, stdout: JSON.stringify({ success: false, errors: [{ message }] }), stderr: '' });
  await automation.ensureAutomation(project, { api, runUnity, log });
  assert.equal(lines.length, 1);
  const reason = lines[0].slice('Unity automation unavailable: '.length, lines[0].indexOf(' — exports use'));
  assert.ok(reason.length <= MAX_LOGGED_REASON, `reason is ${reason.length} chars`);
  assert.ok(reason.endsWith('…'));
  await automation.ensureAutomation(project, { api, runUnity, log });
  assert.equal(lines.length, 1, 'the same failure is logged once');
  message = 'Automation grant refused: expired';
  await automation.ensureAutomation(project, { api, runUnity, log });
  assert.equal(lines.length, 2, 'a different failure is not hidden by the first');
  assert.ok(lines[1].includes('Automation grant refused: expired'));
});

test('automation: a network error or a refused bt_automation never fails the job', async (t) => {
  const down = fakeApi(() => {
    throw new Error('ECONNREFUSED');
  });
  const a = await run(t, { kind: 'unity.command', name: 'bt_status', params: {} }, { api: down, automation: createAutomation() });
  assert.equal(final(a.events).result.ok, true);
  const api = fakeApi(() => ({ status: 200, body: { grant: 'gg', expiresAt: Date.now() + 12 * 3600_000 } }));
  const b = await run(t, { kind: 'unity.command', name: 'bt_status', params: {} }, {
    api,
    automation: createAutomation(),
    answer: (args) =>
      args[1] === 'bt_automation'
        ? { code: 1, stdout: JSON.stringify({ success: false, errors: [{ message: 'Automation grant refused: expired' }] }) }
        : { stdout: envelope({}) },
  });
  assert.equal(final(b.events).result.ok, true);
  assert.ok(b.log.lines.some((l) => l.includes('Automation grant refused: expired')));
});

test('automation: a non-bt_ command (set_transform) → no grant request and no bt_automation call', async (t) => {
  const api = fakeApi(() => ({ status: 200, body: { grant: 'g', expiresAt: Date.now() + 12 * 3600_000 } }));
  const { calls } = await run(t, { kind: 'unity.command', name: 'set_transform', params: {} }, { api, automation: createAutomation() });
  assert.equal(api.posts.length, 0);
  assert.ok(!calls.some((c) => c.args[1] === 'bt_automation'));
});

// ── routing (cli.js) ─────────────────────────────────────────────────────────────────────────

/** A workspace whose current project is `P` (created by `unityProject`). */
const workspaceWith = (P) => createWorkspace({ projectsDir: path.dirname(P.root), currentRoot: P.root });

test('with no current project every Unity, dev-server and Blender job is refused — nothing runs', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  const { events, emit } = collector();
  const { calls, runProcess } = fakeRun();
  const exec = makeExecuteDispatch({ workspace: createWorkspace({ projectsDir: folder }), cli: CLI, noScripts: false, runProcess });
  for (const op of [
    { kind: 'unity.list' },
    { kind: 'unity.command', name: 'set_transform', params: {} },
    { kind: 'devserver.status' },
    { kind: 'blender.script', source: 'x', inputs: [], outputs: [], timeoutSeconds: 60 },
  ]) {
    await exec(dispatchOf(op), emit, new AbortController().signal);
  }
  assert.equal(calls.length, 0);
  assert.equal(events.length, 4);
  for (const e of events) assert.deepEqual(e, { jobId: 'job1', type: 'refused', reason: NO_PROJECT });
  assert.equal(NO_PROJECT, 'No Unity project is open. Use unity_project to open or create one.');
});

test('unity.* and devserver.* dispatches reach the Unity runner for the CURRENT project — no unityProjectKey needed', async (t) => {
  const { events, emit } = collector();
  const { calls, runProcess } = fakeRun();
  const P = unityProject(t);
  const exec = makeExecuteDispatch({ workspace: workspaceWith(P), cli: CLI, noScripts: false, runProcess });
  const dispatch = dispatchOf({ kind: 'devserver.start', port: 8888 });
  assert.equal('unityProjectKey' in dispatch, false);
  await exec(dispatch, emit, new AbortController().signal);
  assert.deepEqual(calls[0].args.slice(0, 2), ['command', 'bt_devserver_start']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--project-path') + 1], P.root);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--') + 1), ['--port', '8888']);
  assert.equal(final(events).result.ok, true);
});

test('64-bit Unity instance ids survive exactly; a string result is shown as is', async (t) => {
  const a = await run(t, { kind: 'unity.command', name: 'get_scene_hierarchy', params: {} }, {
    answer: () => ({ stdout: '{"success":true,"data":{"result":{"roots":[{"instanceId":568105584918862612,"n":1.5}]}},"errors":[]}' }),
  });
  assert.ok(final(a.events).result.text.includes('568105584918862612'));
  assert.ok(final(a.events).result.text.includes('1.5'));
  const b = await run(t, { kind: 'devserver.status' }, { answer: () => ({ stdout: envelope('started : True\nport : 8888') }) });
  assert.equal(final(b.events).result.text, 'started : True\nport : 8888');
});

test('a real command param named timeout or format reaches the COMMAND, never the CLI', async (t) => {
  const { calls } = await run(t, { kind: 'unity.command', name: 'get_serialized_fields', params: { format: 'yaml', timeout: 5 } });
  const args = calls[0].args;
  const dd = args.indexOf('--');
  assert.deepEqual(args.slice(dd + 1), ['--format', 'yaml', '--timeout', '5']);
  assert.equal(args[args.indexOf('--format') + 1], 'json');
  assert.equal(args[args.indexOf('--timeout') + 1], '110');
});

test('a ../../Assets jobId never reaches runProcess and deletes nothing', async (t) => {
  const P = unityProject(t);
  fs.writeFileSync(path.join(P.root, 'Assets', 'Keep.txt'), 'x');
  const { calls, runProcess } = fakeRun();
  const { events, emit } = collector();
  const evil = { jobId: '../../Assets', allowScripts: true, consentGranted: true };
  for (const op of [
    { kind: 'unity.capture', view: 'game', width: 64, height: 64 },
    { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' },
    { kind: 'unity.command', name: 'screenshot', params: {} },
  ]) {
    await executeUnity({ ...evil, op }, { project: P, cli: CLI, emit, runProcess, log: quietLog() });
    const exec = makeExecuteDispatch({ workspace: workspaceWith(P), cli: CLI, noScripts: false, runProcess });
    await exec({ ...evil, op }, emit, new AbortController().signal);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
  assert.ok(fs.existsSync(path.join(P.root, 'Assets', 'Keep.txt')));
  assert.equal(fs.existsSync(path.join(P.root, '.bridge')), false);
});

test('params {yes:true} or {"project-path": …} → refused before anything runs', async (t) => {
  for (const params of [{ yes: true }, { 'project-path': '/elsewhere' }]) {
    const { calls, events } = await run(t, { kind: 'unity.command', name: 'set_transform', params });
    assert.ok(refused(events).reason.includes('reserved'));
    assert.equal(calls.length, 0);
  }
});

// ── projects folder + unity.project (D54) ─────────────────────────────────────────────────────

/** A minimal Unity project at `dir`. */
function makeProject(dir, { pipeline = false } = {}) {
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\n');
  if (pipeline) {
    fs.mkdirSync(path.join(dir, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.8.0-exp.1' } }));
  }
  return dir;
}

const noExec = () => undefined;

test('discovery: cwd is a Unity project → its parent is the projects folder and it is current', (t) => {
  const folder = fs.realpathSync(scratch(t));
  const a = makeProject(path.join(folder, 'Alpha'));
  makeProject(path.join(folder, 'Beta'));
  makeProject(path.join(folder, '.hidden'));
  fs.mkdirSync(path.join(folder, 'NotAProject'));
  const found = discoverUnity({ cwd: a, env: { HOME: folder }, platform: 'darwin', exec: noExec });
  assert.equal(found.projectsDir, folder);
  assert.equal(found.currentRoot, a);
  assert.deepEqual(found.projects.map((p) => p.name), ['Alpha', 'Beta']);
});

test('discovery: cwd is a folder of projects → they are listed, and nothing is current', (t) => {
  const folder = fs.realpathSync(scratch(t));
  makeProject(path.join(folder, 'Zed'));
  makeProject(path.join(folder, 'Alpha'));
  makeProject(path.join(folder, 'Alpha', 'Nested')); // one level only
  const found = discoverUnity({ cwd: folder, env: { HOME: folder }, platform: 'darwin', exec: noExec });
  assert.equal(found.projectsDir, folder);
  assert.equal(found.currentRoot, undefined);
  assert.deepEqual(found.projects.map((p) => p.name), ['Alpha', 'Zed']);
  assert.equal(createWorkspace({ projectsDir: found.projectsDir, projects: found.projects }).current(), undefined);
});

test('discovery: --projects overrides the folder (cwd project is then not current); the first --unity path is current', (t) => {
  const home = fs.realpathSync(scratch(t));
  const here = makeProject(path.join(home, 'Here', 'HereGame'));
  const other = path.join(home, 'Other');
  makeProject(path.join(other, 'OtherGame'));
  const viaFlag = discoverUnity({ projectsDir: other, cwd: here, env: { HOME: home }, platform: 'darwin', exec: noExec });
  assert.equal(viaFlag.projectsDir, other);
  assert.equal(viaFlag.currentRoot, undefined);
  assert.deepEqual(viaFlag.projects.map((p) => p.name), ['OtherGame']);

  const extra = makeProject(path.join(home, 'Elsewhere', 'Extra'));
  const withUnity = discoverUnity({ projectsDir: other, unityPaths: [extra], cwd: here, env: { HOME: home }, platform: 'darwin', exec: noExec });
  assert.equal(withUnity.currentRoot, extra);
  assert.deepEqual(withUnity.projects.map((p) => p.name), ['OtherGame', 'Extra']);
});

/** A fake Unity CLI for unity.project: `projects new` makes the folder; `status` reports `ready` for `readyRoots`. */
function projectCli({ readyAfterOpen = true, readyRoots = [] } = {}) {
  const ready = new Set(readyRoots);
  return fakeRun((args) => {
    if (args[0] === 'projects' && args[1] === 'new') {
      const dir = path.join(args[args.indexOf('--path') + 1], args[2]);
      makeProject(dir);
      return { stdout: JSON.stringify({ success: true, data: { path: dir, version: '6000.5.10f1', opened: false }, errors: [] }) };
    }
    if (args[0] === 'pipeline') return { stdout: JSON.stringify({ success: true, data: { alreadyInstalled: false }, errors: [] }) };
    if (args[0] === 'open') {
      if (readyAfterOpen) ready.add(args[1]);
      return { stdout: '' };
    }
    if (args[0] === 'status') {
      const instances = [...ready].map((p) => ({ project: p, state: 'ready' }));
      return { stdout: JSON.stringify({ success: instances.length > 0, data: { instances }, errors: [] }) };
    }
    return { stdout: envelope({}) };
  });
}

async function runProject(t, op, { workspace, cli = projectCli(), openWaitMs = 1_000 } = {}) {
  const { events, emit } = collector();
  let clock = 0;
  await executeUnityProject(dispatchOf({ kind: 'unity.project', ...op }), {
    workspace,
    cli: CLI,
    emit,
    runProcess: cli.runProcess,
    launch: cli.launch,
    log: quietLog(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    openWaitMs,
  });
  return { calls: cli.calls, events };
}

// The create scaffold (D56) is pinned in tests/bridge-unity-scaffold.test.js.

test('unity.project create refuses an existing folder and a traversal name — nothing runs', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.join(folder, 'Taken'));
  const workspace = createWorkspace({ projectsDir: folder });
  const taken = await runProject(t, { action: 'create', name: 'Taken' }, { workspace });
  assert.match(refused(taken.events).reason, /already exists/);
  assert.equal(taken.calls.length, 0);
  const evil = await runProject(t, { action: 'create', name: '../x' }, { workspace });
  assert.equal(refused(evil.events).reason, 'The Unity project name "../x" is not valid — use letters, numbers, spaces, dots, dashes or underscores.');
  assert.equal(evil.calls.length, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(folder), 'x')), false);
  assert.equal(workspace.current(), undefined);
});

test('unity.project open: only a project inside the projects folder — a sibling outside it is refused', async (t) => {
  const home = fs.realpathSync(scratch(t));
  const folder = path.join(home, 'Projects');
  makeProject(path.join(home, 'Outside'));
  makeProject(path.join(folder, 'Inside'), { pipeline: true });
  fs.mkdirSync(path.join(folder, 'PlainFolder'));
  const workspace = createWorkspace({ projectsDir: folder });
  for (const name of ['Outside', 'PlainFolder']) {
    const r = await runProject(t, { action: 'open', name }, { workspace });
    assert.match(refused(r.events).reason, /There is no Unity project named/);
    assert.equal(r.calls.length, 0);
  }
  const traversal = await runProject(t, { action: 'open', name: '../Outside' }, { workspace });
  assert.ok(refused(traversal.events));
  assert.equal(traversal.calls.length, 0);

  const ok = await runProject(t, { action: 'open', name: 'Inside' }, { workspace });
  assert.equal(ok.calls.some((c) => c.args[0] === 'pipeline'), false); // already has the Pipeline package
  assert.equal(final(ok.events).result.ok, true);
  assert.ok(!final(ok.events).result.text.includes('Pipeline'), 'control: nothing to disclose when the package was already there');
  assert.equal(workspace.current().name, 'Inside');
});

test('unity.project open: an Editor that never reports ready → ok:false after the wait, but the project is current', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  makeProject(path.join(folder, 'Slow'), { pipeline: true });
  const workspace = createWorkspace({ projectsDir: folder });
  const r = await runProject(t, { action: 'open', name: 'Slow' }, { workspace, cli: projectCli({ readyAfterOpen: false }) });
  assert.equal(final(r.events).result.ok, false);
  assert.match(final(r.events).result.text, /did not report the project "Slow" as ready/);
  assert.equal(workspace.current().name, 'Slow');
});

test('unity.project open: "ready" waits until editor_status answers — a 503 Server Busy (or compiling) is NOT ready (T24 item 12)', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  makeProject(path.join(folder, 'Busy'), { pipeline: true });
  const workspace = createWorkspace({ projectsDir: folder });
  const answers = [
    { code: 1, stdout: JSON.stringify({ success: false, error: 'Server Busy', status: 'busy', retryable: true, errors: [{ message: 'Server Busy (503)' }] }) },
    { stdout: envelope({ status: 'compiling', compiling: true }) },
    { stdout: envelope({ status: 'ready', compiling: false, domainReloadInProgress: false }) },
  ];
  let asked = 0;
  const base = projectCli();
  const cli = fakeRun((args, opts) => {
    if (args[0] === 'command' && args[1] === 'editor_status') return answers[Math.min(asked++, answers.length - 1)];
    if (args[0] === 'open' || args[0] === 'status' || args[0] === 'pipeline') return base.runProcess('/fake/unity', args, opts).then((r) => r);
    return { stdout: envelope({}) };
  });
  const r = await runProject(t, { action: 'open', name: 'Busy' }, { workspace, cli, openWaitMs: 60_000 });
  assert.equal(final(r.events).result.ok, true);
  assert.equal(asked, 3, 'polled past the busy and compiling answers');
  // control: an Editor that stays busy for the whole budget is reported as not ready
  asked = 0;
  answers.splice(1);
  const busy = await runProject(t, { action: 'open', name: 'Busy' }, { workspace, cli, openWaitMs: 20_000 });
  assert.equal(final(busy.events).result.ok, false);
  assert.match(final(busy.events).result.text, /did not report the project "Busy" as ready/);
});

test('unity.project list: names with versions and the current one marked; no CLI call', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  makeProject(path.join(folder, 'A'));
  const b = makeProject(path.join(folder, 'B'));
  const workspace = createWorkspace({ projectsDir: folder, currentRoot: b });
  const r = await runProject(t, { action: 'list' }, { workspace });
  assert.equal(r.calls.length, 0);
  const text = final(r.events).result.text;
  assert.match(text, /- A — Unity 6000\.5\.10f1, no Babylon Toolkit package\n- B — Unity 6000\.5\.10f1, no Babylon Toolkit package \(current\)/);
  assert.ok(!text.includes(folder));
});

test('hello (protocol 2): projectsDir is the folder NAME only — no absolute path leaves this computer', async (t) => {
  const home = fs.realpathSync(scratch(t));
  const folder = path.join(home, 'My Unity Projects');
  const cur = makeProject(path.join(folder, 'Game'));
  makeProject(path.join(folder, 'Other'));
  const workspace = createWorkspace({ projectsDir: folder, currentRoot: cur });
  const hello = await makeHello({
    workspace,
    cli: CLI,
    noScripts: false,
    devServer: async () => ({ running: true, origin: 'http://localhost:8888' }),
    helperVersion: '9.9.9',
    os: 'darwin',
  })();
  assert.equal(BRIDGE_PROTOCOL_VERSION, 2);
  assert.equal(hello.protocol, 2);
  assert.equal(hello.projectsDir, 'My Unity Projects');
  assert.equal(hello.currentProject, 'Game');
  assert.deepEqual(hello.unityProjects.map((p) => p.name), ['Game', 'Other']);
  assert.ok(hello.unityProjects.every((p) => !('root' in p)));
  assert.deepEqual(hello.devServer, { running: true, origin: 'http://localhost:8888' });
  const wire = JSON.stringify(hello);
  assert.ok(!wire.includes(home), 'no absolute path in the hello');
  assert.ok(!wire.includes(os.tmpdir()), 'no absolute path in the hello');

  const none = await makeHello({ workspace: createWorkspace({ projectsDir: folder }), noScripts: true, devServer: async () => undefined })();
  assert.equal('currentProject' in none, false);
  assert.equal(none.scriptsDisabledLocally, true);
});

test('the dev-server probe follows the CURRENT project: cached 30 s, re-probed at once when it changes, none without one', async () => {
  let current;
  const probed = [];
  const probe = makeDevServerProbe({
    cli: CLI,
    current: () => current,
    now: () => 0,
    runProcess: async (_f, args) => {
      probed.push(args[args.indexOf('--project-path') + 1]);
      return { code: 0, stdout: JSON.stringify('started : False'), stderr: '', timedOut: false };
    },
  });
  assert.equal(await probe(), undefined);
  current = { root: '/p/A', toolkitVersion: '9.28.0' };
  await probe();
  await probe();
  current = { root: '/p/B', toolkitVersion: '9.28.0' };
  await probe();
  assert.deepEqual(probed, ['/p/A', '/p/B']);
});

test('unity.project open by name is case-insensitive on macOS/Windows only, and the current project is the discovered entry', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  const real = makeProject(path.join(folder, 'Real'), { pipeline: true });
  const mac = createWorkspace({ projectsDir: folder, platform: 'darwin' });
  assert.equal(mac.rootFor('Real'), real);
  assert.equal(mac.rootFor('real'), real);
  const r = await runProject(t, { action: 'open', name: 'real' }, { workspace: mac, cli: projectCli({ readyRoots: [real] }) });
  assert.equal(final(r.events).result.ok, true);
  assert.match(final(r.events).result.text, /the project "Real"/);
  assert.equal(mac.current().name, 'Real');
  assert.equal(mac.current().root, real);
  assert.equal(createWorkspace({ projectsDir: folder, platform: 'win32' }).rootFor('REAL'), real);
  const linux = createWorkspace({ projectsDir: folder, platform: 'linux' });
  assert.equal(linux.rootFor('real'), undefined);
  assert.equal(linux.rootFor('Real'), real);
});

// ── the Editor outlives the helper (e2e fix 1) ──────────────────────────────────────────────────────

const { EventEmitter } = require('events');
const { runProcess: realRunProcess, launchDetached } = require('../lib/bridge/unity/run');

/** A fake child_process.spawn: records every call; the child exits with `code` on the next tick. */
function fakeSpawn(code = 0) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.unrefCalled = false;
    child.unref = () => void (child.unrefCalled = true);
    child.kill = () => true;
    calls.push({ file, args, opts, child });
    setImmediate(() => {
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    });
    return child;
  };
  return { calls, spawn };
}

test('launchDetached spawns detached, with no pipes and no shell, and unrefs the launcher', async () => {
  const { calls, spawn } = fakeSpawn(0);
  const res = await launchDetached('/fake/unity', ['open', '/p', '--non-interactive'], { cwd: '/p', spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].child.unrefCalled, true);
  assert.equal(res.code, 0);
  const failed = await launchDetached('/fake/unity', ['open', '/p'], { spawn: fakeSpawn(3).spawn });
  assert.equal(failed.code, 3, 'a launcher that fails reports its exit code');
});

test('runProcess (every ordinary job) is NOT detached — it stays killable with the helper (control)', async () => {
  const { calls, spawn } = fakeSpawn(0);
  const res = await realRunProcess('/fake/unity', ['status'], { spawn, timeoutMs: 1_000 });
  assert.equal(res.code, 0);
  assert.notEqual(calls[0].opts.detached, true);
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('unity.project open launches the Editor detached; every other Unity call is an ordinary process', async (t) => {
  const folder = fs.realpathSync(scratch(t));
  makeProject(path.join(folder, 'Game'));
  const workspace = createWorkspace({ projectsDir: folder });
  const r = await runProject(t, { action: 'open', name: 'Game' }, { workspace });
  assert.equal(final(r.events).result.ok, true);
  const opens = r.calls.filter((c) => c.args[0] === 'open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].launched, true);
  const others = r.calls.filter((c) => c.args[0] !== 'open');
  assert.ok(others.some((c) => c.args[0] === 'pipeline') && others.some((c) => c.args[0] === 'status'));
  assert.ok(others.every((c) => c.launched === false), 'pipeline install / status are never detached');
});

test('unity.editor open launches detached too; a launcher that exits non-zero → ok:false, no poll', async (t) => {
  const P = unityProject(t);
  const ready = await run(t, { kind: 'unity.editor', action: 'open' }, {
    project: P,
    answer: (args) =>
      args[0] === 'status'
        ? { stdout: JSON.stringify({ success: true, data: { instances: [{ project: P.root, state: 'ready' }] }, errors: [] }) }
        : args[1] === 'editor_status'
          ? { stdout: envelope({ status: 'ready' }) }
          : { stdout: '' },
  });
  assert.equal(final(ready.events).result.ok, true);
  assert.equal(ready.calls.find((c) => c.args[0] === 'open').launched, true);
  assert.ok(ready.calls.filter((c) => c.args[0] !== 'open').every((c) => !c.launched));

  const broken = await run(t, { kind: 'unity.editor', action: 'open' }, { answer: (args) => (args[0] === 'open' ? { code: 1 } : {}) });
  assert.equal(final(broken.events).result.ok, false);
  assert.match(final(broken.events).result.text, /unity open exited with code 1/);
  assert.equal(broken.calls.some((c) => c.args[0] === 'status'), false);
});

// ── empty scratch folders are removed (e2e fix 3) ──────────────────────────────────────────────────

test('after a capture or a script, empty .bridge/out, .bridge/scripts and .bridge are removed', async (t) => {
  const cap = await run(t, { kind: 'unity.capture', view: 'game', width: 128, height: 128 }, {
    answer: (args) => {
      fs.writeFileSync(args[args.indexOf('--output') + 1], Buffer.from([1]));
      return { stdout: envelope({}) };
    },
  });
  assert.equal(fs.existsSync(path.join(cap.P.root, '.bridge')), false);
  const script = await run(t, { kind: 'unity.script', source: 'class S { static void Run() {} }', entry: 'S.Run' }, { extra: { allowScripts: true } });
  assert.equal(final(script.events).result.ok, true);
  assert.equal(fs.existsSync(path.join(script.P.root, '.bridge')), false);
});

test('pruning never deletes other content: a kept file keeps its folder and .bridge (control)', async (t) => {
  const P = unityProject(t);
  const kept = path.join(P.root, '.bridge', 'out', 'keep.png');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, 'x');
  fs.mkdirSync(path.join(P.root, '.bridge', 'notes'));
  await run(t, { kind: 'unity.script', source: 'class S { static void Run() {} }', entry: 'S.Run' }, { project: P, extra: { allowScripts: true } });
  assert.equal(fs.readFileSync(kept, 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(P.root, '.bridge', 'scripts')), false, 'the empty scripts folder is removed');
  assert.equal(fs.existsSync(path.join(P.root, '.bridge', 'notes')), true, 'a folder that is not the helper’s is left alone');
});

// ── the start-up line (e2e fix 4) ──────────────────────────────────────────────────────────────────

test('the projects-folder line counts only the folder, adding "+m from --unity" when m > 0', async () => {
  const { projectsFolderLine } = require('../lib/bridge/cli');
  assert.equal(projectsFolderLine({ projectsDir: '/x/P', projects: [{}], folderProjectCount: 0 }), 'Unity projects: 0 in /x/P, +1 from --unity.');
  assert.equal(projectsFolderLine({ projectsDir: '/x/P', projects: [{}, {}], folderProjectCount: 2 }), 'Unity projects: 2 in /x/P.');
});

test('discovery: folderProjectCount excludes a --unity project from outside the folder', (t) => {
  const home = fs.realpathSync(scratch(t));
  const folder = path.join(home, 'Empty');
  fs.mkdirSync(folder);
  const extra = makeProject(path.join(home, 'Extra'));
  const d = discoverUnity({ unityPaths: [extra], projectsDir: folder, cwd: home, exec: noExec });
  assert.equal(d.projects.length, 1);
  assert.equal(d.folderProjectCount, 0);
});

test('launchDetached keeps the process alive while it waits (its timer is ref’d), and a cancel ends the wait without killing', async () => {
  // A launcher that never exits: only the wait timer or the abort can settle it.
  const calls = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    child.kill = () => void calls.push('kill');
    calls.push(opts);
    return child;
  };
  const realSetTimeout = global.setTimeout;
  let timerRef;
  global.setTimeout = (fn, ms) => (timerRef = realSetTimeout(fn, ms));
  const controller = new AbortController();
  let pending;
  try {
    pending = launchDetached('/fake/unity', ['open', '/p'], { spawn, waitMs: 60_000, signal: controller.signal });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(timerRef.hasRef(), true, 'an unref’d wait lets an otherwise idle helper exit mid-job');
  controller.abort();
  const res = await pending;
  assert.equal(res.aborted, true);
  assert.ok(!calls.includes('kill'), 'the launcher (and the Editor it starts) is never killed');
});

// ── several projects folders (D55: --projects is repeatable) ────────────────────────────────────

/** A minimal Unity project folder `name` inside `folder`. */
function unityIn(folder, name) {
  const dir = path.join(folder, name);
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\n');
  return dir;
}

test('discovery lists projects across every --projects folder; create goes to the first one', (t) => {
  const base = fs.realpathSync(scratch(t));
  const a = path.join(base, 'Studio');
  const b = path.join(base, 'Archive');
  unityIn(a, 'Kart');
  unityIn(b, 'Old Game');
  const d = discoverUnity({ projectsDir: [a, b, a], cwd: base, env: { HOME: base }, platform: 'darwin', exec: () => undefined });
  assert.deepEqual(d.projectsDirs, [a, b]);
  assert.equal(d.projectsDir, a);
  assert.deepEqual(d.projects.map((p) => p.name), ['Kart', 'Old Game']);
  assert.equal(d.folderProjectCount, 2);
  assert.deepEqual(d.missingDirs, []);
  const ws = createWorkspace({ projectsDir: d.projectsDir, projectsDirs: d.projectsDirs });
  assert.equal(ws.projectsDir, a);
  assert.equal(ws.projectsDirName, 'Studio, Archive');
  assert.equal(ws.rootFor('Old Game'), path.join(b, 'Old Game'));
  const missing = discoverUnity({ projectsDir: [a, path.join(base, 'Nope')], cwd: base, env: { HOME: base }, platform: 'darwin', exec: () => undefined });
  assert.deepEqual(missing.missingDirs, [path.join(base, 'Nope')]);
});

test('a name in two projects folders is ambiguous; "<folder>/<name>" picks one', (t) => {
  const base = fs.realpathSync(scratch(t));
  const a = path.join(base, 'Studio');
  const b = path.join(base, 'Archive');
  unityIn(a, 'Kart');
  unityIn(b, 'Kart');
  const ws = createWorkspace({ projectsDir: a, projectsDirs: [a, b], platform: 'linux' });
  assert.deepEqual(ws.resolve('Kart'), { ambiguous: ['Studio', 'Archive'] });
  assert.equal(ws.rootFor('Kart'), undefined);
  assert.deepEqual(ws.resolve('Archive/Kart'), { root: path.join(b, 'Kart') });
  assert.deepEqual(ws.resolve('Studio/Kart'), { root: path.join(a, 'Kart') });
  assert.equal(ws.resolve('Nowhere/Kart'), null);
  assert.equal(ws.resolve('../Kart'), null);
  assert.equal(ws.resolve('Studio/../Kart'), null);
  assert.equal(ws.resolve('a/b/c'), null);
});

test('unity.project open of an ambiguous name answers with the folders — nothing runs; "<folder>/<name>" opens it', async (t) => {
  const base = fs.realpathSync(scratch(t));
  const a = path.join(base, 'Studio');
  const b = path.join(base, 'Archive');
  unityIn(a, 'Kart');
  const archived = unityIn(b, 'Kart');
  const workspace = createWorkspace({ projectsDir: a, projectsDirs: [a, b], platform: 'linux' });
  const amb = await runProject(t, { action: 'open', name: 'Kart' }, { workspace });
  assert.equal(
    refused(amb.events).reason,
    'There is a Unity project named "Kart" in more than one projects folder ("Studio", "Archive"). Call unity_project again with the folder in the name, e.g. "Studio/Kart".'
  );
  assert.equal(amb.calls.length, 0);
  const picked = await runProject(t, { action: 'open', name: 'Archive/Kart' }, { workspace });
  assert.ok(picked.calls.some((c) => c.args[0] === 'open' && c.args[1] === archived));
  assert.equal(workspace.current().root, archived);
});

// ── the dev-server probe never spams "No command named 'bt_devserver_status'" (D56 follow-up) ──────────

/** A probe runner that counts calls and answers `answer` for bt_devserver_status. */
function devServerRunner(answer) {
  const probed = [];
  return {
    probed,
    runProcess: async (_f, args) => {
      probed.push(args[args.indexOf('--project-path') + 1]);
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...answer };
    },
  };
}

test('dev-server probe: no Toolkit, or one older than 9.25.1 → running:false and the command is NOT run', async () => {
  const r = devServerRunner({ stdout: JSON.stringify('started : True\nport : 8888') });
  assert.deepEqual(await probeDevServer({ cli: CLI, project: { root: '/p/None' }, runProcess: r.runProcess }), { running: false });
  assert.deepEqual(await probeDevServer({ cli: CLI, project: { root: '/p/Old', toolkitVersion: '9.25.0' }, runProcess: r.runProcess }), { running: false });
  assert.deepEqual(r.probed, []);
  // control: 9.25.1 exactly is asked
  const on = await probeDevServer({ cli: CLI, project: { root: '/p/New', toolkitVersion: '9.25.1' }, runProcess: r.runProcess });
  assert.deepEqual(r.probed, ['/p/New']);
  assert.equal(on.running, true);
});

test('dev-server probe: an unknown-command answer is remembered per project + Toolkit version; a new version is asked again', async () => {
  const r = devServerRunner({ code: 1, stderr: "No command named 'bt_devserver_status'." });
  const memo = new Map();
  const project = { root: '/p/A', toolkitVersion: '9.26.0' };
  assert.deepEqual(await probeDevServer({ cli: CLI, project, runProcess: r.runProcess, memo }), { running: false });
  assert.deepEqual(await probeDevServer({ cli: CLI, project, runProcess: r.runProcess, memo }), { running: false });
  assert.equal(r.probed.length, 1, 'asked once, then remembered');
  // another project is its own entry
  await probeDevServer({ cli: CLI, project: { root: '/p/B', toolkitVersion: '9.26.0' }, runProcess: r.runProcess, memo });
  assert.equal(r.probed.length, 2);
  // the Toolkit was upgraded → asked again
  await probeDevServer({ cli: CLI, project: { root: '/p/A', toolkitVersion: '9.28.0' }, runProcess: r.runProcess, memo });
  assert.deepEqual(r.probed, ['/p/A', '/p/B', '/p/A']);
  // control: an ordinary failure (Editor not running) is NOT remembered
  const down = devServerRunner({ code: 1, stderr: 'Could not connect to the Unity Editor.' });
  const memo2 = new Map();
  await probeDevServer({ cli: CLI, project, runProcess: down.runProcess, memo: memo2 });
  await probeDevServer({ cli: CLI, project, runProcess: down.runProcess, memo: memo2 });
  assert.equal(down.probed.length, 2);
});

test('dev-server probe: the unknown-command memory EXPIRES after 5 minutes — a Toolkit just added via package_add recovers without a restart', async () => {
  let clock = 1_000_000;
  const r = devServerRunner({ code: 1, stderr: "No command named 'bt_devserver_status'." });
  const memo = new Map();
  const project = { root: '/p/A', toolkitVersion: '9.28.0' };
  const ask = () => probeDevServer({ cli: CLI, project, runProcess: r.runProcess, memo, now: () => clock });
  await ask();
  assert.equal(r.probed.length, 1);
  clock += UNKNOWN_COMMAND_MEMORY_MS - 1;
  await ask();
  assert.equal(r.probed.length, 1, 'suppressed inside 5 minutes');
  clock += 1;
  await ask();
  assert.equal(r.probed.length, 2, 'asked again once 5 minutes have passed');
  assert.equal(UNKNOWN_COMMAND_MEMORY_MS, 5 * 60_000);
});

test('dev-server probe: never asks a project whose create scaffold is running', async () => {
  const r = devServerRunner({ stdout: JSON.stringify('started : False') });
  const project = { root: '/p/New', toolkitVersion: '9.28.0' };
  assert.deepEqual(await probeDevServer({ cli: CLI, project, runProcess: r.runProcess, busy: (root) => root === '/p/New' }), { running: false });
  assert.deepEqual(r.probed, []);
  await probeDevServer({ cli: CLI, project, runProcess: r.runProcess, busy: () => false });
  assert.deepEqual(r.probed, ['/p/New'], 'control: asked once the scaffold is done');
});

test('makeDevServerProbe keeps the unknown-command memory (within 5 minutes) and honours busy', async () => {
  let clock = 0;
  let busy = false;
  const r = devServerRunner({ code: 1, stdout: "No command named 'bt_devserver_status'." });
  const project = { root: '/p/A', toolkitVersion: '9.26.0' };
  const probe = makeDevServerProbe({ cli: CLI, current: () => project, now: () => clock, runProcess: r.runProcess, busy: () => busy });
  busy = true;
  assert.deepEqual(await probe(), { running: false });
  assert.equal(r.probed.length, 0);
  busy = false;
  clock += 60_000;
  await probe();
  clock += 60_000;
  await probe();
  clock += 60_000;
  await probe();
  assert.equal(r.probed.length, 1, 'one unknown-command answer, then never again for this Toolkit version');
});
