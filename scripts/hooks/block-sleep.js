#!/usr/bin/env node
'use strict';

/**
 * Claude Code `PreToolUse` hook on `Bash`: blocks a shell command that sleeps for 3 seconds or more and
 * tells the agent to wait on the condition with `wait.mjs` instead. A blind `sleep 30` (alone, chained,
 * or inside an `until` / `while` / `for` poll loop) is the slowest way to wait: it always costs the full
 * time, even when the server, file or log line was ready a second in.
 *
 * Contract (Claude Code hooks): the tool call arrives as JSON on stdin —
 * `{ "tool_name": "Bash", "tool_input": { "command": "…" } }`. Exit code 2 blocks the call and shows
 * stderr to the agent; exit code 0 lets it run. Anything this hook cannot read exits 0 silently, so a
 * broken hook never blocks work.
 *
 * `sleep` counts only as a command word — at the start of the command or right after `;`, `&&`, `||`,
 * `|`, `&`, `(`, `{`, `$(`, a backtick, a newline, or the keywords `do` / `then` / `else` — so
 * `grep "sleep 30" notes.md` and `node wait.mjs …` are not blocked.
 */

const fs = require('fs');

/** Sleeps of this many seconds or more are blocked; shorter pauses are allowed. */
const MINIMUM_BLOCKED_SECONDS = 3;

/** Exit code that tells Claude Code to block the tool call and show stderr to the agent. */
const BLOCK_EXIT_CODE = 2;

/** Seconds per GNU `sleep` unit suffix; no suffix means seconds. */
const SECONDS_PER_UNIT = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/**
 * `sleep` in command position, with its arguments up to the next shell separator. The argument text is
 * capture group 1.
 */
const SLEEP_COMMAND_PATTERN = /(?:^|[;&|({\n`]|\b(?:do|then|else)\s)\s*(?:[\w./-]*\/)?sleep\s+([^;&|(){}\n`]*)/g;

/** One `sleep` duration: a whole or decimal number with an optional `s` / `m` / `h` / `d` suffix. */
const DURATION_PATTERN = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/;

/** The installed wait helper, as the agent should run it. */
const WAIT_SCRIPT = 'node ~/.claude/toolkit/reference/references/scripts/wait.mjs';

/**
 * Seconds one `sleep` argument stands for.
 * @param {string} argument - One word after `sleep`, e.g. `30`, `3.5`, `5s`, `1m`, `infinity`.
 * @returns {number|null} Seconds (Infinity for `infinity`), or null when the word is not a duration
 *   (an option, a redirect, a `$VARIABLE` whose value cannot be known).
 */
function argumentSeconds(argument) {
  if (argument === 'infinity') return Infinity;
  const match = DURATION_PATTERN.exec(argument);
  if (!match) return null;
  const [, amount, unit] = match;
  return Number(amount) * SECONDS_PER_UNIT[unit];
}

/**
 * Total seconds one `sleep` invocation waits. GNU `sleep` adds up several durations (`sleep 1 2` is
 * 3 seconds), so the words are summed until the first one that is not a duration.
 * @param {string} argumentText - Everything after `sleep` up to the next shell separator.
 * @returns {number} Seconds; 0 when no duration can be read.
 */
function invocationSeconds(argumentText) {
  let total = 0;
  for (const argument of argumentText.trim().split(/\s+/)) {
    const seconds = argumentSeconds(argument);
    if (seconds === null) break;
    total += seconds;
  }
  return total;
}

/**
 * The longest single `sleep` a shell command runs.
 * @param {string} command - The shell command a Bash tool call would run.
 * @returns {number} Seconds of the longest `sleep` in command position; 0 when there is none.
 */
function longestSleepSeconds(command) {
  if (typeof command !== 'string') return 0;
  let longest = 0;
  for (const match of command.matchAll(SLEEP_COMMAND_PATTERN)) {
    longest = Math.max(longest, invocationSeconds(match[1]));
  }
  return longest;
}

/**
 * Whether the hook blocks this command.
 * @param {string} command - The shell command a Bash tool call would run.
 * @returns {boolean} True when it runs `sleep` for {@link MINIMUM_BLOCKED_SECONDS} seconds or more.
 */
function isBlockedSleep(command) {
  return longestSleepSeconds(command) >= MINIMUM_BLOCKED_SECONDS;
}

/**
 * The message the agent sees when a command is blocked: why, and the `wait.mjs` call for each kind of wait.
 * @param {number} seconds - The blocked sleep's length in seconds.
 * @returns {string} Multi-line stderr text ending in a newline.
 */
function blockMessage(seconds) {
  const length = Number.isFinite(seconds) ? `${seconds}s` : 'an endless';
  return [
    `Blocked: a ${length} shell sleep waits blind. Wait on the condition with wait.mjs instead (it polls inside Node,`,
    'exits 0 as soon as the condition holds and 1 with a reason on timeout):',
    `  ${WAIT_SCRIPT} port <n> --timeout <s>`,
    `  ${WAIT_SCRIPT} url <url> [--status 200] --timeout <s>`,
    `  ${WAIT_SCRIPT} file <path> --timeout <s>`,
    `  ${WAIT_SCRIPT} log <path> <regex> --timeout <s>`,
    `  ${WAIT_SCRIPT} cmd "<command>" --match <regex> [--fail <regex>] [--interval <s>] --timeout <s>`,
    `Long-running commands: run them in the foreground with a generous timeout. Pauses under ${MINIMUM_BLOCKED_SECONDS}s are allowed.`,
    '',
  ].join('\n');
}

/**
 * Entry point: read the tool call from stdin and block a long sleep. Unreadable input exits 0.
 * @returns {void} Sets `process.exitCode` (never calls `process.exit`, so stderr is flushed first).
 */
function main() {
  let toolCall;
  try {
    toolCall = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!toolCall || typeof toolCall !== 'object') return;
  if (toolCall.tool_name !== undefined && toolCall.tool_name !== 'Bash') return;
  const command = toolCall.tool_input && toolCall.tool_input.command;
  const seconds = longestSleepSeconds(command);
  if (seconds < MINIMUM_BLOCKED_SECONDS) return;
  process.stderr.write(blockMessage(seconds));
  process.exitCode = BLOCK_EXIT_CODE;
}

if (require.main === module) main();

module.exports = { MINIMUM_BLOCKED_SECONDS, BLOCK_EXIT_CODE, longestSleepSeconds, isBlockedSleep, blockMessage };
