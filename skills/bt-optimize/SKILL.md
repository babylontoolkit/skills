---
name: bt-optimize
description: "The Babylon Toolkit Optimize Skill makes an exported Unity scene run fast as BabylonJS web content. It measures the exported scene in the browser first (frame rate, draw calls per pass — shadow maps, depth / velocity buffers, main pass, post — CPU hot spots, light binding), accounts for every draw by the object that owns it, surveys the Unity scene for the causes, then fixes them on a copy of the scene: skinned meshes that need no skinning (one-bone DAE / FBX imports — coins, item boxes, trees, signs) turned into plain meshes so repeated props share one instanced draw, runtime practical lights baked, realtime point / spot shadows removed, non-moving props marked static, probe-lit props with lightmap UVs lightmapped, no-op post effects removed, and static meshes and LOD groups merged with the Babylon Toolkit MeshCombiner (packed source lightmap UVs, mirrored pieces, LOD clusters with corrected switch distances). It re-bakes, exports, and proves the result — frame rate and draw calls before → after at the same pinned views, and the same look in Unity and in the browser. Every decision is written down with its reason. Use when the user wants a Unity scene to run faster or lighter in the browser, or wants static meshes / LOD groups combined (e.g. `/bt-optimize Assets/Scenes/Garden/GardenScene.unity`, `/bt-optimize --combine-only`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com)
---

You are an EXPERT Babylon Toolkit, BabylonJS and Unity technical artist and web-performance engineer. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md).

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-optimize [<scene asset path>] [--out:<asset path>] [--analyze] [--reset]
             [--no-combine | --combine-only] [--no-tune:unskin,lights,static,lightmaps,post] [--instance-from:4]
             [--keep-lights:Name1,Prefix*] [--bake-shadowed-lights] [--exclude:Name1,Prefix*] [--only:Path/A,Path/B]
             [--cell:15] [--spread:3] [--atlas-share:0.45] [--no-shadergraphs] [--no-lods] [--shaders:Name1,Name2]
             [--textures:ktx2] [--resolution:css] [--no-bake] [--no-export] [--no-browser] [--pins:40,60] [--times:10,20,30,45,60,90]
```

- **`<scene asset path>`** — the scene to optimize. Default: the Editor's active scene.
- **`--out:`** — the working copy. Default: `<scene folder>/<SceneName>_Optimized.unity`. **The source scene is never edited.**
- **`--analyze`** — measure and plan only: browser profile of the current export, Unity survey, tune plan, merge plan. Changes nothing.
- **`--reset`** — start again from the source (re-copies it over the working copy, deletes the previous merged meshes and reports).
- **`--no-combine`** — every optimization except merging meshes.
- **`--combine-only`** — only merge static meshes and LOD groups (no light, static, lightmap or post changes).
- **`--no-tune:`** — skip individual tune steps: `unskin` (rigid skinned meshes → plain meshes), `lights` (bake practical lights / drop point-spot shadows), `static` (mark non-moving props static), `lightmaps` (probe-lit → lightmapped), `post` (no-op post effects).
- **`--instance-from:`** — a mesh drawn this many times or more (same mesh and materials) stays light-probe lit so its copies share one instanced draw instead of each getting its own lightmapped mesh (default `4`; `0` turns it off).
- **`--keep-lights:`** — light names (or prefixes ending in `*`) that stay realtime / Mixed.
- **`--bake-shadowed-lights`** — also bake point / spot lights that cast realtime shadows (default: they stay realtime with their shadows turned off).
- **`--exclude:`** — object names (or prefixes) whose subtrees are never tuned or merged. **`--only:`** limits merging to these hierarchy paths.
- **Merge controls:** `--cell:` area patch in meters (15), `--spread:` meters a merge may extend past its largest piece (3), `--atlas-share:` largest share of one lightmap atlas per merged mesh (0.45), `--no-shadergraphs` (do not merge Shader Graph materials even when they pass the scan), `--no-lods` (leave LOD groups alone), `--shaders:` extra custom shaders known to be pivot-independent.
- **Project-wide exporter settings (opt in — they change every scene's export):** `--textures:ktx2` (KTX2 / UASTC textures: ~4–8× less GPU memory, slower export), `--resolution:css` (render at CSS pixels instead of device pixels on desktop: ¼ of the pixels on a 2× screen — only helps a GPU-bound scene).
- **`--no-bake` / `--no-export` / `--no-browser`** — skip those phases; the report says what stayed unverified.
- **`--pins:`** — seconds after the scene is ready at which the profiler pins the camera (default `40,60`; pick moments inside the scene's own flythrough / spawn view). **`--times:`** — timeline sample moments.

---

# What this skill guarantees

1. **Measure before and after, at the same views.** No change is justified by a guess: the browser profile of the current export names the costs, and the same profile of the optimized export proves the gain.
2. **The source scene — and any scene the user has open — is untouched.** All scene work happens in the working copy, which only `PrepareCopy` can create (it writes `.agents/optimize/<Out>/working-copy.txt`; Tune, Apply and RemoveCopy refuse any scene without it). Nothing switches scenes while an open scene has unsaved changes. The only project-wide edits are (a) deactivating a **zero-intensity** motion blur override in a Volume Profile (no change in Unity; recorded for undo) and (b) exporter settings the user opted into with `--textures` / `--resolution`.
3. **Every decision has a written reason.** `.agents/optimize/<Out>/` holds the survey, the tune plan and log, the merge plan and manifest, verify results, profiles, captures and the report.
4. **It looks the same.** Re-baked, then compared in Unity (LOD0 and LOD1) and in the browser at matching views. Expected, stated differences: baked practical lights lose their specular highlights and their realtime shadows on moving objects (they never had flicker or distance culling in the browser — those were Unity-only scripts).
5. **No vertex bloat.** Merges use the toolkit's `UnityMeshSimplifier.MeshCombiner` in *Pack Source Lightmap UVs* mode — each source keeps its own lightmap UVs, packed at its original texel density.
6. **Every draw is accounted for — ENFORCED.** Per-pass totals say *where* the frame goes; they never say *what* to fix. At every pinned view the profiler's `drawOwners` splits the main-pass draws by the scene object that owns them and lists every shape drawn more than once with why its copies do not share one draw. The plan and the report carry that table. **Every owner group of 5% or more of the main-pass draws is either fixed or has a written, measured reason it cannot be** — "it has an Animator", "it is skinned" or "a rule kept it" is not a reason on its own (see 7). The skill is not done while a large group is unexamined: a run that cut shadow draws but left 129 of 202 main-pass draws to copies of 8 props, all one-bone skinned meshes nobody looked at, was a failed optimization.
7. **An Animator or a SkinnedMeshRenderer is evidence to check, never a reason to skip.** Look at what the clip actually animates (`survey.md` → Skinned meshes): a spawn pop that scales the object, a spin, a collider toggle all work on a plain mesh. Only real deformation (animated bones, blend shapes, cloth) needs skinning. Repeated props are the largest draw group in most levels after the level geometry — always check them.

# Talk to the user while you work

Long runs lose people. At every phase change post one short plain-language update: **Done** (what changed, with numbers) · **Doing now** · **Next**. Say plainly which work is done by their own toolkit (MeshCombiner, exporter, bake). If you change the plan (exclude a group, keep a light, reset, re-bake), say why in one line.

---

# How a BabylonJS frame spends its time — what to look for

Learned on a 2,400-renderer URP garden that ran 8–26 FPS (1–5 FPS in hitches) after export:

- **Draw calls are the currency.** WebGPU / WebGL in the browser is CPU-bound long before it is GPU-bound: each draw costs JavaScript time (`bindForSubMesh`, `_draw`, render-pipeline lookup, uniform writes). Halving render resolution changed nothing; halving draws nearly doubled the frame rate. Every extra **pass** multiplies the draws of everything it renders.
- **Realtime shadows on point / spot lights are full scene passes.** Each shadowed spot light re-draws every caster in its frustum every frame (a point light: six times). The toolkit adds every shadow-casting mesh to every shadow-generating light. Six 5 m lantern spot lights = ~690 draws per frame — half the frame.
- **Runtime lights that the browser never animates are pure cost.** Unity sample scenes drive lights with MonoBehaviours (`LightFlicker`, `DynamicLightController` distance culling). Without a toolkit TypeScript port those scripts **do not run in the browser**: the lights neither flicker nor cull — they just cost. Baked, their light lives in the lightmaps (static objects) and light probes (moving objects) at zero runtime cost.
- **A depth pass appears when anything samples scene depth**: soft particles (`TOOLKIT.ShurikenParticles.SoftParticleDepth`, on by default) and Shader Graph Scene Depth nodes (`ShaderGraphPass.SceneDepth`) create a `DepthRenderer` that re-draws every visible opaque mesh each frame (20–25% of draws in the garden). Report it; merging reduces it; the runtime fix (take depth from the prepass renderer) belongs to the toolkit.
- **Zero-intensity post effects may still run.** URP's pipeline-default Volume Profile ships Motion Blur at intensity 0 (off in Unity); older toolkit runtimes still built a motion-blur pass for it.
- **Light binding is NOT range-aware.** BabylonJS's `Light.canAffectMesh` checks only include / exclude lists and layer masks, so every mesh binds up to its cap of runtime lights wherever they are (verified on Mario Circuit: 5 × 5 m item boxes bound 8 lights, 7 out of range). Tighter mesh bounds never lower the bindings — only baking the lights does. The profiler's `lightAudit` clamps each light into the mesh's box, so scene-sized bounds (skinned or track-wide meshes) hide the waste: a low out-of-range share on such a scene is understated.
- **Skinned meshes never instance.** Copies of a skinned mesh that animate separately each cost their own draw in every pass, and are skinned every frame. DAE and FBX imports routinely make rigid props one-bone skinned meshes: on Mario Circuit, 118 of 135 skinned renderers (coins, item-box parts, trees, track pieces) had one bone moving with the object and 129 of 202 main-pass draws came from 8 such repeated shapes. As plain meshes the exporter writes the copies as glTF instances (`ExportMeshInstances`, default on) — one draw per shape.
- **Lightmapping a repeated prop costs its instancing.** A lightmapped renderer never shares a cached mesh (each copy gets its own lightmap UVs), so 16 lightmapped trees are 16 draws while 16 probe-lit trees are one. Repeated props stay probe-lit (`instanceRepeatsFrom`); unique geometry gets the lightmaps.
- **Materials are cloned per renderer** for each reflection probe / lightmap combination and per LOD cross-fade level. Fewer renderers → fewer clones → fewer first-view shader compiles (hitches).
- **Lightmapped renderers never share a cached mesh** (reference §4): repeated lightmapped props are one draw each — merging is the only way to cut them. Probe-lit repeated props stay glTF instances.

# The tune rules — and why each exists

Enforced by `scripts/BtOptimize.cs` (`Tune`). A **browser driver** is anything that can move, toggle or animate an object *in the browser*: a toolkit script component (`EditorScriptComponent` subclass), Animator / Animation, a Timeline binding, Rigidbody / CharacterController / NavMeshAgent, a constraint, or a toolkit script component that points at the object — on the object or an ancestor. Unity-only MonoBehaviours are not browser drivers (they are reported as "Unity-only").

| Step | Rule | Why |
|---|---|---|
| Unskin rigid meshes | A SkinnedMeshRenderer with **one weighted bone** that moves with the object (no clip, Timeline, script, constraint or physics body moves the bone apart from the object), no blend shapes, no cloth, and no curve or reference aimed at the SkinnedMeshRenderer component becomes a MeshFilter + MeshRenderer on the same mesh and materials. Animators stay. When the bind pose offsets the mesh, a plain leaf object is moved onto it (the mesh stays shared — verified vertex by vertex); otherwise the offset is baked into one mesh asset shared by every copy with the same offset (`<Out>_UnskinnedMeshes/`). Runs first, so the later steps see the new renderers | Babylon skins a skinned mesh every frame and can never instance its copies. A one-bone import of a rigid prop bought nothing — Mario Circuit's coins, item boxes and trees were 112 draws at the start gate that become instances |
| Repeated props stay instanceable | A mesh + materials drawn `instanceRepeatsFrom` (4) times or more stays light-probe lit when marked static (still Contribute GI for bounce) and is skipped by the lightmap step | The exporter gives every lightmapped copy its own mesh; probe-lit copies share one instanced draw |
| Lights → Baked | Active Realtime / Mixed **point and spot** lights with no browser driver and **no realtime shadows** become Baked. Directional lights (the sun) and `--keep-lights` stay | Practical fill lights cost per-pixel lighting every frame; baked, they cost nothing and still light moving objects through probes |
| Shadowed key lights stay runtime, shadows off | A point / spot light that casts realtime shadows (or that a browser driver animates) stays Realtime / Mixed and loses only its realtime shadows. `--bake-shadowed-lights` bakes them too | Each shadowed light re-draws the scene every frame (×6 for a point light) — the shadows are the cost, not the light. Keeping the light realtime keeps its exact look (direct light, specular highlights, light on moving objects) with no bake risk; on Garden, six such lights cost little once their shadow maps were gone. Use `--bake-shadowed-lights` when a scene has many of them and Phase 5 verifies the bake |
| Fixture shells stop casting shadows | When a light is baked, the shadow-casting renderers of its own fixture prefab whose bounds hold the light get Cast Shadows Off | A lantern shell around the bulb is clipped by the realtime shadow map's near plane, but the lightmapper traces from the bulb: a shadow-casting shell traps a baked light (lit floor under each lantern, dark walls) |
| Mark static | A non-static MeshRenderer with no browser driver, not pointed at by any script, not part of a particle system, and **a visible surface** (every material's shader has a lightmapper Meta pass) becomes static (Batching, Occluder, Occludee, Reflection Probe; **Contribute GI** only with lightmap UVs, no vertex animation and opaque) | The exporter freezes static world matrices, and static objects can be lightmapped and merged. The Meta-pass check exists because an invisible stencil mesh (`Custom/StencilOnly`) wrapping a room, once marked Contribute GI, became a solid box in the bake and the room went dark |
| Probe-lit → lightmapped | A static LOD0 / non-LOD visible surface that is probe-lit although it has UV2, no vertex animation and is opaque gets Contribute GI + Receive GI Lightmaps; its lower LOD levels with UV2 receive lightmaps (they borrow LOD0's region) | Lightmapped meshes can merge; a merged probe-lit mesh would get one probe sample for its whole area |
| No-op post | Motion blur overrides with intensity 0 in the profiles the scene uses are deactivated | Off in Unity, but older toolkit runtimes still built the pass |

Kept as they are, by design: wind / vertex-animated vegetation (probe-lit by intent, and unmergeable), props without lightmap UVs (probe-lit), anything a script points at, stencil / depth / VFX utility meshes (no Meta pass), inactive objects.

Reported, never converted automatically — each with its next step in `survey.md` and `tune.md`:
- **Rigid, convert by hand:** a single bone that moves apart from its object (parent a plain mesh under the bone), a clip that animates the SkinnedMeshRenderer itself (retarget the curve to MeshRenderer), a component that references the SkinnedMeshRenderer.
- **Frozen pose:** several weighted bones that nothing animates — bake each copy to a static mesh (`SkinnedMeshRenderer.BakeMesh`).
- **Really deforming and repeated** (a waving crowd): the toolkit's `AnimatorControlRig` VAT (crowd) mode draws the copies instanced (`unity-authoring-recipes.md` §13). Name the group, its copies and its draws in the report.

**Every tune rule above came from a regression found by comparing Unity captures at the browser's poses** — run Phase 5 every time; a rule that changes what the lightmapper sees can change a whole room.

# The merge rules — and why each exists

Enforced by `scripts/BtCombine.cs` (`Analyze` / `Apply`). Each rule comes from a real regression.

**A piece can merge only if it is:**

| Rule | Why |
|---|---|
| Marked static (Contribute GI or Batching Static) | Anything else may move at runtime |
| Not scripted, animated, a particle system, a Rigidbody, or under one | Merged geometry cannot move or toggle on its own |
| Not referenced by any component (scripts, timeline bindings, cameras, signals…) | A script that toggles or moves it would lose its target |
| Opaque or alpha-tested (not transparent) | Transparent meshes are sorted per mesh; merging breaks draw order |
| A safe shader (URP/HDRP/Built-in Lit/Simple Lit/Unlit/Standard, `--shaders`) or a Shader Graph that passes the scan (on by default; `--no-shadergraphs` turns it off) | Graphs that read object space, use the Object node / model matrix, or move vertices (wind) change look when many objects share one pivot |
| Mirrored (negative scale) only on a toolkit whose MeshCombiner has `HandlesMirroredTransforms` | Older combiners did not reverse winding or fix normals / tangent handedness — flipped pieces rendered inside out |
| Not vertex-painted, not on toolkit layers 28–31 | Vertex streams and reserved layers are lost |
| **Lightmapped** when the scene has light probes | A merged light-probe-lit mesh gets **one** probe sample at its centre — metal rails merged across a room turned black |

**A group of pieces merges only if they:**

| Rule | Why |
|---|---|
| Share a container (highest ancestor with no scripts, animation or references) | Toggling or moving anything above still applies to the merged mesh |
| Share every renderer setting (shadows, GI, probes, Scale In Lightmap, lightmap parameters, layer, tag, static flags) | One mesh has one set |
| Share their dominant **reflection probe**, and the merged centre stays inside that probe's box | Probes are chosen from a mesh's bounds centre; merging two corridors moved the centre into a different probe zone and darkened both |
| Stay inside one area cell, and extend at most `--spread` past their largest piece | Keeps merges physically adjacent: culling, probes and light choice stay local |
| Fit the lightmap atlas budget, and stay under 200k vertices | One mesh must fit one lightmap; huge meshes cull badly |
| Are not reached by more runtime lights than BabylonJS applies per mesh (`maximumLights`, default 4), beyond what their most-lit piece already had | Merging must never cost a piece one of its lights |

**LOD groups** merge as **LOD clusters**: nearby groups with the same level count, transition heights, fade mode and per-level settings (typically instances of one prefab). Level *i* of every member becomes one merged mesh in a new LOD group with exactly one renderer per level (BabylonJS's fast native LOD path). New transition heights = old × (cluster size ÷ member size); a cluster is split when a member would sit more than 20% of its LOD0→LOD1 switch distance from the centre, or the rescaled LOD0 height would reach 0.95. **Lower LODs borrow LOD0's lightmap** (a LOD1/LOD2 renderer that receives lightmaps without contributing GI gets LOD0's region), so the engine applies each member's LOD0 packing to its lower levels — packing them independently turned merged rocks black at LOD1. Billboard / SpeedTree / skinned LODs, empty levels and renderers shared between levels are left alone.

---

# Pipeline

Read the Babylon Toolkit Agent Reference router and its `unity-exporter-cli.md`, `unity-editor-commands.md` and `unity-authoring-recipes.md` (§0 fidelity, §3 lights, §4 lightmaps, §5–6 probes, §9 post, §17 LOD, §19 static flags, §20 web budget, §21 verification) before the first run in a session — unless your prompt already carries those excerpts.

Set these once:

```bash
PROJ=<absolute Unity project path>          # folder holding Assets/
SKILL_DIR=<absolute path of this skill's folder>
SOURCE=Assets/.../Scene.unity               # from the arguments, or the active scene (bt_status → scene)
OUT=Assets/.../Scene_Optimized.unity        # --out, or <source folder>/<SceneName>_Optimized.unity
NAME=$(basename "$OUT" .unity); SRC_NAME=$(basename "$SOURCE" .unity)
REPORT="$PROJ/.agents/optimize/$NAME"; QA="$PROJ/.agents/optimize/.qa-tools"
MERGE='{"cellSize":15,"maxSpread":3,"maxAtlasShare":0.45,"includeShaderGraphs":true,"combineLods":true,"exclude":[],"only":[],"extraShaders":[]}'
TUNE='{"unskinRigid":true,"instanceRepeatsFrom":4,"bakeLights":true,"bakeShadowedLights":false,"keepLights":[],"pointSpotShadowsOff":true,"markStatic":true,"lightmapProbeLit":true,"fixZeroMotionBlur":true,"exclude":[]}'

bt_run() {  # bt_run <File: BtOptimize|BtCombine> <Method> '<json args array>'
  unity command run_script --file "AgentScripts/bt-optimize/$1.cs" --entry "$1.$2" --args "$3" \
    --timeout_ms 1800000 --timeout 1900 --project-path "$PROJ" --format json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['data']['result']; print(r.get('result') if r.get('success') else 'FAILED: '+json.dumps(r.get('diagnostics') or r.get('errorDetails') or r)[:4000])"
}
arg() { python3 -c "import json,sys; print(json.dumps([sys.argv[1]]))" "$1"; }   # wraps one JSON options string as a run_script args array
```

Map flags into `MERGE` / `TUNE` (`--no-tune:unskin` → `"unskinRigid":false`, `--instance-from:N` → `"instanceRepeatsFrom":N`, `--exclude:A,B*` → both `"exclude":["A","B*"]`, `--keep-lights:` → `keepLights`, `--no-shadergraphs` → `"includeShaderGraphs":false`, `--no-lods` → `"combineLods":false`, `--no-tune:lights` → `"bakeLights":false,"pointSpotShadowsOff":false`, `--no-tune:static` → `"markStatic":false`, `--no-tune:lightmaps` → `"lightmapProbeLit":false`, `--no-tune:post` → `"fixZeroMotionBlur":false`, `--bake-shadowed-lights` → `"bakeShadowedLights":true`).

## Phase 0 — Preflight

```bash
unity pipeline list                                   # Editor running, Pipeline reachable, not in Safe Mode
unity command editor_status --project-path "$PROJ"    # ready, not in Play mode (editor_stop if it is)
mkdir -p "$PROJ/AgentScripts/bt-optimize" && cp "$SKILL_DIR"/scripts/*.cs "$PROJ/AgentScripts/bt-optimize/"
mkdir -p "$QA" && cp "$SKILL_DIR"/scripts/qa/* "$QA/" && (cd "$QA" && npm install --silent)   # puppeteer-core, outside the Unity project
bt_run BtCombine Preflight "[\"$SOURCE\"]"
unity command bt_devserver_start --project-path "$PROJ"   # rerun after every domain reload — it stops the server
```

Stop and report if: no Editor is reachable (`unity-exporter-cli.md` §6), the source does not exist, **any open scene has unsaved changes** (ask the user to save or discard — never do it for them, never open another scene over it), or `packSourceLightmapUVs=False` (their `CanvasTools.dll` predates the packing combiner; merging would split vertices — tell them to update, or continue with `--no-combine`). `mergesMirrored=False` is not a stop: mirrored pieces just stay separate (say so).

## Phase 1 — Measure the current export

The exported source scene must be current: find `<exportRoot>/scenes/<source>.gltf` (`bt_status` → `exportRoot`; file names may be lower-cased). If it is missing or older than the source `.unity`, `unity command bt_export_level --scene "$SOURCE" --project-path "$PROJ" --timeout 3600` and record the duration.

```bash
mkdir -p "$PROJ/.agents/optimize/$SRC_NAME/profile"
node "$QA/profile-browser.mjs" --scene <source>.gltf --times 10,20,30,45,60,75,90 --window 4 \
  --out "$PROJ/.agents/optimize/$SRC_NAME/profile/before-timeline.json"
node "$QA/profile-browser.mjs" --scene <source>.gltf --pin 40,60,75 --toggles none --window 5 --settle 8 --cpuprofile true \
  --shots "$PROJ/.agents/optimize/$SRC_NAME/profile/shots" --out "$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json"
```

`--pin` waits the given seconds after the scene is ready, then detaches the camera from its rig and **records its exact pose** (position, rotation and lens — field of view and clip planes, because Timeline / Cinemachine tracks animate the lens too; the lens fields are made read-only while pinned, because a lens track keeps writing them and TAA builds its projection from them before any observer runs). Every later run replays those poses with `--poses before-pinned.json`, so before and after are measured from the same views — pinning by time alone lands on different views, because a lighter scene loads sooner and its tour runs ahead.

Read the JSON: `census` (engine, render size, meshes, materials, lights, shadow generators and their casters, post passes, prepass), `samples` (FPS, p95 / worst frame, draws, active meshes), and per pin `baseline.passes` / `baseline.byTarget` (draws per frame in shadow maps, `DepthRenderer`, main pass, post), **`drawOwners`** (main-pass draws by owning object — `mainDraws` must equal `baseline.passes.main` — with each owner's skinned / instanced / lightmapped meshes and shadow casters, plus `repeats`: every shape drawn more than once and what stops its copies sharing one draw), `lightAudit`, and `cpu.top`. **Pin inside the scene's own motion** (a flythrough, a spawn view after compile): the first seconds after load are still compiling shaders and are not comparable. To confirm a suspected cost, re-run with `--toggles shadows,lights,motionblur,taa,bloom,dpr` (each switched off alone and settled on `whenReadyAsync` — never compare a window that follows a toggle without that wait: thousands of materials recompile).

## Phase 2 — Survey and plan

```bash
unity command open_scene --path "$SOURCE" --project-path "$PROJ"     # only when no open scene is dirty
bt_run BtOptimize Survey '[]'                                        # .agents/optimize/<source>/survey.md + .json
bt_run BtOptimize Tune "$(arg "$(echo "$TUNE" | sed 's/}$/,"dryRun":true}/')")"   # tune-plan.md: every change, nothing changed
bt_run BtCombine Analyze "$(arg "$MERGE")"                            # combine-plan.md (on the source: merges before tune unlocks)
```

**Account for every draw before planning — ENFORCED.** From `before-pinned.json` → `pins[].drawOwners`, write the main-pass draws by owner at each pin into the plan (`node "$QA/compare-profiles.mjs"` prints it), then put each owner group of 5% or more beside its Unity cause and its fix: `survey.md` → *Skinned meshes* (every skinned renderer's verdict — rigid, frozen pose, deforms — with the evidence), *Repeated meshes* (copies, draws now, draws if instanced, what stops sharing), *Renderers*, *Lights*. A group with no fix gets a measured reason. Do not start Phase 3 with a large group unexplained.

Tell the user in a few lines: the measured frame (FPS, draws per pass, **the draw owners and the top repeated shapes**, the top costs), and the plan with numbers (rigid skinned meshes to convert, repeated props that will instance, lights to bake, props to mark static, renderers to lightmap, merges). `--analyze` stops here. Otherwise continue — do not wait for approval; the source is safe.

## Phase 3 — Working copy, tune, merge

```bash
bt_run BtCombine PrepareCopy "[\"$SOURCE\",\"$OUT\",<true if --reset else false>]"
bt_run BtOptimize Tune "$(arg "$TUNE")"          # skip with --combine-only
bt_run BtCombine Analyze "$(arg "$MERGE")"        # skip with --no-combine; plan after the unlocks
bt_run BtCombine Apply "$(arg "$MERGE")"          # skip with --no-combine
```

Read the Apply output: every group's `verts a -> b` must be equal. A `WARNING … re-unwrapped` on a few small groups means a lightmapped source had no usable lightmap UVs (no UV2 and UV0 outside 0..1) and was unwrapped on its own — report the count; many or large ones mean the toolkit build lacks packing — stop and report. If Apply refuses ("already combined"), continue from Phase 4 with the existing result or rerun with `--reset`.

## Phase 4 — Bake (skip only with --no-bake)

Light-mode changes, GI-flag changes and merged lightmap UVs all need one bake; a copied scene still points at the source's LightingData.

```bash
bake() {
  unity command bake_lighting --confirm true --project-path "$PROJ"
  deadline=$((SECONDS+5400)); seen=""
  while :; do
    s=$(unity command lighting_bake_status --project-path "$PROJ" --result-only 2>/dev/null)
    case "$s" in
      *completed*) break;;
      *failed*) echo "bake failed: $s"; return 1;;
      *baking*|*running*|*in_progress*) seen=1;;
      *idle*) [ -n "$seen" ] && { echo "bake stopped without completing"; return 1; };;
    esac
    [ $SECONDS -ge $deadline ] && { echo "bake timed out"; return 1; }
    sleep 15
  done
  unity command save_all --project-path "$PROJ"      # the bake assigns new LightingData; exports refuse a dirty scene
}
bake
bt_run BtCombine CorrectDensity '[]'                 # merged meshes get ~84-89% of their sources' texels; raise Scale In Lightmap
# corrected=N with N > 0 → bake once more
bt_run BtCombine Verify '[]'                         # must end with problems=0
```

## Phase 5 — Unity side-by-side (browser poses, then LOD0 **and** LOD1)

**First, the browser's pinned poses in Unity**, source and working copy. `PoseView` puts a capture camera named `BtOptimizePoseCamera` at a pose recorded by the profiler (position, rotation, vertical FOV; toolkit scenes keep Unity's coordinates), copying the main camera's URP data so post-processing matches. It never saves — reopening the scene removes it. Comparing these with the browser shots of the same poses tells you which side of the export a difference is on:

```bash
python3 -c "import json; [print(p['atSeconds'],*p['pinned']['position'],*p['pinned']['rotation'],p['pinned']['fov']) for p in json.load(open('$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json'))['pins']]" > /tmp/poses.txt
for scene in "$OUT" "$SOURCE"; do tag=$(basename "$scene" .unity)
  while read t px py pz qx qy qz qw fov; do
    bt_run BtOptimize PoseView "[\"$scene\",$px,$py,$pz,$qx,$qy,$qz,$qw,$fov]" >/dev/null
    unity command capture_game_view --camera BtOptimizePoseCamera --width 1280 --height 720 --project-path "$PROJ" --result-only --timeout 300 \
      | python3 -c "import json,sys,base64; d=json.load(sys.stdin); d=json.loads(d) if isinstance(d,str) else d; open(sys.argv[1],'wb').write(base64.b64decode(d['base64']))" "$CAPS/unity_${tag}_pose${t}.png"
  done < /tmp/poses.txt
done
unity command eval "UnityEditor.SceneManagement.EditorSceneManager.OpenScene(\"$OUT\"); return \"ok\";" --project-path "$PROJ"
```

Then the largest merges at LOD0 and forced LOD1:

Capture the spawn view, then the three largest merges at LOD0 and forced LOD1, in both scenes (GPU Resident Drawer must be off in batch Editors — `unity-editor-commands.md` §8.1):

```bash
CAPS="$REPORT/captures"; mkdir -p "$CAPS"
CAM=$(unity command eval 'return UnityEngine.Camera.main != null ? UnityEngine.Camera.main.name : "";' --project-path "$PROJ" --result-only | python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")
cap() { unity command capture_game_view --camera "$CAM" --width 1280 --height 720 --project-path "$PROJ" --result-only --timeout 300 \
  | python3 -c "import json,sys,base64; d=json.load(sys.stdin); d=json.loads(d) if isinstance(d,str) else d; open(sys.argv[1],'wb').write(base64.b64decode(d['base64']))" "$1"; }

cap "$CAPS/unity_spawn_optimized.png"
unity command open_scene --path "$SOURCE" --project-path "$PROJ"; cap "$CAPS/unity_spawn_source.png"
unity command open_scene --path "$OUT" --project-path "$PROJ"
bt_run BtCombine QaPoints '[3]' > "$CAPS/points.txt"      # name|x|y|z|size of the largest merges (LOD clusters first)
while IFS='|' read -r name x y z size; do
  [ -z "$name" ] && continue
  dist=$(python3 -c "print(max(4.0, float('$size') * 1.5))")
  for lod in 0 1; do
    for which in source optimized; do
      scene=$([ "$which" = source ] && echo "$SOURCE" || echo "$OUT")
      bt_run BtCombine QaView "[\"$scene\",$x,$y,$z,$dist,$lod]" >/dev/null && cap "$CAPS/unity_${name}_lod${lod}_${which}.png"
    done
  done
done < "$CAPS/points.txt"
unity command open_scene --path "$OUT" --project-path "$PROJ"     # QaView never saves; reopening discards the QA camera
```

Compare every pair: material, detail, baked shadows and brightness must match. **Expected** differences from baked practical lights: no specular glints from those lights, slightly different soft shadows — say so; anything darker, black or blotchy only at LOD1 is a lower-LOD lightmap problem; wrong at LOD0 is a probe or lightmap problem → exclude that merge (Phase 7 loop).

## Phase 6 — Export, measure again, compare

Only with `--textures:ktx2` / `--resolution:css` (project-wide; previous values go to `.agents/optimize/exporter-settings-undo.txt`):

```bash
unity command run_script --file AgentScripts/bt-optimize/BtOptimize.cs --entry BtOptimize.ExporterSettings --args '["ktx2","keep"]' --project-path "$PROJ" --format json
```

Recommend `--resolution:css` only when the profile is GPU-bound (FPS rises with `--toggles dpr`); on a CPU-bound scene it costs sharpness and buys nothing.

```bash
unity command bt_export_level --scene "$OUT" --project-path "$PROJ" --timeout 3600     # record the duration
unity command bt_devserver_start --project-path "$PROJ"
node "$QA/gltf-stats.mjs" <source.gltf> <optimized.gltf>
node "$QA/profile-browser.mjs" --scene <optimized>.gltf --times 10,20,30,45,60,75,90 --window 4 --out "$REPORT/profile/after-timeline.json"
node "$QA/profile-browser.mjs" --scene <optimized>.gltf --poses "$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json" --toggles none --window 5 --settle 8 --cpuprofile true \
  --shots "$REPORT/profile/shots" --out "$REPORT/profile/after-pinned.json"
node "$QA/compare-profiles.mjs" --label Original,Optimized "$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json" "$REPORT/profile/after-pinned.json"
node "$QA/compare-profiles.mjs" --label Original,Optimized "$PROJ/.agents/optimize/$SRC_NAME/profile/before-timeline.json" "$REPORT/profile/after-timeline.json"
node "$QA/compare-browser.mjs" --scenes <source>.gltf,<optimized>.gltf --times 20,25,30,40,50,60 --out "$REPORT/captures"
```

`compare-profiles` prints the report tables. **Before trusting a pinned comparison, look at the paired `--shots` images: the same pose must show the same view** (a lens or camera the pin did not hold shows up there first). The pinned views are the same poses in both runs; compare FPS, p50 / p95 frame time, draws per pass and the CPU top list. In `compare-browser`'s `sheet.png`, pair frames by **view, not timestamp** — a lighter scene finishes loading sooner and its flythrough runs ahead (5–10 s on the garden). Both scenes must be free of console errors.

## Phase 7 — Regression loop (at most 3 rounds)

**Find the side first.** Unity original vs Unity working copy at the same pose: different → the scene changes (tune or merge) did it; same → the export / runtime did it (compare the census and console).

**Then bisect, never guess.** Two plausible stories about Garden's dark tea room were both wrong; one bake per variant found the truth in about 30 minutes:
1. Control copies: `PrepareCopy` to `<Scene>_TuneOnly.unity` (reset each time), run `Tune` with steps switched off (`{"bakeLights":false,"pointSpotShadowsOff":false}` = static/lightmap steps only; `{"markStatic":false,"lightmapProbeLit":false}` = light steps only; then single steps), bake once, `PoseView` + capture the bad pose.
2. The step that reproduces it → diff renderer state near the spot between source and copy (static flags, Contribute GI, receive GI, shadow casting) to name the object, fix the **rule** in `BtOptimize.cs`, `RemoveCopy` the control, rerun with `--reset`.
3. Unity-side runtime experiments (disabling lights in the Editor) are unreliable when the scene has `[ExecuteAlways]` scripts — Garden's `DynamicLightController` re-enabled every light each frame. Change only what such scripts do not touch, or bake a control copy.

If a region looks different (darker, flatter, wrong reflections, LOD popping) or a pinned view got slower:
1. Identify the cause: a merge (`combine-manifest.json` → `combinedPaths`, `sources`, probes), a baked light (`tune.md`), a lightmap switch.
2. Exclude it (`--exclude` / `--keep-lights`), say why in one line, rerun from Phase 3 with `--reset`.
3. Still different without it → compare against a re-baked **untouched** copy (`PrepareCopy` to `<Scene>_Control.unity`, bake, export, capture; then `RemoveCopy`). A difference the control also shows is the re-bake (often a stale source bake), not this skill.

## Phase 8 — Report

Reply in plain language with images, and write `$REPORT/report.md`:

- **Result:** FPS and frame time (p50 / p95 / worst) before → after at each pinned view and over the timeline; draws per frame by pass; meshes, primitives, materials, vertices and export size (`gltf-stats`); export time.
- **What changed and why:** lights baked (count, which), shadows removed, props marked static, renderers lightmapped, post fixes, merges (static groups, LOD clusters, the biggest by name).
- **Draws by owner, before → after, at each pin** (`compare-profiles` prints it): every group of 5% or more of the main-pass draws, with what changed it or the measured reason it could not change. The repeated shapes that still cost one draw per copy, and why.
- **What stayed and why:** top kept reasons with counts, and what the user could change (UV2 on props, scripts that point at objects, vegetation by design, skinned meshes to convert by hand, repeated deforming crowds for the VAT mode).
- **Toolkit findings:** costs the scene cannot fix (for example a `DepthRenderer` pass owned by soft particles or a Scene Depth node), with the runtime fix to ask for.
- **Checks:** Verify result, Unity captures, browser frames, console errors; anything skipped or unverified, stated as such.
- **How to undo:** `--reset`, or delete the working copy, `<Out>_CombinedMeshes/`, `<Out>/` (baked lighting) and `.agents/optimize/<Out>/`; re-tick any Volume Profile override listed in `tune.md`.

---

# Files this skill writes

| Path | What |
|---|---|
| `<out scene>` | the working copy (tuned and merged) |
| `<out scene folder>/<Out>_CombinedMeshes/*.asset` | merged meshes |
| `<out scene folder>/<Out>_UnskinnedMeshes/*.asset` | plain meshes baked from rigid skinned meshes whose bind pose was offset and whose object could not be moved (usually empty) |
| `<out scene folder>/<Out>/` | the copy's baked lighting |
| `.agents/optimize/<Source>/` | survey, tune plan, merge plan and "before" profiles of the source |
| `.agents/optimize/<Out>/` | `working-copy.txt`, `tune.md/json`, `combine-plan.*`, `combine-manifest.json`, `combine-verify.md`, `profile/`, `captures/`, `report.md` |
| `AgentScripts/bt-optimize/*.cs`, `.agents/optimize/.qa-tools/` | the engines and QA tools (outside `Assets/`, no recompiles) |

# Troubleshooting

| Symptom | Fix |
|---|---|
| `FAILED: … Compilation Failed` from `bt_run` | Read the diagnostics; the toolkit DLL may be older than this skill (`UnityMeshSimplifier.MeshCombiner`, `UnityTools.GetMaxSimultaneousLights`, `EditorScriptComponent` must exist) |
| Apply: "no Pack Source Lightmap UVs mode" | Update the Babylon Toolkit (`CanvasTools.dll`), or `--no-combine`; never accept bloat silently |
| Apply: "already combined" | `--reset`, or continue from Phase 4 |
| Bake never completes | `console --level error`; the GPU lightmapper may fall back to CPU — raise the deadline |
| Export refuses: unsaved changes | `unity command save_all` after the bake |
| Browser: connection refused | The dev server stops on every domain reload — `bt_devserver_start` again |
| Profile numbers jump between windows | The view was still compiling (pin later) or a toggle was measured before `whenReadyAsync` settled |
| Faster, but a merged area is darker in the browser only | Probe or light choice: lower `--spread` / `--cell`, or `--exclude` that container; then the control test |
