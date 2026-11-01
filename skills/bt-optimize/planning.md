# Planning optimization work — the bt-optimize playbook for bt-spec, bt-plan and bt-execute

Read this when a spec, a plan (Quick or full) or a plan task is about making a Unity scene run faster or lighter as
BabylonJS web content — "optimize `Level01.unity`", "create a quick plan to optimize …", "spec out optimizing the
forest level", "cut the draw calls", "this level runs at 30 FPS in the browser". The work itself is bt-optimize's
pipeline (`SKILL.md`): the spec records the decisions below, the plan arranges bt-optimize's phases as tasks, and
bt-execute's builders run the skill's scripts — **never re-implement them**. Running `/bt-optimize <scene>` directly
does the same work in one go; a spec or plan adds the dashboard, checkpoints and an independent verifier.

Not this playbook: a slow web app, script or UI (that is bt-profile), or authoring a new level.

## What every optimization delivers

1. **One scene to export.** All work happens on the working copy `<Scene>_Optimized.unity` beside the source. The
   source is never edited and stays the before/after baseline. The working copy is the scene to export and to load in
   the game from then on. Its generated folders sit beside it and are part of it — never delete them while it is in
   use: `<Scene>_Optimized/` (baked lighting), `_UnskinnedMeshes/`, `_RetargetedClips/`, `_VatCrowd/`,
   `_CombinedMeshes/`. The report and the final message name the scene to export in their first lines, with that
   table, so nobody has to guess which file is "the optimized one".
2. **Measured, not guessed.** Frame rate, frame time and draws per pass (shadow maps, depth, main, post) before → after
   at the same pinned camera poses, plus the main-pass draws split by the object that owns them (`drawOwners`).
3. **The same look.** Unity captures of source and copy at the pinned poses, browser shots at the same poses, and —
   when a web game loads the scene — a look in the game through the game's own camera (the export viewer's default
   camera renders without the scene's post-processing).

## The standard decisions

State each in the spec's Functional Requirements / Decisions, or the plan's Codebase Analysis (Quick Plan) or
Decisions log (Heavy Plan). Change one only on the user's word or on measured evidence, and say which.

| # | Decision | Default | How it is proven |
|---|---|---|---|
| O1 | Work on the working copy; the source is the baseline | `--out` default `<Scene>_Optimized.unity`, rebuilt with `--reset` when the plan starts over | `BtCombine.PrepareCopy`; `working-copy.txt` names the source |
| O2 | Account for every draw before planning fixes | Pinned poses `--pin 40,60,75` (inside the scene's own motion) saved to the feature's `tests/poses-pinned.json` and replayed with `--poses` | Every owner group of 5%+ of main-pass draws is fixed or has a measured reason; `mainDraws` equals `passes.main` |
| O3 | Unskin every skinned mesh that does not deform | Tune `unskinRigid` — one-bone imports, offset bind poses, script hosts, renderer curves, frozen poses | `BtOptimize.Verify`: no rigid skinned mesh left; every remaining SkinnedMeshRenderer has its reason in `tune.md` |
| O4 | Instance every repeated mesh | `instanceRepeatsFrom` 4; **2** when the user asks to instance "wherever possible" | Every repeated shape in `drawOwners.repeats` is one instanced draw or listed with its reason; `Verify`: no repeat lightmapped or probe-lit |
| O5 | Nothing that moves is static | Tune `unfreezeAnimated` (static objects a clip, Timeline or physics body moves) | `Verify`: no static mover |
| O6 | Deforming crowds draw instanced | Tune `vatCrowdsFrom` 4: AnimatorControlRig VAT mode, VAT materials, renderer world scale 1, probes off | One draw per crowd material in view, each copy still animating its own state in the browser. One draw for a whole multi-colour crowd needs the runtime per-skin texture array (`shader-materials.md`) — a web-game follow-up |
| O7 | Lighting | Practical point / spot lights with no browser driver baked; shadowed ones stay runtime with shadows off. **"Keep the current look / lighting"** → `--keep-gi` and the copy's lighting settings equal the source's | `Verify`: lighting equal to the source, no new GI contributors (with `--keep-gi`); captures match |
| O8 | Merge static meshes only when it saves draws | Run `BtCombine.Analyze`; merge when `combine-plan.md` shows draws saved. A level already drawn as one renderer per material saves nothing → `--no-combine`, recorded with the plan's numbers | `BtCombine.Verify` problems=0 when merged |
| O9 | Prune shadow casters whose shadow lands on nothing visible | Candidates from `survey.md` (flat surfaces) and the browser's per-cascade dump (`--casters true`: roads, ground, water, far backdrops); `BtOptimize.PruneShadowCasters` with the list | Each entry kept only when Unity captures at every pinned pose show no shadow change; shadow-map draws fall |
| O10 | Project-wide levers are proposals, not changes | Shadow cascade count / distance, KTX2 textures, CSS-pixel resolution change every scene: measure and propose them as follow-ups unless the user asked | — |
| O11 | Anything the engine cannot do is a re-runnable script | One project script (`AgentScripts/<slug>/…`) with entry points run after Tune, each safe to re-run after `--reset` | The report's **Redo after `--reset`** lists the full sequence |

**Questions worth asking** (at most one, with the recommended default; everything else is inferred and stated):
keep the current lighting exactly (O7 `--keep-gi`, no merging) or allow a re-bake that merging needs — default: keep
when the lighting was hand-tuned or the user praises the current look, otherwise allow. Never ask about thresholds,
poses or tools — the defaults above are the answer.

**Find these in the project before writing** (never ask): the scene path; whether its export is current
(`bt_status` → `exportRoot`, `scenes/<scene>.gltf`); which web game code loads the export by name (search the web app
for the lower-cased scene file name) — the plan's last task points it at the optimized export, a one-line change; an
earlier run's `.agents/optimize/<Scene>/` (survey, profiles, poses) to reuse; Animators, Timelines and crowds the
survey names.

## The standard task list

All Unity tasks share one track (one editor per project). Each phase runs one costly session (export + pinned
profile) that proves every task in it.

### Phase 1 — Baseline and the instancing pass

- **T1 — Baseline, draw by draw.** Export the source when stale; bt-optimize Phases 0–2 with `--analyze` and the
  pinned profile run with `--casters true`; copy the pinned poses to `tests/poses-pinned.json`. Write
  `tests/baseline.md`: draws per pass and FPS at each pin, the per-owner table, every repeated shape and what stops it
  instancing, every SkinnedMeshRenderer with its verdict, the shadow casters per cascade. Unity captures of the source
  at every pinned pose (`PoseView`) — the look reference.
  Tests: `mainDraws` = `passes.main` at every pin; every SkinnedMeshRenderer has a verdict. Verify level: live.
- **T2 — Working copy: unskin, unfreeze, instance, VAT crowds, lights; bake; export; measure.** Phase 3 (`PrepareCopy`,
  `Tune` with the decided options; Analyze / Apply only when O8 says merge), Phase 4 (bake, `BtOptimize.Verify`,
  `BtCombine.Verify` when merged), Phase 5 captures at the pinned poses, Phase 6 export + pinned profile replaying
  `tests/poses-pinned.json`, `compare-profiles` into `tests/compare-T2.md`.
  Tests: `Verify` problems=0. Acceptance: main-pass draws fall at every pin; every repeat one draw or its reason;
  captures match T1's; 0 console errors. Verify level: live.

### Phase 2 — Shadow casters, final proof

- **T3 — Prune shadow casters.** From T2's per-cascade dump and the survey's candidates write
  `tests/shadow-casters.md` (each caster's draws per cascade, verdict and reason); `PruneShadowCasters` with the prune
  list; captures at every pinned pose — drop any entry whose removal shows, re-run the prune; re-bake; `Verify`.
  Acceptance: shadow-map draws fall at the pins; every shadow visible in T1's captures is still there.
  Verify level: live.
- **T4 — Final measure, game check, report.** One export; pinned + timeline profiles; `compare-profiles` T1 → final into
  `tests/compare-final.md`; point the web game at the optimized export when it loads the source's; drive the game to
  the pinned views and check the look through the game's own camera (post-processing on), animated props and crowds
  animating, 0 console errors; bt-optimize Phase 8 report with **Export this scene**, **Draws by owner**, **What stayed
  and why** and **Redo after `--reset`**. Verify level: live.

Add a task only for real extra work: a merge pass worth its own checkpoint, a project script (O11), a runtime
follow-up the user asked for (a per-skin VAT array, a camera's post chain). Put a project-wide lever (O10) in the
follow-ups, not the plan.

**Estimate:** Unity rate per task; the first VAT crowd in a project and the game check are outsized (2×). Biggest
uncertainty to name: whether the crowd's Animators keep their own state in the VAT export, and how long the bake takes.

## Executing it (bt-execute)

- Builders copy the skill's `scripts/` into `AgentScripts/bt-optimize/` and `scripts/qa/` into
  `.agents/optimize/.qa-tools/` (Phase 0) and run them; the plan's task brief carries the relevant `SKILL.md` phases and
  the Tune JSON. Never hand-edit the working copy outside a script: `--reset` would lose it.
- The verifier gets **What this skill guarantees** from `SKILL.md`, the `Verify` output and the paired captures. A
  pinned comparison counts only when the paired shots show the same view.
- Snapshots per visual task: the Unity capture and the browser shot at one pinned pose, before → after.
- Never commit, and never delete the source, the working copy or an earlier copy; tidying old scenes is the user's call.
