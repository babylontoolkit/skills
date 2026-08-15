'use strict';

const fs = require('fs');
const path = require('path');

const { personaFile } = require('./paths');

const BEGIN = '<!-- BEGIN BABYLON TOOLKIT PERSONA v1 -->';
const END = '<!-- END BABYLON TOOLKIT PERSONA -->';

/** Present in every persona ever installed, including pre-marker (legacy) ones. */
const LEGACY_SENTINEL = 'babylontoolkit/agent/main/reference.md';
const LEGACY_HEADING = '# Babylon Toolkit Agent Persona';

function personaText() {
  return fs.readFileSync(personaFile(), 'utf8').trim();
}

function renderBlock(text, eol) {
  return [BEGIN, text, END, ''].join('\n').replace(/\n/g, eol);
}

function detectEol(content) {
  return content && content.includes('\r\n') ? '\r\n' : '\n';
}

/** Join the block to whatever follows it, keeping exactly one blank line between. */
function joinAfterBlock(block, rest, eol) {
  if (!rest || rest.trim() === '') return block;
  return block + eol + rest.replace(/^[\r\n]+/, '');
}

/**
 * Locate a legacy (pre-marker) persona: the heading through the `---` rule that
 * closes it. Returns null when the region cannot be identified confidently — a
 * user who reworded the block gets left alone rather than mangled.
 */
function findLegacyRegion(content) {
  const start = content.indexOf(LEGACY_HEADING);
  if (start === -1) return null;

  const rule = /^-{3,}[ \t]*$/m;
  const after = content.slice(start + LEGACY_HEADING.length);
  const m = rule.exec(after);
  if (!m) return null;

  let end = start + LEGACY_HEADING.length + m.index + m[0].length;
  // Swallow the newline(s) that terminate the rule so we don't leave a blank gap.
  while (end < content.length && (content[end] === '\r' || content[end] === '\n')) end += 1;

  // Sanity check: the sentinel must live inside the region we are about to replace.
  if (!content.slice(start, end).includes(LEGACY_SENTINEL)) return null;
  return { start, end };
}

function backup(file) {
  const dest = `${file}.bak`;
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * Install / refresh the Agent Persona in one instruction file.
 *
 * Exactly one outcome per file:
 *   created   — file did not exist
 *   updated   — managed block found, contents refreshed in place
 *   unchanged — managed block already matches
 *   migrated  — legacy unmarked persona converted to a managed block
 *   prepended — no persona present, block added at the top
 *   legacy-unrecognized — persona present but reworded; left untouched
 *
 * Existing content is never truncated, and any modified file is backed up first.
 */
function applyPersona(file, { text = personaText(), dryRun = false, migrate = true } = {}) {
  const exists = fs.existsSync(file);

  if (!exists) {
    const block = renderBlock(text, '\n');
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, block, 'utf8');
    }
    return { file, action: 'created' };
  }

  const content = fs.readFileSync(file, 'utf8');
  const eol = detectEol(content);
  const block = renderBlock(text, eol);

  const b = content.indexOf(BEGIN);
  const e = content.indexOf(END);

  if (b !== -1 && e !== -1 && e > b) {
    const endOfBlock = e + END.length;
    const current = content.slice(b, endOfBlock);
    const desired = [BEGIN, text, END].join('\n').replace(/\n/g, eol);
    if (current === desired) return { file, action: 'unchanged' };

    const next = content.slice(0, b) + desired + content.slice(endOfBlock);
    let bak = null;
    if (!dryRun) {
      bak = backup(file);
      fs.writeFileSync(file, next, 'utf8');
    }
    return { file, action: 'updated', backup: bak };
  }

  if (content.includes(LEGACY_SENTINEL)) {
    if (!migrate) return { file, action: 'unchanged', note: 'legacy persona left in place (--no-migrate)' };

    const region = findLegacyRegion(content);
    if (!region) {
      return {
        file,
        action: 'legacy-unrecognized',
        note: 'persona present but reworded — left untouched to avoid clobbering your edits',
      };
    }

    const next = content.slice(0, region.start) + joinAfterBlock(block, content.slice(region.end), eol);
    let bak = null;
    if (!dryRun) {
      bak = backup(file);
      fs.writeFileSync(file, next, 'utf8');
    }
    return { file, action: 'migrated', backup: bak };
  }

  const next = joinAfterBlock(block, content, eol);
  let bak = null;
  if (!dryRun) {
    bak = backup(file);
    fs.writeFileSync(file, next, 'utf8');
  }
  return { file, action: 'prepended', backup: bak };
}

/** Strip the managed block (used by uninstall). Legacy blocks are left alone. */
function removePersona(file, { dryRun = false } = {}) {
  if (!fs.existsSync(file)) return { file, action: 'absent' };
  const content = fs.readFileSync(file, 'utf8');
  const b = content.indexOf(BEGIN);
  const e = content.indexOf(END);
  if (b === -1 || e === -1 || e < b) return { file, action: 'absent' };

  let endOfBlock = e + END.length;
  while (endOfBlock < content.length && (content[endOfBlock] === '\r' || content[endOfBlock] === '\n')) endOfBlock += 1;

  const next = (content.slice(0, b) + content.slice(endOfBlock)).replace(/^\s+/, '');
  let bak = null;
  if (!dryRun) {
    bak = backup(file);
    if (next.trim() === '') fs.unlinkSync(file);
    else fs.writeFileSync(file, next, 'utf8');
  }
  return { file, action: next.trim() === '' ? 'file-removed' : 'removed', backup: bak };
}

/** True when the file carries the persona in any form (managed or legacy). */
function hasPersona(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(LEGACY_SENTINEL);
  } catch {
    return false;
  }
}

module.exports = {
  BEGIN,
  END,
  LEGACY_SENTINEL,
  personaText,
  applyPersona,
  removePersona,
  hasPersona,
};
