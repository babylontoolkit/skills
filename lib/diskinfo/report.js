'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Scanner, keyOf } = require('./scan');
const { systemRoots, breakdowns, hogs, suggestions, glob } = require('./locations');
const { prettyPath } = require('../paths');

const MB = 1024 ** 2;
const HOG_MIN = 50 * MB;

/** 1536 -> "1.5 KB", using 1024 steps like Finder's "About This Mac" used to. */
function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

function localStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

function statVolume(mount) {
  if (typeof fs.statfsSync !== 'function') return null; // Node < 18.15
  try {
    const s = fs.statfsSync(mount);
    const total = s.blocks * s.bsize;
    return { mount, total, used: total - s.bfree * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

/** The volume holding the user's data, plus every other fixed drive on Windows. */
function volumes(ctx) {
  if (ctx.platform === 'win32') {
    const out = [];
    for (let c = 67; c <= 90; c += 1) {
      const root = `${String.fromCharCode(c)}:\\`;
      const v = fs.existsSync(root) ? statVolume(root) : null;
      if (v && v.total > 0) out.push(v);
    }
    return out;
  }
  const data = ctx.platform === 'darwin' && fs.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
  const v = statVolume(data);
  return v ? [v] : [];
}

/** macOS only: space consumed by each APFS volume (simulator runtimes show up here). */
function apfsVolumes() {
  const out = [];
  let name = null;
  for (const line of run('diskutil', ['apfs', 'list']).split('\n')) {
    const n = /Name:\s+(.+?)(\s+\(Case-.*\))?\s*$/.exec(line);
    if (n) name = n[1];
    const c = /Capacity Consumed:\s+(\d+) B/.exec(line);
    if (c && name) out.push({ name, bytes: Number(c[1]) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

function snapshotCount() {
  return run('tmutil', ['listlocalsnapshots', '/']).split('\n').filter((l) => l.includes('com.apple')).length;
}

const top = (list, n) => [...list].sort((a, b) => b.bytes - a.bytes).slice(0, n);
const sum = (list) => list.reduce((n, x) => n + x.bytes, 0);

/**
 * Scan the disk and return the report data. Read-only: nothing is moved or deleted.
 * The walk itself is synchronous (see Scanner); this stays async for callers' convenience.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onStage]   A new phase started.
 * @param {(p: {files:number, bytes:number, dir:string}) => void} [opts.onProgress]
 * @param {object} [opts.ctx]  { platform, home, env } — injectable for tests.
 * @param {string[]} [opts.roots]  Override the system folders to walk (tests).
 */
async function buildReport(opts = {}) {
  const started = Date.now();
  const ctx = opts.ctx || { platform: process.platform, home: os.homedir(), env: process.env };
  const stage = opts.onStage || (() => {});
  const scanner = new Scanner({ onProgress: opts.onProgress });

  stage('volume overview');
  const vols = volumes(ctx);
  const mac = ctx.platform === 'darwin' && !opts.ctx;
  const apfs = mac ? apfsVolumes() : [];
  const snapshots = mac ? snapshotCount() : 0;

  stage(`home folder ${prettyPath(ctx.home)}`);
  const homeBytes = scanner.measure(ctx.home) || 0;

  const roots = [{ path: ctx.home, bytes: homeBytes, home: true }];
  const homeKey = keyOf(ctx.home);
  for (const root of opts.roots || systemRoots(ctx)) {
    const k = keyOf(root);
    if (k === homeKey || k.startsWith(homeKey + path.sep) || homeKey.startsWith(k + path.sep)) continue;
    if (!fs.existsSync(root)) continue;
    stage(prettyPath(root));
    const bytes = scanner.measure(root);
    if (bytes !== null) roots.push({ path: root, bytes });
  }

  stage('known space hogs');
  const hogRows = [];
  const hogTotals = {};
  for (const hog of hogs(ctx)) {
    const found = hog.paths.flatMap(glob).filter((p) => fs.existsSync(p));
    const rows = hog.each ? found.map((p) => ({ paths: [p], label: `${hog.label} ${path.basename(p)}` })) : [{ paths: found, label: hog.label }];
    for (const row of rows) {
      let bytes = 0;
      for (const p of row.paths) bytes += scanner.sizeOf(p) || 0;
      hogTotals[hog.id] = (hogTotals[hog.id] || 0) + bytes;
      if (bytes >= HOG_MIN) hogRows.push({ id: hog.id, group: hog.group, label: row.label, bytes, paths: row.paths });
    }
  }

  const worthListing = (p) => p.bytes >= HOG_MIN;
  const unity = top(scanner.unityProjects.filter(worthListing), 50);
  const unreal = top(scanner.unrealProjects.filter(worthListing), 50);
  hogTotals['node-modules'] = sum(scanner.nodeModules);
  hogTotals['unity-projects'] = unity.reduce((n, p) => n + p.regenerable, 0);
  hogTotals['unreal-projects'] = unreal.reduce((n, p) => n + p.regenerable, 0);
  hogTotals.snapshots = snapshots;
  hogTotals.always = 0;

  const vol = vols.find((v) => keyOf(ctx.home).startsWith(keyOf(v.mount))) || vols[0] || null;
  const measured = sum(roots);
  const other = vol ? Math.max(0, vol.used - measured) : null;

  return {
    generatedAt: new Date().toISOString(),
    localTime: localStamp(new Date()),
    computer: os.hostname(),
    platform: ctx.platform,
    elapsedMs: Date.now() - started,
    volumes: vols,
    apfs,
    snapshots,
    roots: top(roots, roots.length),
    other,
    home: { path: ctx.home, children: top(scanner.children(ctx.home), 25) },
    breakdowns: breakdowns(ctx)
      .filter((d) => scanner.lookup(d) !== null)
      .map((d) => ({ path: d, bytes: scanner.lookup(d), children: top(scanner.children(d), d === breakdowns(ctx)[0] ? 15 : 10) })),
    hogs: hogRows,
    nodeModules: { count: scanner.nodeModules.length, bytes: hogTotals['node-modules'], top: top(scanner.nodeModules, 15) },
    unityProjects: unity,
    unrealProjects: unreal,
    bigFiles: top(scanner.bigFiles, 30),
    suggestions: suggestions(ctx).filter((s) => (hogTotals[s.id] ?? -1) >= s.min).map((s) => s.text),
    unreadable: scanner.unreadable,
  };
}

/** Plain-text rendering of buildReport()'s result. */
function formatReport(r) {
  const out = [];
  const line = (s = '') => out.push(s);
  const row = (bytes, label) => line(`  ${human(bytes).padStart(10)}  ${label}`);
  const header = (title) => {
    line();
    line('='.repeat(70));
    line(`  ${title}`);
    line('='.repeat(70));
  };
  const win = r.platform === 'win32';

  line(`Disk space report — ${r.localTime} — ${r.computer}`);
  line('(read-only scan; nothing was deleted)');

  header('1. VOLUMES');
  for (const v of r.volumes) {
    const pct = v.total ? Math.round((v.used / v.total) * 100) : 0;
    line(`  ${v.mount.padEnd(24)} ${human(v.used)} used of ${human(v.total)} (${pct}%) — ${human(v.free)} free`);
  }
  if (r.apfs.length) {
    line();
    line('  APFS volumes on this Mac (space consumed):');
    for (const a of r.apfs) line(`    ${human(a.bytes).padStart(10)}  ${a.name}`);
  }
  if (r.platform === 'darwin') {
    line();
    line(`  Local Time Machine snapshots: ${r.snapshots}`);
  }

  header('2. TOP-LEVEL BREAKDOWN (largest first)');
  for (const root of r.roots) row(root.bytes, root.home ? `${prettyPath(root.path)} (your home folder)` : root.path);
  if (r.other !== null) {
    row(r.other, win ? 'Everything else (Windows, page file, restore points, unreadable folders)' : 'Everything else (system files, snapshots, unreadable folders)');
  }

  header(`3. HOME FOLDER — ${r.home.children.length} largest items`);
  for (const c of r.home.children) row(c.bytes, prettyPath(c.path));
  for (const b of r.breakdowns) {
    line();
    line(`  -- ${prettyPath(b.path)} (${human(b.bytes)}) --`);
    if (!b.children.length) line('    (empty or unreadable)');
    for (const c of b.children) row(c.bytes, prettyPath(c.path));
  }

  header('4. KNOWN SPACE HOGS (50 MB and up)');
  let group = null;
  for (const h of r.hogs) {
    if (h.group !== group) line(`  [${(group = h.group)}]`);
    row(h.bytes, h.label);
  }
  if (!r.hogs.length) line('  none found');

  header('5. DEVELOPER CLUTTER (folders that rebuild themselves)');
  if (r.nodeModules.count) {
    line(`  node_modules: ${r.nodeModules.count} folders, ${human(r.nodeModules.bytes)} total. Largest:`);
    for (const n of r.nodeModules.top) row(n.bytes, prettyPath(n.path));
  } else {
    line('  node_modules: none found');
  }
  for (const [title, list, folder] of [
    ['Unity projects', r.unityProjects, 'Library'],
    ['Unreal projects', r.unrealProjects, 'Intermediate etc.'],
  ]) {
    if (!list.length) continue;
    line();
    line(`  ${title} (whole project / regenerable ${folder}):`);
    for (const p of list) line(`  ${human(p.bytes).padStart(10)}  (${folder}: ${human(p.regenerable).padStart(8)})  ${prettyPath(p.path)}`);
    line(`  Total regenerable: ${human(list.reduce((n, p) => n + p.regenerable, 0))}`);
  }

  header('6. LARGEST INDIVIDUAL FILES (1 GB and up)');
  for (const f of r.bigFiles) row(f.bytes, prettyPath(f.path));
  if (!r.bigFiles.length) line('  none');

  header('7. SUGGESTED NEXT STEPS (review first; nothing has been run)');
  for (const s of r.suggestions) line(`  • ${s}`);

  if (r.unreadable > 0) {
    line();
    line(`  Note: ${r.unreadable.toLocaleString()} folders or files could not be read, so some totals are partial.`);
    line(
      win
        ? '  Run the terminal as Administrator for a fuller picture.'
        : r.platform === 'darwin'
          ? '  Give your terminal app Full Disk Access (System Settings > Privacy & Security) and rerun for a fuller picture.'
          : '  Run with sudo for a fuller picture.'
    );
  }
  if (win) {
    line();
    line('  OneDrive / iCloud files that are online-only are counted at full size here, though they use no local space.');
  }
  line();
  line(`  Scanned in ${Math.round(r.elapsedMs / 1000)}s.`);
  line();
  return out.join('\n');
}

module.exports = { buildReport, formatReport, human };
