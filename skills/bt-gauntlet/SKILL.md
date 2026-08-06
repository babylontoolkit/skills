---
name: bt-gauntlet
description: "The Babylon Toolkit Gauntlet Skill uses loop engineering, which is the practice of designing a system in which an AI acts, observes the result, evaluates it against a defined standard, improves the work, and repeats until a success condition, safety boundary, budget, or escalation rule stops it. It runs Matt Shumer's Gauntlet Loop pattern (builders vs fresh harsh critics, blind A/B against a concrete reference) for BabylonJS / Babylon Toolkit games — and it is fully RESUMABLE: each gauntlet job lives in its own _gauntlet/<name>/ workspace (any number of jobs can exist side by side), so the user can stop any time (daily/weekly limits, calling it a night) and continue days or weeks later in a brand-new session with `/bt-gauntlet --resume <name>`. Use when the user wants a long-running, self-improving build of an ambitious game artifact (e.g. `/bt-gauntlet I want you to build a first-person shooter at the level of the most recent Call of Duty games...`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

You define the objective, metric, and boundary; the loop replaces your manual chain of follow-up prompts. You are an EXPERT BabylonJS and Babylon Toolkit game developer — every gauntlet run builds with **BabylonJS and the Babylon Toolkit, NEVER Three.js**.

Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-gauntlet [--name:slug] [--template:gauntlet|bounded] [--rounds:N] [--card:file] [--resume|--status|--stop] [<name>] <brief + attachments>
```

**Flags** (all optional; `--flag:value` or `--flag`):

- **`--name: slug`** — this gauntlet job's name; it becomes the job's workspace folder `_gauntlet/<name>/`. **Any number of gauntlet jobs can exist side by side in one project** (e.g. `cod-fps`, `racing-demo`), each fully independent. If omitted on a new gauntlet, derive a short kebab-case slug from the brief (e.g. `cod-fps`) and confirm it in the interview.
- **`--template: gauntlet | bounded`** — which loop template drives the run. `gauntlet` = **Template A** (full-on Shumer-style fan-out: builders vs fresh harsh critics, blind A/B against the reference). `bounded` = **Template B** (single-track objective / metric / boundary loop card — use when reliability and cost matter more than dramatic language). **Default: `gauntlet`.** The choice is recorded in the job's `_gauntlet/<name>/loop-card.md`; a job never mixes templates.
- **`--rounds: N`** — maximum full rounds (build → verify → critic → record) THIS invocation may run before parking cleanly with a status report and the exact resume command. **Default: `5`.** Override per session (`--rounds:20` for a long night).
- **`--card: file`** — a **pre-filled loop card**: one of the two templates below with EVERY slot already answered, including `<NAME>`. Skips the interview entirely — validate the card (all slots filled, name doesn't collide with an existing job), copy it to `_gauntlet/<name>/loop-card.md`, distill `brief.md` from it, and start round 1 without asking anything. This is the **non-interactive entry** used when a spec/plan drives the gauntlet (see *Composition with the spec workflow*). If any slot is unfilled or vague, STOP and report which — never guess a slot.
- **`--resume [<name>]`** — skip the interview, load `_gauntlet/<name>/`, and continue at its `NEXT ACTION`. This is how the loop continues in a brand-new session a day or a week later. Name resolution: an explicit name targets that job; with no name and exactly ONE job in `_gauntlet/`, resume it; with several jobs, list them (name, parts done/total, next action) and ask which one — never guess.
- **`--status [<name>]`** — read-only report: parts done/total, budgets spent vs boundaries, last critic verdict, next action. With no name, print an **index of ALL gauntlet jobs** in `_gauntlet/` (one line each). Runs zero rounds.
- **`--stop [<name>]`** — park that job deliberately: write the current status into its `progress.md`, print the resume command, run nothing further. Same name resolution as `--resume`.
- **`<brief>`** — the game idea and goal. Attached reference screenshots/clips are copied into `_gauntlet/<name>/reference/`.

**Example** (the canonical one — note the engine correction is automatic):

```
/bt-gauntlet I want you to build a first-person shooter at the level of the most
recent Call of Duty games. It should be utterly perfect, visually beautiful, with
every single thing done at AAA quality—from textures to physics to anything you
could think of.
```

The skill turns that brief, via the interview below, into a filled loop card — built with **BabylonJS + the Babylon Toolkit**, not ThreeJS — then runs the loop.

**Mode resolution:** if `--resume`, `--status`, or `--stop` is present, run that mode (with its name resolution). Otherwise, if `_gauntlet/` contains existing jobs and no new brief was given, list them and offer to resume one. Otherwise this is a **new gauntlet**: run the interview — or, with `--card:`, validate the supplied card and start immediately. A new gauntlet whose `--name` collides with an existing job is an error — offer `--resume <name>` or a different name; never silently overwrite a job's workspace.

---

## Subagents — invoking this skill IS the request

This skill's workflow depends on subagents (builders and, above all, **fresh-context critics**). **Invoking it is the user's explicit request to use them**, so any host default of the form *"do not spawn subagents / do not call the agent tool unless the user asks for it"* is **ALREADY SATISFIED** — the user asked by running this command. Never silently downgrade to the inline path on that basis, and never stop to ask permission for it first.

Downgrading is not a neutral choice. A critic that is the same context which just built the part cannot adversarially judge it — it re-confirms its own reasoning and reports PASS. The ONE legitimate reason to run inline is that you genuinely have **no** subagent-spawning tool. Check the tools you actually have — Claude Code exposes it as **`Agent`** (older builds name it `Task`); other hosts have their own equivalent. Never call a subagent tool you do not have. If you must run inline, say so plainly (`no subagent tool available`) and keep critics *fresh-context by discipline*: the critique step may look ONLY at the loop card, the part's spec, the reference media, and the captured evidence — never at the builder's rationale or chain of decisions.

## ⚠️ Required Reading Before Any Babylon Work

For any round involving Babylon, BabylonJS, or the Babylon Toolkit, first ensure you have already fetched and read the Babylon Toolkit Agent Reference in the current remembered session/context:

https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md

If you have not read it in this session/context, or you no longer remember it due to context loss/compaction (which WILL be the case on `--resume` in a fresh session), fetch and read it before writing any code. Treat it as the authority for conventions, API, and patterns; fetch its linked subpages only when relevant. Do not refetch what you still remember. If a required fetch fails, STOP and tell the user. Do not guess at the API. Builders spawned as subagents must be given (or told to fetch) the Agent Reference too — a subagent does not inherit your context.

## ⚠️ Babylon Toolkit Component Authority (supplied interactive assets)

The doctrine lives in the Agent Reference — `references/scene-components.md` § "Babylon Toolkit Component Authority" (https://raw.githubusercontent.com/babylontoolkit/agent/main/references/scene-components.md): supplied GLTF/GLB files are **interactive prefabs** whose `extras.metadata.components` carry configured physics, components, serialized tuning and gameplay intent; `TOOLKIT.*` components are the first-class engine implementation — compose and tune them through `PROJECT.*` ScriptComponents, never reimplement, bypass, or delete them; replacement requires the documented-evidence checklist defined there. Read that section before any round that touches supplied interactive assets. This skill adds the gauntlet-specific mechanics:

- **Round 1 writes the inventory to disk.** If the job's supplied assets (attachments, the project's asset folders, or `_gauntlet/<name>/reference/`) include GLTF/GLB carrying `extras.metadata.components`, the first build round MUST scan them and write `_gauntlet/<name>/components.md`: the component inventory grouped by scene node — class, execution order, serialized properties, intended responsibility — with every component classified **protected-system** (`TOOLKIT.*` — tune properties, never replace), **project** (`PROJECT.*` — the gauntlet may implement/modify these), or **authoring-only** (markers/level-design metadata consumed by mission or encounter logic). Record the safe-to-tune properties and the declared APIs verified against `babylon.toolkit.d.ts`. A resumed cold session READS this file instead of re-deriving it; the round that changes the supplied assets updates it.
- **Builders build against the manifest.** Builder subagents are given (or told to read) `components.md` alongside the Agent Reference. Desired movement goes through the existing character controller; animation drivers set parameters on the existing `AnimationState`; vehicle input commands the existing car/vehicle components. Unity-authored serialized values are preserved unless a measured gameplay/physics/perf issue justifies the change — and the measurement goes in the round journal.
- **Critics enforce it.** The critic's inputs include `components.md` when it exists. Reimplementing, bypassing (e.g. direct transform updates beside an attached physics controller — the hidden-duplicate-motor defect), or deleting a component marked protected is a **FAIL regardless of how the visual evidence looks**, unless the round journal carries the full replacement-evidence checklist from the reference (demonstrated limitation, reproducing test, alternatives attempted, scope and risks, rollback path, regression tests). This is an architectural criterion IN ADDITION to pixels/perf/console — a duplicated character motor passes a screenshot on day one and desyncs physics, grounding, and animation later.

## ⚠️ The Project Specification (SPEC.md)

If the project keeps a root **SPEC.md**, read it before the first round of each invocation and conform to its architecture, systems, and conventions while building. If gauntlet work changes the architecture, a system, a convention, or a dependency, update SPEC.md per its "How to update this spec" contract as part of the round that changes it.

---

# The Interview (mandatory before round 1 of a NEW gauntlet)

*(Skipped entirely when `--card:` supplies a complete pre-filled loop card — validation replaces conversation.)*

The loop may not start until **every slot of the chosen template is filled**. This is extensive by design — a vague slot produces a loop that spins without a finish line. Use the host's structured question tool (e.g. `AskUserQuestion`) where available; plain numbered questions otherwise. Batch related questions; don't drip them one at a time. Where the user's brief already answers a slot, confirm rather than re-ask. Push back on weak answers and co-rewrite them into useful ones (weak: "make it AAA" → useful: a testable sentence).

Interview batches:

0. **NAME** — Confirm the job's slug (from `--name:` or derived from the brief). It becomes `_gauntlet/<name>/` and must not collide with an existing job.
1. **DELIVERABLE** — What artifact ships? (playable browser FPS demo, vertical slice, one polished level, full game...) Module style: ES6/ESM default per the Agent Reference; UMD only if explicitly demanded. New project or existing repo? Target folder.
2. **OBJECTIVE** — The exact outcome that must become true, as one testable sentence. Rewrite with the user until it is inspectable.
3. **CONCRETE REFERENCE / MEASURABLE BENCHMARK** — Which real game/media is the bar? What media do the critics get for blind A/B — ask the user to attach or drop reference screenshots/clips (named per part when possible: `weapons-01.png`, `lighting-02.png`, ...) into the chat or a folder; they are copied to `_gauntlet/<name>/reference/`. Plus numeric benchmarks: target FPS @ resolution, max load time, draw-call/texture budgets. If the user has no benchmark, making a defensible one is part of the interview, not skipped.
4. **SUCCESS CONDITION** — When is the loop DONE? (e.g. "every part scores ≥8/10 on its rubric from a fresh critic OR wins/ties the blind A/B; sustained 60 FPS @1080p in Chrome; zero console errors; final integration critic passes"). Success and failure defined separately.
5. **BOUNDARIES** — Time/cost expressed in **rounds and attempts, not wall-clock** (wall-clock cannot survive a two-week pause; counters can): max total rounds, max attempts per part before a forced strategy change, max consecutive no-improvement rounds before parking. Permission gates: no deploy, no purchases/paid services, no credentials, no destructive ops, no contacting anyone — without explicit approval. Escalation rules: what blocks and waits for the user.
6. **Game specifics** (Babylon-expert intake) — genre & camera (FPS/third-person/top-down), physics (Havok default), input scheme, audio, asset pipeline (hand-built primitives/CSG? user-supplied glTF? generated via available image/video workflows?), scene scale & level scope, target browsers/devices, and **explicit scope cuts** — what is OUT (multiplayer? save systems? menus?).
7. **Loop mechanics** — confirm `--template` choice, rounds-per-session default, and any parts the user wants prioritized first.

Write all answers to `_gauntlet/<name>/brief.md`. Fill the chosen template's slots (including `<NAME>`) to produce `_gauntlet/<name>/loop-card.md`. **Show the user the filled loop card and get confirmation before round 1.** Nothing builds until the card is confirmed.

---

# The Gauntlet Workspace (resumable state)

This is what makes the loop resumable days or weeks later: **nothing the loop needs lives in the conversation — it all lives in files.** A brand-new session with zero context reads the workspace and knows exactly where it was.

**One folder per gauntlet job.** `_gauntlet/` is just the container; every job owns a self-contained `_gauntlet/<name>/` workspace, so any number of gauntlets — even for the same project — can run, park, and resume independently:

```
_gauntlet/
├── cod-fps/                 # one gauntlet job
│   ├── loop-card.md         # The filled template — the loop's constitution:
│   │                        #   DELIVERABLE, OBJECTIVE, REFERENCE/BENCHMARK,
│   │                        #   SUCCESS CONDITION, BOUNDARIES.
│   │                        #   Written once after the interview; the loop never edits it.
│   ├── brief.md             # Full interview answers (genre, camera, physics, assets,
│   │                        #   target FPS, scope cuts, ESM/UMD, ...).
│   ├── components.md        # Component inventory of supplied interactive GLTF/GLB
│   │                        #   assets (protected TOOLKIT.* / project PROJECT.* /
│   │                        #   authoring-only) — written in round 1, read on resume.
│   │                        #   Only exists when supplied assets carry component metadata.
│   ├── progress.md          # THE resume file — format below.
│   ├── rounds/
│   │   ├── round-01.md      # Append-only per-round journal: what was built, critic
│   │   ├── round-02.md      #   verdict + the named largest gap, evidence links.
│   │   └── ...
│   ├── reference/           # Benchmark media the critics compare against, blind.
│   └── evidence/            # Our side of the A/B: captured screenshots, perf numbers.
└── racing-demo/             # another job, fully independent — same layout
    └── ...
```

**`progress.md` format:**

```markdown
# Gauntlet Progress
Name: cod-fps
Template: gauntlet | bounded
Round: 12 (total, cumulative across all sessions)
Budgets: rounds 12/40 · no-improvement streak 0/3 · <other loop-card counters>

## Parts
- [x] P1 Movement & player controller — passed round 4 (critic 9/10)
- [~] P2 Weapon hands & viewmodel — attempt 3/5
      failed: "PBR metallic-only pass" (round 7 — critic: plastic-looking; evidence/round-07-weapons.png)
      failed: "baked AO decals" (round 9 — critic: anatomy still off vs reference/weapons-01.png)
- [ ] P3 Level lighting & atmosphere
- [ ] P4 Enemy AI & combat feel
- [ ] ...

## NEXT ACTION
Round 13 — P2: rebuild hand mesh materials with <concrete correction target from
last critic>, re-capture evidence at 1080p, re-run the weapons critic.

## Blockers / awaiting user
(none)
```

- Part states: `- [ ]` pending · `- [~]` in-progress · `- [x]` critic-passed. Never flip `- [x]` for partial, skipped, self-reported, or `unverified` work.
- Every part carries its attempt count and a **failed-approaches log** ("tried X, critic evidence Y, abandoned because Z") so a resumed loop never retries what already lost — a changed strategy is forced, not hoped for.
- **`NEXT ACTION`** is always exactly one imperative instruction a completely cold session can execute first.

**Persistence rule (HARD):** update `progress.md` and append the round journal **after every round, before starting the next**. If the session dies mid-round (limits, crash, user close), at most the in-flight round is lost. Budgets count **cumulatively across sessions** — the round counter never resets on resume.

## Resume protocol (`--resume [<name>]`, or auto-offered)

1. Resolve the job: explicit name → that job; one job in `_gauntlet/` → resume it; several → list them and ask.
2. Fetch/read the Babylon Toolkit Agent Reference if not already remembered in this session.
3. Read `_gauntlet/<name>/loop-card.md` → `progress.md` → `components.md` (if present) → the last 1–2 `rounds/*.md`.
4. **Reality check:** verify the workspace still matches the project (files it claims exist do exist; the build still builds; git state sane). Log discrepancies and correct `progress.md` before looping — never resume against stale state.
5. Report a one-paragraph "resuming from" summary to the user (job name, round counter, parts done/total, next action).
6. Execute `NEXT ACTION` and enter the round protocol. Chat history is never required — the files ARE the memory.

---

# The Round Protocol (one round; both templates)

1. **Inspect** the current state: `progress.md` + the actual project — plus `components.md` when supplied assets carry component metadata (write it now if it is owed and missing).
2. **Select** the highest-impact unmet criterion/part (respect user priorities from the brief).
3. **Build** — make one coherent improvement. **Template A:** fan out builder subagents only for *genuinely independent* parts; **keep tightly coupled systems under one sequential owner** (the Claude-of-Duty repo itself notes broad fan-out performed WORSE than sequential ownership for coupled visual systems). **Template B:** single-track — one improvement at a time.
4. **Verify with the real artifact** — build/serve the game, then capture **real browser evidence**: screenshots into `_gauntlet/<name>/evidence/` (via chrome-devtools MCP or the host's browser tool), perf/FPS numbers, console-error check. **Screenshots are required for visual parts.** If no browser tool exists in this host, mark the part `unverified` in `progress.md` — an `unverified` part can NEVER be flipped to `- [x]` on the builder's word; code/perf/test critics still run.
5. **Criticize (fresh context)** — spawn a harsh critic subagent that receives ONLY: the loop card, this part's spec, the reference media, the captured evidence, and `components.md` (when it exists) — **never the builder's rationale**. Component-authority violations (a protected `TOOLKIT.*` component reimplemented, bypassed, or deleted without the reference's replacement-evidence checklist in the round journal) are an automatic FAIL, whatever the pixels look like. It compares our evidence with `_gauntlet/<name>/reference/` as a **blind A/B** where possible ("frame 1 vs frame 2 — which looks better and why"), scores against the rubric, names the **single largest meaningful gap** with a concrete correction target, and returns PASS/FAIL with evidence. The critic does not grade effort or intent; it grades pixels, numbers, and behavior.
6. **Record** — append `rounds/round-NN.md`; update `progress.md`: on PASS flip the part to `- [x]`; on FAIL log the gap as the next attempt's target and increment the attempt counter; if the part hit its attempts boundary, force a strategy change or escalate. Persist BEFORE the next round.
7. **Gate check**, in order:
   - **Success condition met** → run the **integration pass**: one final fresh critic inspects the complete game end-to-end for consistency, seams, and fit with the original objective (local quality can rise while the whole becomes inconsistent). On pass, report DONE with the evidence summary.
   - **A loop-card boundary fired** (rounds exhausted, repeated blocker, permission needed, no-improvement streak) → park + escalate to the user with specifics.
   - **`--rounds` session cap reached** → park cleanly: status report + print exactly `/bt-gauntlet --resume <name>`.
   - Otherwise → next round.

Parking is always clean: state persisted, status reported, resume command printed. The user can walk away at ANY park (or any interrupt) and come back a day or a week later.

---

# Template A — Universal Gauntlet Loop (`--template:gauntlet`, default)

Kept verbatim here so it is easy to modify. The interview fills the `<SLOTS>` — including `<NAME>`, the job's slug — and the filled copy becomes `_gauntlet/<name>/loop-card.md`.

```
I want you to create <DELIVERABLE> that achieves <OBJECTIVE> at the quality
level of <CONCRETE REFERENCE OR MEASURABLE BENCHMARK>.

Build it with BabylonJS and the Babylon Toolkit (NOT Three.js), following the
Babylon Toolkit Agent Reference conventions already loaded in this session.

This gauntlet job is named <NAME>; all of its loop state lives in
_gauntlet/<NAME>/ and never anywhere else.

Choose the approach. Break the work into the smallest important parts that can
be improved and judged independently, and record that decomposition as the part
checklist in _gauntlet/<NAME>/progress.md. Fan out builder subagents only where
the work is genuinely independent; keep tightly coupled systems under one owner.
Give every important part a separate, harsh critic with fresh context.

If the supplied assets include GLTF/GLB files carrying Babylon Toolkit component
metadata (extras.metadata.components), write the component inventory to
_gauntlet/<NAME>/components.md in round 1 and honor it every round: TOOLKIT.*
components are first-class — compose and tune them through PROJECT.* scripts,
never reimplement, bypass, or delete them (see the Agent Reference's
"Babylon Toolkit Component Authority" section). Critics fail violations.

Each critic must inspect the real running game — browser screenshots captured
into _gauntlet/<NAME>/evidence/ — not the builder's summary, and compare it
directly with the reference media in _gauntlet/<NAME>/reference/, using a blind
A/B comparison where possible. If our result loses, identify the largest
meaningful gap, return it to the builder, and run another round.

After EVERY round, update _gauntlet/<NAME>/progress.md and append
_gauntlet/<NAME>/rounds/round-NN.md before starting the next round, so a
brand-new session can resume this loop with `/bt-gauntlet --resume <NAME>`
at any time.

Keep looping until the output meets <SUCCESS CONDITION>, improvements no longer
justify another round, or one of these boundaries fires: <TIME / COST / ATTEMPT /
PERMISSION / SAFETY BOUNDARIES>. Escalate blockers that require human judgment.

Finish with one fresh integration critic that checks the complete game for
consistency, correctness, and fit with the original objective.

Do not deploy, spend money, use credentials, contact people, or make
irreversible changes without explicit approval.
```

# Template B — Bounded AI Loop Card (`--template:bounded`)

Use when reliability and cost matter more than dramatic language. Same slots; kept verbatim here so it is easy to modify.

```
OBJECTIVE
<OBJECTIVE — the exact outcome that should become true for <DELIVERABLE>>

ENGINE
BabylonJS + Babylon Toolkit (NOT Three.js), per the Babylon Toolkit Agent
Reference conventions already loaded in this session.

INPUTS AND STATE
This gauntlet job is named <NAME>; all of its loop state lives in
_gauntlet/<NAME>/ and never anywhere else.
Use: _gauntlet/<NAME>/loop-card.md, _gauntlet/<NAME>/brief.md,
_gauntlet/<NAME>/progress.md, _gauntlet/<NAME>/reference/, and the project
sources. Record after every round in _gauntlet/<NAME>/progress.md and
_gauntlet/<NAME>/rounds/: what changed, evidence, score, failed approach,
next action, and remaining budget — so `/bt-gauntlet --resume <NAME>` can
continue from a brand-new session.

METRIC / VERIFIER
Success requires all of the following:
- <CONCRETE REFERENCE OR MEASURABLE BENCHMARK — objective test or benchmark>
- <quality rubric or blind reference comparison via _gauntlet/<NAME>/evidence/ screenshots>
- <integration, performance, accessibility, or safety check>
- No component-authority violations: supplied TOOLKIT.* components are composed
  and tuned through PROJECT.* scripts, never reimplemented or bypassed
  (inventory: _gauntlet/<NAME>/components.md, when supplied assets carry
  component metadata)

PROCESS
1. Inspect the current state (progress.md + the actual project).
2. Choose the highest-impact unmet criterion.
3. Make one coherent improvement.
4. Run the real verifier (build, browser screenshots, perf capture).
5. If it fails, feed the evidence into a CHANGED strategy and repeat.
6. If it passes, run a fresh independent final review.

BOUNDARIES
Allowed actions: read, draft, edit, build, test, render, screenshot.
Forbidden without approval: deploy, delete, purchase, publish, message, secrets.
Stop, park state, and report when: <SUCCESS CONDITION> passes; <TIME / COST /
ATTEMPT / PERMISSION / SAFETY BOUNDARIES> is reached; the same blocker repeats;
or uncertainty requires human judgment.
```

---

# Composition with the Spec Workflow (bt-spec / bt-plan / bt-execute)

**The gauntlet contains its own plan — never run bt-plan on gauntlet work.** The mapping to the sibling skills:

| Spec workflow | Gauntlet equivalent |
| --- | --- |
| `_specs/<feature>_spec.md` (bt-spec) | `_gauntlet/<name>/loop-card.md` — objective, benchmark, success condition, boundaries |
| `_specs/<feature>_plan.md` (bt-plan) | the part checklist in `_gauntlet/<name>/progress.md` — the lead agent's round-1 decomposition |
| bt-execute `ALL` (checkbox resume) | the round protocol + `--resume <name>` |

The difference is when a box may flip. A **bt-plan task** is feed-forward: known work, visited once, `- [x]` when its acceptance verifies. A **gauntlet part** is feedback: `- [x]` only when a fresh critic says it beats the reference bar, however many rounds that takes.

**Rule of thumb:** acceptance criteria you can enumerate up front, each satisfiable in one pass → **bt-spec → bt-plan → bt-execute**. "As good as *that*" against a reference, unknown iteration count → **bt-gauntlet**.

**Typical sequence for a real game — use both:**

1. **Foundation via the spec workflow** — scaffold, player controller, physics, level loading, weapon systems, HUD. Checklist-shaped work with crisp acceptance; cheaper and faster than critic rounds.
2. **Quality via a gauntlet job** — once the game exists, `/bt-gauntlet --name:aaa-polish <brief>` with the reference media. The loop builds on whatever the plan produced.

## Inside the spec loop (bt-gauntlet named in a bt-spec brief)

When a bt-spec / bt-plan / bt-execute run encounters this skill named in its brief (e.g. `/bt-spec Build the racing game, then polish it to Gran Turismo quality using bt-gauntlet`), the composition follows the same idiom bt-prototype uses with bt-hero — **pre-resolve everything at spec time so nothing prompts mid-run**:

- **bt-spec:** the interview happens HERE, at spec time — the spec answers every loop-card slot (including `<NAME>`, the reference media to collect into `_gauntlet/<name>/reference/`, and the boundaries) and writes the **pre-filled loop card** as a spec artifact (e.g. `_specs/<feature>_gauntlet-card.md`).
- **bt-plan:** the gauntlet becomes one task (usually the last), whose Details invoke `/bt-gauntlet --card:_specs/<feature>_gauntlet-card.md --rounds:N`. Its **Acceptance** is observable: "gauntlet job `<name>` reports DONE — success condition met and the integration critic passed — as evidenced by `_gauntlet/<name>/progress.md` and the final round journal."
- **bt-execute:** runs the task by invoking the gauntlet non-interactively. Because a gauntlet may outlast one session, the task's checkbox stays `- [ ]` while the job is merely parked; each later `bt-execute <plan> NEXT` run re-enters via `/bt-gauntlet --resume <name>` and the box flips only when the job genuinely reports DONE (or a loop-card boundary fires and the user accepts the parked result — record which). The gauntlet's own critic evidence IS the acceptance evidence; the bt-execute verifier reads `progress.md` + the last round journal rather than re-judging the art.

bt-gauntlet never orchestrates bt-spec itself — composition is always initiated from the spec side.

---

# Failure-Mode Guardrails (loop rules, non-negotiable)

- **The builder never grades its own work.** Verdicts come from fresh-context critics (or the strictly-scoped inline discipline above).
- **No single gameable score.** Every part is judged on several guardrails at once (visual A/B + perf + console-clean + rubric), never one narrow number.
- **Repetition without a changed strategy is a boundary event**, not persistence. The failed-approaches log exists to force adaptation.
- **Progress is never self-reported.** Screenshots, perf numbers, test output, diffs — an observable receipt, or it didn't happen.
- **Permissions start reversible.** Deploy, delete, spend, publish, message, and secrets stay behind explicit user approval, always.
- **Context rots; files don't.** Compact durable state in `_gauntlet/<name>/` beats a long chat history. On any doubt, trust the files and the actual project, then correct `progress.md`.
- **Jobs never bleed into each other.** A round touches only its own `_gauntlet/<name>/` state; other jobs' workspaces are read-only neighbors.
- **Every park prints the exact resume command** so the user always knows how to continue: `/bt-gauntlet --resume <name>`.

# Cross-Host Notes

This skill runs the same everywhere because resumability depends on nothing but the `_gauntlet/` files and re-invocation — no host loop feature is required.

- **Subagents:** tool names differ (Claude Code `Agent`/`Task`; other hosts their own equivalent). Check the tools you actually have; never call one you don't. No subagent tool → inline with the fresh-context discipline.
- **Browser evidence:** chrome-devtools MCP on Claude Code; other hosts use their browser/screenshot tool. None available → parts are `unverified`, never passed.
- **Interview:** `AskUserQuestion` where the host has it; plain numbered questions otherwise.
- **Skill loading:** where skills are loaded with a tool (the Babylon Toolkit App Builder platform), `load_skill('bt-gauntlet')`; where skills are files on disk (Claude Code), this file lives in `~/.claude/skills/` or the project's `.claude/skills/`.
