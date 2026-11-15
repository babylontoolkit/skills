'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReport, formatReport, human } = require('./report');
const { prettyPath, expandHome } = require('../paths');

const USAGE = `
bt-agent diskinfo — show where your disk space is going (macOS, Windows, Linux)

Read-only: it walks your home folder and the main system folders once, then prints
the biggest folders, known space hogs (Unity, Xcode, package caches, Docker ...),
node_modules and Unity/Unreal folders that rebuild themselves, the largest files,
and suggested cleanup commands. Nothing is deleted or run. With --folder it walks
only that folder (and reports only what lies inside it).

Usage
  bt-agent diskinfo [options]

Examples
  bt-agent diskinfo
  bt-agent diskinfo --folder ~/Documents/Repos
  bt-agent diskinfo --folder D:\\Projects --no-save

Options
  --folder <dir> Scan only this folder instead of your home folder and the system folders
  --out <file>   Save the report here (default: Desktop/disk-report-YYYY-MM-DD-HHMM.txt)
  --no-save      Print only; do not save a copy
  --json         Machine-readable output on stdout (saved only with --out)
  -h, --help     Show this help
`;

function parseDiskInfoArgs(argv) {
  const opts = { json: false, save: true, out: null, folder: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-save') opts.save = false;
    else if (arg === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Error('--out needs a file path');
    } else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else if (arg === '--folder') {
      opts.folder = argv[++i];
      if (!opts.folder) throw new Error('--folder needs a folder path');
    } else if (arg.startsWith('--folder=')) {
      opts.folder = arg.slice('--folder='.length);
      if (!opts.folder) throw new Error('--folder needs a folder path');
    }
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

/** Expand ~, resolve against the working directory, and require an existing folder. */
function resolveFolder(folder) {
  const resolved = path.resolve(expandHome(folder));
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`--folder: ${resolved} does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`--folder: ${resolved} is not a folder`);
  return resolved;
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
    if (opts.folder && !opts.help) opts.folder = resolveFolder(opts.folder);
  } catch (err) {
    console.error(`${err.message}\n\nRun \`bt-agent diskinfo --help\` for usage.`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const ui = progressLine(!opts.json && process.stderr.isTTY);
  if (!opts.json) {
    console.error(
      opts.folder
        ? `Scanning disk usage in ${prettyPath(opts.folder)} — this can take a while on a big folder.`
        : 'Scanning disk usage — this can take a few minutes on a full disk.'
    );
  }

  const report = await buildReport({ folder: opts.folder, onStage: ui.stage, onProgress: ui.progress });
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

module.exports = { runDiskInfoCli, parseDiskInfoArgs, resolveFolder, defaultReportPath };
