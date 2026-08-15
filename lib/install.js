'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTargets } = require('./targets');
const { listSkills, copyDir } = require('./payload');
const { applyPersona, removePersona, personaText } = require('./persona');
const manifest = require('./manifest');
const { manifestPath } = require('./paths');

const { version } = require('../package.json');

/**
 * Copy every shipped skill into every target skills directory, refresh the Agent
 * Persona in every target instruction file, and record the result.
 *
 * Each skill folder is replaced wholesale (delete-then-copy) so files removed
 * upstream do not linger, but only folder names this package ships are ever
 * deleted — a user's own `bt-*` skill is untouched.
 */
function install(opts = {}) {
  const {
    mode = 'global',
    projectRoot = process.cwd(),
    ids = null,
    legacyCodex = false,
    persona = true,
    skills: installSkills = true,
    migrate = true,
    dryRun = false,
    prune = true,
  } = opts;

  if (!installSkills && !persona) {
    throw new Error('--persona-only and --no-persona cannot be combined — nothing would be installed.');
  }

  const resolved = resolveTargets({ mode, projectRoot, ids, legacyCodex });
  const skills = installSkills ? listSkills() : [];
  const previous = manifest.read(mode, projectRoot);

  const report = {
    version,
    mode,
    dryRun,
    skillsInstalled: installSkills,
    skills: skills.map((s) => s.name),
    skillDirs: [],
    persona: [],
    pruned: [],
    manifest: manifestPath(mode, projectRoot),
  };

  for (const { dir, targets } of installSkills ? resolved.skillDirs : []) {
    if (!dryRun) fs.mkdirSync(dir, { recursive: true });

    for (const skill of skills) {
      const dest = path.join(dir, skill.name);
      if (!dryRun) {
        fs.rmSync(dest, { recursive: true, force: true });
        copyDir(skill.src, dest);
      }
    }

    // Remove skills we installed previously that this version no longer ships.
    if (prune) {
      const shipped = new Set(skills.map((s) => s.name));
      for (const stale of manifest.trackedSkills(previous, dir).filter((n) => !shipped.has(n))) {
        const dest = path.join(dir, stale);
        if (fs.existsSync(dest)) {
          if (!dryRun) fs.rmSync(dest, { recursive: true, force: true });
          report.pruned.push(dest);
        }
      }
    }

    report.skillDirs.push({ dir, targets, skills: skills.map((s) => s.name) });
  }

  if (persona) {
    const text = personaText();
    for (const { file, targets } of resolved.instructionFiles) {
      const result = applyPersona(file, { text, dryRun, migrate });
      report.persona.push({ ...result, targets });
    }
  }

  if (!dryRun) {
    // A persona-only run must not erase the record of previously installed skills,
    // or a later uninstall would leave them orphaned on disk.
    const skillDirs = installSkills ? report.skillDirs : (previous && previous.skillDirs) || [];

    manifest.write(mode, projectRoot, {
      version,
      installedAt: new Date().toISOString(),
      mode,
      projectRoot: mode === 'project' ? projectRoot : undefined,
      skillDirs,
      persona: report.persona.map(({ file, action }) => ({ file, action })),
    });
  }

  return report;
}

/**
 * Remove the skills this package installed, plus the managed persona block.
 * Manifest-scoped: anything the manifest does not list is left alone.
 */
function uninstall(opts = {}) {
  const { mode = 'global', projectRoot = process.cwd(), dryRun = false, persona = true } = opts;

  const previous = manifest.read(mode, projectRoot);
  const report = { mode, dryRun, removed: [], persona: [], manifestFound: Boolean(previous) };

  if (!previous) return report;

  for (const { dir, skills } of previous.skillDirs || []) {
    for (const name of skills) {
      const dest = path.join(dir, name);
      if (fs.existsSync(dest)) {
        if (!dryRun) fs.rmSync(dest, { recursive: true, force: true });
        report.removed.push(dest);
      }
    }
    // Drop the skills directory only if we emptied it.
    try {
      if (!dryRun && fs.readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0) fs.rmdirSync(dir);
    } catch {
      /* directory not empty or not ours to remove */
    }
  }

  if (persona) {
    for (const entry of previous.persona || []) {
      report.persona.push(removePersona(entry.file, { dryRun }));
    }
  }

  if (!dryRun) manifest.remove(mode, projectRoot);
  return report;
}

module.exports = { install, uninstall };
