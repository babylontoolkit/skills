# Babylon Toolkit Agent Skills

Universal [Agent Skills](https://agentskills.io) for the Babylon Toolkit SPEC → PLAN →
EXECUTE workflow. Each `SKILL.md` follows the open standard, so the **same file works
unchanged** in Claude Code, Codex CLI, and GitHub Copilot.

## Skills

| Skill | Command | What it does |
|-------|---------|--------------|
| [`bt-spec`](skills/bt-spec/SKILL.md) | `/bt-spec` | Turn a short idea into a feature spec file on a new git branch. |
| [`bt-plan`](skills/bt-plan/SKILL.md) | `/bt-plan` | Produce a detailed, task-checklist technical plan from a spec. |
| [`bt-execute`](skills/bt-execute/SKILL.md) | `/bt-execute` | Implement one task (or all remaining tasks) from a plan/spec. |
| [`bt-convert`](skills/bt-convert/SKILL.md) | `/bt-convert` | Convert Unity C# scripts to Babylon Toolkit TypeScript. |
| [`bt-design`](skills/bt-design/SKILL.md) | `/bt-design` | Implement high quality frontend and in-game designs. |
| [`bt-atlas`](skills/bt-atlas/SKILL.md) | `/bt-atlas` | Generate texture atlas skin variations. |

Every tool derives the slash-command from the **folder name** (`bt-spec/` → `/bt-spec`) and reads
the frontmatter `name` + `description` to decide when the skill applies. The `allowed-tools`
line is honored by Claude Code (auto-approves those tools) and safely ignored by Codex and
Copilot.

## Universal Installations

Where each tool looks for local project skills (Default Installation):

| Tool | Skills directory |
|------|------------------|
| Claude Code | `.claude/skills/` *(also read by Copilot)* |
| Codex CLI | `.codex/skills/` |

Where each tool looks for all global project skills:

| Tool | Skills directory |
|------|------------------|
| Claude Code | `~/.claude/skills/` *(also read by Copilot)* |
| Codex CLI | `~/.codex/skills/` |

> **Note:** Install skills into **BOTH** Claude Code and Codex locations for maximum coverage.

## Native Claude Code Installation

- Always prefer the `Default Universal Installation` unless instructed to install the `Native Claude Code Agent Skills`

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

## Baylon Toolkit Feature Spec Template

The default spec driven workflow template:
```
# Spec for <feature-name>

branch: project/feature/<feature-name>
design_system: DESIGN.md

## Summary
...

## Functional Requirements
- ...

## Design System Reference (from DESIGN.md, only if the feature has UI)
- DESIGN.md tokens/components this feature uses: ...
- Layout / spacing / typography notes: ...
- Key visual constraints: ...

## Possible Edge Cases
- ...

## Acceptance Criteria
- ...

## Open Questions
- ...

## Testing Guidelines
Create a test file(s) in the ./tests folder for the new feature, and create meaningful tests for the following cases, without going too heavy:
- ...
```