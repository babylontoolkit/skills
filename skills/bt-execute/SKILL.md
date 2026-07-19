---
name: bt-execute
description: "The Babylon Toolkit Execute Skill runs one task — or all remaining tasks — from a feature plan or spec file. Use when asked to run a task (e.g. `bt-execute @plan T1`) or all tasks (e.g. `bt-execute @plan ALL`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com), Task
---

Execute work from the referenced feature plan or spec file — either a single task, or every remaining task in order. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user’s message after the skill name as the `arguments`.

---

# Invocation

```
/bt-execute <plan> <task-id> <optional-brief>
```
- **`<plan>`** — the feature plan or spec file to execute tasks from. This is the *blueprint*.
- **`<task-id>`** — the specific task to execute, or `NEXT` or `ALL` to execute all remaining tasks. This is the *variable*.
- **`<optional-brief>`** — the brief or instructions for executing the task. This is the *variable*.
- If either is missing, ask for it before starting. Never guess a file path or URL.

Example:
```
/bt-execute → @plan.md → T1 → "Implement the first task in the plan"
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

## ⚠️ The Project Specification (SPEC.md) — read before executing

The project's **SPEC.md** at the repository root is the source of truth for the durable architecture, systems, conventions, and decisions. **Read it before executing any task**, and follow it while implementing (it constrains how you build, not just what).

- Implement in a way that conforms to SPEC.md's architecture, systems, and conventions.
- **If reality diverges from SPEC.md during execution** — the code as it actually exists contradicts the spec, or the task can only be done by breaking a documented decision/convention — STOP and flag it to the user. Do not let the spec and the code silently drift apart.
- **This is the write-up half of the spec-driven loop.** When a task changes the architecture, a system, a convention, or a dependency, SPEC.md must end up matching what was built. A well-formed plan makes this an explicit final `Update SPEC.md` task (see below); if you are executing a plan that changes architecture but has no such task, flag the gap and update SPEC.md as part of completing the work rather than leaving it stale.
- Record any new dependency in SPEC.md's Dependencies section as part of the task that introduces it.
- When writing back, follow SPEC.md's **"How to update this spec"** contract, keyed off each section's heading tag: **replace/merge** the current-state sections (Architecture, Game Systems, Conventions, Dependencies), removing seed placeholders on first real content and keeping the text matching the shipped code; **append** to the Decisions log (newest last), superseding rather than deleting.

The `Update SPEC.md` task is a task like any other: it goes through the same acceptance verification below before its checkbox is flipped — the spec write-back is verified, not assumed.

---

## Step 1. Parse the arguments

From `arguments`, extract:

1. `source_file` — the plan or spec file reference to read tasks from (e.g. `_specs/new-heist-form_plan.md` or `_specs/new-heist-form_spec.md`).
2. `task_id` — either the identifier of a single task to execute (e.g. `T1`, `T2`, `T3.1`), or the literal word `NEXT` (case-insensitive, they are synonyms) to execute just the next remaining task, or the literal word `ALL` (case-insensitive) to execute every remaining task in order. If none is provided, list the available task ids and their checked/unchecked status from `source_file` and ask the user what to run. DO NOT guess or pick one yourself.

## Verifying a task before checking its box

Before changing any task's `- [ ]` to `- [x]` (this applies to every mode below), verify its **Acceptance** criteria are genuinely met. At the start of the run, **emit one visible status line** so the user sees which verification path is in effect — either `🔍 [bt-execute] subagent tool detected — using an independent verifier before each checkbox` or `🔍 [bt-execute] no subagent tool — self-verifying before each checkbox` — and when you report each task, note whether it was `verified (independent subagent)` or `verified (self)`. If a subagent-spawning tool is available to you (e.g. Claude Code's `Task`, Lovable's subagent tool, or your host's equivalent — check the tools you actually have), launch an **independent verifier subagent**: give it the task's Details + Acceptance and the changes just made, and instruct it to adversarially confirm the criteria — actively look for a reason they are NOT met, inspecting files and running the relevant build/test/commands as needed — then return PASS/FAIL with evidence. Flip the checkbox only on PASS. On FAIL, leave it `- [ ]`, do not touch later tasks, and report what failed. If no subagent tool is available (or you are unsure), self-verify the Acceptance the same way before flipping — never call a subagent tool you do not have. The verifier need not re-read the Agent Reference. Never check a box for partial, skipped, or unverified work.

**Sibling-skill behaviors are part of Acceptance.** When a task implements a feature built on a sibling-skill template engine (e.g. bt-design's 3D-Hero-Scroll), the verifier must confirm the skill-defined behavioral options are actually present and correct — e.g. `sweep: page` means PLAY/END genuinely reach the **document bottom**, not just the journey's end. A plausible-looking result that silently dropped or inverted a documented behavior is a **FAIL**, even if the surface looks right. Likewise, if a task re-implemented a sub-skill's engine from memory instead of copying its template (dropping veiled cuts, the preload gate, degradation, etc.), flag it and fail the task.

## Testing is handled by a subagent

Testing for each task is owned by a dedicated **testing subagent** — separate from the verifier above. It runs **after the task is implemented and before the acceptance verifier**, so tests exist and pass before a checkbox can flip. At the start of the run, **emit one visible status line** for the testing path — either `🧪 [bt-execute] subagent tool detected — delegating test authoring + runs to a testing subagent` or `🧪 [bt-execute] no subagent tool — authoring and running tests inline` — and when you report each task, note the test outcome (e.g. `tests: 4 passed (testing subagent)` or `tests: 4 passed (inline)`).

For each task, unless the task genuinely has no testable surface (pure config/docs/asset moves — say so explicitly rather than skipping silently):

1. If a subagent-spawning tool is available to you (check the tools you actually have; if there is none, or you are unsure, do this inline yourself — never call a subagent tool you do not have), launch a **testing subagent** and give it: the task's Details + Acceptance, the changes just made, the project's test conventions/runner, and the feature spec's `Testing Guidelines`. Instruct it to (a) author meaningful test file(s) under `./tests` (or wherever this repo's tests live) covering the task's Acceptance and its likely edge cases — following existing test patterns, without over-testing — then (b) run the test suite (or at least the relevant tests) and return the command used, PASS/FAIL, and the failing output on failure. The testing subagent need not re-read the Agent Reference.
2. Treat a test **FAIL** exactly like an acceptance failure: fix the implementation (not the test, unless the test is wrong) and re-run until green, or if it cannot pass, leave the box `- [ ]`, do not touch later tasks, and report which task's tests failed and why.
3. Only once tests are green does the acceptance verifier run. The verifier may re-run the tests as part of its adversarial check — that overlap is intentional. The checkbox flips only when both tests pass **and** the verifier returns PASS.

The `Update SPEC.md` task and other non-code tasks typically have no test surface — note that explicitly and let the acceptance verifier alone gate them.

## Step 2. Single-task mode (`task_id` is a specific id)

Read `source_file` and find the task whose id matches `task_id`. If it cannot be found, print the list of available task ids from the file and STOP without implementing anything.

Then implement ONLY that single task. This is a hard rule:

- Do not start, scaffold, refactor for, or partially implement any other task, even if it looks trivial, related, or "while you're here".
- Stay within the scope described by the task. If the task is ambiguous or blocked by an unfinished prerequisite task, stop and tell the user instead of expanding scope.
- Follow all project rules in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) and any referenced spec/plan conventions.

When the task is implemented, **verify its Acceptance per _Verifying a task before checking its box_ above**; only on PASS mark ONLY this task complete: edit its line and change `- [ ]` to `- [x]` (leave every other task untouched). Never check the box for partial or unverified work.

Then report: the task id and what it required, the files you changed, any tests/build you ran and their result, and the next task id (for reference only — do NOT start it). Do not continue to the next task.

## Step 3. Next-task mode (`task_id` is `NEXT`)

`NEXT` is used to advance one task at a time without having to track the individual task id yourself.

Read `source_file` and collect the task checklist in order. Find the FIRST task still marked `- [ ]` (skip every task already marked `- [x]`). That task becomes the one to execute.

- If there is no unchecked task, report that the plan is already fully complete and STOP without changing anything.
- Otherwise, execute ONLY that single task, following the exact same scope discipline, project conventions, and completion rules as single-task mode (Step 2): implement only that task, then **verify its Acceptance (see _Verifying a task before checking its box_)** and only on PASS change its `- [ ]` to `- [x]`, leaving every other task untouched.

Then report: the task id you just ran and what it required, the files you changed, any tests/build you ran and their result, and the next remaining task id (for reference only — do NOT start it). Do not continue to the next task; the user will run `NEXT` again to advance.

## Step 4. Run-all mode (`task_id` is `ALL`)

Execute every remaining task in the plan, in order, resuming wherever it was left off:

1. Read `source_file` and collect the task checklist in order.
2. Treat tasks already marked `- [x]` as DONE — skip them. The remaining `- [ ]` tasks are the work queue. (This is what makes `ALL` resumable across interruptions and even brand new conversations.)
3. For each unchecked task, in order, one at a time:
   a. Implement ONLY that task, following the same scope discipline and project conventions as single-task mode.
   b. Once it is implemented, **verify its Acceptance (see _Verifying a task before checking its box_)**; only on PASS immediately edit `source_file` to change that task's `- [ ]` to `- [x]` BEFORE starting the next task. Persisting progress after each task is what lets a later run of the execute skill with `ALL` safely continue.
   c. If a task cannot be completed, is blocked, or its acceptance criteria are not met, STOP: leave it unchecked, do not touch any later task, and report which task failed and why.
4. When all tasks are checked (or you stopped early), report a summary: which tasks you completed this run, the current completed/total count, and whether the plan is now fully done.

Never check a box for partial, skipped, or unverified work in either mode.
