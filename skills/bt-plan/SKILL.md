---
name: bt-plan
description: The Babylon Toolkit Plan Skill creates the detailed technical plan for the specified feature spec file. Use when asked to plan or produce implementation tasks for an existing spec.
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
- If either is missing, ask for it before starting. Never guess a file path or URL.

Example:
```
/bt-plan @feature_spec.md "Generate a detailed implementation plan"
```

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

## Step 0. Confirm planning mode

A trustworthy plan requires a thorough, read-only investigation of the codebase before any plan is written.

- This skill is intended to run as a read-only planning pass. If you have been invoked in a mode that would modify source, begin your response with a short visible warning that you will only produce the plan document, then continue.
- Either way, you MUST still perform the comprehensive analysis in Step 1 with full rigor. Never skip it.

## Step 1. Comprehensive project analysis (REQUIRED before any plan)

This analysis can be **fanned out**. First check whether you actually have a subagent-spawning tool, and **emit one visible status line** so the user can see the path chosen — either `🔀 [bt-plan] subagent tool detected — fanning out analysis to N read-only subagents` or `➡️ [bt-plan] no subagent tool — analyzing sequentially`. If a subagent-spawning tool is available to you (e.g. Claude Code's `Task`, Lovable's subagent tool, or your host's equivalent — check the tools you actually have; if there is none, or you are unsure, do the analysis yourself sequentially), launch up to 3 parallel **read-only** exploration subagents and divide the seven investigation points below among them (for example: one maps structure/build and dependencies; one extracts the real conventions and the closest existing feature to mirror; one lists integration points and constraints). Each subagent returns concise conclusions — findings and file paths, not file dumps — which you synthesize into the `## Codebase Analysis` section. Exploration subagents need not re-read the Agent Reference. Never call a subagent tool you do not actually have.

Before writing a single implementation step, investigate the actual codebase read-only. This is mandatory — do NOT generate any plan content until this analysis is complete. Read and search the repo to discover, not assume:

1. Read the referenced feature spec in full (from `_specs/` or the file named in `arguments`), **and read the project `SPEC.md` at the repository root in full.** SPEC.md is the source of truth for the durable architecture, systems, conventions, and decisions — the plan MUST conform to it. Note the feature spec's `spec_impact` field and its `Project Spec Alignment` section. If the plan you are about to write would conflict with SPEC.md (contradict a decision, cross a system boundary, break a convention), STOP and flag the conflict to the user before writing the plan; do not silently override the project spec.
2. Map the project: top-level structure, entry points, how the app is built and run (build scripts, test runner, package manifests).
3. Identify the conventions actually used in this repo: naming, file/folder organization, state management, styling, error handling, testing patterns.
4. Find the closest existing feature(s) or modules to the one being planned and study how they are implemented — the plan should follow these patterns.
5. List the concrete integration points the feature will touch: files, modules, APIs, data models, routes, config.
6. Note relevant dependencies already available (and their versions) versus anything new that would be required.
7. Capture any constraints from the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) and the feature spec.

If the spec or codebase is too ambiguous to analyze responsibly, stop and ask the user rather than guessing.

## Step 2. Write the plan

Only after Step 1 is complete, write the plan markdown to `_specs/` as `<feature-name>_plan.md`. The document MUST open with a `## Codebase Analysis` section that summarizes the findings from Step 1 (cite the real files/modules you inspected) — this is the evidence that the analysis happened. This section MUST include a short **SPEC.md alignment** note: which SPEC.md sections the plan conforms to, and whether the feature is spec-impacting (carry over the feature spec's `spec_impact`). A plan without a grounded analysis section is invalid; do not produce one.

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
