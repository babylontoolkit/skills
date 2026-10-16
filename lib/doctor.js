'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTargets } = require('./targets');
const { listSkills } = require('./payload');
const { hasPersona } = require('./persona');
const { hasCodexNetwork } = require('./codex-config');
const { hasAllowRule } = require('./claude-settings');
const reference = require('./reference');
const { resolveTargetPath } = require('./paths');
const { readSettings } = require('./bridge/config');
const { serviceStatus, hostDeps } = require('./bridge/service');
const { discoverUnity } = require('./bridge/unity/discover');
const { discoverBlender } = require('./bridge/blender/discover');

/**
 * Verify an install.
 *
 * Payload-driven on purpose: it checks every file of every skill this package
 * ships, in every target directory. A hardcoded skill list silently stops
 * verifying skills added later — that is exactly how `bt-gauntlet` shipped
 * unverified while the checker still reported success.
 */
function doctor(opts = {}) {
  const {
    mode = 'global',
    projectRoot = process.cwd(),
    ids = null,
    legacyCodex = false,
    persona = true,
    skills: checkSkills = true,
    checkRemote = false,
  } = opts;

  const resolved = resolveTargets({ mode, projectRoot, ids, legacyCodex });
  const skills = checkSkills ? listSkills() : [];
  const missing = [];

  for (const { dir } of checkSkills ? resolved.skillDirs : []) {
    for (const skill of skills) {
      for (const rel of skill.files) {
        const target = path.join(dir, skill.name, ...rel.split('/'));
        if (!fs.existsSync(target)) missing.push(target);
      }
    }
  }

  if (persona) {
    for (const { file } of resolved.instructionFiles) {
      if (!hasPersona(file)) missing.push(`${file} (persona)`);
    }
  }

  for (const { file } of resolved.configFiles) {
    if (!hasCodexNetwork(file)) missing.push(`${file} (sandbox_workspace_write.network_access = true)`);
  }

  const referenceReport = checkReference({ mode, projectRoot, resolved, skills, checkSkills, checkRemote });

  // Informational only (D46): a user who only wants skills must still get INSTALL OK.
  const { servers } = readSettings();
  let unityCli = false;
  let blender = null;
  /** @type {{ installed: boolean, running: boolean|null }} */
  let svc = { installed: false, running: null };
  try {
    const st = serviceStatus(opts.serviceDeps || hostDeps());
    svc = { installed: st.installed, running: st.running };
  } catch {
    // informational only — never affects ok
  }
  try {
    unityCli = Boolean(discoverUnity({ cwd: process.cwd() }).cli);
    const found = discoverBlender({});
    blender = found ? found.version : null;
  } catch {
    // informational only — never affects ok
  }

  return {
    ok: missing.length === 0,
    missing,
    checked: {
      skills: skills.length,
      files: skills.reduce((n, s) => n + s.files.length, 0),
      skillDirs: checkSkills ? resolved.skillDirs.map((d) => d.dir) : [],
      instructionFiles: resolved.instructionFiles.map((f) => f.file),
      configFiles: resolved.configFiles.map((f) => f.file),
    },
    reference: referenceReport,
    bridge: {
      paired: servers.length > 0,
      server: servers.length ? servers[0].server : null,
      servers: servers.map((c) => c.server),
      service: svc.installed ? 'installed' : 'not installed',
      serviceRunning: svc.running,
      unityCli,
      blender,
    },
  };
}

/**
 * The local Agent Reference — informational, never part of `ok`: without it agents read the Reference
 * from GitHub. Reports the copy, every local link that does not resolve, a missing Claude Code allow
 * rule, and (for `bt-agent doctor`) whether GitHub has moved on since the copy was made.
 */
function checkReference({ mode, projectRoot, resolved, skills, checkSkills, checkRemote }) {
  const dir = reference.referenceDir(mode, projectRoot);
  const metadata = reference.readMetadata(dir);
  if (!metadata || !reference.isUsable(dir)) {
    return { dir, present: false, warnings: ['not installed — agents read the Agent Reference from GitHub; run `bt-agent update`'] };
  }
  const folders = [dir, ...(checkSkills ? resolved.skillDirs.flatMap(({ dir: skillsDir }) => skills.map((skill) => path.join(skillsDir, skill.name))) : [])];
  const links = reference.checkLinks(dir, folders);
  const warnings = links.broken.map((entry) => `broken link: ${entry}`);

  const claude = resolved.selected.find((target) => target.id === 'claude');
  if (claude && mode === 'global') {
    const settingsFile = path.join(path.dirname(resolveTargetPath(claude.global.instructions, mode, projectRoot)), 'settings.json');
    if (!hasAllowRule(settingsFile, reference.CLAUDE_READ_RULE)) warnings.push(`${settingsFile} has no ${reference.CLAUDE_READ_RULE} — Claude Code will ask before each read`);
  }

  let latest = null;
  if (checkRemote && metadata.commit) {
    latest = reference.latestCommit();
    if (latest && latest !== metadata.commit) warnings.push(`GitHub has a newer Agent Reference (${latest.slice(0, 7)}) — run \`bt-agent update\``);
  }
  return { dir, present: true, commit: metadata.commit, installedAt: metadata.installedAt, files: metadata.files, links, latest, warnings };
}

module.exports = { doctor };
