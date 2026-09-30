'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeUnity, CANCELLED } = require('../lib/bridge/unity/ops');
const { resolveProjectPath } = require('../lib/bridge/unity/guard');
const { discoverUnity, probeDevServer } = require('../lib/bridge/unity/discover');
const { createAutomation } = require('../lib/bridge/unity/automation');
const { makeExecuteDispatch, NOT_SERVING } = require('../lib/bridge/cli');

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
 * @param {(args: string[], opts: any) => any} [answer]
 */
function fakeRun(answer = () => ({ stdout: envelope({}) })) {
  const calls = [];
  const runProcess = async (file, args, opts = {}) => {
    calls.push({ file, args, opts });
    const r = (await answer(args, opts)) || {};
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...r };
  };
  return { calls, runProcess };
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
const dispatchOf = (op, extra = {}) => ({ jobId: 'job1', op, unityProjectKey: 'k1', allowScripts: false, consentGranted: false, ...extra });

async function run(t, op, { extra, answer, project, api, automation, noScripts, signal } = {}) {
  const P = project || unityProject(t);
  const { calls, runProcess } = fakeRun(answer);
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

test('scripts with allowScripts:false → refused; --no-scripts wins over allowScripts', async (t) => {
  const op = { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' };
  const a = await run(t, op);
  assert.ok(refused(a.events).reason.startsWith('Scripts are switched off'));
  const b = await run(t, op, { extra: { allowScripts: true }, noScripts: true });
  assert.ok(refused(b.events));
  assert.equal(b.calls.length, 0);
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
  const root = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.join(root, 'Assets'));
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
  const root = fs.realpathSync(scratch(t));
  fs.mkdirSync(path.join(root, 'Assets'));
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
  const ok = await probeDevServer({ cli: CLI, project: { root }, runProcess: async () => ({ code: 0, stdout: JSON.stringify(text), stderr: '', timedOut: false }) });
  assert.deepEqual(ok, { running: true, origin: 'http://localhost:8888', project: 'Babylon Toolkit', listen: 'all', scenes: ['Level01.gltf', 'Level02.glb'] });
  const stopped = await probeDevServer({ cli: CLI, project: { root }, runProcess: async () => ({ code: 0, stdout: 'started : False\nport : 0', stderr: '', timedOut: false }) });
  assert.deepEqual(stopped, { running: false });
  const broken = await probeDevServer({ cli: CLI, project: { root }, runProcess: async () => { throw new Error('x'); } });
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

test('a dispatch for a Unity project this computer does not serve → refused', async (t) => {
  const { events, emit } = collector();
  const exec = makeExecuteDispatch({ projects: [unityProject(t)], cli: CLI, noScripts: false, runProcess: fakeRun().runProcess });
  await exec({ ...dispatchOf({ kind: 'unity.list' }), unityProjectKey: 'nope' }, emit, new AbortController().signal);
  assert.deepEqual(events, [{ jobId: 'job1', type: 'refused', reason: NOT_SERVING }]);
});

test('unity.* and devserver.* dispatches reach the Unity runner', async (t) => {
  const { events, emit } = collector();
  const { calls, runProcess } = fakeRun();
  const exec = makeExecuteDispatch({ projects: [unityProject(t)], cli: CLI, noScripts: false, runProcess });
  await exec(dispatchOf({ kind: 'devserver.start', port: 8888 }), emit, new AbortController().signal);
  assert.deepEqual(calls[0].args.slice(0, 2), ['command', 'bt_devserver_start']);
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
  const evil = { jobId: '../../Assets', unityProjectKey: 'k1', allowScripts: true, consentGranted: true };
  for (const op of [
    { kind: 'unity.capture', view: 'game', width: 64, height: 64 },
    { kind: 'unity.script', source: 'class A {}', entry: 'A.Run' },
    { kind: 'unity.command', name: 'screenshot', params: {} },
  ]) {
    await executeUnity({ ...evil, op }, { project: P, cli: CLI, emit, runProcess, log: quietLog() });
    const exec = makeExecuteDispatch({ projects: [P], cli: CLI, noScripts: false, runProcess });
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
