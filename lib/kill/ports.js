'use strict';

const { spawnSync } = require('child_process');

const MAX_PORT = 65535;
const GRACE_MS = 3000;
const KILL_WAIT_MS = 2000;

/**
 * Parse `4444`, `8000-8010`, `4444,8888` or `:4444` into a sorted list of unique ports.
 * Throws with a readable message on anything else.
 */
function parsePortSpecs(specs) {
  const ports = new Set();
  for (const spec of specs) {
    for (const part of String(spec).split(',')) {
      const token = part.trim().replace(/^:/, '');
      if (!token) continue;
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
      if (!m) throw new Error(`Not a port or range: ${part.trim()}`);
      const from = Number(m[1]);
      const to = m[2] === undefined ? from : Number(m[2]);
      for (const p of [from, to]) {
        if (p < 1 || p > MAX_PORT) throw new Error(`Port out of range (1-${MAX_PORT}): ${p}`);
      }
      if (to < from) throw new Error(`Range runs backwards: ${token}`);
      for (let p = from; p <= to; p += 1) ports.add(p);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Parse `1234` or `1234,5678` into unique process ids (positive integers only). */
function parsePids(specs) {
  const pids = new Set();
  for (const spec of specs) {
    for (const part of String(spec).split(',')) {
      const token = part.trim();
      if (!token) continue;
      // 0 and negative ids address whole process groups in kill(2) — never accept them.
      if (!/^\d+$/.test(token) || Number(token) < 1) throw new Error(`Not a process id: ${token}`);
      pids.add(Number(token));
    }
  }
  return [...pids];
}

function portOf(address) {
  const m = /:(\d+)$/.exec(address || '');
  return m ? Number(m[1]) : null;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → [{ port, pid, command }]. */
function parseLsof(text) {
  const out = [];
  let pid = null;
  let command = '';
  for (const line of text.split(/\r?\n/)) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      command = '';
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n' && pid) {
      const port = portOf(value);
      if (port) out.push({ port, pid, command });
    }
  }
  return out;
}

/**
 * `ss -ltnp` → [{ port, pid, command }]. A listener owned by another user has no
 * process column without root, so it comes back with pid null.
 */
function parseSs(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN') continue;
    const port = portOf(cols[3]);
    if (!port) continue;
    const users = /users:\((.*)\)/.exec(line);
    const owners = [...(users ? users[1] : '').matchAll(/\("([^"]*)",pid=(\d+)/g)];
    if (!owners.length) out.push({ port, pid: null, command: '' });
    for (const m of owners) out.push({ port, pid: Number(m[2]), command: m[1] });
  }
  return out;
}

/** `netstat -ano` (Windows) → [{ port, pid, command: '' }]. */
function parseNetstat(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Proto  Local  Foreign  State  PID — the State word is localized, so a listener is
    // recognized by its foreign port 0 instead of by "LISTENING".
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP' || !/:0$/.test(cols[2])) continue;
    const port = portOf(cols[1]);
    const pid = Number(cols[cols.length - 1]);
    if (port && Number.isInteger(pid)) out.push({ port, pid, command: '' });
  }
  return out;
}

/** `tasklist /FO CSV /NH` → Map(pid → image name). */
function parseTasklist(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) names.set(Number(m[2]), m[1]);
  }
  return names;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { error: r.error || null, stdout: r.stdout || '' };
}

/** Every TCP listener on this machine that the current user can see. */
function findListeners(platform = process.platform) {
  if (platform === 'win32') {
    const net = run('netstat', ['-ano']);
    if (net.error) throw new Error(`Could not run netstat: ${net.error.message}`);
    const listeners = parseNetstat(net.stdout);
    const names = parseTasklist(run('tasklist', ['/FO', 'CSV', '/NH']).stdout);
    for (const l of listeners) l.command = names.get(l.pid) || '';
    return listeners;
  }

  // ss ships with every modern Linux and still reports ports other users hold;
  // macOS has no ss, so lsof goes first there. lsof exits 1 when nothing matches.
  const tools = [
    ['ss', ['-ltnp'], parseSs],
    ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], parseLsof],
  ];
  if (platform !== 'linux') tools.reverse();
  for (const [cmd, args, parse] of tools) {
    const r = run(cmd, args);
    if (!r.error) return parse(r.stdout);
  }
  throw new Error('Neither lsof nor ss is installed — install one of them (e.g. `sudo apt install lsof`).');
}

/** Image name of a running process, or '' when it cannot be read. */
function processName(pid, platform = process.platform) {
  if (platform === 'win32') {
    return parseTasklist(run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout).get(pid) || '';
  }
  return run('ps', ['-p', String(pid), '-o', 'comm=']).stdout.trim().split('/').pop();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Send one stop request. Returns null on success (or already gone), else an error message. */
function signal(pid, hard, platform) {
  if (platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    if (r.error) return `could not run taskkill: ${r.error.message}`;
    if (r.status === 0 || !isAlive(pid)) return null;
    return (r.stderr || r.stdout || `taskkill exited ${r.status}`).trim();
  }
  try {
    process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM');
    return null;
  } catch (err) {
    if (err.code === 'ESRCH') return null;
    if (err.code === 'EPERM') return 'permission denied — it belongs to another user; retry with sudo';
    return err.message;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(pids, ms) {
  const deadline = Date.now() + ms;
  let alive = pids.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter(isAlive);
  }
  return alive;
}

/**
 * Stop each { pid, command, ports } target. On macOS/Linux a process gets SIGTERM and,
 * if it is still running after graceMs, SIGKILL; `force` (and Windows, where console
 * processes cannot be asked politely) kills at once. Resolves to the targets with a
 * status of stopped | killed | failed | protected and an error message where relevant.
 */
async function stopProcesses(targets, { force = false, graceMs = GRACE_MS, platform = process.platform } = {}) {
  const hard = force || platform === 'win32';
  const results = targets.map((t) => ({ ...t, status: null, error: null }));
  const pending = [];

  for (const r of results) {
    if (r.pid === process.pid) {
      r.status = 'protected';
      r.error = 'that is bt-agent itself';
    } else if (platform !== 'win32' && r.pid === 1) {
      r.status = 'protected';
      r.error = 'that is the system init process';
    } else if (platform === 'win32' && r.pid <= 4) {
      r.status = 'protected';
      r.error = 'held by Windows itself (System) — stop the service that owns it, e.g. IIS / http.sys';
    } else {
      const error = signal(r.pid, hard, platform);
      if (error) {
        r.status = 'failed';
        r.error = error;
      } else {
        r.status = hard ? 'killed' : 'stopped';
        pending.push(r);
      }
    }
  }

  let alive = await waitForExit(pending.map((r) => r.pid), hard ? KILL_WAIT_MS : graceMs);
  if (alive.length && !hard) {
    for (const pid of alive) signal(pid, true, platform);
    for (const r of pending) if (alive.includes(r.pid)) r.status = 'killed';
    alive = await waitForExit(alive, KILL_WAIT_MS);
  }
  for (const r of pending) {
    if (alive.includes(r.pid)) {
      r.status = 'failed';
      r.error = 'still running after being killed';
    }
  }
  return results;
}

module.exports = {
  parsePortSpecs,
  parsePids,
  parseLsof,
  parseSs,
  parseNetstat,
  parseTasklist,
  findListeners,
  processName,
  stopProcesses,
  isAlive,
};
