'use strict';

const { resolveTargetPath } = require('./paths');

/**
 * The install target matrix.
 *
 * Adding support for another AI client is one entry here — no other file changes.
 * `skills` is the directory that receives the skill folders (null = this client
 * reads no skills of its own). `instructions` is the global instruction file that
 * receives the Agent Persona (null = this client has no instruction file).
 *
 * Only paths that are documented by the client vendor belong here. Guessing a path
 * writes files somewhere the client will never read.
 */
const TARGETS = [
  {
    id: 'claude',
    label: 'Claude Code',
    default: true,
    global: { skills: '~/.claude/skills', instructions: '~/.claude/CLAUDE.md' },
    project: { skills: '.claude/skills', instructions: 'CLAUDE.md' },
  },
  {
    id: 'agents',
    label: 'Cross-agent standard (Codex, GitHub Copilot, Antigravity)',
    default: true,
    global: { skills: '~/.agents/skills', instructions: '~/.agents/AGENTS.md' },
    project: { skills: '.agents/skills', instructions: 'AGENTS.md' },
  },
  {
    id: 'codex',
    label: 'Codex chat clients (Codex CLI / Codex IDE)',
    default: true,
    global: { skills: null, instructions: '~/.codex/AGENTS.md' },
    project: { skills: null, instructions: 'AGENTS.md' },
  },
  {
    id: 'gemini',
    // Gemini CLI does NOT read AGENTS.md by default — its global context file is
    // GEMINI.md, so ~/.agents/AGENTS.md alone never reaches it.
    label: 'Gemini CLI',
    default: true,
    global: { skills: null, instructions: '~/.gemini/GEMINI.md' },
    project: { skills: null, instructions: 'GEMINI.md' },
  },
  {
    id: 'codex-legacy',
    // Pre-`.agents` Codex CLI builds read ~/.codex/skills. Opt in with --legacy-codex.
    label: 'Legacy Codex CLI skills directory',
    default: false,
    global: { skills: '~/.codex/skills', instructions: null },
    project: { skills: '.codex/skills', instructions: null },
  },
];

function targetIds() {
  return TARGETS.map((t) => t.id);
}

/**
 * Resolve the matrix into concrete absolute paths for this run.
 *
 * Returns de-duplicated lists: in project mode several clients share ./AGENTS.md,
 * and writing the persona to it once per client would stack duplicate blocks.
 */
function resolveTargets({ mode = 'global', projectRoot = process.cwd(), ids = null, legacyCodex = false } = {}) {
  const wanted = new Set(ids && ids.length ? ids : TARGETS.filter((t) => t.default).map((t) => t.id));
  if (legacyCodex) wanted.add('codex-legacy');

  const unknown = [...wanted].filter((id) => !TARGETS.some((t) => t.id === id));
  if (unknown.length) {
    throw new Error(`Unknown target(s): ${unknown.join(', ')}. Known targets: ${targetIds().join(', ')}`);
  }

  const selected = TARGETS.filter((t) => wanted.has(t.id));
  const skillDirs = new Map();
  const instructionFiles = new Map();

  for (const t of selected) {
    const spec = mode === 'project' ? t.project : t.global;

    const skillsDir = resolveTargetPath(spec.skills, mode, projectRoot);
    if (skillsDir) {
      if (!skillDirs.has(skillsDir)) skillDirs.set(skillsDir, { dir: skillsDir, targets: [] });
      skillDirs.get(skillsDir).targets.push(t.id);
    }

    const instructions = resolveTargetPath(spec.instructions, mode, projectRoot);
    if (instructions) {
      if (!instructionFiles.has(instructions)) instructionFiles.set(instructions, { file: instructions, targets: [] });
      instructionFiles.get(instructions).targets.push(t.id);
    }
  }

  return {
    mode,
    projectRoot,
    selected,
    skillDirs: [...skillDirs.values()],
    instructionFiles: [...instructionFiles.values()],
  };
}

module.exports = { TARGETS, targetIds, resolveTargets };
