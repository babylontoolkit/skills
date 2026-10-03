'use strict';

const { parsePortSpecs, parsePids, findListeners, processName, stopProcesses, isAlive } = require('./ports');

const USAGE = `
bt-agent kill — free ports and stop processes (macOS, Windows, Linux)

Stops whatever is listening on the given TCP ports, or the given process ids, so
a dev server can be restarted. --port matches only processes *listening* on a
port — a browser that is merely connected to your dev server is left alone. On
macOS and Linux each process is asked to exit (SIGTERM) and force-killed if it is
still running after 3 seconds; Windows always force-kills the process and its
children (taskkill /T /F).

Usage
  bt-agent kill --port <port|range> [...]    stop whatever listens on these ports
  bt-agent kill --pid <id> [...]             stop these processes
  bt-agent kill --list [port|range ...]      list listening ports (all, or just these)
  bt-agent kill --list --pid <id> [...]      list the ports these processes listen on

  4444          one port
  8000-8010     an inclusive range
  4444,8888     a list (separate arguments work too; the same for process ids)

Options
  --port          The values are ports or port ranges
  --pid           The values are process ids
  --list, -l      Show listening ports with their process id and name; stop nothing
                  (--dry-run is the same)
  --force, -9     Force-kill at once (SIGKILL) instead of asking first
  --json          Machine-readable output
  -h, --help      Show this help

Examples
  bt-agent kill --port 4444
  bt-agent kill --port 4444 8888
  bt-agent kill --port 3000-3010
  bt-agent kill --pid 51234
  bt-agent kill --pid 51234 --force
  bt-agent kill --list
  bt-agent kill --list 3000-3999
`;

const MODE_HINT = 'Say what to stop: `bt-agent kill --port 4444`, `bt-agent kill --pid 51234` or `bt-agent kill --list`';

function parseKillArgs(argv) {
  const opts = { specs: [], ports: [], pids: [], by: null, list: false, force: false, json: false, help: false };
  const setBy = (by) => {
    if (opts.by && opts.by !== by) throw new Error('Use --port or --pid, not both');
    opts.by = by;
  };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--list' || arg === '-l' || arg === '--dry-run') opts.list = true;
    else if (arg === '--force' || arg === '-9') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--port' || arg === '--pid') setBy(arg.slice(2));
    else if (arg.startsWith('--port=') || arg.startsWith('--pid=')) {
      const [flag, value] = arg.split('=');
      setBy(flag.slice(2));
      opts.specs.push(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else opts.specs.push(arg);
  }
  if (opts.help) return opts;

  if (opts.list && opts.force) throw new Error('--force stops processes; --list never does — drop one of them');

  // --list on its own filters by port, the thing it lists.
  if (!opts.by && opts.list) opts.by = 'port';
  if (!opts.by) throw new Error(opts.specs.length ? `${MODE_HINT} — is ${opts.specs[0]} a port or a process id?` : MODE_HINT);
  if (!opts.list && !opts.specs.length) {
    throw new Error(opts.by === 'port' ? '--port needs a port or range, e.g. --port 4444' : '--pid needs a process id, e.g. --pid 51234');
  }
  if (opts.by === 'port') opts.ports = parsePortSpecs(opts.specs);
  else opts.pids = parsePids(opts.specs);
  return opts;
}

function describe(r) {
  if (r.pid == null) return 'a process owned by another user';
  return `${r.command || 'process'} (pid ${r.pid})`;
}

const STATUS_TEXT = {
  stopped: 'stopped',
  killed: 'force-killed',
  'not-running': 'not running',
};

/** Unique listeners, sorted by port then pid. */
function uniqueListeners(listeners) {
  const seen = new Set();
  return listeners
    .filter((l) => {
      const key = `${l.port}/${l.pid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.port - b.port || (a.pid || 0) - (b.pid || 0));
}

function printList(rows, idle, opts, platform) {
  console.log('');
  if (!rows.length && !idle.length) {
    console.log(opts.ports.length || opts.pids.length ? 'Nothing is listening there.' : 'Nothing is listening.');
  } else {
    console.log(`  ${'PORT'.padStart(5)}  ${'PID'.padStart(7)}  PROCESS`);
    for (const l of rows) {
      const who = l.pid == null ? '(another user)' : l.command || '?';
      console.log(`  ${String(l.port).padStart(5)}  ${String(l.pid == null ? '?' : l.pid).padStart(7)}  ${who}`);
    }
    for (const p of idle) {
      console.log(`  ${'-'.padStart(5)}  ${String(p.pid).padStart(7)}  ${p.alive ? `${p.command || '?'} — no listening ports` : 'not running'}`);
    }
  }
  if (platform !== 'win32') console.log('\n(Processes owned by other users are only fully visible with sudo.)');
  console.log('');
}

function printResults(results, respawned, opts, platform) {
  const lines = [];
  for (const r of results) {
    const outcome = STATUS_TEXT[r.status] || `FAILED — ${r.error}`;
    const ports = r.ports.length ? r.ports : ['-'];
    for (const port of ports) lines.push([port === '-' ? Infinity : port, `  ${String(port).padStart(5)}  ${describe(r)}  ${outcome}`]);
  }
  for (const l of respawned) {
    lines.push([l.port, `  ${String(l.port).padStart(5)}  listening again: ${describe(l)} — a watcher or supervisor restarted it`]);
  }

  console.log('');
  if (!lines.length) {
    console.log(`Nothing is listening on ${opts.specs.join(', ')}.`);
    if (platform !== 'win32') console.log('(A process owned by another user is only visible with sudo.)');
  } else {
    for (const [, line] of lines.sort((a, b) => a[0] - b[0])) console.log(line);
  }
  console.log('');
}

/** `--list`: show listeners, kill nothing. */
function runList(opts, listeners, platform) {
  const wantedPorts = new Set(opts.ports);
  const wantedPids = new Set(opts.pids);
  const all = !opts.ports.length && !opts.pids.length;
  const rows = uniqueListeners(listeners.filter((l) => all || wantedPorts.has(l.port) || wantedPids.has(l.pid)));
  const idle = opts.pids
    .filter((pid) => !rows.some((l) => l.pid === pid))
    .map((pid) => {
      const alive = isAlive(pid);
      return { pid, alive, command: alive ? processName(pid, platform) : '' };
    });

  if (opts.json) console.log(JSON.stringify({ listeners: rows, processes: idle }, null, 2));
  else printList(rows, idle, opts, platform);
  return 0;
}

/** Entry point for `bt-agent kill`. Resolves to the process exit code. */
async function runKillCli(argv, platform = process.platform) {
  let opts;
  try {
    opts = parseKillArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\nRun \`bt-agent kill --help\` for usage.`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const listeners = findListeners(platform);
  if (opts.list) return runList(opts, listeners, platform);

  const wanted = new Set(opts.ports);
  const byPid = new Map();
  const unknown = new Set();
  const target = (pid, command) => {
    if (!byPid.has(pid)) byPid.set(pid, { pid, command, ports: [] });
    return byPid.get(pid);
  };
  for (const l of listeners) {
    if (!wanted.has(l.port)) continue;
    if (l.pid == null) unknown.add(l.port);
    else if (!target(l.pid, l.command).ports.includes(l.port)) byPid.get(l.pid).ports.push(l.port);
  }

  const missing = [];
  for (const pid of opts.pids) {
    if (byPid.has(pid)) continue;
    if (!isAlive(pid)) {
      missing.push({ pid, command: '', ports: [], status: 'not-running', error: null });
      continue;
    }
    const own = listeners.filter((l) => l.pid === pid);
    const t = target(pid, (own[0] && own[0].command) || processName(pid, platform));
    for (const l of own) if (!t.ports.includes(l.port)) t.ports.push(l.port);
  }
  for (const t of byPid.values()) t.ports.sort((a, b) => a - b);

  const results = await stopProcesses([...byPid.values()], { force: opts.force, platform });
  results.push(...missing);
  for (const port of unknown) {
    results.push({ pid: null, command: '', ports: [port], status: 'failed', error: 'owned by another user — retry with sudo' });
  }

  // A dev server run under a watcher (nodemon, pm2, a supervisor) can come straight back.
  let respawned = [];
  const freed = new Set(results.filter((r) => r.status === 'stopped' || r.status === 'killed').flatMap((r) => r.ports));
  if (freed.size) {
    respawned = uniqueListeners(findListeners(platform).filter((l) => freed.has(l.port) && !byPid.has(l.pid)));
  }

  if (opts.json) {
    console.log(JSON.stringify({ ports: opts.specs, pids: opts.pids, results, respawned }, null, 2));
  } else {
    printResults(results, respawned, opts, platform);
  }

  const failed = results.some((r) => r.status === 'failed' || r.status === 'protected');
  return failed || respawned.length ? 1 : 0;
}

module.exports = { runKillCli, parseKillArgs };
