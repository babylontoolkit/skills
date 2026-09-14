---
name: bt-execute
description: "The Babylon Toolkit Execute Skill runs one task — or all remaining tasks — from a feature plan or spec file. Use when asked to run a task (e.g. `bt-execute @plan T1`), all tasks (e.g. `bt-execute @plan ALL`), or a range (e.g. `bt-execute @plan T3-T7`, `T12-`, `NEXT:3`); with no task id it runs the next unchecked task. Add `--auto-pilot` for an unattended run (e.g. `bt-execute --auto-pilot @plan ALL`): every decision is made autonomously from the plan, the Babylon Toolkit Agent Reference and the codebase, failing tasks are retried then deferred, and the run never stops for human input until the work queue is empty."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

Execute work from the referenced feature plan or spec file — either a single task, or every remaining task in order. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user’s message after the skill name as the `arguments`.

---

# Invocation

```
/bt-execute [--auto-pilot] <plan> <task-id> <optional-brief>
```
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

---

## ⚠️ The Project Specification (SPEC.md) — read before executing

The project's **SPEC.md** at the repository root is the source of truth for the durable architecture, systems, conventions, and decisions. **Read it before executing any task**, and follow it while implementing (it constrains how you build, not just what).

- Implement in a way that conforms to SPEC.md's architecture, systems, and conventions.
- **If reality diverges from SPEC.md during execution** — the code as it actually exists contradicts the spec, or the task can only be done by breaking a documented decision/convention — STOP and flag it to the user. Do not let the spec and the code silently drift apart. *(Auto-pilot: decide which is right, update SPEC.md in the same task, log the Decision — never stop.)*
- **This is the write-up half of the spec-driven loop.** When a task changes the architecture, a system, a convention, or a dependency, SPEC.md must end up matching what was built. A well-formed plan makes this an explicit final `Update SPEC.md` task (see below); if you are executing a plan that changes architecture but has no such task, flag the gap and update SPEC.md as part of completing the work rather than leaving it stale.
- Record any new dependency in SPEC.md's Dependencies section as part of the task that introduces it.
- When writing back, follow SPEC.md's **"How to update this spec"** contract, keyed off each section's heading tag: **replace/merge** the current-state sections (Architecture, Game Systems, Conventions, Dependencies), removing seed placeholders on first real content and keeping the text matching the shipped code; **append** to the Decisions log (newest last), superseding rather than deleting.

The `Update SPEC.md` task is a task like any other: it goes through the same acceptance verification below before its checkbox is flipped — the spec write-back is verified, not assumed.

---

## Step 1. Parse the arguments

First strip the `--auto-pilot` flag if present and remember that **Auto-pilot mode** is in effect for the whole run. Then, from the remaining `arguments`, extract:

1. `source_file` — the plan or spec file reference to read tasks from (e.g. `_specs/new-heist-form_plan.md` or `_specs/new-heist-form_spec.md`).
2. `task_id` — the token immediately after `source_file`, **only if** it is one of these forms (all case-insensitive):
   - a single task id (e.g. `T1`, `T2`, `T3.1`) → **Single-task mode** (Step 2);
   - `NEXT` → **Next-task mode** (Step 3);
   - `ALL` → **Run-all mode** (Step 4);
   - a **range** → **Range mode** (Step 5): `T1-T10` (two ids joined by `-`), `T5-` (an id followed by `-`, meaning through the end of the plan), or `NEXT:3` (`NEXT:` followed by a positive integer).
   If the token after `source_file` is none of these forms, then no `task_id` was given: **default to `NEXT`** (or `ALL` when auto-pilot is engaged), and treat everything after `source_file` as the `optional-brief`. Never ask which task to run — the default is the answer. Never treat a brief as a task id: a `task_id` must match one of the forms above exactly.
3. `brief` — whatever remains after `source_file` and `task_id`. It shapes *how* the selected task(s) are done, never *which* tasks are selected.

## Verifying a task before checking its box

Before changing any task's `- [ ]` to `- [x]` (this applies to every mode below), verify its **Acceptance** criteria are genuinely met. At the start of the run, **emit one visible status line** so the user sees which verification path is in effect — either `🔍 [bt-execute] subagent tool detected — using an independent verifier before each checkbox` or `🔍 [bt-execute] no subagent tool — self-verifying before each checkbox` — and when you report each task, note whether it was `verified (independent subagent)` or `verified (self)`. If a subagent-spawning tool is available to you (e.g. Claude Code's `Agent`, Lovable's subagent tool, or your host's equivalent — check the tools you actually have), launch an **independent verifier subagent**: give it the task's Details + Acceptance and the changes just made, and instruct it to adversarially confirm the criteria — actively look for a reason they are NOT met, inspecting files and running the relevant build/test/commands as needed — then return PASS/FAIL with evidence. Flip the checkbox only on PASS. On FAIL, leave it `- [ ]`, do not touch later tasks, and report what failed. *(Auto-pilot: a FAIL enters the bounded fix loop, then defers the task and continues — see **Auto-pilot mode**.)* If no subagent tool is available (or you are unsure), self-verify the Acceptance the same way before flipping — never call a subagent tool you do not have. The verifier need not re-read the Agent Reference. Never check a box for partial, skipped, or unverified work.

**Sibling-skill behaviors are part of Acceptance.** When a task implements a feature built on a sibling-skill template engine (e.g. bt-design's 3D-Hero-Scroll), load that sub-skill before verifying — you cannot check a behavior against a spec you have not read. *(Where skills are loaded with a tool — the Babylon Toolkit App Builder platform — call `load_skill('<name>')`, then fetch its references with `read_skill_resource` using the paths the load returns, never a guessed path. Where skills are files on disk — Claude Code — read them from `~/.claude/skills/` or the project's `.claude/skills/`. Skip the load for anything already in your context.)* The verifier must confirm the skill-defined behavioral options are actually present and correct — e.g. `sweep: page` means PLAY/END genuinely reach the **document bottom**, not just the journey's end. A plausible-looking result that silently dropped or inverted a documented behavior is a **FAIL**, even if the surface looks right. Likewise, if a task re-implemented a sub-skill's engine from memory instead of copying its template (dropping veiled cuts, the preload gate, degradation, etc.), flag it and fail the task.

## Testing is handled by a subagent

Testing for each task is owned by a dedicated **testing subagent** — separate from the verifier above. It runs **after the task is implemented and before the acceptance verifier**, so tests exist and pass before a checkbox can flip. At the start of the run, **emit one visible status line** for the testing path — either `🧪 [bt-execute] subagent tool detected — delegating test authoring + runs to a testing subagent` or `🧪 [bt-execute] no subagent tool — authoring and running tests inline` — and when you report each task, note the test outcome (e.g. `tests: 4 passed (testing subagent)` or `tests: 4 passed (inline)`).

For each task, unless the task genuinely has no testable surface (pure config/docs/asset moves — say so explicitly rather than skipping silently):

1. If a subagent-spawning tool is available to you (check the tools you actually have; if there is none, or you are unsure, do this inline yourself — never call a subagent tool you do not have), launch a **testing subagent** and give it: the task's Details + Acceptance, the changes just made, the project's test conventions/runner, and the feature spec's `Testing Guidelines`. Instruct it to (a) author meaningful test file(s) under `./tests` (or wherever this repo's tests live) covering the task's Acceptance and its likely edge cases — following existing test patterns, without over-testing — then (b) run the test suite (or at least the relevant tests) and return the command used, PASS/FAIL, and the failing output on failure. The testing subagent need not re-read the Agent Reference.
2. Treat a test **FAIL** exactly like an acceptance failure: fix the implementation (not the test, unless the test is wrong) and re-run until green, or if it cannot pass, leave the box `- [ ]`, do not touch later tasks, and report which task's tests failed and why. *(Auto-pilot: fix loop, then defer and continue.)*
3. Only once tests are green does the acceptance verifier run. The verifier may re-run the tests as part of its adversarial check — that overlap is intentional. The checkbox flips only when both tests pass **and** the verifier returns PASS.

The `Update SPEC.md` task and other non-code tasks typically have no test surface — note that explicitly and let the acceptance verifier alone gate them.

## Step 2. Single-task mode (`task_id` is a specific id)

Read `source_file` and find the task whose id matches `task_id`. If it cannot be found, print the list of available task ids from the file and STOP without implementing anything.

Then implement ONLY that single task. This is a hard rule:

- Do not start, scaffold, refactor for, or partially implement any other task, even if it looks trivial, related, or "while you're here".
- Stay within the scope described by the task. If the task is ambiguous or blocked by an unfinished prerequisite task, stop and tell the user instead of expanding scope. *(Auto-pilot: resolve it with the decision ladder and log the Decision.)*
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
   c. If a task cannot be completed, is blocked, or its acceptance criteria are not met, STOP: leave it unchecked, do not touch any later task, and report which task failed and why. *(Auto-pilot: never stop here — run the fix loop, then DEFER the task and continue with the next one; see **Auto-pilot mode**.)*
4. When all tasks are checked (or you stopped early), report a summary: which tasks you completed this run, the current completed/total count, and whether the plan is now fully done.

Never check a box for partial, skipped, or unverified work in either mode.

## Step 5. Range mode (`task_id` is `T1-T10`, `T5-` or `NEXT:3`)

Range mode is **Run-all mode restricted to a slice of the checklist**. Everything in Step 4 applies unchanged — one task at a time, in order, skip `- [x]`, tests then verifier, flip the box immediately on PASS, stop (or, under auto-pilot, defer and continue) on failure — except that the work queue is the slice, not the whole plan.

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

Run this mode **only when the `--auto-pilot` flag is present**. Without it, nothing in this section applies and every mode above runs exactly as written. Emit one visible status line when this path is taken, before the verification and testing status lines:

`🛩️ [bt-execute] Auto-pilot engaged — unattended run; every decision is mine, nothing stops for human input until the queue is empty`

Auto-pilot exists so a plan of 50+ tasks can run overnight:

```
/bt-execute --auto-pilot @_specs/<feature>_plan.md ALL
```

The user is asleep. **There is no one to ask.** Every "ask", "STOP and tell the user", "flag it to the user" and "do not touch later tasks" instruction elsewhere in this skill is **REPLACED** by the rules in this section. What is **NOT** relaxed: the Agent Reference requirement, the SPEC.md discipline, the testing subagent, the independent acceptance verifier, and the rule that a box flips only on a genuine PASS. Those are what make an unattended run trustworthy. Only the *stopping* is removed.

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
| Testing subagent FAIL / acceptance verifier FAIL | Enter the **fix loop** below. |
| Task still cannot pass after the fix loop | **DEFER** it (below) and **continue to the next task**. |
| Unity Editor, Blender, dev server or a CLI is not responding | Launch or restart it through its CLI (Unity Exporter CLI / Blender CLI sub-documents), wait, retry. If the tool is genuinely unavailable on this machine (not installed, no license, no project), DEFER the task. |
| A tool call errors or a command fails | Read the error, fix the cause, retry. Transient causes (network, port in use, lock file, editor still compiling) → wait and retry up to 3×. |
| A subagent returns a question instead of a result | Answer it yourself with the decision ladder and re-launch the subagent with the answer included. Never relay a question to the user. |
| Creative or product direction is missing | Choose what best serves the game the spec describes; log it. |
| Two architectures with no clear winner | Pick the one closest to the Toolkit's documented patterns and the existing code; log it and what was rejected. |
| An action would spend money, deploy externally, push to a remote, or destroy work outside this plan's scope | Do it only if the plan or spec explicitly instructs it. Otherwise DEFER that *step* (not the whole task, if the rest can still pass) and continue. Never `git push`, never force-push, never delete or overwrite files outside the plan's scope, never `rm -rf` outside the project. |
| Host permission prompt | Outside this skill's control — see **Prerequisites**. |

### The fix loop (bounded, honest)

A FAIL from the testing subagent or the acceptance verifier does not end the run and does not flip the box. It starts a fix loop for that task:

1. Read the failing evidence. Fix the **implementation** (fix the test only when the test itself is wrong, and say why in the log).
2. Re-run the tests. On green, re-run the acceptance verifier — a **fresh** verifier subagent each time, never one that already holds an opinion.
3. Up to **5 attempts** per task. Each attempt must change something material. If two consecutive attempts hit the same failure with no new hypothesis, end the loop early and DEFER — do not burn the night on one task.

Verification is never relaxed to make progress: no rubber-stamp PASS, no weakening Acceptance, no `- [x]` on partial work. A deferred task with an honest log beats a checked task that lies.

### Deferring a task

When a task cannot pass, mark it in `source_file` **without flipping its box**: keep `- [ ]` and append ` ⏭️ DEFERRED (auto-pilot): <one-line reason>` to the end of that task's checkbox line. Log the details in the run log's `## Deferred` section. Then move on to the next task.

- **Dependents:** a later task that depends on a deferred task is still attempted (see the prerequisite row above). If it genuinely cannot proceed, defer it too with `blocked by T<n>` as the reason.
- **Second pass:** once the queue is exhausted, make **one** more pass over the deferred tasks in order — a later task often fixes what blocked an earlier one. A task that passes on the second pass has its `DEFERRED` marker removed and its box flipped. Tasks still failing stay deferred. Then the run ends.
- **Resumable:** a deferred task is simply an unchecked task with a note. Re-running the same auto-pilot command re-attempts it; `/bt-execute @plan T<n>` on another day runs it with a human present, and the marker tells them why it was left.

### The run log

Auto-pilot writes **`<dir of source_file>/<plan-basename>_autopilot.md`** — created on the first run, appended on later runs. This is what the user reads in the morning:

- **Header per run:** started (ISO timestamp), plan path, completed/total at start.
- **Per task:** id, title, outcome (`DONE` / `DEFERRED`), attempts, tests summary, verifier result, files changed, commit hash.
- **`## Decisions`** — numbered, appended as they are made (what / why / rejected / binds).
- **`## Deferred`** — task, reason, and what a human should look at first.
- **Footer per run:** ended (ISO timestamp), completed/total, deferred count, wall time.

Also narrate to the console at every task boundary — one line each — so a glance at the terminal shows the run is alive: `▶ [auto-pilot] T12/50 — <title>`, `✅ [auto-pilot] T12 verified (independent subagent) — tests: 6 passed — attempt 2/5`, `⏭️ [auto-pilot] T13 deferred — <reason>`.

### Checkpoints (git)

If the project is a git repository: after each task's box flips, commit that task's changes on the current branch with the message `T<n>: <task title> (auto-pilot)`. If the current branch is the repository's default branch (`main` / `master`), first create and check out `autopilot/<plan-basename>` so the default branch is never modified unattended. **Never push.** If the project is not a git repository, skip checkpoints — never `git init` a project on your own.

### Context hygiene for long runs

Fifty tasks will outlive any single context window. **The plan file's checkboxes and the run log are the only state that matters** — re-read both at every task boundary; never rely on memory of earlier tasks.

When a subagent-spawning tool is available (check the tools you actually have — never call one you do not have), implement each task in a **fresh implementer subagent**. Give it: the task's full block, the plan's `Decisions` and `Design Reference` sections (or the whole plan if it is not a heavy plan), SPEC.md, the project's agent instructions, the Agent Reference URL with the instruction to fetch and read it first, and the auto-pilot subagent rules below. The orchestrating context then does only: read plan → launch implementer → launch tester → launch verifier → flip box → commit → log → next. This is the same fresh-context-per-task model heavy plans are written for. Without a subagent tool, implement inline as usual and still re-read the plan and log at every boundary.

After any context compaction: re-emit the auto-pilot status line, re-read `source_file` and the run log, and re-fetch the Agent Reference if you no longer remember it. Then continue from the first unchecked, non-deferred task. Compaction is not a stop.

### Every subagent inherits auto-pilot

Every implementer, testing and verifier subagent is told, verbatim, in its prompt:

> AUTO-PILOT: this is an unattended run. Do not ask questions — there is no one to answer them. Make every call yourself from the plan, the Babylon Toolkit Agent Reference and the codebase, state each assumption in one line in your result, and always return a result, never a question.

A verifier still returns an honest PASS/FAIL with evidence. Auto-pilot never asks it to be lenient.

### Prerequisites (the user's side, before going to bed)

This skill controls its own decisions, not the host's. For a truly unattended run the user must launch the session in a permission mode that does not prompt (Claude Code: an auto / bypass-permissions mode, or pre-approved tools covering this skill's `allowed-tools`), and leave Unity, Blender and the dev server reachable if the plan needs them. Remind the user of this once, in the first status line of the run: `ℹ️ [auto-pilot] host permission prompts are outside this skill's control — run in a non-prompting permission mode for a fully unattended run`. Then continue regardless.

### Exit report

When the queue is empty (after the second pass), print: the tasks completed this run, completed/total, the deferred tasks with their one-line reasons, the number of Decisions logged with the run-log path, the branch and last commit hash, and whether the plan is now fully done. Then end. Re-running the same command resumes safely: it re-attempts deferred tasks and continues from the first unchecked one.
