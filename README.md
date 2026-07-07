# Babylon Toolkit Agent Skills (1.0.0)

Universal [Agent Skills](https://agentskills.io) for the `Babylon Toolkit` web game development framework.
Each `SKILL.md` follows the open standard, so the **same file works unchanged** in Claude Code, Codex CLI, and GitHub Copilot.

## Skills

| Skill | Command | What it does |
|-------|---------|--------------|
| [`bt-spec`](skills/bt-spec/SKILL.md) | `/bt-spec` | Turn a short idea into a feature spec file on a new git branch. |
| [`bt-plan`](skills/bt-plan/SKILL.md) | `/bt-plan` | Produce a detailed, task-checklist technical plan from a spec. |
| [`bt-execute`](skills/bt-execute/SKILL.md) | `/bt-execute` | Implement one task (or all remaining tasks) from a plan/spec. |
| [`bt-convert`](skills/bt-convert/SKILL.md) | `/bt-convert` | Convert source code to Babylon Toolkit TypeScript. |
| [`bt-copycat`](skills/bt-copycat/SKILL.md) | `/bt-copycat` | Re-create the specified website adapted to specified genre. |
| [`bt-design`](skills/bt-design/SKILL.md) | `/bt-design` | Implement high quality frontend and in-game designs. |
| [`bt-atlas`](skills/bt-atlas/SKILL.md) | `/bt-atlas` | Generate texture atlas skin variations. |

Every tool derives the slash-command from the **folder name** (`bt-spec/` → `/bt-spec`) and reads
the frontmatter `name` + `description` to decide when the skill applies. The `allowed-tools`
line is honored by Claude Code (auto-approves those tools) and safely ignored by Codex and
Copilot.

## Universal Installations

Where each tool looks for local project skills (Default Installation):

| Tool | Project skills directory |
|------|--------------------------|
| Claude Code | `.claude/skills/` |
| OpenAI Codex | `.agents/skills/` |
| GitHub Copilot | `.agents/skills/` |
| Gemini CLI / Antigravity | `.agents/skills/` |

Where each tool looks for global skills (`~` = your home directory):

| Tool | macOS / Linux | Windows |
|------|---------------|---------|
| Claude Code | `~/.claude/skills/` | `%USERPROFILE%\.claude\skills\` |
| OpenAI Codex | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |
| GitHub Copilot | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |
| Gemini CLI | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |

> On macOS `~` expands to `/Users/<user>/`, on Linux to `/home/<user>/`,
> and on Windows to `C:\Users\<user>\`.

> **Note:** Install skills into **BOTH** the `.claude/skills/` and `.agents/skills/`
> locations for maximum coverage — `.claude/skills/` for Claude Code, `.agents/skills/`
> for everything else (Codex, Copilot, Gemini CLI, Antigravity). Copy **whole folders**
> into each — the `bt-atlas/scripts/` assets must be present in every location.

## Native Claude Code Installation

- Always prefer the `Default Universal Installation` unless instructed to install the `Native Claude Code Agent Skills`
- The marketplace plugin install bundles all skill assets (including `bt-atlas/scripts/`) automatically.

To install from marketplace:
```
/plugin marketplace add babylontoolkit/skills
/plugin install agent-skills@babylon-toolkit
```

To update marketplace plugin:
```
/plugin marketplace update babylon-toolkit
```

## Babylon Toolkit Agent Persona

Simply ask the agent to install the `Babylon Toolkit Agent Skills` for you.
