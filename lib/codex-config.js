'use strict';

const fs = require('fs');
const path = require('path');
const { PACKAGE_ROOT } = require('./paths');

const KEY = '(?:network_access|"network_access"|\'network_access\')';
const TABLE = '(?:sandbox_workspace_write|"sandbox_workspace_write"|\'sandbox_workspace_write\')';
const header = new RegExp(`^\\s*\\[\\s*${TABLE}\\s*\\]\\s*(?:#.*)?$`);
const setting = new RegExp(`^(\\s*${KEY}\\s*=\\s*)(true|false)(\\s*(?:#.*)?)$`);
const dotted = new RegExp(`^(\\s*${TABLE}\\s*\\.\\s*${KEY}\\s*=\\s*)(true|false)(\\s*(?:#.*)?)$`);

/** Ignore apparent settings inside TOML strings (including multiline strings). */
function codeLines(lines) {
  let quote = null;
  return lines.map((line) => {
    const startsInString = quote !== null;
    let code = '';
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quote) {
        if (quote[0] === '"' && c === '\\') { i += 1; continue; }
        if (line.startsWith(quote, i)) {
          let end = i + quote.length;
          // A multiline TOML string may end in four or five quotes.
          if (quote.length === 3) while (end < i + 5 && line[end] === quote[0]) end += 1;
          i = end - 1;
          quote = null;
        }
      } else if (c === '#') {
        break;
      } else if (c === '"' || c === "'") {
        quote = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        i += quote.length - 1;
      } else {
        code += c;
      }
    }
    return startsInString ? '' : code.trim();
  });
}

/** Change only this boolean; keep comments, other settings and line endings. */
function enableNetwork(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const code = codeLines(lines);
  let inTable = false;
  let root = true;
  let tableLine = -1;
  let rootDottedSibling = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!code[i]) continue;
    if (code[i].startsWith('[')) {
      root = false;
      inTable = header.test(lines[i]);
      if (inTable) tableLine = i;
      continue;
    }
    const match = (inTable ? setting : root ? dotted : /$^/).exec(lines[i]);
    if (match) {
      lines[i] = `${match[1]}true${match[3]}`;
      return lines.join(eol);
    }
    if (root && new RegExp(`^\\s*${TABLE}\\s*\\.`).test(lines[i])) rootDottedSibling = true;
    // Do not create duplicate TOML keys for an unsupported representation.
    if ((root && new RegExp(`^\\s*${TABLE}\\s*=`).test(lines[i])) ||
        (inTable && new RegExp(`^\\s*${KEY}\\s*=`).test(lines[i])) ||
        (root && new RegExp(`^\\s*${TABLE}\\s*\\.\\s*${KEY}\\s*=`).test(lines[i]))) {
      throw new Error('Cannot safely merge Codex network_access. Use [sandbox_workspace_write] with network_access = true or false.');
    }
  }
  if (tableLine !== -1) {
    lines.splice(tableLine + 1, 0, 'network_access = true');
    return lines.join(eol);
  }
  // Dotted sibling keys define the table already; extend it at the root.
  if (rootDottedSibling) {
    return `sandbox_workspace_write.network_access = true${eol}${source}`;
  }
  const template = fs.readFileSync(path.join(PACKAGE_ROOT, '.codex', 'config.toml'), 'utf8').replace(/\r?\n/g, eol);
  return source + (source && !source.endsWith('\n') ? eol : '') + (source ? eol : '') + template;
}

function applyCodexConfig(file, { dryRun = false } = {}) {
  const exists = fs.existsSync(file);
  const source = exists ? fs.readFileSync(file, 'utf8') : '';
  const next = enableNetwork(source);
  const action = !exists ? 'created' : next === source ? 'unchanged' : 'updated';
  const backup = action === 'updated' ? `${file}.bak` : undefined;
  if (!dryRun && action !== 'unchanged') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (backup) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, next, 'utf8');
  }
  return { file, action, ...(backup ? { backup } : {}) };
}

function hasCodexNetwork(file) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    return enableNetwork(source) === source;
  } catch {
    return false;
  }
}

module.exports = { enableNetwork, applyCodexConfig, hasCodexNetwork };
