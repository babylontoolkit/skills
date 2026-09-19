---
name: bt-execute
description: "The Babylon Toolkit Execute Skill runs one task — or all remaining tasks — from a feature plan or spec file. Use when asked to run a task (e.g. `bt-execute @plan T1`), all tasks (e.g. `bt-execute @plan ALL`), or a range (e.g. `bt-execute @plan T3-T7`, `T12-`, `NEXT:3`); with no task id it runs the next unchecked task. Add `--auto-pilot` for an unattended run (e.g. `bt-execute --auto-pilot @plan ALL`): every decision is made autonomously from the plan, the Babylon Toolkit Agent Reference and the codebase, failing tasks are retried then deferred, and the run never stops for human input until the work queue is empty. By default verification is proportional (one scoped independent verifier per phase, browser/Unity QA on every task whose correctness shows only at runtime); add `--strict` for per-task adversarial verification (e.g. `bt-execute --strict @plan ALL`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

Execute work from the referenced feature plan or spec file — either a single task, or every remaining task in order. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user’s message after the skill name as the `arguments`.

---

# Invocation

```
/bt-execute [--auto-pilot] [--strict] <plan> <task-id> <optional-brief>
```
- **`--strict`** *(optional flag)* — **Strict mode**: full-rigor verification — an adversarial independent verifier on **every task**, live QA on every task with a rendered/exported surface, a full fresh re-verify on every fix attempt, and a 5-attempt fix loop. Without it the run uses **Standard mode** (see **Verification modes**). Like `--auto-pilot`, it may appear anywhere, is never part of the brief, and is stripped first. The two flags combine.
- **`--auto-pilot`** *(optional flag)* — **Auto-pilot mode**: an unattended run. Every decision is made by you, nothing stops for human input, failing tasks are retried and then deferred rather than halting the run. See **Auto-pilot mode**. The flag may appear anywhere in the arguments and is never part of the brief — **strip it first**, then resolve the rest below.
- **`<plan>`** — the feature plan or spec file to execute tasks from. This is the *blueprint*.
- **`<task-id>`** *(optional)* — what to run: a single task id (`T4`), a **range** (`T1-T10`, `T5-`, `NEXT:3`), `NEXT` (the next unchecked task), or `ALL` (every remaining task). **Defaults to `NEXT`** when omitted (`ALL` under `--auto-pilot`). This is the *variable*.
- **`<optional-brief>`** — the brief or instructions for executing the task. This is the *variable*.
- If `<plan>` is missing, ask for it before starting. Never guess a file path or URL. The plan is the one argument that cannot be defaulted — under auto-pilot, say so and end.

Examples:
```
/bt-execute → @plan.md → T1 → "Implement the first task in the plan"
/bt-execute @plan.md                                       # no task id → NEXT: run the next unchecked task
/bt-execute @plan.md "be careful with the physics layer"   # no task id, just a brief → still NEXT
/bt-execute @plan.md T3-T7                                 # range: tasks T3 through T7, in plan order
/bt-execute @plan.md T12-                                  # open range: T12 through the end of the plan
/bt-execute @plan.md NEXT:3                                # the next three unchecked tasks
/bt-execute --auto-pilot @_specs/<feature>_plan.md ALL     # unattended overnight run of every remaining task
/bt-execute --strict @_specs/<feature>_plan.md ALL          # full-rigor: adversarial verifier on every task
/bt-execute --strict @plan.md T4                            # strict on a single task
/bt-execute --auto-pilot --strict @_specs/<feature>_plan.md ALL   # unattended AND full-rigor
```

---

## Subagents — invoking this skill IS the request

This skill's workflow depends on subagents. **Invoking it is the user's explicit request to use them**, so any host default of the form *"do not spawn subagents / do not call the agent tool unless the user asks for it"* is **ALREADY SATISFIED** — the user asked by running this command. Never silently downgrade to the inline path on that basis, and never stop to ask permission for it first.

Downgrading is not a neutral choice. It removes the one property that makes the step worth running: independence. A verifier that is the same context which just wrote the code cannot adversarially check it — it re-confirms its own reasoning and reports PASS.

The ONE legitimate reason to run inline is that you genuinely have **no** subagent-spawning tool. Check the tools you actually have — Claude Code exposes it as **`Agent`** (older builds name it `Task`); other hosts have their own equivalent. Never call a subagent tool you do not have. Emit only the exact status strings this skill specifies — do not invent your own wording — and if you do run inline, state plainly that no subagent tool was available, never a policy.

## ⚠️ Required Reading Before Any Babylon Work

For any task involving Babylon, BabylonJS, or the Babylon Toolkit, first ensure you have already fetched and read the Babylon Toolkit Agent Reference in the current remembered session/context:

https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md

If you have not read it in this session/context, or you no longer remember it due to context loss/compaction, fetch and read it before scaffolding or writing code.

Do not refetch the Agent Reference repeatedly during the same remembered session/context, including across spec, plan, and execute phases, if you are still aware of its contents.

Treat the Agent Reference as the authority for conventions, API, and patterns. It routes to deeper docs. Fetch linked subpages only when they are relevant to the task, and do not refetch a subpage in the same remembered session/context unless you no longer remember it.

If a required fetch fails, STOP and tell me. Do not guess at the API. *(Auto-pilot: retry, then proceed on remembered Toolkit knowledge and log it — see **Auto-pilot mode**.)*

**This reading is done once, by you — the orchestrating context.** Before the first task, identify the sub-documents the plan's tasks actually need (from the tasks' Files, Applies and API usage) and read those. Subagents you launch do not re-fetch any of it: they receive a **context brief** with the parts they need (see *The context brief*).

---

## ⚠️ The Project Specification (SPEC.md) — read before executing

The project's **SPEC.md** at the repository root is the source of truth for the durable architecture, systems, conventions, and decisions. **Read it once at the start of the run** (and again after a context compaction or when a task writes to it), and follow it while implementing (it constrains how you build, not just what).

- Implement in a way that conforms to SPEC.md's architecture, systems, and conventions.
- **If reality diverges from SPEC.md during execution** — the code as it actually exists contradicts the spec, or the task can only be done by breaking a documented decision/convention — STOP and flag it to the user. Do not let the spec and the code silently drift apart. *(Auto-pilot: decide which is right, update SPEC.md in the same task, log the Decision — never stop.)*
- **This is the write-up half of the spec-driven loop.** When a task changes the architecture, a system, a convention, or a dependency, SPEC.md must end up matching what was built. A well-formed plan makes this an explicit final `Update SPEC.md` task (see below); if you are executing a plan that changes architecture but has no such task, flag the gap and update SPEC.md as part of completing the work rather than leaving it stale.
- Record any new dependency in SPEC.md's Dependencies section as part of the task that introduces it.
- When writing back, follow SPEC.md's **"How to update this spec"** contract, keyed off each section's heading tag: **replace/merge** the current-state sections (Architecture, Game Systems, Conventions, Dependencies), removing seed placeholders on first real content and keeping the text matching the shipped code; **append** to the Decisions log (newest last), superseding rather than deleting.

The `Update SPEC.md` task is a task like any other: it goes through the same verification (see *Verification modes*) before its checkbox is flipped — the spec write-back is verified, not assumed.

---

## Step 1. Parse the arguments

First strip the `--auto-pilot` and `--strict` flags if present and remember which modes are in effect for the whole run (**Auto-pilot mode**; **Strict** vs the default **Standard** verification mode). Then, from the remaining `arguments`, extract:

1. `source_file` — the plan or spec file reference to read tasks from (e.g. `_specs/new-heist-form_plan.md` or `_specs/new-heist-form_spec.md`).
2. `task_id` — the token immediately after `source_file`, **only if** it is one of these forms (all case-insensitive):
   - a single task id (e.g. `T1`, `T2`, `T3.1`) → **Single-task mode** (Step 2);
   - `NEXT` → **Next-task mode** (Step 3);
   - `ALL` → **Run-all mode** (Step 4);
   - a **range** → **Range mode** (Step 5): `T1-T10` (two ids joined by `-`), `T5-` (an id followed by `-`, meaning through the end of the plan), or `NEXT:3` (`NEXT:` followed by a positive integer).
   If the token after `source_file` is none of these forms, then no `task_id` was given: **default to `NEXT`** (or `ALL` when auto-pilot is engaged), and treat everything after `source_file` as the `optional-brief`. Never ask which task to run — the default is the answer. Never treat a brief as a task id: a `task_id` must match one of the forms above exactly.
3. `brief` — whatever remains after `source_file` and `task_id`. It shapes *how* the selected task(s) are done, never *which* tasks are selected.

## Verification modes — Standard (default) and Strict (`--strict`)

Every mode keeps the same gates: tests are written and green, an **independent verifier** checks the work, SPEC.md is written back, and a box flips **only on a genuine PASS**. The modes differ only in *how often* the verifier runs and *how far* it digs. Proportional rigor is not less rigor: a scoped check of a two-line change is a complete check.

At the start of the run, **emit one visible status line** for the mode in effect:
- `⚡ [bt-execute] Standard mode — scoped verifier per phase; add --strict for per-task adversarial verification`
- `🔒 [bt-execute] Strict mode — per-task adversarial verification`

and one for the verification path — `🔍 [bt-execute] subagent tool detected — using an independent verifier` or `🔍 [bt-execute] no subagent tool — self-verifying`. When you report each task, note `verified (independent subagent)` or `verified (self)`.

| | **Standard** (default) | **Strict** (`--strict`) |
|---|---|---|
| Verifier runs | once per **phase** (see *Phases*) | once per **task** |
| Verifier charter | scoped (below) | adversarial (below) |
| Live QA (Unity export / dev server / browser screenshots) | every task whose correctness shows only at runtime (rendering, visuals, interaction, Unity↔Babylon parity), marked `live` or not, plus the final end-to-end check | every task with a rendered or exported surface |
| Re-verify after a fix | only the failed items, by a fresh verifier given the prior FAIL list | a full fresh re-verify of the task |
| Fix-loop attempts | 3 | 5 |

### Phases (Standard mode)

The verifier runs once per phase, not once per task. A phase is a `### Phase N` group in the plan. If the plan has no phase headings, batch the work queue into runs of **up to 3 consecutive tasks**; a task marked `Verify level: live`, the `Update SPEC.md` task, and the last task in the work queue each close a batch. Single-task and `NEXT` modes are a phase of one.

Within a phase, implement the tasks in order, one at a time, each with its own tests green (see *Tests*), **without flipping boxes yet**. Then launch one verifier for the whole phase. It returns a verdict **per task**: flip the box of every task that PASSed; each FAILed task enters the fix loop. A task that depends on a FAILed task in the same phase stays unchecked until that task passes. Resume behavior is unchanged: the next run starts at the first unchecked task.

### Tests (both modes — owned by the implementer, judged by the verifier)

There is no separate testing subagent. Whoever implements a task (you, or the implementer subagent under auto-pilot) also writes its tests. Unless the task genuinely has no testable surface (pure config/docs/asset moves — say so explicitly rather than skipping silently):

1. Author the test cases the plan's `Tests:` field names (or, with none named, meaningful cases covering the task's Acceptance and its likely edge cases, from the feature spec's `Testing Guidelines`), in the repo's existing test location and patterns — under `./tests` if there is no convention. Do not over-test.
2. Run them (and the relevant suite) until green, fixing the implementation, not the test, unless the test is wrong.
3. Report the command and result per task, e.g. `tests: 4 passed (implementer) · verifier-checked`.

The **verifier owns test judgment**: it re-runs the tests itself and checks that they exercise each Acceptance item and the plan's named edge cases. Missing tests, or a test that cannot fail (vacuous, asserts nothing, mocks away the behavior under test), is a **FAIL** for that task, exactly like broken code.

### The verifier

If a subagent-spawning tool is available (check the tools you actually have — Claude Code's `Agent`, Lovable's subagent tool, or your host's equivalent), launch an **independent verifier subagent** with a fresh context. Give it the **context brief** (below), the Details + Acceptance + Verify of each task it checks, and the list of changes made. It returns PASS/FAIL **per task** with evidence. If no subagent tool is available (or you are unsure), self-verify with the same charter — never call a subagent tool you do not have.

**Scoped charter (Standard mode)** — the verifier is told:
> Confirm each task's Acceptance items are genuinely met, and run each task's `Verify` commands, comparing against the stated expected output. Re-run the tests and the relevant suite once; check the tests actually cover the Acceptance items and named edge cases and could fail. Read the diff and look for real defects: logic errors, broken callers, unhandled edge cases the plan names, a documented behavior dropped or inverted, a sibling-skill template re-implemented instead of copied. Do live QA (dev server / browser / Unity) for every task whose correctness shows only at runtime — rendered output, visuals, interaction, Unity↔Babylon parity — whether or not the plan marks it `live`, and for the final end-to-end check; passing unit tests never substitute for it. Do the phase's live checks in one session on the already-running dev server, and re-export from Unity only when the phase changed Unity-side content. Check an absolute count in the plan (tests passed, suite size) as "named tests pass, no new failures versus baseline"; a count that is stale only because earlier tasks added tests is records-only. Out of scope unless something you found points there: mutation testing, generated oracles or fuzzing, re-deriving the plan's decisions, forced restarts of editors or servers, auditing files the phase did not touch. Aim for roughly 25 tool calls; if you find yourself going far past that, report what you have and what you would check next rather than expanding. Return PASS/FAIL per task with evidence.

**Adversarial charter (Strict mode)** — the verifier is told:
> Adversarially confirm the task's Acceptance: actively look for a reason it is NOT met. Inspect the files, run the build, the tests and the `Verify` commands, and use any technique you judge worthwhile — mutation checks against the tests, oracles or randomized inputs for non-trivial logic, re-deriving values from the plan's Decisions and Design Reference, live QA for any rendered or exported surface. Return PASS/FAIL with evidence.

In both modes a plausible-looking result that silently dropped a documented behavior is a **FAIL**, and records-only defects (a stale ledger line, a wrong count in a notes file) are reported separately from code defects so they can be fixed cheaply (see the fix loop). Never check a box for partial, skipped, or unverified work.

**Sibling-skill behaviors are part of Acceptance.** When a task implements a feature built on a sibling-skill template engine (e.g. bt-design's 3D-Hero-Scroll), load that sub-skill before verifying — you cannot check a behavior against a spec you have not read. *(Where skills are loaded with a tool — the Babylon Toolkit App Builder platform — call `load_skill('<name>')`, then fetch its references with `read_skill_resource` using the paths the load returns, never a guessed path. Where skills are files on disk — Claude Code — read them from `~/.claude/skills/` or the project's `.claude/skills/`. Skip the load for anything already in your context.)* Put the relevant excerpt of that skill in the verifier's brief. The verifier must confirm the skill-defined behavioral options are actually present and correct — e.g. `sweep: page` means PLAY/END genuinely reach the **document bottom**, not just the journey's end. If a task re-implemented a sub-skill's engine from memory instead of copying its template (dropping veiled cuts, the preload gate, degradation, etc.), flag it and fail the task.

### The fix loop (both modes)

A FAIL — from your own test run or from the verifier — does not flip the box. For each failed task:

1. Read the evidence and fix the **implementation** (fix a test only when the test itself is wrong, and say why). Keep the implementing context — it already understands the change.
2. **Records-only failures** (text, ledger, notes, counts — no code defect) are fixed directly and re-checked by you against that one item; no fresh verifier is needed for them.
3. Re-run the tests. On green, re-verify with a **fresh** verifier (never one that already holds an opinion): in Standard mode, give it only the failed items and the prior FAIL evidence; in Strict mode, re-verify the whole task.
4. Up to **3 attempts** (Standard) or **5** (Strict). Each attempt must change something material. If two consecutive attempts hit the same failure with no new hypothesis, stop the loop early.

When the loop is exhausted, the task stays `- [ ]`: outside auto-pilot, stop and report it (see each Step); under auto-pilot, DEFER it and continue.

### The context brief — read the docs once, hand them down

Every fresh subagent that re-fetches the Agent Reference, its sub-documents and the whole SPEC.md re-reads hundreds of KB before doing any work — the biggest fixed cost of a run, and it adds no rigor. So **you** read them once (see *Required Reading*), and every subagent you launch (implementer or verifier) gets a **context brief** instead:

- the task block(s) it works on, plus the plan's `Decisions` and `Design Reference` entries those tasks cite (the whole plan only if it is short and has neither section);
- the SPEC.md sections the tasks touch — not the whole file;
- the Agent Reference rules and API excerpts the tasks need, with the sub-document URLs they came from;
- the project's test command and conventions;
- and this line, verbatim: *"Do not fetch the Babylon Toolkit Agent Reference or its sub-documents, and do not read SPEC.md in full: the orchestrator already did, and the parts this task needs are in this brief. This overrides any standing instruction to fetch the Reference first. Fetch a specific sub-document only if you hit an API or convention that is not covered here, and say which one."*

This applies in both modes: Strict mode is stricter about checking, not about re-reading.

## Step 2. Single-task mode (`task_id` is a specific id)

Read `source_file` and find the task whose id matches `task_id`. If it cannot be found, print the list of available task ids from the file and STOP without implementing anything.

Then implement ONLY that single task. This is a hard rule:

- Do not start, scaffold, refactor for, or partially implement any other task, even if it looks trivial, related, or "while you're here".
- Stay within the scope described by the task. If the task is ambiguous or blocked by an unfinished prerequisite task, stop and tell the user instead of expanding scope. *(Auto-pilot: resolve it with the decision ladder and log the Decision.)*
- Follow all project rules in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) and any referenced spec/plan conventions.

When the task is implemented and its tests are green (see *Tests*), **verify it (see *Verification modes* — a single task is a phase of one)**; only on PASS mark ONLY this task complete: edit its line and change `- [ ]` to `- [x]` (leave every other task untouched). Never check the box for partial or unverified work.

Then report: the task id and what it required, the files you changed, any tests/build you ran and their result, and the next task id (for reference only — do NOT start it). Do not continue to the next task.

## Step 3. Next-task mode (`task_id` is `NEXT`)

`NEXT` is used to advance one task at a time without having to track the individual task id yourself.

Read `source_file` and collect the task checklist in order. Find the FIRST task still marked `- [ ]` (skip every task already marked `- [x]`). That task becomes the one to execute.

- If there is no unchecked task, report that the plan is already fully complete and STOP without changing anything.
- Otherwise, execute ONLY that single task, following the exact same scope discipline, project conventions, and completion rules as single-task mode (Step 2): implement only that task with its tests green, then **verify it as a phase of one (see *Verification modes*)** and only on PASS change its `- [ ]` to `- [x]`, leaving every other task untouched.

Then report: the task id you just ran and what it required, the files you changed, any tests/build you ran and their result, and the next remaining task id (for reference only — do NOT start it). Do not continue to the next task; the user will run `NEXT` again to advance.

## Step 4. Run-all mode (`task_id` is `ALL`)

Execute every remaining task in the plan, in order, resuming wherever it was left off:

1. Read `source_file` and collect the task checklist in order.
2. Treat tasks already marked `- [x]` as DONE — skip them. The remaining `- [ ]` tasks are the work queue. (This is what makes `ALL` resumable across interruptions and even brand new conversations.)
3. Split the work queue into verification units: **phases** in Standard mode (see *Phases*), **single tasks** in Strict mode. For each unit, in order:
   a. Implement its tasks in order, one at a time, ONLY that task each time, following the same scope discipline and project conventions as single-task mode, with each task's tests green before starting the next.
   b. **Verify the unit (see *Verification modes*)**; for every task that PASSes, immediately edit `source_file` to change its `- [ ]` to `- [x]` BEFORE starting the next unit. Persisting progress after each unit is what lets a later run of the execute skill with `ALL` safely continue.
   c. A FAILed task enters the fix loop. If it still cannot pass, or a task cannot be completed or is blocked, STOP: leave it unchecked, do not start any later unit, and report which task failed and why. *(Auto-pilot: never stop here — run the fix loop, then DEFER the task and continue with the next one; see **Auto-pilot mode**.)*
4. When all tasks are checked (or you stopped early), report a summary: which tasks you completed this run, the current completed/total count, and whether the plan is now fully done.

Never check a box for partial, skipped, or unverified work in either mode.

## Step 5. Range mode (`task_id` is `T1-T10`, `T5-` or `NEXT:3`)

Range mode is **Run-all mode restricted to a slice of the checklist**. Everything in Step 4 applies unchanged — one task at a time, in order, skip `- [x]`, tests green per task, verifier per phase (per task under `--strict`), flip boxes immediately on PASS, stop (or, under auto-pilot, defer and continue) on failure — except that the work queue is the slice, not the whole plan.

**A range is a slice of the checklist in plan order, never arithmetic on the numbers.** Read `source_file`, collect the task checklist in file order, then resolve the slice:

- **`T<a>-T<b>`** — every task from the one whose id is `T<a>` through the one whose id is `T<b>`, **inclusive**, as they appear in the file. Sub-tasks (`T3.1`, `T3.2`) sitting between the endpoints are part of the slice. `T3-T3` is the same as `T3`.
- **`T<a>-`** — from the task whose id is `T<a>` through the last task in the file.
- **`NEXT:<n>`** — the first `n` tasks that are still `- [ ]`, in file order, wherever they sit. `NEXT:1` is the same as `NEXT`. If fewer than `n` remain, run the ones that do and say so.

Rules:

- Both endpoint ids must exist in `source_file`. If either does not, print the list of available task ids and STOP without implementing anything. *(Auto-pilot: the one exception to "never stop" besides a missing plan — a mistyped range is a typo the user must fix. Say so and end.)*
- The start must come **before or at** the end in file order. A reversed range (`T10-T1`) is an error — report it and STOP; never silently swap the endpoints.
- Tasks already `- [x]` inside the slice are skipped, so a range is resumable exactly like `ALL`: re-running the same range continues from its first unchecked task. If every task in the slice is already checked, report that and STOP without changing anything.
- Tasks **outside** the slice are never touched, even when a task inside the slice depends on an unchecked task outside it. In that case treat the dependency as a blocker per Step 4 3c: stop and report it. *(Auto-pilot: apply the prerequisite row of the stop-replacement table — do the minimum of the outside task needed to unblock, log the scope expansion, but never flip the outside task's box.)*
- Report at the end exactly as Step 4 does, plus the range that was requested, how many of its tasks were completed this run, and the next unchecked task id after the slice (for reference only — do NOT start it).

---

## Auto-pilot mode (`--auto-pilot`)

Run this mode **only when the `--auto-pilot` flag is present**. Without it, nothing in this section applies and every mode above runs exactly as written. Emit one visible status line when this path is taken, before the mode and verification status lines:

`🛩️ [bt-execute] Auto-pilot engaged — unattended run; every decision is mine, nothing stops for human input until the queue is empty`

Auto-pilot exists so a plan of 50+ tasks can run overnight:

```
/bt-execute --auto-pilot @_specs/<feature>_plan.md ALL
```

The user is asleep. **There is no one to ask.** Every "ask", "STOP and tell the user", "flag it to the user" and "do not touch later tasks" instruction elsewhere in this skill is **REPLACED** by the rules in this section. What is **NOT** relaxed: the Agent Reference requirement, the SPEC.md discipline, the tests every task must have, the independent verifier and the verification mode you chose (Standard or `--strict`), and the rule that a box flips only on a genuine PASS. Those are what make an unattended run trustworthy. Only the *stopping* is removed.

### The prime directive

**The run ends when the work queue is empty — never before.** The work queue is every unchecked task the selected mode covers — the whole plan for `ALL`, the slice for a range, the one task for a single id or `NEXT`. The only acceptable end states are:

- (a) every task in the work queue is `- [x]`, or
- (b) every task in the work queue is `- [x]` or explicitly **DEFERRED** per the rules below, with its reason in the run log.

Ending the turn while an unchecked, non-deferred task remains in the work queue — for any reason other than the plan file itself being missing or unreadable, or a range endpoint that does not exist — is a failure of this skill. Before you end the turn, re-read `source_file`: if such a task exists, you are not done. Continue. Do not stop because the session is long, because the context was compacted, because a tool errored, because a subagent asked a question, because something was ambiguous, or because you would "normally check with the user". None of those are reasons to stop under auto-pilot.

You are the studio, not an advisor (Agent Reference). You decide as a senior Babylon Toolkit game developer whose goal is authoring content in Unity, exporting it with the Toolkit exporter as **interactive glTF**, and running it in **BabylonJS** through script components — and you keep going until the plan is done.

### Decision ladder — how every call is made

When the non-auto-pilot skill would ask, stop or flag, apply this ladder in order and take the first rung that resolves it:

1. **The plan decides.** The plan's `Decisions` log, `Design Reference`, the task's Details and Acceptance, then the feature spec, then SPEC.md. A heavy plan is decision-complete by design — obey it.
2. **The Toolkit decides.** The Agent Reference and its sub-documents: the ES6/ESM style guide, Interactive Scene Components (`TOOLKIT.*` script components — compose and tune them, never re-implement them, never ad-hoc BabylonJS wiring), the Unity Exporter CLI (`bt_export_level` / `bt_export_prefab`, `unity command eval` for anything without a command), and the Blender CLI for model work. If the reference documents a pattern, that pattern is the answer.
3. **The codebase decides.** Mirror the conventions, file layout, naming, test runner and patterns already in the repo.
4. **Expert default.** Choose what a senior Toolkit developer would ship: the simplest option that satisfies Acceptance, keeps the Unity → interactive glTF → BabylonJS pipeline intact, and is easiest to revise later. Prefer reversible over clever. State the assumption in one line and proceed.

Every rung-4 call, every ambiguity resolved, every scope expansion, and every deviation from a documented decision is written to the **run log** as a numbered Decision: what was decided, why, what was rejected, and which task(s) it binds. If the project's SPEC.md has a Decisions log, append it there too (newest last, superseding rather than deleting) so plan, spec and code do not drift. Assumptions are **logged** — never silently made, never asked.

### What replaces each stop

| Where the skill would otherwise stop or ask | Auto-pilot does this instead |
|---|---|
| `task_id` missing | Default to `ALL` (auto-pilot overrides the normal `NEXT` default — an overnight run that does one task is useless). |
| `source_file` missing or unreadable | The one genuine no-op — there is nothing to run. Say so and end. Never guess a path. |
| Agent Reference (or a needed sub-document) fetch fails | Retry up to 3× with a short wait between attempts. If still failing, emit `⚠️ [auto-pilot] reference fetch failed after 3 retries — proceeding on remembered Babylon Toolkit knowledge`, log it, proceed, and retry the fetch at the next task boundary. |
| Task is ambiguous or underspecified | Resolve it with the decision ladder; log the Decision. |
| Task is blocked by an unfinished prerequisite task | If the prerequisite was deferred this run, re-attempt it now if the fix is apparent; otherwise implement the *minimum* of the prerequisite needed to unblock this task, log the scope expansion, and continue. |
| Reality diverges from SPEC.md | Decide which is right (working code and the plan's Decisions outrank a stale spec line), implement accordingly, update SPEC.md in the same task, log the Decision. |
| Plan changes architecture but has no `Update SPEC.md` task | Update SPEC.md as part of the task that made the change. |
| Tests fail / verifier FAIL | Enter the **fix loop** below. |
| Task still cannot pass after the fix loop | **DEFER** it (below) and **continue to the next task**. |
| Unity Editor, Blender, dev server or a CLI is not responding | Launch or restart it through its CLI (Unity Exporter CLI / Blender CLI sub-documents), wait, retry. If the tool is genuinely unavailable on this machine (not installed, no license, no project), DEFER the task. |
| A tool call errors or a command fails | Read the error, fix the cause, retry. Transient causes (network, port in use, lock file, editor still compiling) → wait and retry up to 3×. |
| A subagent returns a question instead of a result | Answer it yourself with the decision ladder and re-launch the subagent with the answer included. Never relay a question to the user. |
| Creative or product direction is missing | Choose what best serves the game the spec describes; log it. |
| Two architectures with no clear winner | Pick the one closest to the Toolkit's documented patterns and the existing code; log it and what was rejected. |
| An action would spend money, deploy externally, push to a remote, or destroy work outside this plan's scope | Do it only if the plan or spec explicitly instructs it. Otherwise DEFER that *step* (not the whole task, if the rest can still pass) and continue. Never `git push`, never force-push, never delete or overwrite files outside the plan's scope, never `rm -rf` outside the project. |
| Host permission prompt | Outside this skill's control — see **Prerequisites**. |

### The fix loop (bounded, honest)

A failing test run or a verifier FAIL does not end the run and does not flip the box. It starts the fix loop defined in *Verification modes › The fix loop* — records-only failures fixed directly, a fresh verifier on every re-check, 3 attempts in Standard mode and 5 under `--strict`, and an early exit when two consecutive attempts hit the same failure with no new hypothesis. Under auto-pilot the only difference is what happens when the loop is exhausted: DEFER the task and continue — do not burn the night on one task.

Verification is never relaxed to make progress: no rubber-stamp PASS, no weakening Acceptance, no `- [x]` on partial work. A deferred task with an honest log beats a checked task that lies.

### Deferring a task

When a task cannot pass, mark it in `source_file` **without flipping its box**: keep `- [ ]` and append ` ⏭️ DEFERRED (auto-pilot): <one-line reason>` to the end of that task's checkbox line. Log the details in the run log's `## Deferred` section. Then move on to the next task.

- **Dependents:** a later task that depends on a deferred task is still attempted (see the prerequisite row above). If it genuinely cannot proceed, defer it too with `blocked by T<n>` as the reason.
- **Second pass:** once the queue is exhausted, make **one** more pass over the deferred tasks in order — a later task often fixes what blocked an earlier one. A task that passes on the second pass has its `DEFERRED` marker removed and its box flipped. Tasks still failing stay deferred. Then the run ends.
- **Resumable:** a deferred task is simply an unchecked task with a note. Re-running the same auto-pilot command re-attempts it; `/bt-execute @plan T<n>` on another day runs it with a human present, and the marker tells them why it was left.

### The run log

Auto-pilot writes **`<dir of source_file>/<plan-basename>_autopilot.md`** — created on the first run, appended on later runs. This is what the user reads in the morning:

- **Header per run:** started (ISO timestamp), plan path, completed/total at start.
- **Per task:** id, title, outcome (`DONE` / `DEFERRED`), attempts, tests summary (`<n> passed (implementer) · verifier-checked`), verifier result, files changed, commit hash.
- **`## Decisions`** — numbered, appended as they are made (what / why / rejected / binds).
- **`## Deferred`** — task, reason, and what a human should look at first.
- **Footer per run:** ended (ISO timestamp), completed/total, deferred count, wall time.

Also narrate to the console at every task boundary — one line each — so a glance at the terminal shows the run is alive: `▶ [auto-pilot] T12/50 — <title>`, `✅ [auto-pilot] T12 verified (independent subagent, phase 4) — tests: 6 passed — attempt 2/3`, `⏭️ [auto-pilot] T13 deferred — <reason>`.

### Checkpoints (git)

If the project is a git repository: after each verification unit's boxes flip, commit its changes (one commit per task where the changes separate cleanly, otherwise one per unit) on the current branch with the message `T<n>: <task title> (auto-pilot)` (or `T<a>–T<b>: <phase title> (auto-pilot)` for a unit commit). If the current branch is the repository's default branch (`main` / `master`), first create and check out `autopilot/<plan-basename>` so the default branch is never modified unattended. **Never push.** If the project is not a git repository, skip checkpoints — never `git init` a project on your own.

### Context hygiene for long runs

Fifty tasks will outlive any single context window. **The plan file's checkboxes and the run log are the only state that matters** — re-read both at every task boundary; never rely on memory of earlier tasks.

When a subagent-spawning tool is available (check the tools you actually have — never call one you do not have), implement each verification unit (a phase in Standard mode, a task under `--strict`) in a **fresh implementer subagent** that implements the unit's tasks in order and writes and runs their tests. Give it the **context brief** (see *Verification modes › The context brief* — task blocks, cited Decisions and Design Reference, the SPEC.md sections touched, the Reference excerpts, the do-not-refetch line), the project's agent instructions, and the auto-pilot subagent rules below. Keep that implementer for the unit's fix loop (continue it rather than starting a new one — it already understands the change). The orchestrating context then does only: read plan → launch implementer → launch verifier → flip boxes → commit → log → next unit. This is the same fresh-context-per-task model heavy plans are written for. Without a subagent tool, implement inline as usual and still re-read the plan and log at every boundary.

After any context compaction: re-emit the auto-pilot status line, re-read `source_file` and the run log, and re-fetch the Agent Reference if you no longer remember it. Then continue from the first unchecked, non-deferred task. Compaction is not a stop.

### Every subagent inherits auto-pilot

Every implementer and verifier subagent is told, verbatim, in its prompt:

> AUTO-PILOT: this is an unattended run. Do not ask questions — there is no one to answer them. Make every call yourself from the plan, the Babylon Toolkit Agent Reference and the codebase, state each assumption in one line in your result, and always return a result, never a question.

A verifier still returns an honest PASS/FAIL with evidence. Auto-pilot never asks it to be lenient.

### Prerequisites (the user's side, before going to bed)

This skill controls its own decisions, not the host's. For a truly unattended run the user must launch the session in a permission mode that does not prompt (Claude Code: an auto / bypass-permissions mode, or pre-approved tools covering this skill's `allowed-tools`), and leave Unity, Blender and the dev server reachable if the plan needs them. Remind the user of this once, in the first status line of the run: `ℹ️ [auto-pilot] host permission prompts are outside this skill's control — run in a non-prompting permission mode for a fully unattended run`. Then continue regardless.

### Exit report

When the queue is empty (after the second pass), print: the tasks completed this run, completed/total, the deferred tasks with their one-line reasons, the number of Decisions logged with the run-log path, the branch and last commit hash, and whether the plan is now fully done. Then end. Re-running the same command resumes safely: it re-attempts deferred tasks and continues from the first unchecked one.
