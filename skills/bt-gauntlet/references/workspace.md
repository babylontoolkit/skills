# The Gauntlet Workspace — resumable state

This is what makes the loop resumable days or weeks later: **nothing the loop needs lives in the
conversation — it all lives in files.** A brand-new session with zero context reads the workspace and knows
exactly where it was.

**One folder per gauntlet job.** `_gauntlet/` is just the container; every job owns a self-contained
`_gauntlet/<name>/` workspace, so any number of gauntlets — even for the same project — can run, park and
resume independently.

```
_gauntlet/
├── cod-fps/                 # one gauntlet job
│   ├── loop-card.md         # The filled template — the loop's constitution:
│   │                        #   DELIVERABLE KIND, DELIVERABLE, OBJECTIVE,
│   │                        #   REFERENCE/BENCHMARK, RUBRIC + PASS THRESHOLD,
│   │                        #   OUT OF REACH, SUCCESS CONDITION, BOUNDARIES.
│   │                        #   Written once after the interview; the loop never edits it.
│   │                        #   A deliberate change is an AMENDMENT, appended and dated.
│   ├── brief.md             # Full interview answers (genre, camera, physics, assets,
│   │                        #   target FPS, scope cuts, ESM/UMD, ...).
│   ├── cameras.md           # The LOCKED capture cameras — name, exact transform, fov,
│   │                        #   resolution, and which target image each one pairs with.
│   │                        #   Evidence not shot from these is inadmissible.
│   ├── components.md        # Component inventory of supplied interactive GLTF/GLB
│   │                        #   assets (protected TOOLKIT.* / project PROJECT.* /
│   │                        #   authoring-only) — written in round 1, read on resume.
│   │                        #   Only exists when supplied assets carry component metadata.
│   ├── pipeline.md          # Pipeline state for the deliverable kind: project paths,
│   │                        #   Unity project root, licence tier, capture mode, bake tier,
│   │                        #   checkpoint cadence + last checkpoint round, dev-server port,
│   │                        #   .blend/FBX paths. Written round 1, re-verified on every
│   │                        #   resume (a resident Editor does NOT survive a pause).
│   ├── progress.md          # THE resume file — format below.
│   ├── rounds/
│   │   ├── round-01.md      # Append-only per-round journal: what was built, the critic's
│   │   ├── round-02.md      #   score + FULL gap list, gates, STRATEGY lines, evidence links.
│   │   └── ...
│   ├── reference/           # The bar: target.png (+ per-camera targets), user-supplied
│   │                        #   screenshots/clips. LOCKED at round 1.
│   └── evidence/            # Our side of the A/B: round-NN-<part>-<camera>.png,
│                            #   round-NN-<part>-metrics.json, exported-metadata dumps.
└── racing-demo/             # another job, fully independent — same layout
    └── ...
```

## `progress.md` format

```markdown
# Gauntlet Progress
Name: cod-fps
Kind: web-game | unity
Template: gauntlet | bounded
Round: 12 (total, cumulative across all sessions)
Budgets: rounds 12/40 · no-improvement streak 0/3 · stall: none · bake tier: preview · last checkpoint: round 1

## Parts
- [x] P1 Movement & player controller — passed round 4 (9.0/10, gates all PASS)
- [~] P2 Weapon hands & viewmodel — attempt 3/5 · best 6.5 (round 9) · last 6.5 (round 11)
      top gap (round 11): "hand anatomy — thumb wrap and knuckle spacing vs reference/weapons-01.png"
      failed: "PBR metallic-only pass" (round 7 — 4.0; critic: plastic-looking; evidence/round-07-p2-hero.png)
      failed: "baked AO decals" (round 9 — 6.5; critic: anatomy still off vs reference/weapons-01.png)
- [ ] P3 Level lighting & atmosphere
- [ ] P4 Enemy AI & combat feel

## NEXT ACTION
Round 13 — P2: STALL APPROACHING (same top gap twice). Incremental tweaks are forbidden.
Replace the hand mesh outright rather than re-texturing it: re-source or re-model the
viewmodel hands, then re-capture evidence at 1080p from camera `hero` and re-run the
weapons critic.

## Blockers / awaiting user
(none)
```

- Part states: `- [ ]` pending · `- [~]` in-progress · `- [x]` critic-passed. Never flip `- [x]` for
  partial, skipped, self-reported, or `unverified` work.
- Every part carries its attempt count, **best and last score**, the **current top gap**, and a
  **failed-approaches log** ("tried X, scored Y, critic evidence Z, abandoned because W") so a resumed loop
  never retries what already lost — a changed strategy is forced, not hoped for.
- **`NEXT ACTION`** is always exactly one imperative instruction a completely cold session can execute
  first. When a stall tier is active, `NEXT ACTION` must say so and must name the forbidden move.

**Persistence rule (HARD):** update `progress.md` and append the round journal **after every round, before
starting the next**. If the session dies mid-round (limits, crash, user close), at most the in-flight round
is lost. Budgets count **cumulatively across sessions** — the round counter never resets on resume.

## Round journal format (`rounds/round-NN.md`)

```markdown
# Round 12 — P2 Weapon hands & viewmodel
Attempt: 3/5 · Bake tier: preview

## Built
<what actually changed — files, scene objects, settings. Not a narrative.>
STRATEGY: <only when a stall tier forced an architectural change — what was thrown away>

## Evidence
- evidence/round-12-p2-hero.png  (camera `hero`, 1920x1080)
- evidence/round-12-p2-metrics.json  (fps 58 · draws 412 · console 0 errors)

## Critic
SCORE: 6.5 / 10 (Comp 1.5 · Light 1.5 · Mat 1.5 · Detail 1.5 · Motion 0.5)
PREVIOUS: 6.5 / 10 (round 09)
GATES: perf PASS · console PASS · authority PASS · camera PASS
VERDICT: FAIL
REGRESSION: none

### Gap list
GAP 01 [Materials] ...
GAP 02 [Detail] ...
GAP 03 ...

## Recorded
progress.md updated: attempt 3/5, stall -> approaching (same top gap twice)
```

## Resume protocol (`--resume [<name>]`, or auto-offered)

1. Resolve the job: explicit name → that job; one job in `_gauntlet/` → resume it; several → list them and
   ask.
2. Fetch/read the Babylon Toolkit Agent Reference if not already remembered in this session.
3. Read `_gauntlet/<name>/loop-card.md` → `progress.md` → `pipeline.md` → `cameras.md` →
   `components.md` (if present) → the last 1–2 `rounds/*.md`.
4. Read the pipeline reference for the job's `Kind` and **re-run its prerequisite gate**. This is not
   optional on resume: a resident Unity Editor, a running dev server and a warm asset database do **not**
   survive a pause. Re-establish them and re-verify licence tier before building anything.
5. **Reality check:** verify the workspace still matches the project (files it claims exist do exist; the
   build still builds; git state sane; the locked cameras still exist in the scene). Log discrepancies and
   correct `progress.md` before looping — never resume against stale state.
6. Report a one-paragraph "resuming from" summary to the user (job name, kind, round counter, parts
   done/total, active stall tier, next action).
7. Execute `NEXT ACTION` and enter the round protocol. Chat history is never required — the files ARE the
   memory.
