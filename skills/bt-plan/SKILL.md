---
name: bt-plan
description: "The Babylon Toolkit Plan Skill creates the detailed technical plan for the specified feature spec file. Use when asked to plan or produce implementation tasks for an existing spec. Also supports a Quick Plan mode: when given only a brief (no spec file), it interviews the user to build a mini-spec and plans from that. Always planning-only — it writes the plan file and stops; execution is the separate bt-execute skill."
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Task
---

Create a detailed technical implmentation plan for the specified feature spec and save in the _specs folder as `<feature-name>_plan.md`. Always generate implmentation tasks or steps (prefer to call them tasks).

Use the user’s message after the skill name as the `arguments`.

---

# Invocation

```
/bt-plan <feature-spec> <optional-brief>
```
- **`<feature-spec>`** — the feature spec file to create a plan for. This is the *blueprint*.
- **`<optional-brief>`** — the brief or instructions for generating the plan. This is the *variable*.
- Never guess a file path or URL. Resolve the arguments as follows:
  - **Both a spec file and a brief** → normal full planning.
  - **A spec file only** → normal full planning; the brief defaults to "Generate a detailed implementation plan".
  - **A brief only, no spec file** → **Quick Plan mode** (see below). Do not ask *for a spec file* — treat the brief as the feature request. But because there is no spec, **interview the user with clarifying questions** to pin down the requirements before finalizing the plan.
  - **Neither** → ask the user for at least a brief before starting.

Example:
```
/bt-plan → @feature_spec.md → "Generate a detailed implementation plan"
/bt-plan → "add a settings toggle to mute all game audio"   # no spec file → Quick Plan mode, automatically
```

---

## Quick Plan mode (no feature spec file)

> 🛑 **"Quick" refers ONLY to skipping the spec file — never to skipping steps, and NEVER to executing the plan.**
> Quick Plan is still **PLANNING MODE**. It ends the moment `_specs/<feature-name>_plan.md` is written. Do **NOT** implement any task, do **NOT** edit application/source files, do **NOT** run builds or tests, and do **NOT** continue into the tasks you just wrote — not even the first one, not even if the tasks look small, obvious, or trivially automatable. The user executes tasks separately with the **bt-execute** skill, deliberately, with a clean context between steps. Auto-executing destroys that workflow.

When invoked with a brief but **no feature spec file**, produce a plan from the brief. Do not stop to ask *for a spec file* — instead **interview the user** to build a **mini-spec** from their answers, then plan from that mini-spec exactly as you would from a real spec file. A spec is largely the product of that Q&A; skipping the file must not mean skipping the questions. Everything the skill would normally read from the feature spec is supplied by sensible defaults only as a **last-resort fallback** for anything left unanswered:

| Normally from the spec | Quick Plan default |
| --- | --- |
| Feature name (for `<feature-name>_plan.md`) | Derive a short kebab-case name from the brief (e.g. "mute all game audio" → `mute-game-audio`). |
| Full feature requirements | Use the brief itself as the requirements, expanded by the Step 1 codebase analysis. |
| `spec_impact: yes/no` | **Infer** it from the Step 1 analysis: `yes` if the feature adds/changes a system, convention, dependency, or architectural decision; otherwise `no`. |
| `Project Spec Alignment` section | Derive alignment directly from root `SPEC.md` + the analysis. |

**The one and only difference in Quick Plan mode is operating without a spec file** — the interview produces a mini-spec that stands in for it. Everything else is identical to a normal run: Step 1's comprehensive codebase analysis (including reading root `SPEC.md`) runs in full, the plan document has the same structure, the SPEC.md write-back task is still appended when the inferred `spec_impact` is `yes`, and the run still **STOPS after writing the plan file**. Nothing about Quick Plan grants permission to implement.

Emit one visible status line when this path is taken: `⚡ [bt-plan] Quick Plan mode — no feature spec file; interviewing, then planning from the brief`.

### Finishing a Quick Plan (hard stop)

After writing `_specs/<feature-name>_plan.md`, **STOP**. Your final response must be a short summary of the plan plus the exact next-step hint below — and nothing else. Do not begin T1. Do not offer to "go ahead and start". If the user wants execution, they will invoke bt-execute themselves:

```
Plan written to _specs/<feature-name>_plan.md
Run a single task with `bt-execute _specs/<feature-name>_plan.md T1`, or every task with `bt-execute _specs/<feature-name>_plan.md ALL`.
```

### Interview before planning (Quick Plan)

Because there is no spec, the clarifying questions the spec process would have asked are now **your** responsibility. After the Step 1 analysis (so your questions are grounded in the real codebase, not generic), and **before** writing the plan:

- Ask the user a focused round of clarifying questions covering the things that most change the plan: scope and non-goals, target UX/behavior, edge cases, which existing systems/files it should integrate with, constraints, and — critically — anything ambiguous in the brief or where the codebase suggests more than one reasonable approach.
- Prefer a small number of high-leverage questions (grouped, easy to answer) over interrogating the user. Do not ask about things the brief or codebase already make clear.
- Only fall back to the defaults table for items the user leaves unanswered or explicitly says "you decide". Never silently pick a default when a quick question would materially improve the plan.
- If the user declines to answer or says "just make the plan", proceed with the defaults and state which assumptions you made in the plan's Codebase Analysis section.

The goal is the same as a spec: a plan optimized to what the user actually wants — reached by asking, not by guessing.

---

## ⚠️ Required Reading Before Any Babylon Work

For any task involving Babylon, BabylonJS, or the Babylon Toolkit, first ensure you have already fetched and read the Babylon Toolkit Agent Reference in the current remembered session/context:

https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md

If you have not read it in this session/context, or you no longer remember it due to context loss/compaction, fetch and read it before scaffolding or writing code.

Do not refetch the Agent Reference repeatedly during the same remembered session/context, including across spec, plan, and execute phases, if you are still aware of its contents.

Treat the Agent Reference as the authority for conventions, API, and patterns. It routes to deeper docs. Fetch linked subpages only when they are relevant to the task, and do not refetch a subpage in the same remembered session/context unless you no longer remember it.

If a required fetch fails, STOP and tell me. Do not guess at the API.

---

## Planning mode — do not implement

This command runs in PLANNING MODE. Research read-only and produce ONLY the technical plan document. Do NOT implement the feature, edit any existing application/source files, or run build, test, or other shell commands. The only file you may create is the plan markdown in `_specs/`, named `<feature-name>_plan.md`.

**This applies identically in Quick Plan mode.** Planning and execution are deliberately separate skills: `bt-plan` writes the plan, `bt-execute` runs it — one task at a time, with a clean context between tasks, at the user's discretion. Rolling straight from planning into implementation defeats the entire purpose of that split. Writing the plan file is the LAST action of this skill in every mode.

## Step 0. Confirm planning mode

A trustworthy plan requires a thorough, read-only investigation of the codebase before any plan is written.

- This skill is intended to run as a read-only planning pass. If you have been invoked in a mode that would modify source, begin your response with a short visible warning that you will only produce the plan document, then continue.
- Either way, you MUST still perform the comprehensive analysis in Step 1 with full rigor. Never skip it.

## Step 1. Comprehensive project analysis (REQUIRED before any plan)

This analysis can be **fanned out**. First check whether you actually have a subagent-spawning tool, and **emit one visible status line** so the user can see the path chosen — either `🔀 [bt-plan] subagent tool detected — fanning out analysis to N read-only subagents` or `➡️ [bt-plan] no subagent tool — analyzing sequentially`. If a subagent-spawning tool is available to you (e.g. Claude Code's `Task`, Lovable's subagent tool, or your host's equivalent — check the tools you actually have; if there is none, or you are unsure, do the analysis yourself sequentially), launch up to 3 parallel **read-only** exploration subagents and divide the eight investigation points below among them (for example: one maps structure/build and dependencies; one extracts the real conventions and the closest existing feature to mirror; one lists integration points and constraints). Each subagent returns concise conclusions — findings and file paths, not file dumps — which you synthesize into the `## Codebase Analysis` section. Exploration subagents need not re-read the Agent Reference. Never call a subagent tool you do not actually have.

Before writing a single implementation step, investigate the actual codebase read-only. This is mandatory — do NOT generate any plan content until this analysis is complete. Read and search the repo to discover, not assume:

1. Read the referenced feature spec in full (from `_specs/` or the file named in `arguments`), **and read the project `SPEC.md` at the repository root in full.** SPEC.md is the source of truth for the durable architecture, systems, conventions, and decisions — the plan MUST conform to it. Note the feature spec's `spec_impact` field and its `Project Spec Alignment` section. **In Quick Plan mode there is no feature spec file** — treat the brief as the feature request, still read root `SPEC.md` in full, and *infer* the `spec_impact` and Project Spec Alignment from the analysis per the Quick Plan defaults table. If the plan you are about to write would conflict with SPEC.md (contradict a decision, cross a system boundary, break a convention), STOP and flag the conflict to the user before writing the plan; do not silently override the project spec.
2. Map the project: top-level structure, entry points, how the app is built and run (build scripts, test runner, package manifests).
3. Identify the conventions actually used in this repo: naming, file/folder organization, state management, styling, error handling, testing patterns.
4. Find the closest existing feature(s) or modules to the one being planned and study how they are implemented — the plan should follow these patterns.
5. List the concrete integration points the feature will touch: files, modules, APIs, data models, routes, config.
6. Note relevant dependencies already available (and their versions) versus anything new that would be required.
7. Capture any constraints from the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) and the feature spec.
8. If the feature builds on a **sibling-skill pattern** (e.g. bt-design's 3D-Hero-Scroll), read that sub-skill's reference **and its templates**. The plan MUST **copy and configure the sub-skill's template engine — never re-implement it from memory**; re-implementation is exactly how documented behaviors (`sweep`, veiled cuts, the preload gate, HUD auto-hide, graceful degradation) silently get dropped. Turn every behavioral-config requirement the spec records (e.g. `sweep: page`) into a concrete task whose Acceptance asserts that behavior in observable terms.

If the spec or codebase is too ambiguous to analyze responsibly, stop and ask the user rather than guessing.

## Step 2. Write the plan

Only after Step 1 is complete, write the plan markdown to `_specs/` as `<feature-name>_plan.md`. The document MUST open with a `## Codebase Analysis` section that summarizes the findings from Step 1 (cite the real files/modules you inspected) — this is the evidence that the analysis happened. This section MUST include a short **SPEC.md alignment** note: which SPEC.md sections the plan conforms to, and whether the feature is spec-impacting (carry over the feature spec's `spec_impact`, or in Quick Plan mode the value you inferred, and say it was inferred). A plan without a grounded analysis section is invalid; do not produce one.

Then write the implementation as an ordered checklist of discrete tasks. Use GitHub-style checkboxes so progress can be tracked directly in the file — one task per line, numbered T1, T2, T3 … in dependency order, each small enough to be implemented and verified on its own:

```markdown
## Tasks

- [ ] **T1** — <short task title>
  - Files: `path/one`, `path/two`
  - Details: <what to do>
  - Acceptance: <how to know it is done>
- [ ] **T2** — <short task title>
  - Files: `...`
  - Details: <...>
  - Acceptance: <...>
```

When a task implements a **sibling-skill pattern**, its **Acceptance** must assert the skill-defined behavior in observable terms — e.g. for `sweep: page`, "PLAY auto-scrolls through to the document bottom and END jumps there", not merely "the hero renders". A plausible-looking result that dropped a documented behavior must fail acceptance. Prefer copying the sub-skill's template files as an early task (e.g. "T1 — copy + wire the 3D-Hero-Scroll engine") so later tasks only configure it.

### SPEC.md write-back task (required when the feature is spec-impacting)

If the feature is spec-impacting (`spec_impact: yes`, or your analysis found it adds/changes a system, convention, dependency, or architectural decision), the plan MUST end with an explicit final task that updates the project spec, so the write-back is tracked and independently verified like any other task — never left as a soft afterthought:

```markdown
- [ ] **T<n>** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: Update the specific SPEC.md section(s) named in the feature spec's Project Spec Alignment — e.g. add/modify the affected Game System, record the new Convention or Decision (with rationale), and add any new Dependency + version. Follow SPEC.md's "How to update this spec" contract: **replace/merge** the current-state sections (Architecture, Game Systems, Conventions, Dependencies) — removing seed placeholders on first real content — and **append** to the Decisions log (never delete; supersede with a newer entry).
  - Acceptance: SPEC.md accurately describes the architecture/systems/conventions/dependencies as actually implemented by the tasks above; no section contradicts the shipped code; new dependencies are listed.
```

Make this the LAST task so it captures the true final state. If the feature is genuinely not spec-impacting (`spec_impact: no`), omit this task, but state in the Codebase Analysis that no SPEC.md change is required.

Finally, include this exact `## How to execute this plan` section verbatim in the document so the plan is self-describing no matter how it is later run:

```markdown
## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
```
