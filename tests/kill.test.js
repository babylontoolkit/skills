'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn, execFile } = require('child_process');
const {
  parsePortSpecs,
  parsePids,
  parseLsof,
  parseSs,
  parseNetstat,
  parseTasklist,
  findListeners,
  stopProcesses,
} = require('../lib/kill/ports');
const { parseKillArgs } = require('../lib/kill/cli');

const CLI = path.join(__dirname, '..', 'bin', 'bt-agent.js');

test('port specs: single, range, comma list, leading colon, dedupe and sort', () => {
  assert.deepEqual(parsePortSpecs(['4444']), [4444]);
  assert.deepEqual(parsePortSpecs(['8000-8003']), [8000, 8001, 8002, 8003]);
  assert.deepEqual(parsePortSpecs(['8888,:4444', '4444']), [4444, 8888]);
  assert.equal(parsePortSpecs(['1-65535']).length, 65535);
  assert.throws(() => parsePortSpecs(['0']), /out of range/);
  assert.throws(() => parsePortSpecs(['70000']), /out of range/);
  assert.throws(() => parsePortSpecs(['9000-8000']), /backwards/);
  assert.throws(() => parsePortSpecs(['abc']), /Not a port/);
});

test('pids: positive integers only — 0 and negatives address process groups', () => {
  assert.deepEqual(parsePids(['123,456', '123']), [123, 456]);
  assert.throws(() => parsePids(['0']), /Not a process id/);
  assert.throws(() => parsePids(['-1']), /Not a process id/);
  assert.throws(() => parsePids(['12a']), /Not a process id/);
});

test('args: --port, --pid and --list say what the values are', () => {
  const byPort = parseKillArgs(['--port', '4444', '8000-8001', '-9']);
  assert.deepEqual(byPort.ports, [4444, 8000, 8001]);
  assert.deepEqual(byPort.pids, []);
  assert.equal(byPort.force, true);
  assert.deepEqual(parseKillArgs(['--pid', '12,13', '14']).pids, [12, 13, 14]);
  assert.deepEqual(parseKillArgs(['--port=4444']).ports, [4444]);
  assert.deepEqual(parseKillArgs(['--pid=99']).pids, [99]);

  const listAll = parseKillArgs(['--list']);
  assert.equal(listAll.list, true);
  assert.deepEqual(listAll.ports, []);
  assert.deepEqual(parseKillArgs(['--list', '3000-3001']).ports, [3000, 3001]);
  assert.deepEqual(parseKillArgs(['--list', '--pid', '77']).pids, [77]);
  assert.equal(parseKillArgs(['--dry-run', '--port', '4444']).list, true);
});

test('args: a bare number, a missing value, or both modes are refused', () => {
  assert.throws(() => parseKillArgs(['4444']), /port or a process id/);
  assert.throws(() => parseKillArgs([]), /Say what to stop/);
  assert.throws(() => parseKillArgs(['--port']), /--port needs a port/);
  assert.throws(() => parseKillArgs(['--pid']), /--pid needs a process id/);
  assert.throws(() => parseKillArgs(['--port', '1', '--pid', '2']), /not both/);
  assert.throws(() => parseKillArgs(['--pid', '4444-4445']), /Not a process id/);
  assert.throws(() => parseKillArgs(['--list', '--force']), /--list never does/);
  assert.throws(() => parseKillArgs(['--nope']), /Unknown option/);
});

test('lsof -F output', () => {
  const text = ['p501', 'cnode', 'f22', 'n*:4444', 'f23', 'n[::1]:8888', 'p77', 'cPython', 'f3', 'n127.0.0.1:5000', ''].join('\n');
  assert.deepEqual(parseLsof(text), [
    { port: 4444, pid: 501, command: 'node' },
    { port: 8888, pid: 501, command: 'node' },
    { port: 5000, pid: 77, command: 'Python' },
  ]);
});

test('ss -ltnp output, including a listener owned by another user', () => {
  const text = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      511    0.0.0.0:4444       0.0.0.0:*         users:(("node",pid=1234,fd=20),("node",pid=1240,fd=20))',
    'LISTEN 0      4096   [::]:8888          [::]:*            users:(("vite",pid=99,fd=7))',
    'LISTEN 0      128    127.0.0.1%lo:5432  0.0.0.0:*',
  ].join('\n');
  assert.deepEqual(parseSs(text), [
    { port: 4444, pid: 1234, command: 'node' },
    { port: 4444, pid: 1240, command: 'node' },
    { port: 8888, pid: 99, command: 'vite' },
    { port: 5432, pid: null, command: '' },
  ]);
});

test('netstat -ano output: listeners only, in any Windows language', () => {
  const text = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:4444           0.0.0.0:0              LISTENING       1234',
    '  TCP    [::]:8888              [::]:0                 ABHÖREN         5678',
    '  TCP    127.0.0.1:4444         127.0.0.1:52344        ESTABLISHED     9999',
    '  UDP    0.0.0.0:5353           *:*                                    2222',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(text), [
    { port: 4444, pid: 1234, command: '' },
    { port: 8888, pid: 5678, command: '' },
  ]);
});

test('tasklist CSV output', () => {
  const names = parseTasklist('"node.exe","1234","Console","1","45,000 K"\r\n"System","4","Services","0","120 K"\r\n');
  assert.equal(names.get(1234), 'node.exe');
  assert.equal(names.get(4), 'System');
});

test('never stops itself', async () => {
  const [r] = await stopProcesses([{ pid: process.pid, command: 'node', ports: [] }]);
  assert.equal(r.status, 'protected');
});

/** A throwaway TCP server in a child process; resolves to { child, port, exited }. */
function startServer() {
  const child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve({ child, port: Number(String(d).trim()), exited }));
    child.once('error', reject);
  });
}

// execFile, not spawnSync: the event loop must stay free so the killed child is reaped.
const cli = (args) =>
  new Promise((resolve) => execFile(process.execPath, [CLI, 'kill', ...args], (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));

function toolsAvailable() {
  try {
    findListeners();
    return true;
  } catch {
    return false;
  }
}

test('end to end: list, kill by port, kill by pid', { skip: !toolsAvailable() && 'no lsof/ss/netstat' }, async (t) => {
  const a = await startServer();
  const b = await startServer();
  t.after(() => [a, b].forEach((s) => s.child.exitCode === null && s.child.kill('SIGKILL')));

  const listed = await cli(['--list', String(a.port), '--json']);
  assert.equal(listed.code, 0);
  assert.deepEqual(JSON.parse(listed.stdout).listeners.map((l) => l.pid), [a.child.pid]);
  assert.equal(a.child.exitCode, null, '--list must not stop anything');

  const byPort = await cli(['--port', String(a.port), '--json']);
  assert.equal(byPort.code, 0);
  const [r] = JSON.parse(byPort.stdout).results;
  assert.equal(r.pid, a.child.pid);
  // Windows has no polite stop for console processes, so it always force-kills.
  assert.equal(r.status, process.platform === 'win32' ? 'killed' : 'stopped');
  const { sig } = await a.exited;
  if (process.platform !== 'win32') assert.equal(sig, 'SIGTERM');

  const byPid = await cli(['--pid', String(b.child.pid), '--force', '--json']);
  assert.equal(byPid.code, 0);
  const [forced] = JSON.parse(byPid.stdout).results;
  assert.deepEqual(forced.ports, [b.port]);
  assert.equal(forced.status, 'killed');
  if (process.platform !== 'win32') assert.equal((await b.exited).sig, 'SIGKILL');

  const free = await cli(['--port', String(a.port)]);
  assert.equal(free.code, 0);
  assert.match(free.stdout, /Nothing is listening/);
});
