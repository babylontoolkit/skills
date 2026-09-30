'use strict';

const nodeFs = require('fs');
const path = require('path');

/**
 * Terminal output for `bt-agent bridge`. Colour only on a TTY, so piped/logged output stays plain.
 *
 * The start-at-login service (D55) has no terminal: `toFile()` sends every line to
 * `~/.babylon-toolkit/bridge.log` instead, time-stamped, and rotates it at 5 MB to `bridge.log.1`.
 */

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** @type {{ file: string, maxBytes: number, fs: typeof nodeFs, now: () => Date }|null} */
let sink = null;

/**
 * Appends one line to a size-capped log: when the file has reached `maxBytes` it becomes `<file>.1`
 * (replacing the previous one) and a new file is started. Never throws — a log must not stop the bridge.
 * @param {{ file: string, line: string, maxBytes?: number, fs?: typeof nodeFs }} opts
 */
function appendLogLine({ file, line, maxBytes = LOG_MAX_BYTES, fs = nodeFs }) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size >= maxBytes) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // nowhere left to report it
  }
}

/**
 * Sends all bridge output to `file` from now on.
 * @param {string} file
 * @param {{ maxBytes?: number, fs?: typeof nodeFs, now?: () => Date }} [opts]
 */
function toFile(file, opts = {}) {
  sink = { file, maxBytes: opts.maxBytes || LOG_MAX_BYTES, fs: opts.fs || nodeFs, now: opts.now || (() => new Date()) };
}

/** Back to the terminal (tests). */
function toConsole() {
  sink = null;
}

/** @param {string} level @param {string} text */
function write(level, text) {
  if (!sink) return false;
  const stamp = sink.now().toISOString();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    appendLogLine({ file: sink.file, line: `${stamp} ${level} ${line}`, maxBytes: sink.maxBytes, fs: sink.fs });
  }
  return true;
}

/** @param {string} code @param {string} text */
function paint(code, text) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** @param {string} msg */
function info(msg) {
  if (write('info ', msg)) return;
  console.log(msg);
}

/**
 * One line per operation the bridge runs: `▶ [<tier>] <label>`.
 * @param {string} tier
 * @param {string} label
 */
function op(tier, label) {
  if (write('op   ', `[${tier}] ${label}`)) return;
  console.log(`${paint('36', '▶')} ${paint('2', `[${tier}]`)} ${label}`);
}

/** @param {string} msg */
function error(msg) {
  if (write('error', msg)) return;
  console.error(process.stderr.isTTY ? `\x1b[31m${msg}\x1b[0m` : msg);
}

/** @param {string[]} lines */
function box(lines) {
  if (write('info ', lines.join('\n'))) return;
  const width = Math.max(...lines.map((l) => l.length));
  const bar = '─'.repeat(width + 2);
  const out = [`┌${bar}┐`, ...lines.map((l) => `│ ${l.padEnd(width)} │`), `└${bar}┘`];
  console.log(paint('1', out.join('\n')));
}

module.exports = { info, op, error, box, toFile, toConsole, appendLogLine, LOG_MAX_BYTES };
