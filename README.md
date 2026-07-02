# Babylon Toolki Skills

Universal [Agent Skills](https://agentskills.io) for the Babylon Toolkit SPEC → PLAN →
EXECUTE workflow. Each `SKILL.md` follows the open standard, so the **same file works
unchanged** in Claude Code, Codex CLI, and GitHub Copilot.

## Skills

| Skill | Command | What it does |
|-------|---------|--------------|
| [`convert`](convert/SKILL.md) | `/convert` | Convert Unity C# scripts to Babylon Toolkit TypeScript. |
| [`spec`](spec/SKILL.md) | `/spec` | Turn a short idea into a feature spec file on a new git branch. |
| [`plan`](plan/SKILL.md) | `/plan` | Produce a detailed, task-checklist technical plan from a spec. |
| [`execute`](execute/SKILL.md) | `/execute` | Implement one task (or all remaining tasks) from a plan/spec. |

## How it works

Every tool derives the slash-command from the **folder name** (`spec/` → `/spec`) and reads
the frontmatter `name` + `description` to decide when the skill applies. The `allowed-tools`
line is honored by Claude Code (auto-approves those tools) and safely ignored by Codex and
Copilot.

Where each tool looks for local (all-projects) skills:

| Tool | Skills directory |
|------|------------------|
| Claude Code | `.claude/skills/` *(also read by Copilot)* |
| Codex CLI | `.codex/skills/` |
| GitHub Copilot | `.copilot/skills/`, `.claude/skills/`, or `.agents/skills/` |

Where each tool looks for global (all-projects) skills:

| Tool | Skills directory |
|------|------------------|
| Claude Code | `~/.claude/skills/` *(also read by Copilot)* |
| Codex CLI | `~/.codex/skills/` |
| GitHub Copilot | `~/.copilot/skills/`, `~/.claude/skills/`, or `~/.agents/skills/` |

> **Note:** the file must be named exactly `SKILL.md` — Codex silently skips `SKILL.MD`.

## Install

_Installation instructions coming soon._ For now, copy a skill folder (e.g. `spec/`) into
the relevant directory above and start a new session. A cross-platform installer will be
added once this repo has a permanent home.
