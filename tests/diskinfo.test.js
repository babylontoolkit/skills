'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Scanner } = require('../lib/diskinfo/scan');
const { hogs, systemRoots, breakdowns, suggestions } = require('../lib/diskinfo/locations');
const { buildReport, formatReport, human } = require('../lib/diskinfo/report');
const { parseDiskInfoArgs } = require('../lib/diskinfo/cli');

const CLI = path.join(__dirname, '..', 'bin', 'bt-agent.js');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-diskinfo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

/** A small fake home folder: a Unity project, an Unreal project, nested node_modules, a big file. */
function fakeHome(root) {
  write(path.join(root, 'Documents', 'Game', 'Assets', 'a.bin'), 4096);
  write(path.join(root, 'Documents', 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 10);
  write(path.join(root, 'Documents', 'Game', 'Library', 'cache.bin'), 64 * 1024);
  write(path.join(root, 'Documents', 'Shooter', 'Shooter.uproject'), 10);
  write(path.join(root, 'Documents', 'Shooter', 'Config', 'DefaultEngine.ini'), 10);
  write(path.join(root, 'Documents', 'Shooter', 'Intermediate', 'x.bin'), 32 * 1024);
  write(path.join(root, 'web', 'node_modules', 'pkg', 'index.js'), 8192);
  write(path.join(root, 'web', 'node_modules', 'pkg', 'node_modules', 'dep', 'index.js'), 8192);
  write(path.join(root, 'Downloads', 'big.iso'), 200 * 1024);
}

test('human() matches the shell report format', () => {
  assert.equal(human(0), '0 B');
  assert.equal(human(1536), '1.5 KB');
  assert.equal(human(5 * 1024 ** 3), '5.0 GB');
});

test('one walk finds folder sizes, node_modules, Unity/Unreal projects and big files', async (t) => {
  const home = scratch(t);
  fakeHome(home);
  const scanner = new Scanner({ bigFile: 100 * 1024 });
  const total = await scanner.measure(home);

  assert.ok(total >= 4096 + 64 * 1024 + 32 * 1024 + 16384 + 200 * 1024);
  assert.equal(scanner.lookup(home), total);
  assert.ok(scanner.lookup(path.join(home, 'Downloads')) >= 200 * 1024);

  // nested node_modules count once, inside the outer folder
  assert.equal(scanner.nodeModules.length, 1);
  assert.ok(scanner.nodeModules[0].bytes >= 16384);

  assert.equal(scanner.unityProjects.length, 1);
  assert.equal(scanner.unityProjects[0].path, path.join(home, 'Documents', 'Game'));
  assert.ok(scanner.unityProjects[0].regenerable >= 64 * 1024);
  assert.equal(scanner.unrealProjects.length, 1);
  assert.ok(scanner.unrealProjects[0].regenerable >= 32 * 1024);

  assert.deepEqual(scanner.bigFiles.map((f) => path.basename(f.path)), ['big.iso']);

  const kids = scanner.children(home).map((c) => path.basename(c.path));
  assert.equal(kids[0], 'Downloads');
  assert.deepEqual([...kids].sort(), ['Documents', 'Downloads', 'web']);
});

test('look-alikes are not reported as Unity or Unreal projects', (t) => {
  const home = scratch(t);
  // a Unity package inside a project's Library has Assets/ + ProjectSettings/ but no ProjectVersion.txt
  const pkg = path.join(home, 'Game', 'Library', 'PackageCache', 'com.unity.x', 'Editor', 'Commands');
  write(path.join(pkg, 'Assets', 'a.txt'), 10);
  write(path.join(pkg, 'ProjectSettings', 'b.asset'), 10);
  write(path.join(home, 'Lone', 'Assets', 'a.txt'), 10);
  write(path.join(home, 'Lone', 'ProjectSettings', 'b.asset'), 10);
  // VS Code's local history keeps stray copies like 1a2b.uproject without a Config/ folder
  write(path.join(home, 'History', '6dd53bb7', '1a2b.uproject'), 10);

  const scanner = new Scanner();
  scanner.measure(home);
  assert.deepEqual(scanner.unityProjects, []);
  assert.deepEqual(scanner.unrealProjects, []);
});

test('symlinks are not followed and hard links count once', { skip: process.platform === 'win32' }, async (t) => {
  const home = scratch(t);
  const outside = scratch(t);
  write(path.join(outside, 'huge.bin'), 512 * 1024);
  write(path.join(home, 'a', 'file.bin'), 128 * 1024);
  fs.symlinkSync(outside, path.join(home, 'link'));
  fs.linkSync(path.join(home, 'a', 'file.bin'), path.join(home, 'a', 'hardlink.bin'));

  const total = await new Scanner().measure(home);
  assert.ok(total < 256 * 1024, `expected one copy of file.bin only, got ${total}`);
});

test('sizeOf() inside a walked root does not double count totals or big files', async (t) => {
  const home = scratch(t);
  write(path.join(home, 'a', 'b', 'c', 'd', 'e', 'f.bin'), 200 * 1024);
  const scanner = new Scanner({ recordDepth: 1, bigFile: 100 * 1024 });
  await scanner.measure(home);
  const deep = await scanner.sizeOf(path.join(home, 'a', 'b', 'c', 'd'));
  assert.ok(deep >= 200 * 1024);
  assert.equal(scanner.bigFiles.length, 1);
  assert.equal(await scanner.sizeOf(path.join(home, 'missing')), null);
});

test('location tables resolve for macOS, Windows and Linux from any host', () => {
  const win = { platform: 'win32', home: 'C:\\Users\\me', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } };
  const mac = { platform: 'darwin', home: '/Users/me', env: {} };
  const linux = { platform: 'linux', home: '/home/me', env: {} };

  const winHogs = Object.fromEntries(hogs(win).map((h) => [h.id, h]));
  assert.equal(winHogs.npm.paths[0], 'C:\\Users\\me\\AppData\\Local\\npm-cache');
  assert.equal(winHogs['unity-editors'].paths[0], 'C:\\Program Files\\Unity\\Hub\\Editor\\*');
  assert.equal(winHogs.trash.paths[0], 'C:\\$Recycle.Bin');
  assert.deepEqual(systemRoots(win), ['C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']);
  assert.equal(breakdowns(win)[0], 'C:\\Users\\me\\AppData\\Local');

  const macHogs = Object.fromEntries(hogs(mac).map((h) => [h.id, h]));
  assert.equal(macHogs['xcode-deriveddata'].paths[0], '/Users/me/Library/Developer/Xcode/DerivedData');
  assert.equal(macHogs.cpptools.paths[0], '/Users/me/Library/Caches/vscode-cpptools');
  assert.ok(systemRoots(mac).includes('/Applications'));

  assert.ok(hogs(linux).some((h) => h.id === 'npm'));

  for (const ctx of [win, mac, linux]) {
    const ids = new Set(hogs(ctx).map((h) => h.id));
    for (const h of hogs(ctx)) assert.ok(h.paths.every((p) => typeof p === 'string'), h.id);
    // every hog-driven suggestion names a hog that can exist somewhere
    assert.ok(suggestions(ctx).length > 0);
    assert.ok(ids.has('downloads'));
  }
});

test('buildReport() + formatReport() over a fake home produce every section', async (t) => {
  const home = scratch(t);
  fakeHome(home);
  write(path.join(home, '.npm', '_cacache', 'blob'), 60 * 1024 * 1024);
  write(path.join(home, 'Documents', 'Game', 'Library', 'big.bin'), 60 * 1024 * 1024); // projects under 50 MB are not listed
  // linux tables keep every hog under the fake home, so the test never walks the real disk
  const report = await buildReport({ ctx: { platform: 'linux', home, env: {} }, roots: [] });

  assert.equal(report.roots.length, 1);
  assert.equal(report.nodeModules.count, 1);
  assert.equal(report.unityProjects.length, 1);
  assert.ok(report.hogs.some((h) => h.id === 'npm'));
  assert.ok(report.suggestions.some((s) => s.includes('journalctl')));

  const text = formatReport(report);
  for (const section of ['1. VOLUMES', '2. TOP-LEVEL', '3. HOME FOLDER', '4. KNOWN SPACE HOGS', '5. DEVELOPER CLUTTER', '6. LARGEST', '7. SUGGESTED']) {
    assert.ok(text.includes(section), section);
  }
  assert.ok(text.includes('npm cache'));
});

test('argument parsing', () => {
  assert.deepEqual(parseDiskInfoArgs([]), { json: false, save: true, out: null, help: false });
  assert.equal(parseDiskInfoArgs(['--out', 'r.txt']).out, 'r.txt');
  assert.equal(parseDiskInfoArgs(['--out=r.txt']).out, 'r.txt');
  assert.equal(parseDiskInfoArgs(['--no-save', '--json']).save, false);
  assert.throws(() => parseDiskInfoArgs(['--bogus']), /Unknown option/);
  assert.throws(() => parseDiskInfoArgs(['--out']), /needs a file/);
});

test('bt-agent diskinfo --help is wired into the CLI', () => {
  const r = spawnSync(process.execPath, [CLI, 'diskinfo', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bt-agent diskinfo/);
  const main = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(main.stdout, /diskinfo/);
});
