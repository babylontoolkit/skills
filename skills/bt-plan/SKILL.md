---
name: bt-plan
description: "The Babylon Toolkit Plan Skill creates the detailed technical plan for the specified feature spec file. Use when asked to plan or produce implementation tasks for an existing spec. Also supports a Quick Plan mode: when given only a brief (no spec file), it interviews the user to build a mini-spec and plans from that. Add `--heavy` for Heavy Plan mode: a decision-complete plan (numbered Decisions log, Design Reference with real interfaces and patterns, self-contained task blocks, cold-context audit) that keeps a long run of fresh-context tasks cohesive. Plans are sized to the feature (task budget by spec size, phases, per-task verify level) so execution cost stays proportional. Always planning-only — it writes the plan file and stops; execution is the separate bt-execute skill."
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

Create a detailed technical implmentation plan for the specified feature spec and save in the _specs folder as `<feature-name>_plan.md`. Always generate implmentation tasks or steps (prefer to call them tasks).

Use the user’s message after the skill name as the `arguments`.

---

# Invocation

```
/bt-plan [--heavy] <feature-spec> <optional-brief>
```
- **`<feature-spec>`** — the feature spec file to create a plan for. This is the *blueprint*.
- **`<optional-brief>`** — the brief or instructions for generating the plan. This is the *variable*.
- **`--heavy`** *(optional flag)* — **Heavy Plan mode**: write the plan as the feature's complete shared memory (a numbered Decisions log, a Design Reference, self-contained task blocks) and audit it from a cold context before finalizing, so a long run of tasks executed in fresh contexts stays cohesive. See **Heavy Plan mode**. Without the flag, the plan is produced exactly as described in Step 2. The flag may appear anywhere in the arguments and is never part of the brief — **strip it first**, then resolve the rest below.
- Never guess a file path or URL. Resolve the (flag-stripped) arguments as follows:
  - **Both a spec file and a brief** → normal full planning.
  - **A spec file only** → normal full planning; the brief defaults to "Generate a detailed implementation plan".
  - **A brief only, no spec file** → **Quick Plan mode** (see below). Do not ask *for a spec file* — treat the brief as the feature request. But because there is no spec, **interview the user with clarifying questions** to pin down the requirements before finalizing the plan.
  - **Neither** → ask the user for at least a brief before starting.

Example:
```
/bt-plan → @feature_spec.md → "Generate a detailed implementation plan"
/bt-plan → "add a settings toggle to mute all game audio"   # no spec file → Quick Plan mode, automatically
/bt-plan --heavy @feature_spec.md                           # Heavy Plan mode: decision-complete plan for a long run
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
| `size: small/medium/large` | **Infer** it from the brief + analysis per *Size the plan to the feature*. |

**The one and only difference in Quick Plan mode is operating without a spec file** — the interview produces a mini-spec that stands in for it. Everything else is identical to a normal run: Step 1's comprehensive codebase analysis (including reading root `SPEC.md`) runs in full, the plan document has the same structure, the SPEC.md write-back task is still appended when the inferred `spec_impact` is `yes`, and the run still **STOPS after writing the plan file**. Nothing about Quick Plan grants permission to implement.

Emit one visible status line when this path is taken: `⚡ [bt-plan] Quick Plan mode — no feature spec file; interviewing, then planning from the brief`.

### Finishing a Quick Plan (hard stop)

After writing `_specs/<feature-name>_plan.md`, **STOP**. Your final response must be a short summary of the plan plus the exact next-step hint below — and nothing else. Do not begin T1. Do not offer to "go ahead and start". If the user wants execution, they will invoke bt-execute themselves:

```
Plan written to _specs/<feature-name>_plan.md
Run a single task with `bt-execute _specs/<feature-name>_plan.md T1`, or every task with `bt-execute _specs/<feature-name>_plan.md ALL` (add `--strict` for an adversarial verifier on every task).
```

### Interview before planning (Quick Plan)

Because there is no spec, the clarifying questions the spec process would have asked are now **your** responsibility. After the Step 1 analysis (so your questions are grounded in the real codebase, not generic), and **before** writing the plan:

- Ask the user a focused round of clarifying questions covering the things that most change the plan: scope and non-goals, target UX/behavior, edge cases, which existing systems/files it should integrate with, constraints, and — critically — anything ambiguous in the brief or where the codebase suggests more than one reasonable approach.
- Prefer a small number of high-leverage questions (grouped, easy to answer) over interrogating the user. Do not ask about things the brief or codebase already make clear.
- Only fall back to the defaults table for items the user leaves unanswered or explicitly says "you decide". Never silently pick a default when a quick question would materially improve the plan.
- If the user declines to answer or says "just make the plan", proceed with the defaults and state which assumptions you made in the plan's Codebase Analysis section.

The goal is the same as a spec: a plan optimized to what the user actually wants — reached by asking, not by guessing.

---

## Heavy Plan mode (`--heavy`)

Run this mode **only when the `--heavy` flag is present**. Without it, nothing in this section applies and the plan is produced exactly as Step 2 describes.

Heavy Plan mode changes **only two things**: the structure of the plan document (Step 2 below is replaced by the *Heavy plan document* structure in this section) and one extra step before finalizing (the *cold-context audit*). Everything else — the argument rules, Quick Plan mode (yes, `--heavy` combines with a brief-only Quick Plan), the subagent and narration rules, the Agent Reference requirement, planning-only mode, and the full Step 1 analysis — runs unchanged. Emit one visible status line when this path is taken: `🏋️ [bt-plan] Heavy Plan mode — writing a decision-complete plan with a cold-context audit`.

### Why: the plan is the memory

A long plan is not executed in one sitting. It can hold **fifty or more tasks**, run over **several days**, and each task is typically executed by **bt-execute in a fresh context** (`/clear` between tasks, new sessions, resumed runs). The only thing that survives from one task to the next is the plan file. Whatever is not written in it is gone: the executor of task 40 has never seen task 3, does not know what it decided, and will re-derive conventions from the codebase — possibly differently. Across a long run, that is how features drift: two naming styles, two error-handling patterns, a helper written twice, an interface that changed shape halfway through.

So a heavy plan is the **complete, shared memory** of the feature: every decision, every name, every signature, every pattern to mirror, written once, in one place, and cited from every task that depends on it. **The test:** could an engineer with a fresh context, who has never seen this repo or the earlier tasks, open task 40 and produce code consistent with tasks 1–39 — same names, same shapes, same conventions — using only the plan? If they would have to look at what earlier tasks produced and infer the pattern, the plan is not carrying the memory.

**What a heavy plan must decide and record, rather than leave to be re-derived per task:**

| Class | What the plan must record |
| --- | --- |
| Architecture | module boundaries, which layer owns what, dependency direction, where state lives, sync vs async, event vs call |
| File layout | every file created / modified / deleted, by exact path; each new file's responsibility; where in an existing file new code goes (an anchor: "after `foo()`", "inside the `switch` at `:412`") |
| Interfaces & contracts | full signatures of every new/changed function, class, type, interface, event name, message shape, config key, CLI flag, route — written as code, not prose, so every task types the same thing |
| Data shapes & state | schemas, field names + types, defaults, invariants, persistence format, migration behaviour |
| Algorithms & formulas | pseudocode or real code for anything non-obvious: math, ordering, caching, retry, timing, physics tuning values |
| Naming | the actual names of the new things (classes, functions, fields, files, CSS classes, events, test names) — chosen once, following the repo's conventions |
| Error & edge-case policy | for every edge case the spec lists (and every one the analysis found): the decided behaviour, written as "when X → do Y" |
| Dependencies | exactly which packages/versions are added, or an explicit "no new dependencies" |
| Sibling-skill behavioural config | every option of a sibling-skill pattern (e.g. 3D-Hero-Scroll `sweep`) with its value, not just its name |
| Test design | the test file(s), the harness/pattern to copy, the named cases with expected outcomes, and the exact command to run |
| Ordering & dependencies | which tasks depend on which; what must keep working between tasks (temporary shims, feature flags) and which later task removes them |

**Write the code when the code IS the decision.** This skill never edits source files, but a heavy plan may (and should) put code *inside the plan*: full signatures, type definitions, data schemas, the tricky 20-line algorithm, a config block, a test skeleton. When the shape of the code is the decision, prose is a lossy encoding of it — write the code once here, and every task that needs it copies the same thing. Leave to prose only the mechanical glue ("wire `X` into `Y`'s constructor the same way `Z` is at `:88`").

**Self-contained tasks, sized to real work.** A task should fit in one fresh context: one clear outcome, everything it needs either in its own block or cited by name from the Decisions and Design Reference. Split a task when it would not fit in one sitting — not merely because it touches several files. *Size the plan to the feature* (task budget, no ceremony tasks, phases, `Verify level`, no brittle pins) applies to heavy plans too: every task and phase costs a verification round at execution time. Heavy mode fits whenever execution runs in fresh contexts or on a cheaper model than planning — any feature size. The task budget still follows the spec's `size`.

**Do the API homework once, here.** When a task uses a Babylon Toolkit component or BabylonJS API, show the exact call the way the Agent Reference (or its sub-document) shows it, in the Design Reference › *API usage* section — so every task across the run uses the same API the same way instead of each fresh context rediscovering it. Fetch the relevant sub-documents during Step 1 and copy the correct usage into the plan.

**Ask now, while the whole feature is in view.** Anything ambiguous that Step 1 or the interview surfaces is resolved here, with the user if necessary — a question deferred to execution gets answered by whichever task happens to hit it, in isolation, without the context to answer it consistently.

### Step 1 additions in Heavy Plan mode

The analysis is the same eight points; ask for **plan-grade detail** when running it. Exploration subagents (or you, on the sequential path) should return `file:line` references, the real signatures of the functions the feature will call or change, and verbatim snippets of the conventions to mirror (the actual pattern, ten to thirty lines, with its location) — not summaries like "uses a manager pattern". Also carry forward the feature spec's `Decisions` entries and note its `Open Questions` (each gets resolved in the plan's `## Decisions`), and establish the **test baseline** (command, current pass/fail state, which failures are pre-existing), so a task run days later can tell new failures from old ones.

### Heavy plan document

Emit `✍️ [bt-plan] Writing draft _specs/<feature-name>_plan.md …` before writing, and `💾 [bt-plan] Draft written — _specs/<feature-name>_plan.md (<n> tasks)` once the file is saved. The document has **five required sections, in this order**. A plan missing any of them is invalid; do not produce one.

**1. `## Codebase Analysis`** — exactly as in Step 2 (the Step 1 findings with `file:line` citations and the SPEC.md alignment note), plus the **test baseline** and, in Quick Plan mode, the **interview answers** that stand in for the spec.

**2. `## Decisions`** — the feature-scoped decision log; the part of the plan that keeps task 40 consistent with task 3. One entry per decision, numbered `D1`, `D2`, … so tasks can cite them. Carry every entry from the feature spec's `Decisions` section forward (keep its wording, add the D-number), then add every decision *you* made while planning — architecture, layout, naming, algorithms, error policy, test strategy — using the table above as the checklist. Every entry has the same shape:

```markdown
- **D3 — <decision, stated as a fact>.** <why: the deciding constraint, or the precedent in the codebase with file:line>
  Rejected: <alternative> (<why not>). Binds: T4, T7.
```

Resolve every `Open Question` from the spec here. An open question that survives into execution gets answered by one task in isolation and, days later, differently by another. If you genuinely cannot resolve one without the user, ask the user now, then record the answer. "TBD", "to be decided during implementation", "the implementer may choose" and similar phrases are forbidden anywhere in a heavy plan.

**3. `## Design Reference`** — the blueprint every task cites, where the shared names, shapes and code live so each task copies from one source instead of inventing its own. Use these sub-headings (omit one only if it truly does not apply, and say so in one line):

- **File map** — a table of every file the feature creates, modifies, or deletes: `path | create/modify/delete | responsibility | touched by tasks`.
- **Module boundaries** — what owns what, which direction dependencies point, where state lives. A short ASCII diagram is welcome where it clarifies flow.
- **Interfaces & contracts** — every new or changed function, class, type, interface, event, message, config key, or route, **written as code in the project's language** with full signatures, parameter types, return types and a one-line doc comment. These are the exact names every task will type.
- **Data shapes & state** — schemas / type definitions, defaults, invariants, persistence format.
- **Control flow** — the key sequences, numbered ("1. `onPointerDown` → 2. `#pick()` → 3. …"), including what happens on the failure branches.
- **Algorithms & formulas** — pseudocode or real code for anything non-obvious, with the constants and tuning values decided (`offset = max(halfWidth + 4, 18)`, not "a sensible offset").
- **Error & edge-case policy** — one line per edge case: `when <X> → <Y>`.
- **Conventions to mirror** — verbatim snippets of the repo's existing pattern with `file:line`, one per convention the feature must copy (component registration, debug-drawing pattern, test harness, styling tokens from `DESIGN.md`, …).
- **API usage** — for every Babylon Toolkit / BabylonJS / third-party API the feature calls, the exact call as the Agent Reference (or the library docs) shows it.
- **Test strategy** — the test file(s) to create or extend, the harness/pattern to copy (with `file:line`), how to run them, and the baseline to compare against.

**4. `## Tasks`** — the ordered checklist, numbered `T1`, `T2`, `T3` … in dependency order with GitHub-style checkboxes, grouped under `### Phase N — <name>` headings, each task implementable and verifiable on its own in a fresh context. Every task uses this block. Fields marked **required** must be present on every task; the others are omitted only when they genuinely have nothing to say.

```markdown
## Tasks

- [ ] **T7** — <short imperative title>
  - Depends on: T3, T5                                             # required (write "none" for the first task)
  - Files: `src/foo.ts` (create), `src/bar.ts` (modify — `Bar.init()`), `src/old.ts` (delete)   # required
  - Applies: D2, D5 · Design Reference › Interfaces › `FooService` · Conventions to mirror › debug drawing   # required — what this task must stay consistent with
  - Steps:                                                         # required — numbered, concrete, one action each
    1. In `src/bar.ts`, directly after the `import` block, add `import { FooService } from "./foo";`.
    2. In `Bar.init()` (currently `src/bar.ts:41-58`), after the line `this.scene = scene;`, add `this.foo = new FooService(scene, { mode: "page" });`.
    3. Create `src/foo.ts` with the code in **Code** below.
    4. …
  - Code:                                                          # when the code is the decision: full or skeleton code, in the project's language
    ```ts
    export class FooService { … }
    ```
  - Do not: …                                                      # the tempting wrong turns: "do not add a second guard in pull()", "do not touch the metadata override"
  - Tests: `tests/foo.test.ts` (create, copy harness from `tests/bar.test.ts:1-30`) —   # required unless the task has no testable surface, in which case say so
    - `constructs with page mode by default` → `service.mode === "page"`
    - `throws on a null scene` → rejects with `TypeError`
    - run: `npm test -- tests/foo.test.ts`
  - Acceptance: <observable, checkable statements — what is true when this task is done>   # required
  - Verify: `npm test -- tests/foo.test.ts` → both named cases pass · `npx tsc --noEmit` → no errors · `grep -n "new FooService" src/bar.ts` → 1 hit   # required — commands + expected output (never an absolute suite count)
  - Verify level: standard                                         # required — `standard` or `live` (see Size the plan to the feature)
```

Rules for heavy task blocks:

- **Every task is self-contained.** Its Steps plus the Decisions and Design Reference sections it cites on **Applies** are everything needed to do it. A task must never say "follow the pattern from T3" — T3's context is gone by then; say "follow Design Reference › Conventions to mirror › <name>" and put the pattern there, once.
- **Steps are instructions, not goals.** "Add validation" is a goal; "In `submit()` at `:120`, before the `fetch` call, add `if (!form.name) { setError('name', 'Required'); return; }`" is a step. Every step names the file, the anchor, and the change.
- **Anchors are real.** Every `file:line` and "after `<code>`" anchor comes from Step 1's reading of the actual file. Prefer code anchors ("after the line `this.scene = scene;`") to bare line numbers where lines are likely to shift during a long run — or give both.
- **Names, signatures and values come from the Design Reference.** If a step introduces a name that is not in the Design Reference, add it there first. That is what keeps the fortieth task's naming identical to the third's.
- **Acceptance is observable.** Something a verifier can check by running a command or inspecting a file: a test count, a grep result, a rendered behaviour ("PLAY auto-scrolls to the document bottom"), never "works correctly". Sibling-skill behaviours are asserted in observable terms exactly as Step 2 requires.
- **Verify gives the command and the expected output**, so a fresh context compares against a stated value rather than judging. Expected outputs never pin absolute counts that later tasks change (total tests passed, suite sizes, ledger figures).
- **Keep the system working between tasks.** When a change spans tasks, say what temporary shim, flag, or compatibility write keeps the app running after each one, and which later task removes it — a resumed run may pause for days between them.

The **SPEC.md write-back task** is required under the same conditions as in Step 2 and is still the LAST task. In a heavy plan, **write the SPEC.md content in the task** — the exact paragraphs to merge into each current-state section and the exact Decisions entries to append (your `## Decisions` entries, promoted to project scope) — using the heavy task block (Steps that name each SPEC.md section and the text to insert, a **Code** block holding the exact markdown, a **Verify** of `grep -n "<distinctive phrase>" SPEC.md` → one hit each), so the write-back records what was planned rather than what one fresh context remembers at the end.

**5. `## How to execute this plan`** — the exact verbatim section from Step 2, unchanged.

### Cold-context audit (required in Heavy Plan mode, before the plan is final)

The draft is not the plan. A plan written in one pass by the same mind that holds all the context always leaves gaps that mind cannot see — the "obvious" choice that was never written down, the name that was in your head but not on the page, the task that quietly assumes you remember an earlier one. Those gaps are exactly what a fresh context at task 40 will fill in differently. The audit finds them now.

Emit `🕵️ [bt-plan] Cold-context audit — reading the draft as a fresh executor …`. Then, if a subagent-spawning tool is available, launch **one read-only audit subagent** with a fresh context (it must NOT see your reasoning, only the files), and give it: the path of the draft plan, the repository root, and these instructions verbatim:

> You are a competent engineer with a fresh context. You have never seen this repository or this feature before, and you will execute one task at a time with no memory of the others. Read the plan at `<path>` in full. Then, for **every** task, check the plan against the actual codebase (read the files and anchors it names) and list every point where you would be **forced to decide, guess, look up, or infer** something the plan should have given you: a missing signature, name, value, file location or anchor; an anchor that does not match the real file; a step that states a goal instead of an instruction; a step that depends on knowing what an earlier task did rather than on the Design Reference; a name used in a task that is not defined in the Design Reference; a test case without an expected outcome; a Verify without an expected output; an edge case with no decided behaviour; an API call whose exact usage is not shown; any use of "TBD", "appropriate", "suitable", "as needed", "etc." or "the implementer may". Also flag any task that would not fit in one sitting, any micro-task that should be merged into its neighbour, any ceremony task (verification sweep, ledger/baseline opening) the brief did not ask for, and any Verify that pins an absolute count a later task will change. Report as a list: `T<n> · step <k> · <what is missing> · <what you would have had to decide>`. Do not fix anything, do not write files, do not run builds or tests. Report "NO GAPS" only if you found none.

If no subagent tool is available, emit `➡️ [bt-plan] no subagent tool — self-auditing the draft` and perform the same read yourself, deliberately re-reading the plan top to bottom against the real files with the checklist above, one task at a time.

Emit `🧾 [bt-plan] Audit found <n> gaps across <m> tasks` (or `… found NO GAPS`). Then **resolve every reported gap by editing the plan** — add the missing decision to `## Decisions`, the missing code/signature/name to `## Design Reference`, the missing instruction to the task — and emit `🔧 [bt-plan] Resolved <n>/<n> gaps`. If the audit found more than 10 gaps, run it **once more** on the revised plan (`🕵️ [bt-plan] Second audit pass …`); stop after the second pass regardless, and list any gap you chose not to resolve, with why, in the plan's Codebase Analysis. A gap the audit reports that you cannot resolve without the user is a question for the user — ask it now. Re-writing the plan file after the audit is the one case where this skill writes it more than once; it is still the only file this skill ever writes.

Finish with `💾 [bt-plan] Plan finalized — _specs/<feature-name>_plan.md (<n> tasks, <k> decisions)`, then report the number of tasks and decisions, the two or three most consequential decisions (with their D-numbers), anything you were unable to resolve, and the same next-step hint as Quick Plan mode. Then **STOP** — heavy or not, this skill never begins T1.

---

## Subagents — invoking this skill IS the request

This skill's workflow depends on subagents. **Invoking it is the user's explicit request to use them**, so any host default of the form *"do not spawn subagents / do not call the agent tool unless the user asks for it"* is **ALREADY SATISFIED** — the user asked by running this command. Never silently downgrade to the inline path on that basis, and never stop to ask permission for it first.

Downgrading is not a neutral choice. It removes the one property that makes the step worth running: independence. A verifier that is the same context which just wrote the code cannot adversarially check it — it re-confirms its own reasoning and reports PASS.

The ONE legitimate reason to run inline is that you genuinely have **no** subagent-spawning tool. Check the tools you actually have — Claude Code exposes it as **`Agent`** (older builds name it `Task`); other hosts have their own equivalent. Never call a subagent tool you do not have. Use the exact fan-out / inline status strings this skill specifies for the *path-chosen* line (the progress-narration lines below carry a fixed prefix but free wording), and if you do run inline, state plainly that no subagent tool was available, never a policy.

## ⚠️ Progress narration — NEVER go silent

The user is watching a terminal, not your reasoning. Research and analysis in this skill routinely take several minutes, and **a silent span of more than about 30 seconds is indistinguishable from a hang or a crash** — users cancel runs on exactly that basis, throwing away all the work done so far. Silence is therefore a failure of this skill, not a neutral default. Narrate continuously, in short one-line status updates, from the first action to the final summary.

**Hard rules:**

1. **Announce before every long action.** Before any tool call that can take more than a few seconds — fetching the Agent Reference, reading `SPEC.md` / `DESIGN.md` / a sibling skill, launching subagents, a broad search — emit one visible line saying what you are about to do and why. Example: `🔎 [bt-plan] Reading SPEC.md and DESIGN.md to find the sections this feature must conform to …`
2. **Report after every result.** After each tool result, emit one line stating what you learned and what comes next, *before* the next tool call. The text between tool calls IS the progress display; a run of back-to-back tool calls with no text between them is a silent run.
3. **Subagents get a line each, going out and coming back.** When fanning out, print one line per subagent naming what it is investigating (`🚀 [bt-plan] Subagent 1/3 → mapping project structure, build + dependencies`). Prefer the host's background / non-blocking launch mode where it exists (Claude Code's `Agent` with `run_in_background: true`), so each completion returns control to you and you can report it: `✅ [bt-plan] Subagent 1/3 done — <one-line finding>`. Never block on all subagents in silence and then report them together.
4. **Waiting is also something to say.** If you are waiting on subagents with nothing else to do, say so once, naming what is still outstanding: `⏳ [bt-plan] Waiting on 2/3 research subagents (conventions to mirror, integration points) — typically 1–3 minutes …`. One line per wait, not repeated spam.
5. **Mark the phase transitions.** Emit a line when research starts, when it completes, and when drafting begins — e.g. `🧩 [bt-plan] Research complete — <n> findings synthesized` followed by a **3–6 bullet research summary** (the key findings, with file paths) so the user can see what the run is based on, then `✍️ [bt-plan] Drafting the document …`.
6. **Keep the lines short and uniform.** Format: `<emoji> [bt-plan] <what> — <detail>`. One line each. The prefix and emoji are fixed; the `<what>` / `<detail>` wording is yours. Do not dump findings, file contents, or tool output as progress — a status line says what happened, the document holds the detail.
7. **A silent gap may never span more than a single tool call.** If one tool call is itself long (a subagent, a large fetch), the line *preceding* it must say what it is and roughly how long it is expected to take.

This applies to every phase of this skill — the Agent Reference fetch, `SPEC.md`/`DESIGN.md` reads, the fan-out research, sibling-skill reads, interviewing, and drafting. When in doubt, say what you are doing.

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

This analysis can be **fanned out**. First check whether you actually have a subagent-spawning tool, and **emit one visible status line** so the user can see the path chosen — either `🔀 [bt-plan] subagent tool detected — fanning out analysis to N read-only subagents` or `➡️ [bt-plan] no subagent tool — analyzing sequentially`. If a subagent-spawning tool is available to you (e.g. Claude Code's `Agent`, Lovable's subagent tool, or your host's equivalent — check the tools you actually have; if there is none, or you are unsure, do the analysis yourself sequentially), launch up to 3 parallel **read-only** exploration subagents and divide the eight investigation points below among them (for example: one maps structure/build and dependencies; one extracts the real conventions and the closest existing feature to mirror; one lists integration points and constraints). Each subagent returns concise conclusions — findings and file paths, not file dumps — which you synthesize into the `## Codebase Analysis` section. Exploration subagents need not re-read the Agent Reference. Never call a subagent tool you do not actually have.

**Narrate the whole step** (see *Progress narration — NEVER go silent* above). This is the step that most often runs for minutes, so it is where the rule matters most. The required cadence:

- One `🚀 [bt-plan] Subagent i/N → <what it investigates>` line per subagent as it is launched, and prefer the background / non-blocking launch mode so completions return to you one at a time.
- One `✅ [bt-plan] Subagent i/N done — <one-line finding>` line as each returns; a `⏳ [bt-plan] Waiting on …` line if you are idle with subagents still outstanding.
- On the sequential path, one `🔎 [bt-plan] …` line before each read/search (each of the eight investigation points below) and one result line after it.
- When everything is in: `🧩 [bt-plan] Analysis complete — <n> findings synthesized`, followed by a 3–6 bullet analysis summary (key findings with file paths), before moving on to the interview (Quick Plan) or Step 2.

Before writing a single implementation step, investigate the actual codebase read-only. This is mandatory — do NOT generate any plan content until this analysis is complete. Read and search the repo to discover, not assume:

1. Read the referenced feature spec in full (from `_specs/` or the file named in `arguments`), **and read the project `SPEC.md` at the repository root in full.** SPEC.md is the source of truth for the durable architecture, systems, conventions, and decisions — the plan MUST conform to it. Note the feature spec's `spec_impact` field and its `Project Spec Alignment` section. **In Quick Plan mode there is no feature spec file** — treat the brief as the feature request, still read root `SPEC.md` in full, and *infer* the `spec_impact` and Project Spec Alignment from the analysis per the Quick Plan defaults table. If the plan you are about to write would conflict with SPEC.md (contradict a decision, cross a system boundary, break a convention), STOP and flag the conflict to the user before writing the plan; do not silently override the project spec.
2. Map the project: top-level structure, entry points, how the app is built and run (build scripts, test runner, package manifests).
3. Identify the conventions actually used in this repo: naming, file/folder organization, state management, styling, error handling, testing patterns.
4. Find the closest existing feature(s) or modules to the one being planned and study how they are implemented — the plan should follow these patterns.
5. List the concrete integration points the feature will touch: files, modules, APIs, data models, routes, config.
6. Note relevant dependencies already available (and their versions) versus anything new that would be required.
7. Capture any constraints from the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) and the feature spec.
8. If the feature builds on a **sibling-skill pattern** (e.g. bt-design's 3D-Hero-Scroll), read that sub-skill's reference **and its templates**. *(How to read one: where skills are loaded with a tool — the Babylon Toolkit App Builder platform — call `load_skill('<name>')`, then fetch its references and templates with `read_skill_resource` using the paths the load returns, never a guessed path. Where skills are files on disk — Claude Code — read them from the same skills directory, `~/.claude/skills/` or the project's `.claude/skills/`. Skip the load for anything already in your context.)* The plan MUST **copy and configure the sub-skill's template engine — never re-implement it from memory**; re-implementation is exactly how documented behaviors (`sweep`, veiled cuts, the preload gate, HUD auto-hide, graceful degradation) silently get dropped. Turn every behavioral-config requirement the spec records (e.g. `sweep: page`) into a concrete task whose Acceptance asserts that behavior in observable terms.

If the spec or codebase is too ambiguous to analyze responsibly, stop and ask the user rather than guessing.

*(In Heavy Plan mode, also apply the **Step 1 additions** listed under *Heavy Plan mode* above.)*

## Size the plan to the feature (all modes)

Execution cost is paid **per verification unit**, not per line of code: every phase bt-execute runs costs an implementer pass plus a fresh independent verifier. A plan that splits a one-hour feature into eight micro-tasks, adds bookkeeping tasks, and asks for live Unity/browser QA on each one turns an hour of work into a day. Rigor comes from good Acceptance, named tests and an independent verifier — not from the number of tasks. So:

1. **Read the size.** Take `size: small | medium | large` from the feature spec header. In Quick Plan mode (or for an older spec without it), infer it: **small** ≈ something a developer would do by hand in about 1–2 hours, touching one system; **medium** ≈ a day, a few systems; **large** ≈ multi-day, multi-system, or Unity/Blender/export pipeline work. Record it in Codebase Analysis.
2. **Task budget.** small → **1–3 tasks**; medium → **3–8**; large → as many as the work needs. Going over the budget needs a one-line reason in Codebase Analysis.
3. **A task is a meaningful unit of work** — a coherent change a developer would commit on its own, with its own tests. Merge tasks that edit the same file for the same purpose, or that cannot be tested apart (adding a constant and the code that uses it is ONE task). Split only when a task would not fit in one sitting.
4. **No ceremony tasks.** Do not write standalone "verification sweep", "confirm all callers", "open the review / ledger / baseline / archive" or "final check" tasks unless the brief asks for them. A read-and-confirm check belongs in the **Acceptance** of the task that made the change; the final end-to-end check belongs in the last phase's last task.
5. **Phases.** Group tasks under `### Phase N — <name>` headings inside `## Tasks`. bt-execute runs one independent verifier per phase, so a phase is "what should be checked together": a small plan is **one phase**; otherwise phases of 2–4 related tasks, ending where a checkpoint is natural (a working intermediate state, a UI becoming visible, the SPEC.md write-back).
6. **`Verify level` per task.** `standard` (default — build/typecheck, the named tests, diff review) or `live` (needs the dev server, a browser, or Unity/Blender to observe). Mark `live` whenever the task's Acceptance depends on runtime behavior — rendering, visuals, interaction, Unity↔Babylon parity; bt-execute runs live QA on such tasks even if unmarked. Whatever the per-task levels, the **last feature task** (before the SPEC.md write-back) carries one `live` **end-to-end check** of the whole feature when the feature has a rendered, exported or interactive surface — that is where "loaded in the browser, screenshotted, console clean" is verified, once.
7. **No brittle pins.** Never pin absolute counts that later tasks will change — total tests passed, suite sizes, ledger figures, file hashes of files later tasks edit. Say "the named tests pass and there are no new failures versus the baseline" instead. A pin that goes stale makes a correct task FAIL and costs a whole fix-loop round.
8. **Named tests, not exhaustive ones.** Each task with a testable surface names its test cases with expected outcomes. Cover the Acceptance and the edge cases the spec lists; do not ask for probe suites, fuzzing or mutation testing unless the feature's risk genuinely calls for it (say why).

## Step 2. Write the plan

> **Heavy Plan mode (`--heavy`):** the *Heavy plan document* structure and the *cold-context audit* under **Heavy Plan mode** above replace this step. The Codebase Analysis requirements, the SPEC.md write-back rules, and the verbatim `How to execute this plan` section below still apply unchanged inside that structure. Without the flag, follow this step exactly as written.

Emit `✍️ [bt-plan] Writing _specs/<feature-name>_plan.md …` before writing, and `💾 [bt-plan] Plan written — _specs/<feature-name>_plan.md` once the file is saved.

Only after Step 1 is complete, write the plan markdown to `_specs/` as `<feature-name>_plan.md`. The document MUST open with a `## Codebase Analysis` section that summarizes the findings from Step 1 (cite the real files/modules you inspected) — this is the evidence that the analysis happened. This section MUST include a short **SPEC.md alignment** note: which SPEC.md sections the plan conforms to, and whether the feature is spec-impacting (carry over the feature spec's `spec_impact`, or in Quick Plan mode the value you inferred, and say it was inferred). A plan without a grounded analysis section is invalid; do not produce one.

Then write the implementation as an ordered checklist of tasks, sized and grouped per *Size the plan to the feature* above. Use GitHub-style checkboxes so progress can be tracked directly in the file — one task per line, numbered T1, T2, T3 … in dependency order, grouped under phase headings:

```markdown
## Tasks

### Phase 1 — <name>

- [ ] **T1** — <short task title>
  - Files: `path/one`, `path/two`
  - Details: <what to do>
  - Tests: <test file> — `<case>` → <expected outcome>; … (or "no testable surface — <why>")
  - Acceptance: <how to know it is done — observable, no absolute count pins>
  - Verify level: standard
- [ ] **T2** — <short task title>
  - Files: `...`
  - Details: <...>
  - Tests: <...>
  - Acceptance: <...; includes the end-to-end check of the whole feature if this is the last feature task>
  - Verify level: live
```

When a task implements a **sibling-skill pattern**, its **Acceptance** must assert the skill-defined behavior in observable terms — e.g. for `sweep: page`, "PLAY auto-scrolls through to the document bottom and END jumps there", not merely "the hero renders". A plausible-looking result that dropped a documented behavior must fail acceptance. Prefer copying the sub-skill's template files as an early task (e.g. "T1 — copy + wire the 3D-Hero-Scroll engine") so later tasks only configure it.

### SPEC.md write-back task (required when the feature is spec-impacting)

If the feature is spec-impacting (`spec_impact: yes`, or your analysis found it adds/changes a system, convention, dependency, or architectural decision), the plan MUST end with an explicit final task that updates the project spec, so the write-back is tracked and independently verified like any other task — never left as a soft afterthought:

```markdown
- [ ] **T<n>** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: Update the specific SPEC.md section(s) named in the feature spec's Project Spec Alignment — e.g. add/modify the affected Game System, record the new Convention or Decision (with rationale), and add any new Dependency + version. Follow SPEC.md's "How to update this spec" contract: **replace/merge** the current-state sections (Architecture, Game Systems, Conventions, Dependencies) — removing seed placeholders on first real content — and **append** to the Decisions log (never delete; supersede with a newer entry).
  - Acceptance: SPEC.md accurately describes the architecture/systems/conventions/dependencies as actually implemented by the tasks above; no section contradicts the shipped code; new dependencies are listed.
  - Verify level: standard
```

Make this the LAST task so it captures the true final state. If the feature is genuinely not spec-impacting (`spec_impact: no`), omit this task, but state in the Codebase Analysis that no SPEC.md change is required.

Finally, include this exact `## How to execute this plan` section verbatim in the document so the plan is self-describing no matter how it is later run:

```markdown
## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- bt-execute verifies each phase with an independent verifier; add `--strict` for an adversarial verifier on every task.
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
```
