---
name: bt-spec
description: "The Babylon Toolkit Spec Skill creates a feature spec file and branch from a short idea, plus the feature's dashboard (`.agents/specs/<slug>/dashboard.html`), which shows the bt-plan commands to copy until the feature is planned. Use when asked to spec, spec out, plan, or scaffold a new feature (\"spec out a mute toggle\", \"let's spec this\")."
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Bash(git switch:*), AskUserQuestion, Agent, Task
---

Turn a short feature idea into a spec file that `bt-plan` can plan from. Follow the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md). The user's message after the skill name is the `arguments`.

```
/bt-spec [--grill-me] [--parity] [--no-time-limit] <feature-brief>

/bt-spec "add a settings toggle to mute all game audio"
/bt-spec --grill-me "add a settings toggle to mute all game audio"    # interview first, then spec
/bt-spec --parity "port the Unity water shader and match it to within 2% in the browser"   # numeric parity bars allowed (slow — hours become days)
/bt-spec --no-time-limit "redesign the save system"                   # turn off the default TIME MATTERS mode
```

- `--grill-me` — interview the user, one question at a time, before writing (Step 4).
- `--parity` — the spec may set numeric parity bars against a reference. Without it, `proof: functional`.
- `--no-time-limit` — turn off TIME MATTERS mode (Ground rules).
- Strip the flags, and any literal `TIME MATTERS`, first; they are never part of the brief or the file name. An unrecognised `--flag` is part of the brief only if it is clearly prose — otherwise ask. No brief → ask for one. Never guess a path or URL.

## Ground rules

- **TIME MATTERS** — on by default; `--no-time-limit` turns it off. Treat the arguments as ending with `TIME MATTERS`: the user is waiting on this run, so finish quickly — research only what the spec needs, keep subagents few and their questions narrow, and do not re-read what you already have. Begin every subagent prompt with `TIME MATTERS.` Print `⏱️ [bt-spec] TIME MATTERS` at the start (`--no-time-limit`: print `⏱️ [bt-spec] No time limit`, and do not add it). Speed never skips a required step or lowers the quality of the spec.
- **Planning only.** Research read-only and write only the spec file and the feature dashboard into the new feature folder (Step 6; plus `SPEC.md` from the scaffold, if the user says yes below, a builder skill's intake file in the same `documents/` folder — Step 3 — and the one `.gitignore` line Step 6 names). No source edits, no builds, no tests, no other shell commands.
- **Babylon work:** if you have not read the Babylon Toolkit Agent Reference in this session, read it once: https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md — it is the authority for conventions and API; read its sub-documents only when relevant, and again only if a context compaction made you forget it. If it cannot be read, stop and tell the user — do not guess at the API.
- **Say what you are doing.** Before any step that takes more than a few seconds (a fetch, a big read, subagents) print one short line — `🔎 [bt-spec] <what> …` — and one line when it returns. A silent run looks like a hang and gets cancelled.
- **Subagents:** running this skill is the user's request to use them where this skill says so. Use whatever subagent tool your host provides (its name varies by host — e.g. `Agent` or `Task`); if there is none, do the work inline and say so. Tell research subagents they need not read the Agent Reference.

## Step 1. Arguments, name, branch

From the flag-stripped brief derive `feature_title` (Title Case), `feature_slug` (lowercase kebab-case, `a-z 0-9 -` only, max 40 chars) and `branch_name` = `project/feature/<feature_slug>`. If a folder of that name already exists in `.agents/specs/`, `.agents/complete/` or anywhere under `.agents/archived/` (the user moves finished features from `specs/` to `complete/` for review, and later on to `archived/`), append `-02`, `-03` … to the slug, so any of them can be moved back. If you cannot infer a sensible title, ask. Make a first estimate of the feature's `size` (defined in Step 5) — it sizes the research in Step 2.

Git is optional. **Where git is available:** stop now if the working tree has uncommitted or untracked files (ask the user to commit or stash); switch to a new branch `branch_name` (if taken, append `-01`, `-02` …) just before writing the spec in Step 5, so a conflict stop leaves no empty branch behind. **Where it is not** (no binary, sandboxed host such as the Babylon Toolkit App Builder): skip this silently — the branch name recorded in the spec header is the deliverable. Do not mention git as missing.

## Step 2. Read the project

- **`SPEC.md`** (repository root) is the project's source of truth for architecture, systems, conventions and decisions. Read its headings, Architecture, Conventions, and the systems this feature touches. The feature must fit it. **If the idea conflicts with SPEC.md, stop and tell the user before writing.** Verification procedures described in SPEC.md are tooling the feature may reuse, not requirements it inherits.
- **If `SPEC.md` is missing or an empty stub, ask the user first** whether to create it from the scaffold at the end of this file. Yes → write it, then continue against it. No → continue, and note in the spec: `"No project SPEC.md content yet — following existing codebase conventions."`
- **`DESIGN.md`** (only if the feature has UI): it is the single source of truth for design — never Figma or invented values. Cite the tokens and shared components the feature uses in 3–8 bullets. Missing → note `"No DESIGN.md design system found — follow the existing UI conventions already in the codebase."` No UI → say no design tokens apply.
- **Recon docs (`.agents/recon/*_recon.md`, written by bt-recon):** if any recon's `scope` covers a system this feature touches, read its Summary, Architecture, the relevant Feature Inventory / UI Reference / External Interfaces sections, Known Issues and Extension Points — it is the grounding for code nobody else documented, so build on it instead of re-deriving it. Cite it in `## Research Notes`. If its `commit:` is well behind HEAD for the files this feature touches, note the drift there and suggest `bt-recon --refresh`.
- **Recons the brief cites (`… using @<path>_recon.md`):** bt-profile's fix commands cite the recon of the code behind the fixes, kept in the profile's own folder (`.agents/profile/<slug>/recon/`) or in `.agents/recon/`. Always read a cited recon in full, whatever its scope says. It is the map of the code the fix changes: callers, invariants, tests, extension points. Turn what it says must not break into Acceptance Criteria or named test cases. **Copy each cited recon into this feature's `recon/` folder** and cite the copy in `## Research Notes`. The feature folder then holds everything it rests on, and still works after the profile is archived or moved. A cited recon that does not exist yet: say so, give the `/bt-recon` command that makes it (the profile report's **Copy recon command**), and carry on with your own research.
- **Research the codebase, sized to the feature.** Find the closest existing feature to mirror, the real conventions, and the integration points. For a `small` feature do this inline; fan out to up to 3 **read-only** subagents only for `medium` / `large` (they report findings and file paths, never draft the spec; if a finding contradicts SPEC.md, raise it with the user rather than resolving it silently). Record the result in the spec's `## Research Notes` so bt-plan starts from it.

## Step 3. Sibling-skill patterns

If the feature is built on a pattern owned by another skill (bt-design's 3D-Hero-Scroll, bt-atlas, bt-convert …), or the brief names a builder skill ("using bt-hero …", "using bt-prototype …"), **read that skill's SKILL.md and relevant reference before writing requirements.** *(Where skills load through a tool: `load_skill('<name>')`, then `read_skill_resource` with the paths it returns — never a guessed path. Where skills are files on disk: read them from the skills directory this skill was loaded from — e.g. `~/.claude/skills/`, `~/.agents/skills/`, or the project's `.claude/skills/` / `.agents/skills/`.)* For 3D-scroll / scroll-scrubbed / cinematic-hero features that is bt-design's `references/3d-hero-scroll.md`.

- Record the pattern's behavioral config as explicit Functional Requirements, using the sub-skill's **own names and defaults, unchanged** (e.g. 3D-Hero-Scroll `sweep: page` — PLAY glides to the document bottom and END jumps there). State any override and why.
- Keep a behavioral option separate from the feature's route/DOM scope — `sweep` is not "which page it lives on".
- List which optional controls are in or out.
- For a named builder skill, run **only its intake steps** here (bt-hero Steps 1–2 → the hero brief, written to `.agents/specs/<feature_slug>/documents/<feature_slug>_hero-brief.md`; bt-prototype Steps 1–2 → the `_directions.md` manifest) and fold the result in; resolve its questions now so nothing prompts later. The builder contributes intake only — this spec → plan → execute loop owns the build and the verification.

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

**The feature folder.** This spec creates the feature's folder, which holds everything about it from here on:

```
.agents/specs/<feature_slug>/
  dashboard.html    the feature dashboard (this spec creates it; bt-plan fills in the plan; bt-execute keeps it current)
  documents/        <feature_slug>_spec.md, _plan.md, _autopilot.md, _dashboard.js, _live.js, and any builder intake file
  snapshots/        the meaningful snapshots of the build, shown by the dashboard
  tests/            every test the plan's tasks write
  recon/            copies of the recons the brief cites (`using @…_recon.md`), when it cites any
```

Print `✍️ [bt-spec] Drafting .agents/specs/<feature_slug>/documents/<feature_slug>_spec.md …`, then make sure the default `.agents` folders exist — `.agents/specs/`, `.agents/complete/`, `.agents/archived/`, `.agents/profile/` and `.agents/recon/`, each with an empty `.gitkeep` (write only the ones missing; never touch what a folder holds), and write the spec to `.agents/specs/<feature_slug>/documents/<feature_slug>_spec.md` (creating the folders) using the project's `FEATURE.md` template if it exists (add any header field or section below that it lacks), otherwise this structure. No implementation detail or code examples. Then go straight to Step 6 for this feature.

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
<!-- State the outcome, not the machinery: "an unfinished build never reaches a folder the
     user looks at", not "a nine-step gated promotion script with archives and md5 records".
     The plan picks the cheapest mechanism that gets the outcome. -->

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
Create test file(s) in .agents/specs/<feature-name>/tests/ for these named cases, without going heavy:
- <case> → <expected outcome>
```

## Step 6. Write the dashboard (specified state)

Write the dashboard **straight after its spec, before anything else** — a spec never sits on disk without its dashboard. When one request produces several specs, finish each feature (spec, then dashboard) before drafting the next; never write the specs first and the dashboards in a batch at the end.

Print `🗂️ [bt-spec] Writing the feature dashboard …`. The feature's dashboard exists from the spec on: until a plan is written it shows the `bt-plan` commands that plan this spec — a standard plan, `--heavy`, `--parity`, `--no-time-limit` — each with a copy button, and a *Build your own* with those options and a brief. From bt-execute's `templates/dashboard/` *(where skills load through a tool: `load_skill('bt-execute')` + `read_skill_resource`; where they are files: the sibling `bt-execute/` folder in the skills directory this skill was loaded from)*:

- copy `dashboard.html` to `.agents/specs/<feature_slug>/dashboard.html`, replacing `{{slug}}` with the slug and changing nothing else;
- write `.agents/specs/<feature_slug>/documents/<feature_slug>_dashboard.js` from the starter `dashboard.template.js`, written whole as strict JSON behind its `window.FEATURE_DASHBOARD =` prefix — double-quoted keys, no comments, no trailing commas (`data-schema.md` documents every field): `feature` (title, slug, branch, `origin: "spec"`, size, proof, a plain-language summary from the spec's Summary), `documents` (the Spec alone), **`status: "specified"`**, `updatedAt` (the current local time, `YYYY-MM-DD HH:MM`), `estimate` empty, **no phases**, an empty `afterAction`, the spec's Decisions as `decisions` when it has any (`D1` …), no follow ups, and one `activity` line: `Spec written — <size>, <proof> proof`;
- write `.agents/specs/<feature_slug>/documents/<feature_slug>_live.js` from `live.template.js`, the same way: no task, `role: "orchestrator"`, `title: "Spec written — waiting for bt-plan"`, no steps;
- in a git repository, make sure `.gitignore` (at the repository root) contains the line `.agents/*/*/documents/*_live.js` — append it once if missing.

If the template cannot be found, skip the dashboard and say so — bt-plan creates it with the plan.

## Step 7. Report

```
Branch: <branch_name>
Spec file: .agents/specs/<feature_slug>/documents/<feature_slug>_spec.md
Dashboard: .agents/specs/<feature_slug>/dashboard.html   (open it in a browser to copy a bt-plan command)
Title: <feature_title>
```

Do not print the spec unless asked.

## Project SPEC.md scaffold (used only when the user says yes in Step 2)

```markdown
# Project Spec

> The source of truth for this project: its durable architecture, systems, conventions and decisions.
> Feature specs in `.agents/specs/` are derived from and constrained by this file. It describes the **product** —
> what exists and why — never how a feature was verified (capture protocols, tool lists, ledgers).

## Architecture & Module Layout  _(current-state — replace/merge)_
- _(Seed placeholder — replaced on first real content.)_

## Game Systems  _(current-state — replace/merge)_
- _(Seed placeholder — one subsection per system: what it owns, what it delegates.)_

## Conventions  _(current-state — replace/merge)_
- Prefer ESM imports throughout.
- Use Babylon Toolkit script component patterns rather than ad-hoc BabylonJS wiring, per the Agent Reference.
- Keep game systems modular.

## Decisions  _(the decisions that still bind — one or two lines each)_
- _(Newest last. When a decision is superseded, fold what still matters into the sections
  above and drop the old entry; the feature's own spec keeps the full rationale and history.)_

## Dependencies  _(current-state — replace/merge)_
- **BabylonJS** — engine.
- **Babylon Toolkit** — Unity-style script components, scene management.

## How to update this spec
- `(current-state — replace/merge)` sections say what is true now: replace seed placeholders with real content, then keep them matching the shipped code.
- `Decisions` holds only what still binds the current design, briefly. A decision's full rationale, its rejected alternatives and its history live in that feature's spec in `.agents/specs/`, not here — this file must stay short enough to read before every feature.
- Add each new Game System as its own subsection; record every new dependency (version + why) in the task that introduces it.
- bt-spec reads this file and aligns the feature to it; bt-plan conforms to it and adds an `Update SPEC.md` task for spec-impacting features; bt-execute runs that task through the same verifier as every other task.
```
