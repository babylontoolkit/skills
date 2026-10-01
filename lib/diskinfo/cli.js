'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReport, formatReport, human } = require('./report');
const { prettyPath } = require('../paths');

const USAGE = `
bt-agent diskinfo — show where your disk space is going (macOS, Windows, Linux)

Read-only: it walks your home folder and the main system folders once, then prints
the biggest folders, known space hogs (Unity, Xcode, package caches, Docker ...),
node_modules and Unity/Unreal folders that rebuild themselves, the largest files,
and suggested cleanup commands. Nothing is deleted or run.

Usage
  bt-agent diskinfo [options]

Options
  --out <file>   Save the report here (default: Desktop/disk-report-YYYY-MM-DD-HHMM.txt)
  --no-save      Print only; do not save a copy
  --json         Machine-readable output on stdout (saved only with --out)
  -h, --help     Show this help
`;

function parseDiskInfoArgs(argv) {
  const opts = { json: false, save: true, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-save') opts.save = false;
    else if (arg === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Error('--out needs a file path');
    } else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function defaultReportPath(date = new Date()) {
  const desktop = path.join(os.homedir(), 'Desktop');
  const dir = fs.existsSync(desktop) ? desktop : os.homedir();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return path.join(dir, `disk-report-${stamp}.txt`);
}

/** One updating status line on stderr, only when a person is watching. */
function progressLine(enabled) {
  if (!enabled) return { stage() {}, progress() {}, done() {} };
  const width = () => Math.max(40, (process.stderr.columns || 100) - 1);
  let current = '';
  const draw = (text) => process.stderr.write(`\r${text.slice(0, width()).padEnd(width())}`);
  return {
    stage(msg) {
      current = msg;
      draw(`  scanning ${msg} ...`);
    },
    progress(p) {
      draw(`  scanning ${current} — ${p.files.toLocaleString()} files, ${human(p.bytes)} — ${prettyPath(p.dir)}`);
    },
    done() {
      process.stderr.write(`\r${' '.repeat(width())}\r`);
    },
  };
}

/** Entry point for `bt-agent diskinfo`. Resolves to the process exit code. */
async function runDiskInfoCli(argv) {
  let opts;
  try {
    opts = parseDiskInfoArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\nRun \`bt-agent diskinfo --help\` for usage.`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const ui = progressLine(!opts.json && process.stderr.isTTY);
  if (!opts.json) console.error('Scanning disk usage — this can take a few minutes on a full disk.');

  const report = await buildReport({ onStage: ui.stage, onProgress: ui.progress });
  ui.done();

  const text = opts.json ? JSON.stringify(report, null, 2) : formatReport(report);
  console.log(text);

  const out = opts.out || (opts.save && !opts.json ? defaultReportPath() : null);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text + '\n');
    if (!opts.json) console.error(`Report saved to ${prettyPath(path.resolve(out))}`);
  }
  return 0;
}

module.exports = { runDiskInfoCli, parseDiskInfoArgs, defaultReportPath };
