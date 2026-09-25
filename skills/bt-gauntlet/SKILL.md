---
name: bt-gauntlet
description: "The Babylon Toolkit Gauntlet Skill runs a loop-engineering gauntlet: builders versus fresh harsh critics, scored against a LOCKED target image from LOCKED cameras, looping until a success condition, boundary, or stall rule stops it. Two deliverable kinds share one loop — BabylonJS / Babylon Toolkit web games, and anything authored in Unity (game levels and the individual assets in them: baked GI, IBL, reflection probes, terrain, fog, tonemapping, materials, models), with headless Blender as the tool for low-level model work. Unity plus the Toolkit exporter is the content-creation surface and asset manager, shipping interactive glTF that BabylonJS loads; iteration stays inside Unity on camera snapshots, relying on Unity→Babylon parity, with export + browser checkpoints at milestones rather than every round. Fully RESUMABLE: each job lives in its own _gauntlet/<name>/ workspace, so the user can stop any time (daily limits, calling it a night) and continue weeks later in a brand-new session with `/bt-gauntlet --resume <name>`. Use for a long-running, self-improving build of an ambitious game artifact, level, or asset (e.g. `/bt-gauntlet build me a rain-soaked neon alley level at the fidelity of this reference image`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com), Agent, Task
---

You define the objective, metric, and boundary; the loop replaces your manual chain of follow-up prompts. The core pattern is Matt Shumer's Gauntlet Loop — builders versus fresh harsh critics — with the target-image discipline of the dream-loop pattern layered on top. You are an EXPERT BabylonJS and Babylon Toolkit game developer — every gauntlet run builds with **BabylonJS and the Babylon Toolkit, NEVER Three.js**.

Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-gauntlet [--name:slug] [--template:gauntlet|bounded] [--rounds:N] [--card:file] [--resume|--status|--stop] [<name>] <brief + attachments>
```

**Flags** (all optional; `--flag:value` or `--flag`):

- **`--name: slug`** — this gauntlet job's name; it becomes the job's workspace folder `_gauntlet/<name>/`. **Any number of gauntlet jobs can exist side by side in one project** (e.g. `cod-fps`, `neon-alley`), each fully independent. If omitted on a new gauntlet, derive a short kebab-case slug from the brief and confirm it in the interview.
- **`--template: gauntlet | bounded`** — which loop template drives the run. `gauntlet` = **Template A** (full-on Shumer-style fan-out: builders vs fresh harsh critics). `bounded` = **Template B** (single-track objective / metric / boundary loop card — use when reliability and cost matter more than dramatic language). **Default: `gauntlet`.** Recorded in `loop-card.md`; a job never mixes templates. Both live in `references/loop-templates.md`.
- **`--rounds: N`** — maximum full rounds (build → verify → critic → record) THIS invocation may run before parking cleanly with a status report and the exact resume command. **Default: `5`.** Override per session (`--rounds:20` for a long night).
- **`--card: file`** — a **pre-filled loop card**: one of the two templates with EVERY slot already answered, including `<NAME>` and `<DELIVERABLE KIND>`. Skips the interview entirely — validate the card, copy it to `_gauntlet/<name>/loop-card.md`, distill `brief.md` from it, and start round 1 without asking anything. This is the **non-interactive entry** used when a spec/plan drives the gauntlet. If any slot is unfilled or vague, STOP and report which — never guess a slot.
- **`--resume [<name>]`** — skip the interview, load `_gauntlet/<name>/`, and continue at its `NEXT ACTION`. This is how the loop continues in a brand-new session a day or a week later. Name resolution: an explicit name targets that job; with no name and exactly ONE job in `_gauntlet/`, resume it; with several jobs, list them (name, kind, parts done/total, next action) and ask which one — never guess.
- **`--status [<name>]`** — read-only report: parts done/total, budgets spent vs boundaries, last critic score, active stall tier, next action. With no name, print an **index of ALL gauntlet jobs**. Runs zero rounds.
- **`--stop [<name>]`** — park that job deliberately: write the current status into its `progress.md`, print the resume command, run nothing further.
- **`<brief>`** — the idea and the goal. Attached reference screenshots/clips are copied into `_gauntlet/<name>/reference/`.

**Mode resolution:** if `--resume`, `--status`, or `--stop` is present, run that mode. Otherwise, if `_gauntlet/` contains existing jobs and no new brief was given, list them and offer to resume one. Otherwise this is a **new gauntlet**: run the interview — or, with `--card:`, validate the supplied card and start immediately. A new gauntlet whose `--name` collides with an existing job is an error — offer `--resume <name>` or a different name; never silently overwrite a job's workspace.

---

# Deliverable kinds — what the loop is actually building

**One loop, two build-and-verify pipelines.** The round protocol, the critic contract, the stall ladder, the workspace and the resume machinery are identical in every case. What changes is *what the builder edits* and *how evidence is produced*. The interview settles this (batch 1) and records it in the loop card as `DELIVERABLE KIND`.

| Kind | Builder edits | Evidence is | Pipeline reference |
|---|---|---|---|
| **`web-game`** | BabylonJS / Toolkit TypeScript, scene code, shaders, UI | the running game in a browser | *(built in; no extra reference)* |
| **`unity`** | a Unity scene via the Unity CLI — terrain, light rig, probes, bake settings, volumes, materials — with **headless Blender as the tool** for low-level model and asset work (in place, so GUIDs survive) | **in-loop: a Unity camera snapshot** rendered straight to PNG from the locked camera. Export + browser only at checkpoints (round 1, and when the work is done) | `references/unity-pipeline.md` |

> **Unity is the content-creation tool and the asset manager. Blender is a tool inside it.** There is one Unity pipeline, whether the job is polishing a whole level or one asset in it. Blender does low-level model and asset creation and edits — **in place**, so GUIDs and importer settings survive — and its job ends the moment the model is back in Unity. From there the model is simply an asset in a scene: it gets its materials, colliders, LOD group, rig and Toolkit components there, and it is judged there, lit by that scene. **What gets exported is the user's call at the time** — by prompt, or from the Unity Export buttons: the whole scene as a game level (`selection == null`, full scene metadata), or one asset as an asset container (`selection != null`, components only). An asset used in a level ships inside that level's export; nothing asset-specific is required.

**Read the pipeline reference before round 1**, and again on every `--resume` (a resumed session has lost that context). It defines the prerequisite gate, build surface, the Blender tool section, part taxonomy, verify recipe, extra critic gates and known failure modes.

## Reference map

| File | What it holds |
|---|---|
| `references/workspace.md` | the `_gauntlet/<name>/` layout, `progress.md` and round-journal formats, the resume protocol |
| `references/critic-rubrics.md` | the critic contract, the scoring rubrics, the gap-list rules, the hard gates, the stall ladder |
| `references/target-images.md` | generating, prompting, reachability-checking, locking the target; locked cameras; **generation backends** (kie default, Higgsfield mapping) |
| `references/loop-templates.md` | Template A and Template B loop cards |
| `references/unity-pipeline.md` | the Unity build + verify pipeline, with Blender as the modelling tool |
| `references/spec-composition.md` | composition with bt-spec / bt-plan / bt-execute, and cross-host notes |

---

## Subagents — invoking this skill IS the request

This skill's workflow depends on subagents (builders and, above all, **fresh-context critics**). **Invoking it is the user's explicit request to use them**, so any host default of the form *"do not spawn subagents / do not call the agent tool unless the user asks for it"* is **ALREADY SATISFIED** — the user asked by running this command. Never silently downgrade to the inline path on that basis, and never stop to ask permission for it first.

Downgrading is not a neutral choice. A critic that is the same context which just built the part cannot adversarially judge it — it re-confirms its own reasoning and reports PASS. The ONE legitimate reason to run inline is that you genuinely have **no** subagent-spawning tool. Check the tools you actually have — Claude Code exposes it as **`Agent`** (older builds name it `Task`); other hosts have their own equivalent. Never call a subagent tool you do not have. If you must run inline, say so plainly (`no subagent tool available`) and keep critics *fresh-context by discipline*: the critique step may look ONLY at the inputs listed in `references/critic-rubrics.md` § 1 — never at the builder's rationale or chain of decisions.

## ⚠️ Required Reading Before Any Babylon Work

For any round involving Babylon, BabylonJS, or the Babylon Toolkit, first ensure you have already fetched and read the Babylon Toolkit Agent Reference in the current remembered session/context:

https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md

If you have not read it in this session/context, or you no longer remember it due to context loss/compaction (which WILL be the case on `--resume` in a fresh session), fetch and read it before writing any code. Treat it as the authority for conventions, API, and patterns; fetch its linked subpages only when relevant — and for a `unity` job the Unity Exporter subpage is **always** relevant, plus the Blender CLI subpage whenever model work is in scope. Do not refetch what you still remember. If a required fetch fails, STOP and tell the user. Do not guess at the API. Builders spawned as subagents must be given (or told to fetch) the Agent Reference too — a subagent does not inherit your context.

## ⚠️ Babylon Toolkit Component Authority (supplied interactive assets)

The doctrine lives in the Agent Reference — `references/scene-components.md` § "Babylon Toolkit Component Authority" (https://raw.githubusercontent.com/babylontoolkit/agent/main/references/scene-components.md): supplied GLTF/GLB files are **interactive prefabs** whose `extras.metadata.components` carry configured physics, tuning and gameplay intent; `TOOLKIT.*` components are the first-class engine implementation — compose and tune them through `PROJECT.*` ScriptComponents, never reimplement, bypass, or delete them; replacement requires that document's evidence checklist. Read it before any round touching supplied interactive assets. The gauntlet-specific mechanics:

- **Round 1 writes the inventory to disk** — `_gauntlet/<name>/components.md`: every component grouped by scene node, classified **protected-system** (`TOOLKIT.*` — tune, never replace), **project** (`PROJECT.*` — modifiable), or **authoring-only**, with safe-to-tune properties verified against `babylon.toolkit.d.ts`. A resumed cold session READS this instead of re-deriving it; the round that changes supplied assets updates it.
- **Builders build against the manifest** — given `components.md` alongside the Agent Reference. Unity-authored serialized values are preserved unless a *measured* issue justifies the change, and the measurement goes in the round journal.
- **Critics enforce it** — reimplementing, bypassing (e.g. direct transform updates beside an attached physics controller), or deleting a protected component is a **FAIL regardless of how the evidence looks**, unless the round journal carries the full replacement-evidence checklist.

> **Direction matters.** The doctrine above governs *consuming* supplied prefabs. A `unity` job is usually **authoring** the thing that carries the metadata — there, the equivalent discipline is honoring the exporter's contract (see the pipeline reference's export-boundary gate), not preserving components you are in the act of creating. Say which situation applies in the loop card so critics do not misapply it.

## ⚠️ The Project Specification (SPEC.md)

If the project keeps a root **SPEC.md**, read it before the first round of each invocation and conform to its architecture, systems, and conventions while building. If gauntlet work changes the architecture, a system, a convention, or a dependency, update SPEC.md per its "How to update this spec" contract as part of the round that changes it.

---

# The Interview (mandatory before round 1 of a NEW gauntlet)

*(Skipped entirely when `--card:` supplies a complete pre-filled loop card — validation replaces conversation.)*

The loop may not start until **every slot of the chosen template is filled**. This is extensive by design — a vague slot produces a loop that spins without a finish line. Use the host's structured question tool (e.g. `AskUserQuestion`) where available; plain numbered questions otherwise. Batch related questions; don't drip them one at a time. Where the user's brief already answers a slot, confirm rather than re-ask. Push back on weak answers and co-rewrite them into useful ones (weak: "make it AAA" → useful: a testable sentence).

Interview batches:

0. **NAME** — Confirm the job's slug. It becomes `_gauntlet/<name>/` and must not collide with an existing job.
1. **DELIVERABLE KIND + DELIVERABLE** — Which of the three kinds is this: a **web game**, a **Unity level for export**, or a **Blender model**? Then what exactly ships (playable browser demo, one polished level, a hero asset with LODs...)? Module style: ES6/ESM default; UMD only if explicitly demanded. New project or existing? Target folder. **Read the matching pipeline reference now** and run its prerequisite gate before going further — a failed gate (no Pro licence, no toolkit bootstrap, no rendering Editor for snapshots, no Blender) changes what is worth agreeing to.
2. **OBJECTIVE** — The exact outcome that must become true, as one testable sentence. Rewrite with the user until it is inspectable.
3. **THE TARGET + CAMERAS** — Per `references/target-images.md`: does the user have reference media, is there an existing artifact to refine, or do we generate the target? Agree the target image(s), run the **reachability pass** (Reachable / Approximable / **OUT OF REACH**), and agree the **locked cameras** — one per target, three to five, including a detail crop. Settle the **image-generation backend** too (kie by default, the Higgsfield CLI if it is installed and signed in or the user asks for it — `target-images.md` §1a) and record it in `pipeline.md`. Plus numeric benchmarks: target FPS @ resolution, max load time, draw-call / texture / triangle budgets. If the user has no benchmark, making a defensible one is part of the interview, not skipped.
4. **RUBRIC + PASS THRESHOLD** — Confirm the rubric axes from `references/critic-rubrics.md` (or amend them for this job) and the score a part must reach to pass. Default: **8.0 / 10 plus every hard gate green.**
5. **SUCCESS CONDITION** — When is the loop DONE? (e.g. "every part scores ≥8/10 from a fresh critic; sustained 60 FPS @1080p in Chrome; zero console errors; the final integration critic passes"). Success and failure defined separately.
6. **BOUNDARIES** — Time/cost expressed in **rounds and attempts, not wall-clock** (wall-clock cannot survive a two-week pause; counters can): max total rounds, max attempts per part before a forced strategy change, max consecutive no-improvement rounds. Permission gates: no deploy, no purchases/paid services, no credentials, no destructive ops, no contacting anyone — without explicit approval. For `unity`: the **bake tier policy** (how many rounds at preview tier before a production bake). Escalation rules: what blocks and waits for the user.
7. **Kind specifics** — For `web-game`: genre & camera, physics (Havok default), input, audio, asset pipeline, scene scale, target browsers, and explicit scope cuts. For `unity`: which scene (that is where the work is authored, rendered and judged), render pipeline, terrain in scope?, existing lighting to preserve, whether Blender model work is in scope (and if so which assets, in-place or new path, tri budget, texel density, rig to match), the bake tier policy, and the **milestone checkpoints** (round 1, each major part group as it passes, and the end — by default). The Editor runs **with graphics** (never `-nographics`) and with the GPU Resident Drawer off, or its snapshots show only the sky. The level is authored like a full Unity game level and relies on Unity→Babylon parity; checkpoints confirm it. What finally gets exported — the whole level, or an individual asset as a container — is the user's call at checkpoint time, not something to decide now.

8. **Loop mechanics** — confirm `--template` choice, rounds-per-session default, and any parts the user wants prioritized first.

Write all answers to `_gauntlet/<name>/brief.md`. Write the locked cameras to `cameras.md` and the pipeline state to `pipeline.md`. Fill the chosen template's slots to produce `_gauntlet/<name>/loop-card.md`. **Show the user the filled loop card and get confirmation before round 1.** Nothing builds until the card is confirmed.

---

# The Gauntlet Workspace (resumable state)

**Nothing the loop needs lives in the conversation — it all lives in files.** One folder per job:

```
_gauntlet/<name>/
├── loop-card.md      # the constitution: kind, objective, target, rubric, OUT OF REACH, boundaries
├── brief.md          # full interview answers
├── cameras.md        # LOCKED capture cameras — evidence from anywhere else is inadmissible
├── pipeline.md       # pipeline state: project paths, licence tier, capture mode, bake tier, checkpoints
├── components.md     # component inventory of supplied interactive assets (when applicable)
├── progress.md       # THE resume file — parts, scores, attempts, failed approaches, NEXT ACTION
├── rounds/           # append-only per-round journals with the full gap list
├── reference/        # the LOCKED target image(s)
└── evidence/         # our side: round-NN-<part>-<camera>.png + metrics + metadata dumps
```

**Full layout, file formats and the resume protocol: `references/workspace.md`.**

**Persistence rule (HARD):** update `progress.md` and append the round journal **after every round, before starting the next**. Budgets count **cumulatively across sessions** — the round counter never resets on resume.

---

# The Round Protocol (one round; every kind, both templates)

1. **Inspect** the current state: `progress.md` + `pipeline.md` + the actual project — plus `components.md` when supplied assets carry component metadata (write it now if it is owed and missing).
2. **Select** the highest-impact unmet criterion — normally the top entries of the **standing gap list** from the last critic, respecting user priorities from the brief.
3. **Build** — make one coherent improvement, through the deliverable kind's build surface. **Template A:** fan out builder subagents only for *genuinely independent* parts; **keep tightly coupled systems under one sequential owner** (broad fan-out performs WORSE than sequential ownership for coupled visual systems). **Template B:** single-track. When a stall tier is active, obey it — incremental tweaks are forbidden and the round must carry a `STRATEGY:` line.
4. **Verify with the real artifact** — run the pipeline's verify recipe and capture evidence **from the locked cameras** into `_gauntlet/<name>/evidence/`: screenshots plus whatever metrics that pipeline can measure in-loop. **Use the pipeline's cheap in-loop mode every round** — for `unity` that is a Unity camera snapshot, *not* a bake-export-serve-browser round trip; the expensive engine verification is a deliberate checkpoint (round 1, each milestone, and when the work is done), never a per-round tax. **Screenshots are required for visual parts.** If the host cannot produce the evidence, mark the part `unverified` — it can NEVER be flipped to `- [x]` on the builder's word.

5. **Criticize (fresh context)** — spawn a harsh critic subagent per `references/critic-rubrics.md`. It receives the loop card, the part's spec, the target, the evidence, the metrics, **the previous round's screenshot and verdict**, and the pipeline's extra inputs — **never the builder's rationale**. It returns a **scored rubric**, the **FULL prioritized gap list** (not one gap), every **hard gate** as pass/fail, a regression note, and PASS/FAIL. It grades pixels, numbers and behaviour — never effort or intent.
6. **Record** — append `rounds/round-NN.md` with the score and the whole gap list; update `progress.md`: on PASS flip the part to `- [x]`; on FAIL log the top gap and increment the attempt counter; update the best/last scores and the stall tier. Persist BEFORE the next round.
7. **Gate check**, in order:
   - **Success condition met** → run the **integration pass**: one final fresh critic inspects the complete artifact end-to-end for consistency, seams, and fit with the objective (local quality can rise while the whole becomes inconsistent). For `unity` this is where the expensive path finally runs — **production bake → export → serve → browser** — so the integration critic judges the real deliverable and the perf, console, component and export-boundary gates are measured for real. Ask the user what to export if it is not obvious: the whole level, or an individual asset as a container. On pass, report DONE with the evidence summary.

   - **Stall ladder fired** → **STALL APPROACHING** (no full-point gain in 2 rounds, or the same top gap twice) forbids tweaks and forces one architectural change next round. **STALLED** (that swing scored the same or worse) parks and escalates to the user. See `references/critic-rubrics.md` § 4.
   - **A loop-card boundary fired** (rounds exhausted, repeated blocker, permission needed) → park + escalate with specifics.
   - **`--rounds` session cap reached** → park cleanly: status report + print exactly `/bt-gauntlet --resume <name>`.
   - Otherwise → next round.

Parking is always clean: state persisted, status reported, resume command printed. The user can walk away at ANY park (or any interrupt) and come back a day or a week later.

---

# Worked Examples

## Example 1 — A game level from scratch, from reference images (or generated ones)

```
/bt-gauntlet --name:neon-alley --rounds:12 Build me a rain-soaked neon alley level in Unity
and export it for my BabylonJS game — wet asphalt with puddle reflections, layered signage,
volumetric haze under the lights, at the fidelity of the attached screenshots.
```

**If the user attaches nothing**, the interview generates the target instead — a real in-engine screenshot, never concept art (`references/target-images.md` § 2). The calls below use the kie shape (the default backend); on the Higgsfield CLI, map them per `target-images.md` §1a: `node scripts/hf-generate.mjs <model> --prompt … --image-references <file> --out <same out_path>`:

```
generate_image(
  prompt: "in-engine screenshot from a modern real-time WebGL game, narrow rain-soaked
           alley at night, wet asphalt with sharp neon reflections in standing water,
           layered Kanji signage in magenta and cyan, thin haze in the light cones,
           baked global illumination, gameplay camera at eye height, 1920x1080",
  out_path: "_gauntlet/neon-alley/reference/target-hero.png",
  aspect_ratio: "16:9", resolution: "2K", output_format: "png")
```

**Interview settles:** kind `unity`; three locked cameras (`gauntlet_hero` down the alley, `gauntlet_side` across the puddles, `gauntlet_detail` on a sign); pass threshold 8.0; budgets 60 FPS @1080p, ≤900 draws; bake policy *preview until round 8, then production*.

**The reachability pass matters here.** URP has no screen-space reflections to export — the declared approach becomes *a reflection probe per puddle group plus a wet-mask material*, recorded as **Approximable**. True volumetric light shafts go to `OUT OF REACH`; height fog stands in. Without this the critic names "no SSR" every round forever.

**Round 1** runs the prerequisite gate (`bt_status` → `pro : True` or park), writes `pipeline.md`, authors the blockout via `run_script` builders, creates the LightingSettings asset (`NewScene → build → SaveScene → assign → MarkSceneDirty → SaveOpenScenes`), places the three `gauntlet_*` cameras, and decomposes into the P1–P11 part checklist.

Round 1 also runs the **one calibration checkpoint** — a single export + browser load — to prove the whole chain works before investing 12 rounds, and to record what actually crosses the export boundary.

**Every round after that stays inside Unity:**

```bash
# bake (preview tier) only if this round touched anything GI-dependent
unity command bake_lighting --project-path "$PROJ"
until unity command lighting_bake_status --project-path "$PROJ" --result-only 2>/dev/null | grep -q completed; do sleep 5; done

# snapshot each locked camera straight to PNG — no export, no server, no browser
unity command capture_game_view --camera gauntlet_hero --width 1920 --height 1080 --project-path "$PROJ" \
  --result-only | jq -r .base64 | base64 -d > _gauntlet/neon-alley/evidence/round-NN-p7-hero.png
```

Seconds, not minutes. The critic scores hero + side + detail against their targets and returns the full gap list.

**The export runs at milestones, not every round:** the round-1 calibration; a checkpoint each time a part group passes (landform, light rig + GI bake + probes, materials + dressing, atmosphere + post); and the final pass — production bake, export the finished scene, serve it, and let the integration critic judge the real deliverable while the perf, console and export-boundary gates are measured for real. *Did `reflectionprobeintensity` actually cross, or did the round only move a Unity slider?* — each milestone answers that for the parts it covers, instead of forty times over or only at the very end.

**Parks** at round 12 with `/bt-gauntlet --resume neon-alley`. Weeks later that resumes cold: re-read the workspace, re-launch the Editor, re-run the gate, continue at `NEXT ACTION`.

## Example 2 — Spit and polish on an existing Unity level

```
/bt-gauntlet --name:harbor-polish --rounds:20 Take my existing Assets/Scenes/Harbor.unity
and push it to the fidelity of the attached shots — I want the lighting and materials to
sing. Don't change the layout.
```

The difference from Example 1 is **the target is a refinement of what exists, not a new dream**:

1. Export and capture the level **as it stands today** from the agreed cameras — that is `evidence/round-00-baseline-*.png`.
2. Feed the baseline to the image model as the reference so the target improves the real scene rather than reimagining it:

```
generate_image(
  prompt: "the same harbor scene, same layout and camera, upgraded to a modern real-time
           in-engine look: warmer low sun, softer bounce into the shadows, wet stone with
           varied roughness, richer ambient occlusion, subtle haze over the water",
  reference_paths: ["_gauntlet/harbor-polish/evidence/round-00-baseline-hero.png"],
  out_path: "_gauntlet/harbor-polish/reference/target-hero.png")
```

3. **Constrain the part list.** "Don't change the layout" removes P1/P2/P3 from scope — record that as an explicit scope cut, so the loop works only P4–P11 (materials, light rig, GI bake, IBL, probes, atmosphere, image processing, perf) and a critic never raises a composition gap.
4. **Capture the baseline score.** Round 1's critic scores the untouched level against the target. That number is the floor — every later round is measured against it, and a regression below it is a gate failure, not a preference.
5. Bake tiering matters more here than anywhere, because the scene is already heavy: preview tier for the convergence rounds, one production bake before the integration critic — and with the export out of the loop, the bake is the only per-round cost left, so skip it entirely on rounds that change nothing GI-dependent.

Because the scene was authored in the GUI it already has a LightingSettings asset — but **always pass `--scene`** at checkpoint exports anyway, or a fresh Editor session silently exports the template's default scene instead. Note this pipeline needs an Editor that can render for the in-loop snapshots: never `-nographics`, and the GPU Resident Drawer off (`unity-pipeline.md` § 1).

## Example 3 — A high-fidelity model, polished in Blender and shipped as an interactive prefab

```
/bt-gauntlet --name:hero-mech --rounds:15 Take Assets/Models/mech.fbx and make it a hero
asset — bevelled panel work, real wear, proper PBR maps, under 45k tris with an LOD chain.
It needs a rigidbody, an LOD group and the Animator wired up. Reference is the attached
turntable.
```

**Interview settles:** kind `unity`, with Blender model work in scope; **write mode IN PLACE** so the GUID and importer settings survive every round; the **render scene** is `Assets/Scenes/Level01.unity` — the level the mech actually lives in, so it is judged under the lighting it will really have (a dedicated lookdev scene only if the asset has no home yet), with its rig frozen for the run; four locked `gauntlet_*` cameras in it including a detail crop; model root `Props/Mech`; budgets 45k tris, 512 px/m texel density; checkpoints at round 1, after the Blender parts pass, and at the finish.

**Blender hands off to Unity and stops there.** Blender does geometry, UVs, bakes and skinning, editing the FBX in place; Unity assigns materials, colliders, the LODGroup, the Animator and the Babylon Toolkit script components — Blender cannot write `extras.metadata.components`, and under a community licence Unity won't either. After the hand-off the mech is just an asset in `Level01`.

**A round, end to end — no export in sight:**

```bash
cp "$FBX" "$FBX.bak"          # the write is destructive — always
blender --background --factory-startup --python-exit-code 1 \
        --python /tmp/round-07-bevels.py -- "$FBX" "$FBX"    # same path in and out
unity command eval 'UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceSynchronousImport); return "ok";' --project-path "$PROJ"
unity command capture_game_view --camera gauntlet_hero --width 1920 --height 1080 --project-path "$PROJ" \
  --result-only | jq -r .base64 | base64 -d > _gauntlet/hero-mech/evidence/round-07-p2-hero.png
```

Without `--python-exit-code 1` a crashed script exits `0` and the loop records a failed round as a success. Without in-place writing, every round mints a new GUID and quietly detaches the model from every scene that used it. Both are hard gates.

**Checkpoints export the scene, and the mech ships inside it:**

```bash
unity command bt_export_level --scene Assets/Scenes/Level01.unity --project-path "$PROJ" --timeout 900
```

Nothing model-specific is needed — `selection == null` exports the level, the mech is in there with its components, lit by the scene's baked lighting. If you *also* want the mech as a standalone reusable container, that is the deliberate extra call (`bt_export_prefab --paths "Props/Mech" --metadata true`), and `selection != null` means it carries components but no scene metadata.

The checkpoint is also where the critic gets both the Unity snapshot and the browser frame of the same angle and must say which side a gap is on — *Unity right, browser wrong* means material translation, not the sculpt, so don't re-model.

**Textures are generated, never procedural stand-ins** — `generate_image` (kie by default, Higgsfield per `target-images.md` §1a) for albedo, normal and roughness detail. With the Higgsfield CLI set up, a part that starts from nothing may take an image-to-3D GLB as its blockout (`unity-pipeline.md`). "Substituted procedural noise for the missing map" is a gate failure, and it is the single most common reason a model reads as plastic.

Scored on the **model rubric** (Silhouette & Proportion · Surface & Material · Detail Density · Topology & Efficiency · Integration Readiness), with gates on tri budget, ≤4 influences/vertex, weights normalised, transform hygiene and GUID survival.

## Example 4 — The canonical brief (engine correction is automatic)

```
/bt-gauntlet I want you to build a first-person shooter at the level of the most recent
Call of Duty games. It should be utterly perfect, visually beautiful, with every single
thing done at AAA quality—from textures to physics to anything you could think of.
```

The interview turns that into a filled loop card built with **BabylonJS + the Babylon Toolkit, not ThreeJS** — and, because "AAA quality" is not a bar, into a locked target image, locked cameras, a rubric and a pass threshold before a single round runs.

## Example 5 — A design-heavy kart-racing level, built in Unity, verified at milestones

```
/bt-gauntlet --name:candy-circuit --rounds:40 Build a Mario Kart style race track — a bright
candy-themed circuit with a jump, a tunnel, boost pads and scenery everywhere. Karts must drive it.
```

**Unity is the level editor; BabylonJS runs the race.** The track is authored in Unity the way a Unity game level would be — and relies on Unity→Babylon parity rather than exporting every round.

**Interview settles:**
- kind `unity`, with four locked cameras: start grid, the jump, the tunnel exit, and a detail crop on a boost pad;
- budgets: 60 FPS @1080p desktop, and a mobile tier with a draw-call ceiling;
- **milestones:**
  - M1 landform + track spline;
  - M2 light rig + GI bake + probes;
  - M3 materials + set dressing;
  - M4 atmosphere + post-processing;
  - M5 gameplay components.

**Parts:**

| Part | Owns |
|---|---|
| Landform | terrain, road mesh along the spline, banking |
| Blockout + composition | sightlines at each locked camera, readable turns |
| Materials | candy PBR, emissive boost pads |
| Light rig | Mixed sun, Baked practicals in the tunnel |
| GI bake | lightmaps + shadowmask, `LightProbeGroup` along the racing line for the karts |
| Reflection probes | baked, box-projected in the tunnel |
| Atmosphere + post | fog, a Volume with ACES and bloom |
| Physics | road and wall colliders, boost-pad triggers |
| Karts | Rigidbody chassis, `WheelCollider`s + `RaycastWheel`s |
| Gameplay | the racing starter's `RaceTrackManager`, `CheckpointManager`, `VehicleInputController` (human + AI autopilot), `StandardCarController` |
| Perf | the draw-call and FPS budgets |

**The rhythm:**
- **Most rounds stay in Unity:** a `run_script` builder, a preview bake when GI changed, and locked-camera snapshots.
- **When a milestone's parts pass, run a checkpoint:** export (`--geometryOnly false`), serve, load the same cameras in the browser, and have the critic say which side of the export any gap is on.
- **M5 is judged driving:** a kart actually laps the track in the browser.
- **The integration pass** runs the production bake and the full perf gates, desktop and mobile.

---

# Failure-Mode Guardrails (loop rules, non-negotiable)

- **The builder never grades its own work.** Verdicts come from fresh-context critics (or the strictly-scoped inline discipline above).
- **The bar is an image, and it is locked.** No prose bars. No moving the target mid-run except by a dated amendment that resets the affected parts' score history.
- **Evidence comes from the locked cameras.** A frame shot from anywhere else is inadmissible, however good it looks.
- **No single gameable score.** The rubric score decides quality; the hard gates decide admissibility. A part passes only when both are satisfied — perf, console, camera lock, component authority and the pipeline gate all green.
- **The critic returns the whole gap list.** One gap per round is a slow loop; a comprehensive, actionable, prioritized list is the work order for the next round.
- **Scores must be comparable.** Every critic sees the previous verdict and screenshot. A regression scores worse and says what regressed.
- **Repetition without a changed strategy is a boundary event**, not persistence. The stall ladder is mandatory, and its triggers are concrete: no full-point gain in 2 rounds, or the same top gap twice.
- **Progress is never self-reported.** Screenshots, perf numbers, exported metadata, diffs — an observable receipt, or it didn't happen.
- **Never chase what cannot cross the boundary.** The `OUT OF REACH` list exists so critics stop naming impossible gaps.
- **Permissions start reversible.** Deploy, delete, spend, publish, message, and secrets stay behind explicit user approval, always.
- **Context rots; files don't.** Compact durable state in `_gauntlet/<name>/` beats a long chat history. On any doubt, trust the files and the actual project, then correct `progress.md`.
- **Pipeline state does not survive a pause.** A resident Unity Editor, a dev server, a warm asset database: all session-scoped. Re-run the prerequisite gate on every resume.
- **Jobs never bleed into each other.** A round touches only its own `_gauntlet/<name>/` state; other jobs' workspaces are read-only neighbors.
- **Every park prints the exact resume command**: `/bt-gauntlet --resume <name>`.

---

# Composition and Cross-Host Notes

How this skill composes with **bt-spec / bt-plan / bt-execute**, and how it degrades across hosts that lack subagents, browser tools, image generation or a shell: **`references/spec-composition.md`**.
