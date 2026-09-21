---
name: bt-plan
description: "The Babylon Toolkit Plan Skill creates the detailed technical plan for the specified feature spec file. Use when asked to plan or produce implementation tasks for an existing spec. Also supports a Quick Plan mode: when given only a brief (no spec file), it interviews the user to build a mini-spec and plans from that. Add `--heavy` for Heavy Plan mode: a decision-complete plan (numbered Decisions log, Design Reference with real interfaces and patterns, self-contained task blocks, cold-context audit) that keeps a long run of fresh-context tasks cohesive. Add `--parity` for numeric parity gates instead of the default functional proof. Always planning-only — it writes the plan file and stops; execution is the separate bt-execute skill."
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

Turn a feature spec into `_specs/<feature-name>_plan.md`: an ordered checklist of tasks that `bt-execute` runs. Follow the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md). The user's message after the skill name is the `arguments`.

```
/bt-plan [--heavy] [--parity] <feature-spec> <optional-brief>

/bt-plan @_specs/mute-game-audio_spec.md
/bt-plan "add a settings toggle to mute all game audio"     # no spec file → Quick Plan: short interview, then plan
/bt-plan --heavy @_specs/feature_spec.md                    # decision-complete plan for a long or cheaper-model run
/bt-plan --heavy --parity @_specs/feature_spec.md           # numeric parity gates against the reference (slow)
```

- `--heavy` — Heavy Plan mode (below). `--parity` — plan numeric parity proof; also on when the spec says `proof: parity`. Strip flags first; they are never part of the brief.
- Spec file (± brief) → plan from it. **Brief only → Quick Plan.** Neither → ask for a brief. Never guess a path or URL.

## Ground rules

- **Planning only — in every mode.** Research read-only; the plan file is the only file you write. Never implement a task, edit source, or run builds/tests — not even a trivial first task. Writing the plan is the last action; the user runs `bt-execute` separately.
- **Babylon work:** if you have not read the Babylon Toolkit Agent Reference in this session, fetch and read it once: https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md — the authority for conventions and API; fetch sub-documents only when relevant, and again only if a context compaction made you forget it. If the fetch fails, stop and tell the user — do not guess at the API.
- **Say what you are doing.** Before any step that takes more than a few seconds print one short line — `🔎 [bt-plan] <what> …` — and one when it returns; one line per subagent going out and coming back. A silent run looks like a hang and gets cancelled.
- **Subagents:** running this skill is the user's request to use them where it says so. Use whatever subagent tool your host provides (its name varies by host — e.g. `Agent` or `Task`); if there is none, work inline and say so. Tell exploration subagents they need not fetch the Agent Reference.

## Step 1. Analyze (required before writing)

1. Read the feature spec in full, and `SPEC.md`'s headings, Architecture, Conventions and the systems the feature touches. The plan must conform to SPEC.md — **if it would conflict, stop and tell the user.** Verification procedures described in SPEC.md are tooling you may reuse, not a bar the plan must meet. Note the spec's `spec_impact`, `size` and `proof`.
2. **Start from the spec's `## Research Notes`.** Spot-check that the paths exist, then research only what a plan needs beyond them: how the app is built and tested, the real conventions and the closest feature to mirror, the concrete files and integration points, available dependencies, constraints from the agent instructions.
3. Size the research: `small` → inline; `medium` / `large` (or no Research Notes) → up to 3 **read-only** subagents returning findings and paths, not file dumps. Tell each one verbatim: *"Read-only: you may read, search and report. Do not edit or create files, and do not run builds, tests or any command that writes — not even into a build folder. If a fact needs a build or a test run to establish, report it as unknown and say which command would settle it."*
4. Sibling-skill pattern (e.g. bt-design's 3D-Hero-Scroll): read that skill's reference **and templates** *(where skills load through a tool: `load_skill` + `read_skill_resource`, never a guessed path; where they are files: the skills directory this skill was loaded from, e.g. `~/.claude/skills/`, `~/.agents/skills/` or the project's equivalent)*. The plan **copies and configures the template engine — never re-implements it**; each behavioral option the spec records (e.g. `sweep: page`) becomes an Acceptance item stated in observable terms. Prefer copying and wiring the template as the first task, so later tasks only configure it.
5. Too ambiguous to plan responsibly → ask the user. **Already built?** If the research shows some or all of the feature already exists, say so first and plan only what is missing (often just tests and the live check).

**Quick Plan (no spec file):** after the analysis, ask a small round of high-leverage questions (scope, behavior, edge cases, which systems it touches); skip anything the brief or code already answers. Unanswered items fall back to: feature name from the brief (kebab-case); `spec_impact` and `size` inferred from the analysis; `proof: functional` unless `--parity`. List the assumptions in Codebase Analysis.

## Step 2. Rules for a good plan

Execution time is mostly *how the work is proven*, not the code. Keep proof strong and cheap:

1. **Tasks are real units of work** — something a developer would commit on its own, with its tests. Guide: `small` 1–3 tasks, `medium` 3–8, `large` as needed. Merge tasks that touch the same code for the same purpose; split only when a task would not fit in one sitting. Going well past the guide needs a one-line reason in Codebase Analysis.
2. **Phases.** Group tasks under `### Phase N — <name>`. bt-execute runs one independent verifier per phase. Small plan = one phase; otherwise 2–4 related tasks ending at a natural checkpoint.
3. **`Verify level`** per task: `standard` (build, named tests, diff review) or `live` (needs the dev server, a browser, Unity or Blender to observe). Mark `live` whenever correctness shows only at runtime — rendering, UI, interaction, Unity↔Babylon parity. The last feature task carries one `live` end-to-end check of the whole feature when it has anything on screen — write it into that task's Acceptance, not as a separate task; a read-and-confirm check likewise belongs in the Acceptance of the task that made the change. bt-execute's verifier performs the live checks, and does all of a phase's live tasks in **one** session. So mark as many tasks `live` as truly need it, but never schedule a capture, screenshot or page session **per task** in the Steps — the phase gets one session covering all of them, and any second engine or full-resolution pass happens once, in the final end-to-end task. A plan with more planned looks than phases is the single most expensive mistake this skill can make. If a live check may be impossible where the plan runs (needs credentials, data or hardware), say in the task what to report instead.
4. **Named tests** with expected outcomes for every task that has a testable surface. No probe suites, fuzzing or mutation testing unless the risk calls for it.
5. **Functional proof by default:** unit tests; for anything on screen, one look per visual phase — the running result in the browser, judged against the spec and DESIGN.md, or beside a reference image when one exists (a mockup, the original site, the Unity view) — on one browser/engine at reduced resolution, with any second engine checked once in the final end-to-end task; cheap value fixtures sampled once from a reference implementation where there is one. Keep Acceptance to what a user of the feature would notice. **Numeric parity gates** (pixel thresholds, repeats, several engines) only under `--parity` / `proof: parity` or when the brief states a number — and then planned to run once per phase (iteration inside the phase uses the quick look), never loosened.
6. **Proportional safety.** When the spec requires a safety outcome (nothing unfinished reaches the user's folders, the app keeps working between tasks), pick the cheapest mechanism that achieves it — normally a feature branch, a build output the user's folders do not read, and one copy across at the end after the live check. Version control is the archive. Add staged promotions, per-step archives or hash records only if the brief asks for them by name.
7. **No ceremony.** No standalone "verification sweep / open the review / final check" tasks, and no ledgers, md5 or environment records, archives, checked-in capture trees, standing evidence suites, doc-integrity registration or staged promotions — unless the brief asks.
8. **No brittle pins.** Never pin counts later tasks will change (tests passed, suite sizes, hashes). Say "the named tests pass, no new failures versus the baseline".

## Step 3. Write the plan

Print `✍️ [bt-plan] Writing _specs/<feature-name>_plan.md …`. The file has, in order:

**`## Codebase Analysis`** — what Step 1 found, citing real files; the SPEC.md sections the plan conforms to; `spec_impact`, `size`, `proof` (say which were inferred); Quick Plan assumptions.

**`## Tasks`**

```markdown
### Phase 1 — <name>

- [ ] **T1** — <short imperative title>
  - Files: `path/one` (create), `path/two` (modify)
  - Details: <what to do>
  - Tests: `<test file>` — `<case>` → <expected outcome>; …   (or "no testable surface — <why>")
  - Acceptance: <observable, checkable statements>
  - Verify level: standard
```

**`Update SPEC.md` — the last task, when the feature is spec-impacting** — `spec_impact: yes`, or your analysis found it adds or changes a system, convention, dependency or architectural decision (otherwise state in Codebase Analysis that none is needed):

```markdown
- [ ] **T<n>** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: Update the sections named in the spec's Project Spec Alignment, following SPEC.md's "How to update this spec" (replace/merge current-state sections; append Decisions). Record the product only — never verification procedure, tool lists, ledgers or gates.
  - Acceptance: SPEC.md matches what the tasks above shipped; new dependencies listed; nothing contradicts the code.
  - Verify level: standard
```

**`## Estimated execution time`** — **agent time, computed from the measured rates below — never from how long a developer would take.** An agent writes a 500-line module with its tests in about ten minutes; what costs time is running things. Count, per phase:

| What the phase contains | Measured agent time |
| --- | --- |
| each code + unit-test task (any language) | 5–10 min |
| each task that also rebuilds a native/C# library or runs a full test chain — once per task, however many builds it runs | + 10–20 min |
| each Unity / Blender **Editor operation** — one authoring pass, one bake, one export, one capture (count a job that authors dozens of objects as 2–3) | + 15–30 min |
| each live look — one **scene × engine page session**, not one screenshot; a build that exists only to serve a look is already inside this rate | + 10–20 min |
| a visual "adjust until it looks right" loop — only where the plan says it expects to iterate on a picture | + 45–90 min |
| the phase's independent verifier (counts under Prove) | + 5–10 min |

Write a table `Phase | Tasks | Build | Prove | Estimate` (Build = code and tests; Prove = exports, captures, looks, adjust-until-right), then one **Total** = the sum plus 20–40 % for fix loops, in hours (days only if over ~16 h), the `--strict` multiplier (~2–3×), what would cut Prove if it exceeds Build, and the biggest uncertainty. If the total exceeds ~1 h per task, re-check it against the table. Usual causes: developer-hours thinking in the Build column; ceremony the brief did not ask for; or per-task captures that rule 5 says to batch. If the cost is load-bearing work the brief *did* ask for, say so in one line and keep the number. An estimate, never a pin.

**`## How to execute this plan`** — this text verbatim:

```markdown
## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- bt-execute verifies each phase with an independent verifier; add `--strict` for an adversarial verifier on every task.
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
```

Then **stop**. Final message: a short summary, the estimated time, and:

```
Plan written to _specs/<feature-name>_plan.md — <n> tasks, estimated <total range> of agent time
Run a single task with `bt-execute _specs/<feature-name>_plan.md T1`, or every task with `bt-execute _specs/<feature-name>_plan.md ALL` (add `--strict` for an adversarial verifier on every task).
```

## Heavy Plan mode (`--heavy`)

Use when the plan will be executed in fresh contexts, over days, or by a cheaper model than the one planning. The plan file is then the only memory that survives between tasks: **whatever it does not say, task 40 will re-decide differently from task 3.** So a heavy plan decides everything once, in one place, and every task cites it. Print `🏋️ [bt-plan] Heavy Plan mode`. Everything above still applies; the document gains two sections and richer task blocks. There is no limit on how much a heavy plan may say — write what the executor needs — but the number of tasks still follows the spec's `size`.

In Step 1, collect plan-grade detail: `file:line` references, the real signatures the feature calls or changes, verbatim 10–30-line snippets of the conventions to mirror, the exact API usage from the Agent Reference sub-documents, and the test baseline (command, current state, pre-existing failures). Carry the spec's Decisions forward and resolve every Open Question — with the user if needed. "TBD", "as appropriate", "the implementer may choose" are forbidden.

Sections, in order: `## Codebase Analysis` (plus the test baseline) · **`## Decisions`** · **`## Design Reference`** · `## Tasks` · `## Estimated execution time` · `## How to execute this plan`.

- **`## Decisions`** — numbered `D1, D2 …`, one per choice that binds more than one task or rejects a plausible alternative — architecture, file layout, naming, algorithms and constants, error policy, dependencies (exact packages and versions, or "no new dependencies"), sibling-skill option values, test strategy:
  `- **D3 — <decision, stated as a fact>.** <why / precedent with file:line> Rejected: <alternative> (<why not>). Binds: T4, T7.`
- **`## Design Reference`** — the shared blueprint, written as code wherever the code *is* the decision: File map (path · create/modify/delete · responsibility · tasks) · Module boundaries · Interfaces & contracts (full signatures, in the project's language) · Data shapes & state · Control flow · Algorithms & formulas with their constants · Error & edge-case policy (`when X → Y`) · Conventions to mirror (verbatim, with `file:line`) · API usage · Test strategy. Omit a heading only if it truly does not apply.
- **Heavy task block** — adds to the standard block: `Depends on:` · `Applies:` (the D-numbers and Design Reference entries it must match) · `Steps:` numbered instructions, each naming the file, a real anchor (prefer quoted code over bare line numbers) and the change · `Code:` when the code is the decision · `Do not:` the tempting wrong turns · `Verify:` commands with expected output. `Depends on`, `Files`, `Applies`, `Steps`, `Tests`, `Acceptance`, `Verify` and `Verify level` are required on every heavy task. A task never says "like T3" — it cites the Design Reference; a name, signature or value a step introduces is added to the Design Reference first, so task 40 types what task 3 typed. Say what keeps the app working between tasks (shim, flag) and which task removes it. The `Update SPEC.md` task carries the exact text to write.
- **Cold-context audit (one pass).** After the draft, launch one fresh read-only subagent (or re-read it yourself) with: *"You have never seen this repo. For every task, check the plan against the real files and list each point where you would have to decide, guess or look something up: a missing signature, name, value or anchor; an anchor that does not match the file; a goal stated instead of an instruction; a dependence on remembering an earlier task; a name used in a task but not defined in the Design Reference; a test without an expected outcome; a Verify without an expected output; vague words ("appropriate", "as needed", "etc."); a task that would not fit in one sitting; an edge case with no decided behavior; an API call not shown. Also flag micro-tasks to merge, ceremony tasks nobody asked for, and pinned counts later tasks will change. Report `T<n> · step · what is missing`. Change nothing."* Fix every gap in the plan, ask the user what only they can answer, list any gap you chose not to resolve (with why) in Codebase Analysis, then finalize: `💾 [bt-plan] Plan finalized — <n> tasks, <k> decisions`, and report the two or three most consequential decisions and anything left unresolved.
