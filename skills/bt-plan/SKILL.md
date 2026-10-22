---
name: bt-plan
description: "The Babylon Toolkit Plan Skill creates the detailed technical plan for the specified feature spec file. Use when asked to plan or produce implementation tasks for an existing spec. Also supports a Quick Plan mode: when given only a brief (no spec file), it interviews the user to build a mini-spec and plans from that. Add `--heavy` for Heavy Plan mode: a decision-complete plan (numbered Decisions log, Design Reference with real interfaces and patterns, self-contained task blocks, cold-context audit) that keeps a long run of fresh-context tasks cohesive. Add `--parity` for numeric parity gates instead of the default functional proof. Always planning-only — it writes the plan file into the feature's folder (`.agents/specs/<slug>/`, which a Quick Plan creates) plus the feature's live dashboard in its planned state, and stops; execution is the separate bt-execute skill."
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

Turn a feature spec into `.agents/specs/<slug>/documents/<slug>_plan.md`: an ordered checklist of tasks that `bt-execute` runs — plus the feature's dashboard (`.agents/specs/<slug>/dashboard.html`) in its planned state, which bt-execute keeps current — live activity while a run is going, an After Action Report once it is over. Follow the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md). The user's message after the skill name is the `arguments`.

```
/bt-plan [--heavy] [--parity] [--no-time-limit] <feature-spec> <optional-brief>

/bt-plan @.agents/specs/mute-game-audio/documents/mute-game-audio_spec.md
/bt-plan "add a settings toggle to mute all game audio"     # no spec file → Quick Plan: short interview, creates the feature folder, then plans
/bt-plan --heavy @.agents/specs/<slug>/documents/<slug>_spec.md   # decision-complete plan for a long or cheaper-model run
/bt-plan --heavy --parity @.agents/specs/<slug>/documents/<slug>_spec.md   # numeric parity gates against the reference (slow)
/bt-plan --no-time-limit @.agents/specs/<slug>/documents/<slug>_spec.md   # turn off the default TIME MATTERS mode
```

- `--heavy` — Heavy Plan mode (below). `--parity` — plan numeric parity proof; also on when the spec says `proof: parity`. `--no-time-limit` — turn off TIME MATTERS mode (Ground rules). Strip flags, and any literal `TIME MATTERS`, first; they are never part of the brief.
- Spec file (± brief) → plan from it. **Brief only → Quick Plan.** Neither → ask for a brief. Never guess a path or URL.

## Ground rules

- **TIME MATTERS** — on by default; `--no-time-limit` turns it off. Treat the arguments as ending with `TIME MATTERS`: the user is waiting on this run, so finish quickly — research only what the plan needs, keep subagents few and their questions narrow, and do not re-read what you already have. Begin every subagent prompt with `TIME MATTERS.` Print `⏱️ [bt-plan] TIME MATTERS` at the start (`--no-time-limit`: print `⏱️ [bt-plan] No time limit`, and do not add it). Speed never skips a required step, the Heavy Plan cold-context audit, or anything the plan needs to be complete.
- **Planning only — in every mode.** Research read-only; the only files you write are the plan and the dashboard (`dashboard.html` and its data files) in the feature folder, plus the one `.gitignore` line Step 4 names. Never implement a task, edit source, or run builds/tests — not even a trivial first task. Writing the plan is the last action; the user runs `bt-execute` separately.
- **Babylon work:** if you have not read the Babylon Toolkit Agent Reference in this session, read it once: https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md — the authority for conventions and API; read sub-documents only when relevant, and again only if a context compaction made you forget it. If it cannot be read, stop and tell the user — do not guess at the API.
- **Say what you are doing.** Before any step that takes more than a few seconds print one short line — `🔎 [bt-plan] <what> …` — and one when it returns; one line per subagent going out and coming back. A silent run looks like a hang and gets cancelled.
- **Subagents:** running this skill is the user's request to use them where it says so. Use whatever subagent tool your host provides (its name varies by host — e.g. `Agent` or `Task`); if there is none, work inline and say so. Tell exploration subagents they need not read the Agent Reference.

## Step 1. Analyze (required before writing)

1. Read the feature spec in full, and `SPEC.md`'s headings, Architecture, Conventions and the systems the feature touches. The plan must conform to SPEC.md — **if it would conflict, stop and tell the user.** Verification procedures described in SPEC.md are tooling you may reuse, not a bar the plan must meet. Note the spec's `spec_impact`, `size` and `proof`.
2. **Start from the spec's `## Research Notes`, and any bt-recon doc it cites (the feature's own `recon/` copies, or `.agents/recon/*_recon.md`) or whose scope covers the systems the feature touches** — its Extension Points and End-to-End Flows usually name the integration points directly. Spot-check that the paths exist, then research only what a plan needs beyond them: how the app is built and tested, the real conventions and the closest feature to mirror, the concrete files and integration points, available dependencies, constraints from the agent instructions.
3. Size the research: `small` → inline; `medium` / `large` (or no Research Notes) → up to 3 **read-only** subagents returning findings and paths, not file dumps. Tell each one verbatim: *"Read-only: you may read, search and report. Do not edit or create files, and do not run builds, tests or any command that writes — not even into a build folder. If a fact needs a build or a test run to establish, report it as unknown and say which command would settle it."*
4. Sibling-skill pattern (e.g. bt-design's 3D-Hero-Scroll): read that skill's reference **and templates** *(where skills load through a tool: `load_skill` + `read_skill_resource`, never a guessed path; where they are files: the skills directory this skill was loaded from, e.g. `~/.claude/skills/`, `~/.agents/skills/` or the project's equivalent)*. The plan **copies and configures the template engine — never re-implements it**; each behavioral option the spec records (e.g. `sweep: page`) becomes an Acceptance item stated in observable terms. Prefer copying and wiring the template as the first task, so later tasks only configure it.
5. Too ambiguous to plan responsibly → ask the user. **Already built?** If the research shows some or all of the feature already exists, say so first and plan only what is missing (often just tests and the live check).

**Quick Plan (no spec file):** after the analysis, ask a small round of high-leverage questions (scope, behavior, edge cases, which systems it touches); skip anything the brief or code already answers. Unanswered items fall back to: feature name from the brief — the `<slug>`: lowercase kebab-case, `a-z 0-9 -` only, max 40 chars, with `-02`, `-03` … appended if a folder of that name already exists in `.agents/specs/`, `.agents/complete/` or anywhere under `.agents/archived/`; `spec_impact` and `size` inferred from the analysis; `proof: functional` unless `--parity`. List the assumptions in Codebase Analysis. **A Quick Plan is a creation point:** it first makes sure the default `.agents` folders exist — `.agents/specs/`, `.agents/complete/`, `.agents/archived/`, `.agents/profile/` and `.agents/recon/`, each with an empty `.gitkeep` (write only the ones missing; never touch what a folder holds), then creates the feature folder `.agents/specs/<slug>/` (with `documents/`), exactly as bt-spec would, and the plan, report and tests live there.

**The feature folder.** Every feature has one: `.agents/specs/<slug>/` holding `dashboard.html` (the feature dashboard), `documents/` (`<slug>_spec.md`, `<slug>_plan.md`, bt-execute's `<slug>_autopilot.md`, the dashboard data `<slug>_dashboard.js` and live status `<slug>_live.js`), `snapshots/` and `tests/`. From a spec, `<slug>` is its folder name. A **legacy flat spec** (`.agents/specs/<slug>_spec.md`) is read where it is and left there; the plan and report still go into the new `.agents/specs/<slug>/` folder, and the report's Spec link points back to the flat file.

## Step 2. Rules for a good plan

Execution time is mostly *how the work is proven*, not the code. Keep proof strong and cheap:

1. **Tasks are real units of work** — something a developer would commit on its own, with its tests. Guide: `small` 1–3 tasks, `medium` 3–8, `large` as needed. Merge tasks that touch the same code for the same purpose; split only when a task would not fit in one sitting. Going well past the guide needs a one-line reason in Codebase Analysis.
2. **Phases.** Group tasks under `### Phase N — <name>`. bt-execute runs one independent verifier per phase. Small plan = one phase; otherwise 2–4 related tasks ending at a natural checkpoint.
3. **`Verify level`** per task: `standard` (build, named tests, diff review) or `live` (needs the dev server, a browser, Unity or Blender to observe). Mark `live` whenever correctness shows only at runtime — rendering, UI, interaction, Unity↔Babylon parity. The last feature task carries one `live` end-to-end check of the whole feature when it has anything on screen — write it into that task's Acceptance, not as a separate task; a read-and-confirm check likewise belongs in the Acceptance of the task that made the change. bt-execute's verifier performs the live checks, and does all of a phase's live tasks in **one** session. So mark as many tasks `live` as truly need it, but never schedule a capture, screenshot or page session **per task** in the Steps — the phase gets one session covering all of them, and any second engine or full-resolution pass happens once, in the final end-to-end task. A plan with more planned looks than phases is the single most expensive mistake this skill can make. If a live check may be impossible where the plan runs (needs credentials, data or hardware), say in the task what to report instead.
4. **Named tests** with expected outcomes for every task that has a testable surface, in test files under the feature folder's `tests/` (`.agents/specs/<slug>/tests/` — never a root `tests/` folder). No probe suites, fuzzing or mutation testing unless the risk calls for it.
5. **Functional proof by default:** unit tests; for anything on screen, one look per visual phase — the running result in the browser, judged against the spec and DESIGN.md, or beside a reference image when one exists (a mockup, the original site, the Unity view) — on one browser/engine at reduced resolution, with any second engine checked once in the final end-to-end task; cheap value fixtures sampled once from a reference implementation where there is one. Keep Acceptance to what a user of the feature would notice. **Numeric parity gates** (pixel thresholds, repeats, several engines) only under `--parity` / `proof: parity` or when the brief states a number — and then planned to run once per phase (iteration inside the phase uses the quick look), never loosened.
6. **Proportional safety.** When the spec requires a safety outcome (nothing unfinished reaches the user's folders, the app keeps working between tasks), pick the cheapest mechanism that achieves it — normally a feature branch, a build output the user's folders do not read, and one copy across at the end after the live check. Version control is the archive. Add staged promotions, per-step archives or hash records only if the brief asks for them by name.
7. **Minimal exports.** A task's Steps re-export only the Unity project the task tests and only the scenes it works on, and only when the change alters that scene's export. Never write "re-export every scene" or "re-export all projects" for consistency — other scenes pick the change up at their next natural export. Name the scenes explicitly.
8. **No ceremony.** No standalone "verification sweep / open the review / final check" tasks, and no ledgers, md5 or environment records, archives, checked-in capture trees, standing evidence suites, doc-integrity registration or staged promotions — unless the brief asks.
9. **No brittle pins.** Never pin counts later tasks will change (tests passed, suite sizes, hashes). Say "the named tests pass, no new failures versus the baseline".
10. **Plan code follows the Agent Reference's Coding Practices — ENFORCED.** Every snippet, signature, interface, class, method, property, variable, constant and file name the plan writes or decides is clean, professional TypeScript or JavaScript in the language the project uses (never switched unasked), with meaningful full-word names (never one- or two-letter names, cryptic abbreviations or code-golf tricks), well structured, readable and maintainable by human developers, and carries meaningful JSDoc on every class, function, method, interface and public member it defines. JSDoc is always written but never a gate: never write an Acceptance item, Test or Verify step that fails on missing JSDoc. The executor copies plan code word for word, so a badly named snippet ships badly named. Names that bind to exported data (component properties, serialized fields, Unity property names) keep the source's names. Plan UI code also follows **Game UI Performance — ENFORCED**: every HUD value the plan introduces is classified as *state* (React, set on events) or *telemetry* (refs and one frame loop, never React state or a per-frame EventBus message), and the plan's snippets show telemetry that way. Every UI element also gets the cheapest cadence in `ui-design-system.md` › **Per frame or not** — events for state, CSS for decorative motion, the frame loop only for telemetry, throttled readouts, nothing while hidden — and no plan snippet puts a frame loop on a menu, splash, preloader or landing page (a real-time hero excepted, paused off-screen and at rest). Code-quality checks are never a separate task; bt-execute's verifier enforces them on every task.

## Step 3. Write the plan

Print `✍️ [bt-plan] Writing .agents/specs/<slug>/documents/<slug>_plan.md …`. The file has, in order:

**`## Codebase Analysis`** — what Step 1 found, citing real files; the SPEC.md sections the plan conforms to; `spec_impact`, `size`, `proof` (say which were inferred); Quick Plan assumptions.

**`## Tasks`**

```markdown
### Phase 1 — <name>

- [ ] **T1** — <short imperative title>
  - Files: `path/one` (create), `path/two` (modify)
  - Details: <what to do>
  - Tests: `.agents/specs/<slug>/tests/<test file>` — `<case>` → <expected outcome>; …   (or "no testable surface — <why>")
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

**`## Estimated execution time`** — **agent time, from the calibration below — never developer-hours, and never by adding up activities.** Builds, exports, captures and browser looks are *not* separate line items: they happen inside a task's own run and are already inside the per-task rate. Counting them separately is how a 10-hour plan gets estimated at 45 hours.

Rate each task by the **kind of work it does** (classify tasks, not the plan — most plans mix kinds), sum, then give a range of **−35 % / +50 %**. Nothing else is added — no per-phase overhead (it did not show up in the measurements):

| Kind | min/task | What puts a task here |
| --- | --- | --- |
| **Code** | 6 | Code + tests, at most a quick browser look or one small scripted export. |
| **Live** | 16 | Proven by running it: live external APIs, a page or scene loaded and probed in a browser, live memory or perf runs in one engine, a visual match to a reference image. |
| **Game** | 40 | Proven by **playing the running game**: races, laps or levels driven through scenarios, a two-page network session, reproducing an intermittent in-game bug, tuning feel or sound by eye and ear. |
| **Unity / parity / GPU** | 35 | Authoring or re-exporting Unity content, measured parity against Unity Play mode, GPU shader backends, perf A/B across beds, exporter DLL + runtime changed together. |

- **Live or Game?** Loading a scene and reading values from it is Live. Playing it until something happens is Game. Game work ran 1.2–2.8× its estimate when it was rated Live, because every scenario is a real-time play session and a bug that only shows on lap three costs three laps each time it is checked.
- **Do not budget fix rounds.** They are inside the rates: about one task in four needed a second attempt in both calibrations, and every one of those is already in the numbers. Defensively budgeting rounds per phase was the single largest source of over-estimation in the first calibration.
- **Do not add a further margin.** The range is the margin. Do not discount for parallel phases either — the rates are wall-clock with bt-execute's usual parallelism.
- **Outsized work is 2× the task's own kind rate**, never a flat figure. A task that ports a whole engine subsystem rated as Code is 12 min, not the Unity rate doubled (babylon-toolkit-networking rated its nine engine-scale code tasks at a flat 72 min each, estimated 15.7 h and ran 6.4 h). A task that builds a compiler or transpiler, or must prove coverage across many Unity sample projects, is 2× Unity (shadergraph-transpiler-complete-coverage: 72 min/task). Multiply by ~2 for `proof: parity` only if the plan really carries numeric gates, and by ~2–3 for `bt-execute --strict` (neither measured yet).
- **Unity frame-matching runs long.** A task proven by matching Unity frame by frame (animation feel, foot IK, landing poses) is where Unity tasks overran most (starter-assets-third-person: 2.4×). Name it as the biggest uncertainty.
- **The estimate covers the plan as written.** Tasks added mid-run cost far more than planned ones — unity-terrain-system-parity's 17 planned tasks took about 6 h, the 9 added during the run about 21 h; mario-kart-port grew from 22 to 42 tasks. Say so in the biggest-uncertainty line when the scope is still moving. Tasks added after a plan is complete get their own estimate at these rates.

**Calibration (third, 2026-10-19; 40 runs).** 19 new bt-execute runs (Runtime, 2026-10-07 → 10-19, 190 tasks) measured from their `⏱` lines, active time only, with waits on the user excluded, fitted per task kind together with the 21 runs of the 2026-10-07 calibration. Each new run's actual ÷ estimate at these rates:

| Run | Mix (tasks by kind, outsized counted 2×) | Active | ÷ estimate |
| --- | --- | --- | --- |
| ugui-animation-parity | code 4 · Unity 5 | 80 min | 0.40 |
| draco-mesh-compression | code 3 · Unity 4 | 90 min | 0.57 |
| light-probe-network-toggle | code 5 · live 1 | 29 min | 0.63 |
| mario-kart-audio-parity | code 2 · game 4 | 112 min | 0.65 |
| navigation-areas-costs | code 9 · live 1 · Unity 2 | 92 min | 0.66 |
| lens-flares-all-pipelines | code 2 · live 3 · Unity 6 | 204 min | 0.76 |
| prewarm-behind-splash | code 3 · live 5 · GPU 1 | 103 min | 0.77 |
| unity-timeline-playback | code 5 · Unity 6 | 186 min | 0.78 |
| babylon-game-server | code 8 · live 8 | 157 min | 0.89 |
| mario-kart-leftover-particles | game 5 | 189 min | 0.94 |
| babylon-toolkit-networking | code 20 · Unity 8 | 385 min | 0.96 |
| mario-kart-drift-vfx-parity | Unity 2 · game 1 | 107 min | 0.97 |
| cinemachine-port | code 10 · Unity 14 | 560 min | 1.02 |
| vfx-graph-port | code 10 · Unity 7 | 310 min | 1.02 |
| unity-animator-port (run 1) | code 7 · live 3 · Unity 9 | 455 min | 1.12 |
| mario-kart-antigravity | Unity 2.3 · game 2 | 230 min | 1.43 |
| terminal-portals-fps-controller | code 5 · live 1 · Unity 6 | 375 min | 1.46 |
| prewarm-splash-status | code 1 · live 1 | 36 min | 1.64 |
| starter-assets-third-person | code 2 · live 1 · Unity 3 · game 1 | 411 min | 2.38 |

Across all 40 runs the median actual ÷ estimate is **1.00**; 30 of 40 land inside −35 % / +50 % and 34 of 40 within 0.6–1.6×. The previous rates (code 8 · live 18 · Unity 35, −30 % / +40 %) put only 11 of the 19 new runs inside their range: they ran about 2× high on engine-code plans and up to 2× low on plans that play the game. Excluded from the fit: mario-kart-port (scope grew 22 → 42 tasks mid-run), hdrp-complete-parity's run 2 (a reopened, deferred task), and the user-directed follow-up runs of draco-mesh-compression and unity-animator-port.

To recalibrate later, read the `⏱` lines bt-execute writes to each `documents/<slug>_autopilot.md` (older runs: `<plan>_autopilot.md` beside a flat plan) — they carry the plan's estimate, active minutes per phase and per run, and waits already separated out.

Write a table `Phase | Tasks | Kind (code / live / game / Unity) | What makes it slow | Estimate`, then one **Total** line in hours (days only if over ~16 h), the `--strict` multiplier, and the biggest uncertainty in one line. If the total averages above ~45 or below ~5 min per task, the estimate is wrong before the plan is: re-check it. An estimate, never a pin.

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

## Step 4. Write the dashboard (planned state)

Print `🗂️ [bt-plan] Writing the feature dashboard …`. **A spec from bt-spec already has a dashboard, in its `specified` state** (showing the bt-plan commands): read its `<slug>_dashboard.js` first and keep its `feature`, `decisions` and `activity`; everything below then fills it in and moves it to `planned`. A Quick Plan, or a spec with no dashboard, creates it here. From bt-execute's `templates/dashboard/` *(where skills load through a tool: `load_skill('bt-execute')` + `read_skill_resource`; where they are files: the sibling `bt-execute/` folder in the skills directory this skill was loaded from)*:

- copy `dashboard.html` to `.agents/specs/<slug>/dashboard.html`, replacing `{{slug}}` with the slug and changing nothing else (always — over a copy bt-spec wrote too, so the page is the current template);
- write `.agents/specs/<slug>/documents/<slug>_dashboard.js` from the starter `dashboard.template.js`, written whole as strict JSON behind its `window.FEATURE_DASHBOARD =` prefix — double-quoted keys, no comments, no trailing commas (`data-schema.md` documents every field): `feature` (title, slug, branch, `origin` `spec` or `quick-plan`, size, proof, a plain-language summary), `documents` (Spec — omitted for a Quick Plan — and Plan), `status: "planned"`, `updatedAt` from the shell clock (`date '+%Y-%m-%d %H:%M'`; with no shell, the current local time), `estimate` (the Total line), every phase and task from the plan as `pending` (id, title, kind from the estimate table, verify level), an empty `afterAction` and no snapshots, the plan’s Decisions as `decisions` (Heavy Plan; otherwise the spec’s), each an object `{ "id": "D1", "text": "…", "updates": [] }` (never a plain `"D1 — …"` string, which shows as an empty row), and one more `activity` line: `Plan written — <n> tasks in <k> phases, estimated <range>` (after bt-spec's `Spec written` line when there is one);
- write `.agents/specs/<slug>/documents/<slug>_live.js` from `live.template.js`, the same way (whole, strict JSON): no task, `role: "orchestrator"`, `title: "Plan written — waiting for bt-execute"`, no steps (bt-execute rewrites it at every step of a run).
- in a git repository, make sure `.gitignore` (at the repository root) contains the line `.agents/*/*/documents/*_live.js` — append it once if missing. The live file is rewritten at every step of a run and is not history worth keeping; `<slug>_dashboard.js` is, and stays tracked. A live file git already tracks is left as it is.

Re-planning an existing feature rewrites the data file's phases and tasks from the new plan but keeps the results of tasks already done, its `afterAction` and its `activity` history, adding a `Plan revised` line; new tasks are `pending` with an `updates` note, and a `complete` status becomes `paused`. If the template cannot be found, skip the dashboard and say so — bt-execute creates it on its first run.

Then **stop**. Final message: a short summary, the estimated time, and:

```
Plan written to .agents/specs/<slug>/documents/<slug>_plan.md — <n> tasks, estimated <total range> of agent time
Dashboard: .agents/specs/<slug>/dashboard.html (open it in a browser to copy a bt-execute command; bt-execute keeps it current)
Run a single task with `bt-execute .agents/specs/<slug>/documents/<slug>_plan.md T1`, or every task with `bt-execute .agents/specs/<slug>/documents/<slug>_plan.md ALL` (add `--strict` for an adversarial verifier on every task).
```

## Heavy Plan mode (`--heavy`)

Use when the plan will be executed in fresh contexts, over days, or by a cheaper model than the one planning. The plan file is then the only memory that survives between tasks: **whatever it does not say, task 40 will re-decide differently from task 3.** So a heavy plan decides everything once, in one place, and every task cites it. Print `🏋️ [bt-plan] Heavy Plan mode`. Everything above still applies; the document gains two sections and richer task blocks. There is no limit on how much a heavy plan may say — write what the executor needs — but the number of tasks still follows the spec's `size`.

In Step 1, collect plan-grade detail: `file:line` references, the real signatures the feature calls or changes, verbatim 10–30-line snippets of the conventions to mirror, the exact API usage from the Agent Reference sub-documents, the Agent Reference's full `Coding Practices — ENFORCED` section, and the test baseline (command, current state, pre-existing failures). Carry the spec's Decisions forward and resolve every Open Question — with the user if needed. "TBD", "as appropriate", "the implementer may choose" are forbidden.

Sections, in order: `## Codebase Analysis` (plus the test baseline) · **`## Decisions`** · **`## Design Reference`** · `## Tasks` · `## Estimated execution time` · `## How to execute this plan`.

- **`## Decisions`** — numbered `D1, D2 …`, one per choice that binds more than one task or rejects a plausible alternative — architecture, file layout, naming, algorithms and constants, error policy, dependencies (exact packages and versions, or "no new dependencies"), sibling-skill option values, test strategy:
  `- **D3 — <decision, stated as a fact>.** <why / precedent with file:line> Rejected: <alternative> (<why not>). Binds: T4, T7.`
- **`## Design Reference`** — the shared blueprint, written as code wherever the code *is* the decision: File map (path · create/modify/delete · responsibility · tasks) · Module boundaries · Interfaces & contracts (full signatures, in the project's language) · Data shapes & state · Control flow · Algorithms & formulas with their constants · Error & edge-case policy (`when X → Y`) · Conventions to mirror (verbatim, with `file:line`) · API usage · Test strategy. Omit a heading only if it truly does not apply. **All of it is written to the Agent Reference's Coding Practices — ENFORCED**: every interface, signature, data shape, constant and snippet uses meaningful full-word names, strict types (JSDoc type tags in JavaScript) and meaningful JSDoc, and reads cleanly to a developer new to the project. Mirror the structure of existing conventions, but never copy one- or two-letter names or obfuscated code into a new name.
- **Heavy task block** — adds to the standard block: `Depends on:` · `Applies:` (the D-numbers and Design Reference entries it must match) · `Steps:` numbered instructions, each naming the file, a real anchor (prefer quoted code over bare line numbers) and the change · `Code:` when the code is the decision, written to the Coding Practices exactly as it must ship · `Do not:` the tempting wrong turns · `Verify:` commands with expected output. `Depends on`, `Files`, `Applies`, `Steps`, `Tests`, `Acceptance`, `Verify` and `Verify level` are required on every heavy task. A task never says "like T3" — it cites the Design Reference; a name, signature or value a step introduces is added to the Design Reference first, so task 40 types what task 3 typed. Say what keeps the app working between tasks (shim, flag) and which task removes it. The `Update SPEC.md` task carries the exact text to write.
- **Cold-context audit (one pass).** After the draft, launch one fresh read-only subagent (or re-read it yourself) with: *"You have never seen this repo. For every task, check the plan against the real files and list each point where you would have to decide, guess or look something up: a missing signature, name, value or anchor; an anchor that does not match the file; a goal stated instead of an instruction; a dependence on remembering an earlier task; a name used in a task but not defined in the Design Reference; a test without an expected outcome; a Verify without an expected output; vague words ("appropriate", "as needed", "etc."); a task that would not fit in one sitting; an edge case with no decided behavior; an API call not shown; any snippet, signature or name that breaks the Agent Reference's Coding Practices — ENFORCED (code in the wrong language for the project, loose typing or needless `any`, one- or two-letter or obfuscated names, code-golf tricks, code a developer new to the project could not read and maintain). Also flag micro-tasks to merge, ceremony tasks nobody asked for, and pinned counts later tasks will change. Report `T<n> · step · what is missing`. Change nothing."* Fix every gap in the plan, ask the user what only they can answer, list any gap you chose not to resolve (with why) in Codebase Analysis, write the dashboard (Step 4) from the finished plan, then finalize: `💾 [bt-plan] Plan finalized — <n> tasks, <k> decisions`, and report the two or three most consequential decisions and anything left unresolved.
