'use strict';

const fs = require('fs');
const path = require('path');

/**
 * One-pass disk-usage walker.
 *
 * Every root is walked once. Along the way it records the size of each folder
 * down to `recordDepth`, every `node_modules`, every Unity / Unreal project and
 * every file over `bigFile` bytes — so the report is lookups, not re-walks.
 *
 * Sizes are allocated bytes (st.blocks * 512) where the platform reports them, so
 * sparse files (Docker.raw) count what they really use, like `du`. Windows has no
 * st.blocks, so it falls back to st.size. Hard links count once (like `du`),
 * symlinks and junctions are never followed, and a walk never crosses onto
 * another volume.
 */

const GB = 1024 ** 3;

function allocated(st) {
  return typeof st.blocks === 'number' && st.blocks >= 0 && process.platform !== 'win32' ? st.blocks * 512 : st.size;
}

/** Normalised key for the size map, so lookups are case-insensitive on Windows and macOS. */
function keyOf(p) {
  const resolved = path.resolve(p);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

class Scanner {
  /**
   * @param {object} [opts]
   * @param {number} [opts.recordDepth=4]  Folder sizes are kept for this many levels below each root.
   * @param {number} [opts.bigFile=1 GiB]  Files at least this big are listed individually.
   * @param {(s: {files: number, bytes: number, dir: string}) => void} [opts.onProgress]
   */
  constructor(opts = {}) {
    this.recordDepth = opts.recordDepth ?? 4;
    this.bigFile = opts.bigFile ?? GB;
    this.onProgress = opts.onProgress || null;

    this.sizes = new Map(); // keyOf(dir) -> bytes, for folders within recordDepth of a root
    this.kids = new Map(); // keyOf(dir) -> [{ path, bytes }] recorded subfolders
    this.seenInodes = new Set();
    this.nodeModules = []; // { path, bytes }
    this.unityProjects = []; // { path, bytes, regenerable }
    this.unrealProjects = []; // { path, bytes, regenerable }
    this.bigFiles = []; // { path, bytes }
    this.unreadable = 0;
    this.files = 0;
    this.bytes = 0;
    this._lastProgress = 0;
  }

  /** Walk a folder (or measure a file). Returns its size in bytes, or null when it does not exist. */
  measure(target) {
    const known = this.lookup(target);
    if (known !== null) return known;
    let st;
    try {
      st = fs.lstatSync(target);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') this.unreadable += 1;
      return null;
    }
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return this._countFile(target, st);
    return this._walkDir(target, st.dev, 0, false);
  }

  /**
   * Size of any path, for one-off lookups like the known-hogs table. Folders recorded
   * by a walk are free; anything else is measured by a throwaway scanner, so a lookup
   * never adds to the totals, the big-file list, the hard-link set or the project lists.
   */
  sizeOf(target) {
    const known = this.lookup(target);
    if (known !== null) return known;
    const probe = new Scanner({ recordDepth: 0, bigFile: Infinity });
    const bytes = probe.measure(target);
    this.unreadable += probe.unreadable;
    return bytes;
  }

  /** Size of a folder already covered by a walk, without touching the disk; null if unknown. */
  lookup(target) {
    const k = keyOf(target);
    return this.sizes.has(k) ? this.sizes.get(k) : null;
  }

  /** Recorded subfolders of a walked folder, largest first: [{ path, bytes }]. */
  children(dir) {
    return [...(this.kids.get(keyOf(dir)) || [])].sort((a, b) => b.bytes - a.bytes);
  }

  _record(dir, depth, bytes) {
    if (depth > this.recordDepth) return;
    this.sizes.set(keyOf(dir), bytes);
    if (depth === 0) return;
    const parent = keyOf(path.dirname(dir));
    if (!this.kids.has(parent)) this.kids.set(parent, []);
    this.kids.get(parent).push({ path: dir, bytes });
  }

  _countFile(file, st) {
    if (st.nlink > 1) {
      const id = `${st.dev}:${st.ino}`;
      if (this.seenInodes.has(id)) return 0;
      this.seenInodes.add(id);
    }
    const bytes = allocated(st);
    this.files += 1;
    this.bytes += bytes;
    if (bytes >= this.bigFile) this.bigFiles.push({ path: file, bytes });
    if (this.onProgress && (this.files & 0x3fff) === 0) {
      const now = Date.now();
      if (now - this._lastProgress > 250) {
        this._lastProgress = now;
        this.onProgress({ files: this.files, bytes: this.bytes, dir: path.dirname(file) });
      }
    }
    return bytes;
  }

  /**
   * Synchronous on purpose: on a 690k-file tree it is ~3.4x faster than a promise-per-entry
   * walk, which spends its time in promise bookkeeping rather than on the disk.
   * `quiet` = inside node_modules or a project's rebuildable folder: count, but detect nothing.
   */
  _walkDir(dir, rootDev, depth, quiet) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') this.unreadable += 1;
      this._record(dir, depth, 0);
      return 0;
    }

    const isNodeModules = !quiet && path.basename(dir) === 'node_modules';
    const engine = quiet || isNodeModules ? null : detectProject(dir, entries);
    const rebuildable = new Set(engine ? engine.regenerable : []);

    let total = 0;
    let regenerable = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (err) {
        if (err.code !== 'ENOENT') this.unreadable += 1;
        continue;
      }
      if (st.isSymbolicLink()) continue; // Windows junctions surface here
      if (st.isDirectory()) {
        if (st.dev !== rootDev) continue; // another volume
        const inRebuildable = rebuildable.has(entry.name);
        const bytes = this._walkDir(full, rootDev, depth + 1, quiet || isNodeModules || inRebuildable);
        total += bytes;
        if (inRebuildable) regenerable += bytes;
      } else {
        total += this._countFile(full, st);
      }
    }

    this._record(dir, depth, total);
    if (isNodeModules) this.nodeModules.push({ path: dir, bytes: total });
    if (engine) (engine.kind === 'unity' ? this.unityProjects : this.unrealProjects).push({ path: dir, bytes: total, regenerable });
    return total;
  }
}

/**
 * A Unity project has Assets/ and ProjectSettings/ProjectVersion.txt (packages and test
 * fixtures often have the two folders but never the version file). An Unreal project has
 * a *.uproject file next to Config/ (VS Code's file history alone keeps stray *.uproject copies).
 */
function detectProject(dir, entries) {
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  if (dirs.has('Assets') && dirs.has('ProjectSettings') && fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
    return { kind: 'unity', regenerable: ['Library', 'Temp', 'Obj', 'Logs'] };
  }
  if (dirs.has('Config') && entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.uproject'))) {
    return { kind: 'unreal', regenerable: ['Intermediate', 'DerivedDataCache', 'Binaries'] };
  }
  return null;
}

module.exports = { Scanner, detectProject, allocated, keyOf, GB };
