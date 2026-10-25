'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTargets } = require('./targets');
const { listSkills, copyDir } = require('./payload');
const { applyPersona, removePersona, personaText } = require('./persona');
const { applyCodexConfig } = require('./codex-config');
const { addAllowRule, removeAllowRule, blockSleepHook, addHook, removeHook } = require('./claude-settings');
const reference = require('./reference');
const manifest = require('./manifest');
const { manifestPath, resolveTargetPath } = require('./paths');

const { version } = require('../package.json');

/**
 * Copy every shipped skill into every target skills directory, refresh the Agent
 * Persona in every target instruction file, and record the result.
 *
 * With skills, the Agent Reference is downloaded into `~/.claude/toolkit/reference/` (see
 * reference.js) and the installed skills and the persona point at that local copy. Without a
 * usable copy they keep the GitHub addresses, so agents still work.
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
    reference: installLocalReference = true,
    referenceFrom = null,
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
    config: [],
    pruned: [],
    reference: null,
    permissions: [],
    hooks: [],
    manifest: manifestPath(mode, projectRoot),
  };

  // The Reference first: the skills and persona written below point at it only when it is usable.
  const referenceDir = reference.referenceDir(mode, projectRoot);
  if (installLocalReference && installSkills) {
    report.reference = reference.installReference({ mode, projectRoot, from: referenceFrom, dryRun });
  } else if (installLocalReference && reference.isUsable(referenceDir)) {
    report.reference = { dir: referenceDir, status: 'unchanged', ...reference.readMetadata(referenceDir) };
  }
  const localReference = installLocalReference && !dryRun && reference.isUsable(referenceDir) ? referenceDir : null;

  // Preflight every merge before changing installed skills or instructions.
  for (const { file } of resolved.configFiles) applyCodexConfig(file, { dryRun: true });
  for (const { file, targets } of resolved.configFiles) {
    report.config.push({ ...applyCodexConfig(file, { dryRun }), targets });
  }

  for (const { dir, targets } of installSkills ? resolved.skillDirs : []) {
    if (!dryRun) fs.mkdirSync(dir, { recursive: true });

    for (const skill of skills) {
      const dest = path.join(dir, skill.name);
      if (!dryRun) {
        fs.rmSync(dest, { recursive: true, force: true });
        copyDir(skill.src, dest);
        if (localReference) reference.rewriteFolder(dest, localReference);
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

  if (report.reference) {
    report.reference.links = localReference
      ? reference.checkLinks(localReference, [localReference, ...report.skillDirs.flatMap(({ dir }) => report.skills.map((name) => path.join(dir, name)))])
      : null;
  }

  // Claude Code asks before reading outside the project; the global copy gets one read-only allow rule,
  // and the no-sleep hook that points agents at the copy's wait.mjs.
  if (localReference && mode === 'global') {
    const claude = resolved.selected.find((target) => target.id === 'claude');
    if (claude) {
      const claudeHome = path.dirname(resolveTargetPath(claude.global.instructions, mode, projectRoot));
      const settingsFile = path.join(claudeHome, 'settings.json');
      report.permissions.push(addAllowRule(settingsFile, reference.CLAUDE_READ_RULE, { dryRun }));
      report.hooks.push(installSleepHook(claudeHome, settingsFile, { dryRun }));
    }
  }

  if (persona) {
    const text = personaText({ referenceDir: localReference });
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
      config: report.config,
      persona: report.persona.map(({ file, action }) => ({ file, action })),
      reference: report.reference && report.reference.status !== 'unavailable'
        ? { dir: report.reference.dir, commit: report.reference.commit || null, source: report.reference.source || null }
        : (previous && previous.reference) || undefined,
      // Kept across runs so uninstall can remove a rule an earlier install added.
      permissions: mergePermissions(previous && previous.permissions, report.permissions),
      hooks: mergeHooks(previous && previous.hooks, report.hooks),
    });
  }

  return report;
}

/**
 * Remove the skills this package installed, plus the managed persona block.
 * Codex config is retained as a user preference, including its backup.
 * Manifest-scoped: anything the manifest does not list is left alone.
 */
function uninstall(opts = {}) {
  const { mode = 'global', projectRoot = process.cwd(), dryRun = false, persona = true } = opts;

  const previous = manifest.read(mode, projectRoot);
  const report = { mode, dryRun, removed: [], persona: [], permissions: [], hooks: [], manifestFound: Boolean(previous) };

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

  if (previous.reference && reference.removeReference(previous.reference.dir, { dryRun })) {
    report.removed.push(previous.reference.dir);
  }
  for (const entry of previous.permissions || []) {
    report.permissions.push(removeAllowRule(entry.file, entry.rule, { dryRun }));
  }
  for (const entry of previous.hooks || []) {
    report.hooks.push(uninstallSleepHook(entry, { dryRun }));
  }

  if (!dryRun) manifest.remove(mode, projectRoot);
  return report;
}

/** The allow rules this tool added, by file and rule, so uninstall removes exactly those. */
function mergePermissions(previous, current) {
  const merged = new Map();
  // A rule that was already there is the user's own (`unchanged`), so it is never recorded as ours.
  const added = current.filter((entry) => ['created', 'updated'].includes(entry.action));
  for (const entry of [...(previous || []), ...added]) merged.set(`${entry.file}\n${entry.rule}`, { file: entry.file, rule: entry.rule });
  return [...merged.values()];
}

/**
 * Add the no-sleep hook to Claude Code's settings and copy its script to the stable path the hook runs.
 * The script is refreshed on every install; when the settings cannot be changed it is not copied at all.
 * @param {string} claudeHome - Claude Code's folder, e.g. `~/.claude`.
 * @param {string} settingsFile - Its `settings.json`.
 * @param {{ dryRun?: boolean }} [options] - Dry run: report only, write nothing.
 * @returns {{ file: string, command: string, script: string, action: string }} The `addHook` result
 *   plus the installed script path.
 */
function installSleepHook(claudeHome, settingsFile, { dryRun = false } = {}) {
  const hook = blockSleepHook(claudeHome);
  const result = { ...addHook(settingsFile, hook.command, { dryRun }), script: hook.script };
  if (result.action === 'skipped' || dryRun) return result;
  fs.mkdirSync(path.dirname(hook.script), { recursive: true });
  fs.copyFileSync(hook.source, hook.script);
  return result;
}

/**
 * Remove the no-sleep hook from the settings, delete its copied script, and drop the hooks folder
 * only if that emptied it.
 * @param {{ file: string, command: string, script: string }} entry - What the manifest recorded.
 * @param {{ dryRun?: boolean }} [options] - Dry run: report only, delete nothing.
 * @returns {{ file: string, command: string, script: string, action: string }} The `removeHook`
 *   result plus the script path.
 */
function uninstallSleepHook(entry, { dryRun = false } = {}) {
  const result = { ...removeHook(entry.file, entry.command, { dryRun }), script: entry.script };
  // Settings that could not be changed still run the hook, so its script stays.
  if (dryRun || result.action === 'skipped' || !entry.script) return result;
  fs.rmSync(entry.script, { force: true });
  try {
    fs.rmdirSync(path.dirname(entry.script));
  } catch {
    /* the folder holds something else — keep it */
  }
  return result;
}

/**
 * The hooks this tool added, by settings file and command, so uninstall removes exactly those.
 * Unlike an allow rule, an `unchanged` hook is ours too: its command runs the script bt-agent copies.
 * @param {object[]|undefined} previous - Hooks recorded by earlier installs.
 * @param {object[]} current - This install's `installSleepHook` results.
 * @returns {{ file: string, command: string, script: string }[]} Deduplicated records.
 */
function mergeHooks(previous, current) {
  const merged = new Map();
  const recorded = current.filter((entry) => entry.action !== 'skipped');
  for (const entry of [...(previous || []), ...recorded]) {
    merged.set(`${entry.file}\n${entry.command}`, { file: entry.file, command: entry.command, script: entry.script });
  }
  return [...merged.values()];
}

module.exports = { install, uninstall };
