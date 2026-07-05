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

Where each tool looks for all global project skills (`~` = your home directory):

| Tool | macOS / Linux | Windows |
|------|---------------|---------|
| Claude Code | `~/.claude/skills/` *(also read by Copilot)* | `%USERPROFILE%\.claude\skills\` |
| Codex CLI | `~/.codex/skills/` | `%USERPROFILE%\.codex\skills\` |

> On macOS this expands to `/Users/<user>/.claude/skills/`, on Linux to `/home/<user>/.claude/skills/`,
> and on Windows to `C:\Users\<user>\.claude\skills\`.

> **Note:** Install skills into **BOTH** Claude Code and Codex locations for maximum coverage.
> Copy **whole folders** into each — the `bt-atlas/scripts/` assets must be present in every location.

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
# Feature Spec Template

> This is the template bt-spec uses to author `_specs/<feature_slug>_spec.md`.
> Copy this structure verbatim. A feature spec is derived **from** and constrained
> **by** the project [SPEC.md](SPEC.md) — the `Project Spec Alignment` section and
> the `spec_impact` header field are required, not optional.

---

# Spec for <feature-name>

branch: project/feature/<feature-name>
design_system: DESIGN.md
spec_impact: <yes|no>   # yes if this feature adds/changes a system, convention, dependency, or architectural decision in SPEC.md

## Summary
<one-paragraph description of the feature>

## Project Spec Alignment (from SPEC.md — REQUIRED)
- SPEC.md sections this feature relies on or must conform to: <cite by name, e.g. "Game Systems › Inventory", "Conventions">
- How this feature fits the existing architecture: <...>
- **spec_impact = yes** → what will change in SPEC.md and which section(s): <architecture / system / convention / decision / dependency + the new state>
- **spec_impact = no** → confirm this feature introduces no architectural, system, convention, or dependency change.
- Conflicts with SPEC.md (if any): <describe; these must be resolved/flagged before planning>

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