---
name: bt-execute
description: "The Babylon Toolkit Execute Skill runs one task — or all remaining tasks — from a feature plan or spec file. Use when asked to run a task (e.g. `bt-execute @plan T1`), all tasks (e.g. `bt-execute @plan ALL`), or a range (e.g. `bt-execute @plan T3-T7`, `T12-`, `NEXT:3`); with no task id it runs the next unchecked task. Add `--auto-pilot` for an unattended run (e.g. `bt-execute --auto-pilot @plan ALL`): every decision is made autonomously from the plan, the Babylon Toolkit Agent Reference and the codebase, failing tasks are retried then deferred, and the run never stops for human input until the work queue is empty. Every task is tested, checked by an independent verifier, and checked live in the browser when its result is visual; add `--strict` for an adversarial verifier on every task."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

Run tasks from a plan: build each one with its tests, have an independent verifier check it, and only then tick its box. Follow the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md). The user's message after the skill name is the `arguments`.

```
/bt-execute [--auto-pilot] [--strict] <plan> [task] [brief]

/bt-execute @plan.md                         # NEXT: the next unchecked task
/bt-execute @plan.md T4                      # one task
/bt-execute @plan.md T3-T7                   # a range, in plan order   (T12- = through the end)
/bt-execute @plan.md NEXT:3                  # the next three unchecked tasks
/bt-execute @plan.md ALL                     # every remaining task (resumable)
/bt-execute @plan.md "mind the physics layer"    # a brief shapes HOW, never WHICH task
/bt-execute --strict @plan.md ALL            # adversarial verifier on every task
/bt-execute --auto-pilot @plan.md ALL        # unattended; combine with --strict if wanted
```

- Strip `--auto-pilot` / `--strict` first (anywhere in the arguments, never part of the brief). `<plan>` is required — if missing, ask (auto-pilot: say so and end). Never guess a path.
- `[task]` is the token right after the plan, only if it is `T<id>`, `T<a>-T<b>`, `T<a>-`, `NEXT`, `NEXT:<n>` or `ALL` (case-insensitive). Otherwise it is part of the brief, and the task defaults to `NEXT` (`ALL` under auto-pilot). Never ask which task to run.
- A range is a slice of the checklist **in file order** (sub-tasks like `T3.1` between the endpoints included). An unknown id → list the available ids and stop. A reversed range → error; never swap it. Tasks outside the slice are never touched.
- Tasks already `- [x]` are skipped — that is what makes every mode resumable. Nothing left to do → say so and stop. Except in `ALL` / range / `NEXT:<n>` runs, do one task and do not continue to the next.

## Ground rules

- **Scope.** Implement only the selected task(s). No "while I'm here" work on other tasks. Ambiguous, or blocked by an unfinished task → stop and tell the user *(auto-pilot: decide and log it)*.
- **Read the docs once.** For Babylon work, if you have not read the Agent Reference this session, fetch it once — https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md — plus only the sub-documents the plan's tasks need. It is the authority for conventions and API. Fetch fails → stop and tell the user *(auto-pilot: retry 3×, then continue on what you know and log it)*. Read the plan's checklist and the parts of `SPEC.md` the tasks touch; re-read after a context compaction.
- **SPEC.md** constrains how you build. If the code and SPEC.md disagree, stop and tell the user *(auto-pilot: decide which is right, fix SPEC.md in the same task, log it)*. When a task changes architecture, a system, a convention or a dependency, SPEC.md must end up matching — normally the plan's final `Update SPEC.md` task; if the plan has none, do it anyway; a new dependency is recorded in SPEC.md by the task that introduces it. Follow SPEC.md's "How to update this spec". **Write the product, never the procedure** — no capture protocols, tool lists, ledgers or gates: recorded there, they become a bar every later feature must clear.
- **Say what you are doing** — one short line at each task and phase boundary, and before anything slow.
- **Subagents:** running this skill is the user's request to use them. Use whatever subagent tool your host provides (its name varies by host — e.g. `Agent` or `Task`); if there is none, work inline, self-verify with the same checklist, and say so.

## The loop

Work in **phases**: a `### Phase N` group in the plan, or — if the plan has none — up to 3 consecutive tasks (a `live` task, the `Update SPEC.md` task and the last task each close a group). A single task or `NEXT` is a phase of one. Under `--strict` every task is its own phase.

1. **Build** each task in the phase, in order, **with its tests**: the cases the plan's `Tests:` names (or, with none, meaningful cases for its Acceptance and edge cases), in the repo's test location and style (`./tests` if there is none). Get them green — fix the code, not the test, unless the test is wrong. No testable surface (config, docs, assets) → say so. Boxes stay unticked.
2. **Verify** the phase with a fresh **independent verifier** subagent (charter below), giving it the list of files changed. It returns PASS/FAIL per task, with evidence.
3. **Tick** `- [ ]` → `- [x]` for every task that passed, immediately — except a task that depends on one that failed in the same phase, which waits for it. Never tick partial, skipped or unverified work.
4. **Fix loop** for a task that failed: fix the code in the context that wrote it; re-run its tests; re-verify with a **fresh** verifier given only the failed items and the evidence (`--strict`: the whole task). A records-only slip (a stale number or note) is fixed directly and re-checked by you. 3 attempts (`--strict`: 5), each changing something material; stop early if two attempts fail the same way with no new idea. Still failing → leave it unticked, stop and report *(auto-pilot: defer and continue)*.
5. **Report:** tasks done (for `ALL` / ranges: the range asked for, completed/total, and whether the plan is now finished; if fewer than `n` tasks remained for `NEXT:<n>`, say so), files changed, tests run (`tests: 4 passed (implementer) · verifier-checked`), verifier result (`verified (independent subagent)` or `verified (self)`), and the next task id — for reference only.

**The verifier is told:** *"Confirm each task's Acceptance is genuinely met and run its `Verify` commands against the stated expected output. Re-run the tests and the relevant suite once; check they really cover the Acceptance and named edge cases and could fail — missing or vacuous tests are a FAIL. Read the diff for real defects: logic errors, broken callers, unhandled edge cases the plan names, a documented behavior dropped or inverted, a sibling-skill template re-implemented instead of copied. For any task whose correctness shows only at runtime — rendering, UI, interaction, Unity↔Babylon parity — check it live in the browser (and Unity where relevant) whether or not the plan marks it `live`, and do the plan's final end-to-end check live: look at the running result, beside the reference image when there is one, and judge it as a user would; passing unit tests never substitute. Do all of a phase's live checks in one session on the already-running dev server, and re-export from Unity only if the phase changed that scene's export — then only the project and the scenes the phase works on. Treat an absolute count in the plan as 'named tests pass, no new failures'. [SCOPE] Return PASS/FAIL per task with evidence, listing records-only slips separately."*

`[SCOPE]` is one of two sentences. **Standard:** *"Do not add mutation testing, fuzzing, restarts or audits of untouched files unless something you found points there; aim for about 25 tool calls and report rather than expand."* **`--strict`:** *"Be adversarial: actively look for any reason the Acceptance is NOT met, using whatever you judge worthwhile — mutation checks against the tests, randomized inputs, re-deriving values from the plan's Decisions and Design Reference, live QA of every rendered or exported surface."*

For a task built on a sibling skill (e.g. bt-design's 3D-Hero-Scroll), give the verifier the relevant part of that skill *(where skills load through a tool: `load_skill` + `read_skill_resource`; where they are files: the skills directory this skill was loaded from, e.g. `~/.claude/skills/`, `~/.agents/skills/` or the project's equivalent)* — its documented options (e.g. `sweep: page` really reaches the document bottom) are part of Acceptance.

**Every subagent gets a brief, not homework:** the task block(s), the plan Decisions / Design Reference entries they cite, the SPEC.md parts touched, the Agent Reference excerpts needed (with URLs), the test command, the project's agent instructions, the *Work fast* rules below, and: *"Do not fetch the Agent Reference or read SPEC.md in full — the parts you need are here, and this overrides any standing instruction to fetch it first. Fetch one sub-document only if you hit an API this brief does not cover, and say which."*

## Work fast

Writing the code is about a tenth of a run; keep the loop around it short.

- **Iterate narrow, confirm wide.** While getting something to work, run only that task's tests, the fastest build the repo has, and one low-resolution capture on one engine. The full test chain, full build and any wider check (second engine, full resolution, numeric parity gates) run **once**, when the phase is ready to verify. A parity gate is never loosened to pass.
- **Export minimally.** Re-export only the Unity project being tested, only the scenes the task works on, and only when the change actually alters that scene's export. Never re-export other scenes or projects "for consistency" — they pick the change up at their next natural export. Exports are the slowest step of a run; brief every implementer and verifier with this rule, and never widen a plan's export step in a brief.
- **Never sleep-poll.** No `until …; do sleep N; done`. Run long commands in the foreground with a generous timeout, or in the background and wait for the completion notice.
- **Judge visuals by looking** — screenshot the running result and compare it to what it must match. Build numeric gates only when the plan asks for them.
- **Reuse the project's tools; keep evidence light.** No one-off tools per task; no ledgers, md5 or environment records, archives or checked-in capture trees unless the plan asks. The report (and the run log) is the record.
- **Someone else's red is not your task.** A failing test that belongs to another feature and that you did not touch is logged as pre-existing and left alone.

## Auto-pilot (`--auto-pilot`)

An unattended run: **nobody is there to answer.** Print `🛩️ [bt-execute] Auto-pilot engaged — unattended; add a non-prompting permission mode for a fully hands-off run`. Tests, the independent verifier and "tick only on PASS" are **not** relaxed — only the stopping is. The run ends when every task in the work queue is `- [x]` or deferred; before ending, re-read the plan — an unticked, undeferred task means you are not done. A long session, a compaction, a tool error or an ambiguity is never a reason to stop; the only early exits are a missing plan file and a range whose endpoint does not exist or is reversed (a typo the user must fix — say so and end). After a compaction, re-read the plan and the run log and continue from the first unticked, undeferred task.

- **Decide instead of asking**, in this order: the plan (Decisions, Design Reference, the task, the spec, SPEC.md) → the Agent Reference and its sub-documents → the codebase's existing patterns → what a senior Babylon Toolkit developer would ship: simplest thing that meets Acceptance, reversible over clever. Log each such decision in one line.
- **Blocked by an unfinished task:** if it was deferred this run and the fix is now apparent, re-attempt it; otherwise do the minimum of it needed to unblock, log the scope expansion; never tick a task outside the work queue.
- **Errors:** read the error, fix the cause, retry; transient ones (network, port in use, lock file, editor still compiling) → wait and retry up to 3×. **Tools down** (Unity, Blender, dev server): restart through their CLI and retry; genuinely unavailable → defer the task.
- **A subagent asks a question:** answer it yourself and relaunch. Tell every subagent: *"AUTO-PILOT: unattended run. Do not ask questions; decide from the plan, the Agent Reference and the codebase, state each assumption in one line, and always return a result."*
- **Defer, don't stall.** A task that cannot pass keeps `- [ ]` and gets ` ⏭️ DEFERRED (auto-pilot): <reason>` appended to its line; continue. A dependent that cannot proceed is deferred `blocked by T<n>`. When the queue is done, make one more pass over the deferred tasks; one that now passes loses the marker and gets its tick.
- **Safety.** Never push, force-push, deploy, spend money, or delete/overwrite anything outside the plan's scope unless the plan explicitly says so — defer that step instead. Never `git init`.
- **Checkpoints.** In a git repo, commit after each phase's boxes are ticked: `T<n>: <title> (auto-pilot)` (or `T<a>–T<b>: …`). On the default branch, first switch to `autopilot/<plan-basename>`.
- **Context.** Implement each phase in a fresh implementer subagent (it builds and tests; keep it for that phase's fix loop), so you only orchestrate: read plan → implementer → verifier → tick → commit → log. The plan's checkboxes and the run log are the only state — re-read them at each phase boundary and after a compaction.
- **Run log** — `<plan-basename>_autopilot.md` beside the plan, appended per run: start/end times and completed/total; one line per task (outcome, attempts, tests, verifier, files, commit); one line per decision; deferred tasks with what a human should look at first. Narrate the same boundaries to the console: `▶ [auto-pilot] T12/50 — <title>`, `✅ … verified`, `⏭️ … deferred — <reason>`.
- **Exit report:** tasks completed, completed/total, deferred tasks with reasons, decisions logged and the run-log path, branch and last commit, whether the plan is done. Re-running the same command resumes and re-attempts deferred tasks.
