'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTargets } = require('./targets');
const { listSkills } = require('./payload');
const { hasPersona } = require('./persona');
const { hasCodexNetwork } = require('./codex-config');
const { readBridgeConfig } = require('./bridge/config');
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

  // Informational only (D46): a user who only wants skills must still get INSTALL OK.
  const bridgeCfg = readBridgeConfig();
  let unityCli = false;
  let blender = null;
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
    bridge: { paired: Boolean(bridgeCfg), server: bridgeCfg ? bridgeCfg.server : null, unityCli, blender },
  };
}

module.exports = { doctor };
