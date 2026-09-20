---
name: bt-spec
description: "The Babylon Toolkit Spec Skill creates a feature spec file and branch from a short idea. Use when asked to spec out, plan, or scaffold a new feature."
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Bash(git switch:*), AskUserQuestion, Agent, Task
---

Turn a short feature idea into a spec file that `bt-plan` can plan from. Follow the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md). The user's message after the skill name is the `arguments`.

```
/bt-spec [--grill-me] [--parity] <feature-brief>

/bt-spec "add a settings toggle to mute all game audio"
/bt-spec --grill-me "add a settings toggle to mute all game audio"    # interview first, then spec
/bt-spec --parity "port the Unity water shader and match it to within 2% in the browser"   # numeric parity bars allowed (slow — hours become days)
```

- `--grill-me` — interview the user, one question at a time, before writing (Step 4).
- `--parity` — the spec may set numeric parity bars against a reference. Without it, `proof: functional`.
- Strip the flags first; they are never part of the brief or the file name. An unrecognised `--flag` is part of the brief only if it is clearly prose — otherwise ask. No brief → ask for one. Never guess a path or URL.

## Ground rules

- **Planning only.** Research read-only and write only the spec file (plus `SPEC.md` from the scaffold, if the user says yes below). No source edits, no builds, no tests, no other shell commands.
- **Babylon work:** if you have not read the Babylon Toolkit Agent Reference in this session, fetch and read it once: https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md — it is the authority for conventions and API; fetch its sub-documents only when relevant, and again only if a context compaction made you forget it. If the fetch fails, stop and tell the user — do not guess at the API.
- **Say what you are doing.** Before any step that takes more than a few seconds (a fetch, a big read, subagents) print one short line — `🔎 [bt-spec] <what> …` — and one line when it returns. A silent run looks like a hang and gets cancelled.
- **Subagents:** running this skill is the user's request to use them where this skill says so. Use whatever subagent tool your host provides (its name varies by host — e.g. `Agent` or `Task`); if there is none, do the work inline and say so. Tell research subagents they need not fetch the Agent Reference.

## Step 1. Arguments, name, branch

From the flag-stripped brief derive `feature_title` (Title Case), `feature_slug` (lowercase kebab-case, `a-z 0-9 -` only, max 40 chars) and `branch_name` = `project/feature/<feature_slug>`. If you cannot infer a sensible title, ask. Make a first estimate of the feature's `size` (defined in Step 5) — it sizes the research in Step 2.

Git is optional. **Where git is available:** stop now if the working tree has uncommitted or untracked files (ask the user to commit or stash); switch to a new branch `branch_name` (if taken, append `-01`, `-02` …) just before writing the spec in Step 5, so a conflict stop leaves no empty branch behind. **Where it is not** (no binary, sandboxed host such as the Babylon Toolkit App Builder): skip this silently — the branch name recorded in the spec header is the deliverable. Do not mention git as missing.

## Step 2. Read the project

- **`SPEC.md`** (repository root) is the project's source of truth for architecture, systems, conventions and decisions. Read its headings, Architecture, Conventions, and the systems this feature touches. The feature must fit it. **If the idea conflicts with SPEC.md, stop and tell the user before writing.** Verification procedures described in SPEC.md are tooling the feature may reuse, not requirements it inherits.
- **If `SPEC.md` is missing or an empty stub, ask the user first** whether to create it from the scaffold at the end of this file. Yes → write it, then continue against it. No → continue, and note in the spec: `"No project SPEC.md content yet — following existing codebase conventions."`
- **`DESIGN.md`** (only if the feature has UI): it is the single source of truth for design — never Figma or invented values. Cite the tokens and shared components the feature uses in 3–8 bullets. Missing → note `"No DESIGN.md design system found — follow the existing UI conventions already in the codebase."` No UI → say no design tokens apply.
- **Research the codebase, sized to the feature.** Find the closest existing feature to mirror, the real conventions, and the integration points. For a `small` feature do this inline; fan out to up to 3 **read-only** subagents only for `medium` / `large` (they report findings and file paths, never draft the spec; if a finding contradicts SPEC.md, raise it with the user rather than resolving it silently). Record the result in the spec's `## Research Notes` so bt-plan starts from it.

## Step 3. Sibling-skill patterns

If the feature is built on a pattern owned by another skill (bt-design's 3D-Hero-Scroll, bt-atlas, bt-convert …), or the brief names a builder skill ("using bt-hero …", "using bt-prototype …"), **read that skill's SKILL.md and relevant reference before writing requirements.** *(Where skills load through a tool: `load_skill('<name>')`, then `read_skill_resource` with the paths it returns — never a guessed path. Where skills are files on disk: read them from the skills directory this skill was loaded from — e.g. `~/.claude/skills/`, `~/.agents/skills/`, or the project's `.claude/skills/` / `.agents/skills/`.)* For 3D-scroll / scroll-scrubbed / cinematic-hero features that is bt-design's `references/3d-hero-scroll.md`.

- Record the pattern's behavioral config as explicit Functional Requirements, using the sub-skill's **own names and defaults, unchanged** (e.g. 3D-Hero-Scroll `sweep: page` — PLAY glides to the document bottom and END jumps there). State any override and why.
- Keep a behavioral option separate from the feature's route/DOM scope — `sweep` is not "which page it lives on".
- List which optional controls are in or out.
- For a named builder skill, run **only its intake steps** here (bt-hero Steps 1–2 → the hero brief; bt-prototype Steps 1–2 → the `_directions.md` manifest) and fold the result in; resolve its questions now so nothing prompts later. The builder contributes intake only — this spec → plan → execute loop owns the build and the verification.

## Step 4. `--grill-me` (only with the flag)

Interview the user until the design is decided, after Steps 2–3 so questions are grounded in the real code:

- One question at a time (`AskUserQuestion` where available), your recommended answer first, labelled `(Recommended)`.
- If the answer is in the repo, go find it instead of asking. Never ask what the brief, SPEC.md, DESIGN.md or a sibling skill already settles.
- Go depth-first: resolve a decision before the questions that depend on it.
- Write every answer into the spec (requirement, acceptance criterion or edge case) plus a `## Decisions` entry with the why and the rejected alternative.
- Stop when only implementation choices remain, or when the user says "enough" — then put unexplored branches in `## Open Questions` with your recommended answer, and note in the spec that grilling ended early.

## Step 5. Classify, then write the spec

- **`spec_impact`** — `yes` if the feature adds or changes a system, convention, dependency or architectural decision in SPEC.md; else `no`. This decides whether the plan ends with an `Update SPEC.md` task.
- **`size`** — `small` ≈ 1–2 hours by hand, one system; `medium` ≈ a day, a few systems; `large` ≈ multi-day, multi-system, or Unity/Blender/export pipeline work. Classify by the real work.
- **`proof`** — `functional` (default) or `parity` (only with `--parity`, or when the brief itself states a numeric bar). Under `functional`, Acceptance Criteria are what a user would notice — it works, it looks and feels right (against DESIGN.md, or next to a reference when there is one), the console is clean — proven by tests and a look at the running result. Never invent numeric pixel thresholds, repeat counts, per-engine matrices or evidence archives: how a feature is proven is most of what it costs to build.

Print `✍️ [bt-spec] Drafting _specs/<feature_slug>_spec.md …`, then write the spec to `_specs/<feature_slug>_spec.md` using the project's `FEATURE.md` template if it exists (add any header field or section below that it lacks), otherwise this structure. No implementation detail or code examples.

```markdown
# Spec for <feature-name>

branch: project/feature/<feature-name>
design_system: DESIGN.md
spec_impact: <yes|no>
size: <small|medium|large>
proof: <functional|parity>

## Summary
<one paragraph>

## Project Spec Alignment (from SPEC.md)
- SPEC.md sections this feature relies on: <by name>
- How it fits the architecture: <...>
- spec_impact = yes → what will change in SPEC.md, and where: <...>   (or: confirms no architectural change)
- Conflicts with SPEC.md (if any): <...>

## Functional Requirements
- ...   <!-- sibling-skill behavioral config goes here verbatim, separate from route/scope -->

## Design System Reference (only if the feature has UI)
- DESIGN.md tokens/components used: ...

## Possible Edge Cases
- ...

## Acceptance Criteria
- ...   <!-- what a user would notice; numeric parity bars only when proof: parity -->

## Decisions   <!-- required with --grill-me -->
- **<decision>.** <why.> Rejected: <alternative> (<why not>).

## Open Questions   <!-- only genuinely undecided items -->
- ...

## Research Notes   <!-- key files, the pattern to mirror, integration points — with paths -->
- ...

## Testing Guidelines
Create test file(s) in ./tests for these named cases, without going heavy:
- <case> → <expected outcome>
```

## Step 6. Report

```
Branch: <branch_name>
Spec file: _specs/<feature_slug>_spec.md
Title: <feature_title>
```

Do not print the spec unless asked.

## Project SPEC.md scaffold (used only when the user says yes in Step 2)

```markdown
# Project Spec

> The source of truth for this project: its durable architecture, systems, conventions and decisions.
> Feature specs in `_specs/` are derived from and constrained by this file. It describes the **product** —
> what exists and why — never how a feature was verified (capture protocols, tool lists, ledgers).

## Architecture & Module Layout  _(current-state — replace/merge)_
- _(Seed placeholder — replaced on first real content.)_

## Game Systems  _(current-state — replace/merge)_
- _(Seed placeholder — one subsection per system: what it owns, what it delegates.)_

## Conventions  _(current-state — replace/merge)_
- Prefer ESM imports throughout.
- Use Babylon Toolkit script component patterns rather than ad-hoc BabylonJS wiring, per the Agent Reference.
- Keep game systems modular.

## Decisions  _(append-only log)_
- _(Newest last. To reverse a decision, add a new entry that supersedes it.)_

## Dependencies  _(current-state — replace/merge)_
- **BabylonJS** — engine.
- **Babylon Toolkit** — Unity-style script components, scene management.

## How to update this spec
- `(current-state — replace/merge)` sections say what is true now: replace seed placeholders with real content, then keep them matching the shipped code.
- `(append-only log)`: append, never delete.
- Add each new Game System as its own subsection; record every new dependency (version + why) in the task that introduces it.
- bt-spec reads this file and aligns the feature to it; bt-plan conforms to it and adds an `Update SPEC.md` task for spec-impacting features; bt-execute runs that task through the same verifier as every other task.
```
