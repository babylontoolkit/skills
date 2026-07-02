# Babylon Toolkit Agent Skills

Universal [Agent Skills](https://agentskills.io) for the Babylon Toolkit SPEC → PLAN →
EXECUTE workflow. Each `SKILL.md` follows the open standard, so the **same file works
unchanged** in Claude Code, Codex CLI, and GitHub Copilot.

## Skills

| Skill | Command | What it does |
|-------|---------|--------------|
| [`spec`](skills/spec/SKILL.md) | `/spec` | Turn a short idea into a feature spec file on a new git branch. |
| [`plan`](skills/plan/SKILL.md) | `/plan` | Produce a detailed, task-checklist technical plan from a spec. |
| [`execute`](skills/execute/SKILL.md) | `/execute` | Implement one task (or all remaining tasks) from a plan/spec. |
| [`convert`](skills/convert/SKILL.md) | `/convert` | Convert Unity C# scripts to Babylon Toolkit TypeScript. |

Every tool derives the slash-command from the **folder name** (`spec/` → `/spec`) and reads
the frontmatter `name` + `description` to decide when the skill applies. The `allowed-tools`
line is honored by Claude Code (auto-approves those tools) and safely ignored by Codex and
Copilot.

## Installation Locations

Where each tool looks for local project skills:

| Tool | Skills directory |
|------|------------------|
| Claude Code | `.claude/skills/` *(also read by Copilot)* |
| Codex CLI | `.codex/skills/` |

Where each tool looks for global (all) project skills:

| Tool | Skills directory |
|------|------------------|
| Claude Code | `~/.claude/skills/` *(also read by Copilot)* |
| Codex CLI | `~/.codex/skills/` |

> **Note:** Install skills into **BOTH** Claude Code and Codex locations for maximum coverage.

## Native Claude Code Installation

To install from marketplace:
```
/plugin marketplace add babylontoolkit/skills
/plugin install agent-skills@babylon-toolkit
```

To update marketplace plugin: 
```
/plugin marketplace update babylon-toolkit.
```

## Babylon Toolkit Agent Persona

Simply ask the `Babylon Toolkit Agent` to **install the agent skills** for you.
