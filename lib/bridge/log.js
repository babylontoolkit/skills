'use strict';

/** Terminal output for `bt-agent bridge`. Colour only on a TTY, so piped/logged output stays plain. */

/** @param {string} code @param {string} text */
function paint(code, text) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** @param {string} msg */
function info(msg) {
  console.log(msg);
}

/**
 * One line per operation the bridge runs: `▶ [<tier>] <label>`.
 * @param {string} tier
 * @param {string} label
 */
function op(tier, label) {
  console.log(`${paint('36', '▶')} ${paint('2', `[${tier}]`)} ${label}`);
}

/** @param {string} msg */
function error(msg) {
  console.error(process.stderr.isTTY ? `\x1b[31m${msg}\x1b[0m` : msg);
}

/** @param {string[]} lines */
function box(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const bar = '─'.repeat(width + 2);
  const out = [`┌${bar}┐`, ...lines.map((l) => `│ ${l.padEnd(width)} │`), `└${bar}┘`];
  console.log(paint('1', out.join('\n')));
}

module.exports = { info, op, error, box };
