---
name: bt-optimize
description: "The Babylon Toolkit Optimize Skill makes an exported Unity scene run fast as BabylonJS web content. It measures the exported scene in the browser first (frame rate, draw calls per pass — shadow maps, depth / velocity buffers, main pass, post — CPU hot spots, light binding), accounts for every draw by the object that owns it, surveys the Unity scene for the causes, then fixes them on a copy of the scene — the one scene to export afterwards: skinned meshes that need no skinning (one-bone DAE / FBX imports — coins, item boxes, trees, signs) turned into plain meshes so repeated props share one instanced draw, repeated props kept off lightmaps and light probes so they instance, static objects that animate made non-static, repeated deforming characters turned into an instanced vertex-animation (VAT) crowd, runtime practical lights baked, realtime point / spot shadows removed, shadow casters whose shadow lands on nothing visible pruned, non-moving props marked static, probe-lit props with lightmap UVs lightmapped, no-op post effects removed, and static meshes and LOD groups merged with the Babylon Toolkit MeshCombiner when that saves draws (packed source lightmap UVs, mirrored pieces, LOD clusters with corrected switch distances). It re-bakes, verifies the copy against its source, exports, and proves the result — frame rate and draw calls before → after at the same pinned views, and the same look in Unity, in the browser and in the game. Every decision is written down with its reason. Its `planning.md` is the playbook bt-spec and bt-plan follow to spec or plan the same work (\"create a quick plan to optimize Level01.unity\"). Use when the user wants a Unity scene to run faster or lighter in the browser, or wants static meshes / LOD groups combined (e.g. `/bt-optimize Assets/Scenes/Level01.unity`, `/bt-optimize --combine-only`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com)
---

You are an EXPERT Babylon Toolkit, BabylonJS and Unity technical artist and web-performance engineer. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md).

Use the user's message after the skill name as the `arguments`.

**Spec or plan instead of a direct run?** When the user asks to spec, plan or Quick Plan an optimization ("create a
quick plan to optimize `Level01.unity`"), bt-spec / bt-plan run and read this skill's [`planning.md`](planning.md): the
standard decisions (O1–O11) and task list built on the phases below. bt-execute's builders then run this skill's
scripts task by task. The work and its proof are the same either way.

---

# Invocation

```
/bt-optimize [<scene asset path>] [--out:<asset path>] [--analyze] [--reset]
             [--no-combine | --combine-only] [--no-tune:unskin,unfreeze,lights,static,lightmaps,post,vat] [--instance-from:4] [--vat-from:4] [--keep-gi]
             [--no-prune-casters]
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
- **`--no-tune:`** — skip individual tune steps: `unskin` (rigid skinned meshes → plain meshes), `unfreeze` (clear static flags on objects that animate), `lights` (bake practical lights / drop point-spot shadows), `static` (mark non-moving props static), `lightmaps` (probe-lit → lightmapped), `post` (no-op post effects), `vat` (deforming crowds → VAT).
- **`--instance-from:`** — a mesh drawn this many times or more (same mesh and materials) is never lightmapped, and its copies get Light Probes Off so they share one instanced draw instead of each getting its own mesh (default `4`; `2` = instance wherever possible; `0` turns it off).
- **`--vat-from:`** — a really deforming character with this many copies or more becomes an instanced vertex-animation crowd (default `4`; `0` turns it off).
- **`--no-prune-casters`** — skip Phase 3's shadow-caster prune.
- **`--keep-gi`** — keep Contribute GI exactly as the source has it: no tune step adds it to an object that did not contribute GI in the source, so the re-bake keeps the source's indirect light (default off: merging needs the newly lightmapped props).
- **`--keep-lights:`** — light names (or prefixes ending in `*`) that stay realtime / Mixed.
- **`--bake-shadowed-lights`** — also bake point / spot lights that cast realtime shadows (default: they stay realtime with their shadows turned off).
- **`--exclude:`** — object names (or prefixes) whose subtrees are never tuned or merged. **`--only:`** limits merging to these hierarchy paths.
- **Merge controls:** `--cell:` area patch in meters (15), `--spread:` meters a merge may extend past its largest piece (3), `--atlas-share:` largest share of one lightmap atlas per merged mesh (0.45), `--no-shadergraphs` (do not merge Shader Graph materials even when they pass the scan), `--no-lods` (leave LOD groups alone), `--shaders:` extra custom shaders known to be pivot-independent.
- **Project-wide exporter settings (opt in — they change every scene's export):** `--textures:ktx2` (KTX2 / UASTC textures: ~4–8× less GPU memory, slower export), `--resolution:css` (render at CSS pixels instead of device pixels on desktop: ¼ of the pixels on a 2× screen — only helps a GPU-bound scene).
- **`--no-bake` / `--no-export` / `--no-browser`** — skip those phases; the report says what stayed unverified.
- **`--pins:`** — seconds after the scene is ready at which the profiler pins the camera (default `40,60`; pick moments inside the scene's own flythrough / spawn view). Each pin also **holds the scene's Timeline** at the director time it reached (the profiler's `--hold`, Phase 1), so the sun, the active light and the shot stay put while it is measured. **`--times:`** — timeline sample moments.

---

# What this skill guarantees

1. **Measure before and after, at the same views.** No change is justified by a guess: the browser profile of the current export names the costs, and the same profile of the optimized export proves the gain.
2. **The source scene — and any scene the user has open — is untouched.** All scene work happens in the working copy, which only `PrepareCopy` can create (it writes `.agents/optimize/<Out>/working-copy.txt`; Tune, Apply and RemoveCopy refuse any scene without it). Nothing switches scenes while an open scene has unsaved changes. The only project-wide edits are (a) deactivating a **zero-intensity** motion blur override in a Volume Profile (no change in Unity; recorded for undo) and (b) exporter settings the user opted into with `--textures` / `--resolution`.
3. **Every decision has a written reason.** `.agents/optimize/<Out>/` holds the survey, the tune plan and log, the merge plan and manifest, verify results, profiles, captures and the report.
4. **It looks the same.** Re-baked, then compared in Unity (LOD0 and LOD1) and in the browser at matching views. Expected, stated differences: baked practical lights lose their specular highlights and their realtime shadows on moving objects (they never had flicker or distance culling in the browser — those were Unity-only scripts).
5. **No vertex bloat.** Merges use the toolkit's `UnityMeshSimplifier.MeshCombiner` in *Pack Source Lightmap UVs* mode — each source keeps its own lightmap UVs, packed at its original texel density.
6. **Every draw is accounted for — ENFORCED.** Per-pass totals say *where* the frame goes; they never say *what* to fix. At every pinned view the profiler's `drawOwners` splits the main-pass draws by the scene object that owns them and lists every shape drawn more than once with why its copies do not share one draw. The plan and the report carry that table. **Every owner group of 5% or more of the main-pass draws is either fixed or has a written, measured reason it cannot be** — "it has an Animator", "it is skinned" or "a rule kept it" is not a reason on its own (see 7). The skill is not done while a large group is unexamined: a run that cut shadow draws but left 129 of 202 main-pass draws to copies of 8 props, all one-bone skinned meshes nobody looked at, was a failed optimization.
7. **An Animator or a SkinnedMeshRenderer is evidence to check, never a reason to skip.** Look at what the clip actually animates (`survey.md` → Skinned meshes): a spawn pop that scales the object, a spin, a collider toggle all work on a plain mesh. Only real deformation (animated bones, blend shapes, cloth) needs skinning — and repeated deforming characters still instance as a VAT crowd. Repeated props are the largest draw group in most levels after the level geometry — always check them.
8. **One scene to export, named.** The working copy is the result. The report and the final message open with **Export this scene**: its path, its export file name, the source kept as the untouched baseline, and the folders beside the copy that belong to it (never delete them while it is in use). Nobody should have to ask which of the scenes is the optimized one.
9. **Verified against its source before export.** `BtOptimize.Verify` (and `BtCombine.Verify` after a merge) ends with problems=0: scene saved, no capture camera left, every camera enabled as in the source, lighting settings as in the source, no rigid skinned mesh left, no repeat lightmapped or probe-lit, no static object that moves, crowds and pruned casters set as recorded.
10. **Everything is re-runnable.** A step the engine cannot do goes in one project script with entry points run after Tune — never a hand edit of the working copy, which `--reset` would lose. The report's **Redo after `--reset`** lists the whole sequence.

# Talk to the user while you work

Long runs lose people. At every phase change post one short plain-language update: **Done** (what changed, with numbers) · **Doing now** · **Next**. Say plainly which work is done by their own toolkit (MeshCombiner, exporter, bake). If you change the plan (exclude a group, keep a light, reset, re-bake), say why in one line.

---

# How a BabylonJS frame spends its time — what to look for

Learned on measured levels — a 2,400-renderer URP scene that ran 8–26 FPS (1–5 FPS in hitches) after export, and a racing level built from DAE imports:

- **Draw calls are the currency.** WebGPU / WebGL in the browser is CPU-bound long before it is GPU-bound: each draw costs JavaScript time (`bindForSubMesh`, `_draw`, render-pipeline lookup, uniform writes). Halving render resolution changed nothing; halving draws nearly doubled the frame rate. Every extra **pass** multiplies the draws of everything it renders.
- **Realtime shadows on point / spot lights are full scene passes.** Each shadowed spot light re-draws every caster in its frustum every frame (a point light: six times). The toolkit adds every shadow-casting mesh to every shadow-generating light. Six 5 m lantern spot lights = ~690 draws per frame — half the frame.
- **Runtime lights that the browser never animates are pure cost.** Unity sample scenes drive lights with MonoBehaviours (`LightFlicker`, `DynamicLightController` distance culling). Without a toolkit TypeScript port those scripts **do not run in the browser**: the lights neither flicker nor cull — they just cost. Baked, their light lives in the lightmaps (static objects) and light probes (moving objects) at zero runtime cost.
- **A depth pass appears when anything samples scene depth**: soft particles (`TOOLKIT.ShurikenParticles.SoftParticleDepth`, on by default) and Shader Graph Scene Depth nodes (`ShaderGraphPass.SceneDepth`) create a `DepthRenderer` that re-draws every visible opaque mesh each frame (20–25% of draws in one measured scene). Report it; merging reduces it; the runtime fix (take depth from the prepass renderer) belongs to the toolkit.
- **Zero-intensity post effects may still run.** URP's pipeline-default Volume Profile ships Motion Blur at intensity 0 (off in Unity); older toolkit runtimes still built a motion-blur pass for it.
- **Light binding is NOT range-aware.** BabylonJS's `Light.canAffectMesh` checks only include / exclude lists and layer masks, so every mesh binds up to its cap of runtime lights wherever they are (measured: 5 × 5 m props bound 8 lights, 7 of them out of range). Tighter mesh bounds never lower the bindings — only baking the lights does. The profiler's `lightAudit` clamps each light into the mesh's box, so scene-sized bounds (skinned or track-wide meshes) hide the waste: a low out-of-range share on such a scene is understated.
- **Skinned meshes never instance.** Copies of a skinned mesh that animate separately each cost their own draw in every pass, and are skinned every frame. DAE and FBX imports routinely make rigid props one-bone skinned meshes: on one measured level, 118 of 135 skinned renderers (coins, item-box parts, trees, track pieces) had one bone moving with the object and 129 of 202 main-pass draws came from 8 such repeated shapes. As plain meshes the exporter writes the copies as glTF instances (`ExportMeshInstances`, default on) — one draw per shape. Copies of a character that really deforms (a waving crowd) instance too once they are a VAT crowd: 13 skinned draws became one per material in view, and off-screen they cull.
- **Static means frozen.** The exporter freezes a static object's world matrix. A spinning item box or an animated bone that came from the source marked static stands still in the browser — Tune clears the flags (`unfreezeAnimated`).
- **Lightmapping a repeated prop costs its instancing — and so does light-probe lighting.** A lightmapped renderer never shares a cached mesh (each copy gets its own lightmap UVs), and the toolkit also loads every light-probe-lit node as its own mesh (`SceneManager.DeinstanceProbeLitNodes`, default on): copies instance only with Light Probes **Off**. Measured: trees, item boxes and coins went from 14 / 18 / 6 draws to 3 / 3 / 1 once their probes were off. Repeated props get neither (`instanceRepeatsFrom`); unique geometry gets the lightmaps.
- **Materials are cloned per renderer** for each reflection probe / lightmap combination and per LOD cross-fade level. Fewer renderers → fewer clones → fewer first-view shader compiles (hitches).
- **Lightmapped renderers never share a cached mesh** (reference §4): repeated lightmapped props are one draw each — merging is the only way to cut them. Probe-lit repeated props stay glTF instances.
- **Once repeats instance, the shadow maps are often the biggest pass.** A directional light with cascades draws each caster again in every cascade it touches (4 cascades → up to 4 draws per caster). Roads, ground, markings, water and grass planes and far backdrops cast shadows that land on nothing the camera sees: pruning 13 of them cut 46 shadow draws a frame on one level. An overhanging lip or a deck above other geometry does cast a visible shadow — every prune is proven by capture. Cascade count and shadow distance live on the project's pipeline asset, so they change every scene: propose them, never change them unasked.
- **Merging only pays when draws are scattered.** A level imported as one renderer per material has nothing to merge: one merge plan saved 0 draws and cost a cascade draw. Read `combine-plan.md`'s draws saved before merging, and use `--no-combine` when it is ~0.
- **Every camera with post-processing builds its own post chain.** Two enabled cameras with post doubled one level's post passes and cost 17% at a pinned view. The survey counts them; turn post off on a camera the player does not see.
- **Judge the look in the game, through its camera.** The export viewer's default camera renders without the scene's post-processing; a capture step that disabled the scene's main camera and was saved once shipped a level with no post at all. PoseView now never touches the scene's cameras, Verify compares every camera's state with the source, and the final check drives the game itself.

# The tune rules — and why each exists

Enforced by `scripts/BtOptimize.cs` (`Tune`). A **browser driver** is anything that can move, toggle or animate an object *in the browser*: a toolkit script component (`EditorScriptComponent` subclass), Animator / Animation, a Timeline binding, Rigidbody / CharacterController / NavMeshAgent, a constraint, or a toolkit script component that points at the object — on the object or an ancestor. Unity-only MonoBehaviours are not browser drivers (they are reported as "Unity-only").

| Step | Rule | Why |
|---|---|---|
| Unskin rigid meshes | A SkinnedMeshRenderer with **one weighted bone** that moves with the object (no clip, Timeline, script, constraint or physics body moves the bone apart from the object), no blend shapes, no cloth, and no curve or reference aimed at the SkinnedMeshRenderer component becomes a MeshFilter + MeshRenderer on the same mesh and materials. Animators stay. When the bind pose offsets the mesh, a plain leaf object is moved onto it (the mesh stays shared — verified vertex by vertex); otherwise the offset is baked into one mesh asset shared by every copy with the same offset (`<Out>_UnskinnedMeshes/`). Three more rigid cases convert too: a **script host** (the only separate motion is a toolkit script on the renderer's own object) is baked as it is drawn now; a **renderer curve** (a clip animates the SkinnedMeshRenderer itself) converts as above, and each Animator playing it gets a copied controller whose copied clips aim those curves at MeshRenderer, same path and property (`<Out>_RetargetedClips/`); a **frozen pose** (several weighted bones, none moved apart from the object) is baked once, copies whose baked vertices match (4 decimals) sharing one mesh asset so they still instance. The swap keeps materials, shadow casting and receiving, occlusion, both probe usages, the probe anchor, motion vectors and rendering layers. Runs first, so the later steps see the new renderers | Babylon skins a skinned mesh every frame and can never instance its copies. A one-bone import of a rigid prop bought nothing — on one level, coins, item boxes and trees were 112 draws at one view that became instances; its grass (a script host), guardrail arrows (a renderer curve) and flag ropes (frozen poses) had to be converted by hand before Tune learned them |
| Unfreeze what moves | Any object with static flags that a clip or Timeline moves (on it or an ancestor), or a Rigidbody, CharacterController or NavMeshAgent moves, loses every static flag; its renderer goes Receive GI Light Probes (`Static cleared (moves in the browser)` in `tune.md`). Narrower than a browser driver on purpose: an Animator on a level root that only animates one light does not unfreeze the level | The exporter freezes static world matrices: spinning item boxes and animated bones that arrived marked static stood still, and a lightmap baked in one place is wrong once the object moves |
| Repeated props instance | A mesh + materials drawn `instanceRepeatsFrom` (4) times or more is not lightmapped when marked static (still Contribute GI for bounce) and is skipped by the lightmap step. Last of the renderer steps, every copy that is still unlightmapped gets **Light Probe Usage Off** and Receive GI Light Probes (`Light probes off (instancing)` in `tune.md`); Reflection Probe Usage and Contribute GI stay. **Look trade-off:** the copies light from the scene's ambient instead of the nearest light probe — Phase 5's captures are the proof; `--exclude` a group whose probe lighting matters | The exporter gives every lightmapped copy its own mesh, and the toolkit gives every probe-lit node its own mesh (`SceneManager.DeinstanceProbeLitNodes`): only copies with probes off share one instanced draw |
| Keep the source's GI (`--keep-gi`) | Tune reads the source scene named in `working-copy.txt` (opened additively, closed unsaved) and collects the renderers with Contribute GI. Mark static then marks an object outside that set static without Contribute GI, the lightmap step leaves it probe-lit (`keep-gi: not a GI contributor in the source` in Left alone), and an unskinned object that carried the flag loses it. `tune.md` always shows `GI contributors: source N → copy N` | Every new contributor is an occluder in the re-bake: unskinned props pulled 62 objects into one level's bake and a light probe at its start fell 0.79 → 0.66. Off by default, because merging needs the newly lightmapped props |
| Lights → Baked | Active Realtime / Mixed **point and spot** lights with no browser driver and **no realtime shadows** become Baked. Directional lights (the sun) and `--keep-lights` stay | Practical fill lights cost per-pixel lighting every frame; baked, they cost nothing and still light moving objects through probes |
| Shadowed key lights stay runtime, shadows off | A point / spot light that casts realtime shadows (or that a browser driver animates) stays Realtime / Mixed and loses only its realtime shadows. `--bake-shadowed-lights` bakes them too | Each shadowed light re-draws the scene every frame (×6 for a point light) — the shadows are the cost, not the light. Keeping the light realtime keeps its exact look (direct light, specular highlights, light on moving objects) with no bake risk; in one measured scene, six such lights cost little once their shadow maps were gone. Use `--bake-shadowed-lights` when a scene has many of them and Phase 5 verifies the bake |
| Fixture shells stop casting shadows | When a light is baked, the shadow-casting renderers of its own fixture prefab whose bounds hold the light get Cast Shadows Off | A lantern shell around the bulb is clipped by the realtime shadow map's near plane, but the lightmapper traces from the bulb: a shadow-casting shell traps a baked light (lit floor under each lantern, dark walls) |
| Mark static | A non-static MeshRenderer with no browser driver, not pointed at by any script, not part of a particle system, and **a visible surface** (every material's shader has a lightmapper Meta pass) becomes static (Batching, Occluder, Occludee, Reflection Probe; **Contribute GI** only with lightmap UVs, no vertex animation and opaque) | The exporter freezes static world matrices, and static objects can be lightmapped and merged. The Meta-pass check exists because an invisible stencil mesh (`Custom/StencilOnly`) wrapping a room, once marked Contribute GI, became a solid box in the bake and the room went dark |
| Probe-lit → lightmapped | A static LOD0 / non-LOD visible surface that is probe-lit although it has UV2, no vertex animation and is opaque gets Contribute GI + Receive GI Lightmaps; its lower LOD levels with UV2 receive lightmaps (they borrow LOD0's region) | Lightmapped meshes can merge; a merged probe-lit mesh would get one probe sample for its whole area |
| VAT crowds | Animators whose skinned renderers draw the same meshes, `vatCrowdsFrom` (4) copies or more, that really deform: each gets the toolkit's `AnimatorControlRig` in `UseVertexAnimations` mode over its renderers; their materials are copied onto `Babylon/Custom/Vertex Animation Shader` (`<Out>_VatCrowd/<material>_VAT.mat`, one per source material, shared); each renderer gets world scale 1 and Light Probes Off. Each copy keeps its Animator, controller and clips. Skipped and reported: blend shapes, cloth, transparent materials, a renderer that is also a bone or parent, a renderer under a non-uniform scale, a material with no base colour texture property | Skinned copies never instance. The exporter bakes each controller's clips to vertex animation textures and the browser draws the copies as instances, one draw per material in view, each in its own Animator state. World scale 1 because the baker writes world-size positions and the browser applies the renderer node's scale again (a 0.386-scaled crowd drew at 0.386 of its size); a skinned mesh draws from its bones, so Unity looks the same. The Editor draws the VAT shader magenta under URP / HDRP: judge crowds in the browser |
| No-op post | Motion blur overrides with intensity 0 in the profiles the scene uses are deactivated | Off in Unity, but older toolkit runtimes still built the pass |

Kept as they are, by design: wind / vertex-animated vegetation (probe-lit by intent, and unmergeable), props without lightmap UVs (probe-lit), anything a script points at, stencil / depth / VFX utility meshes (no Meta pass), inactive objects.

Reported, never converted automatically — each with its next step in `survey.md` and `tune.md`:
- **Rigid, convert by hand:** a bone that a clip, Timeline, constraint or physics body moves apart from its object (parent a plain mesh under the bone), a component that references the SkinnedMeshRenderer, a clip Tune cannot retarget (a legacy Animation, an override controller) that animates the SkinnedMeshRenderer.
- **Deforming, not a crowd:** blend shapes, cloth, and a deforming character with fewer copies than `--vat-from`.
- **A crowd Tune could not convert** (the reasons in the VAT row): set up the `AnimatorControlRig` VAT mode by hand (`unity-authoring-recipes.md` §13), in the project script. A multi-colour crowd costs one draw per colour material; one draw for all needs the runtime per-skin texture array (`shader-materials.md`, web-game code) — report it as a follow-up.

# Shadow casters — pruned per object, proven by capture

Run in Phase 3 (skip with `--no-prune-casters`). `BtOptimize.PruneShadowCasters '{"paths":[…]}'` sets Cast Shadows Off on exactly the renderers listed (names, `Prefix*`, or hierarchy paths; Receive Shadows unchanged) and gives every renderer an earlier run pruned that the list no longer names its original mode back — the list is the whole truth, so edit it and re-run. `pruned-casters.json` records it; `Verify` checks it.

1. **Candidates:** `survey.md` → *Shadow casters — flat surfaces to prune* (unique casters whose surface is ≥ 90% horizontal — ground, roads, markings, water, grass planes, undersides), plus the browser's per-cascade dump (`before-pinned.json` → `pins[].shadowCasters`: every caster's draws per cascade) for far backdrops and anything else whose shadow falls outside the view. Write each with its draws and a keep / prune verdict and reason into `$REPORT/shadow-casters.md`.
2. **Keep** anything above other geometry: bridge decks, jumps, overhanging lips, roofs, props, buildings, trees, rails.
3. **Prove it:** after the bake, Phase 5's captures at every pinned pose must show every shadow the source shows. An entry whose removal shows (a lip loses its self-shadow) comes off the list; re-run the prune and re-bake. Cast Shadows also drives the lightmapper's occlusion, so the prune always comes before the bake.

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
TUNE='{"unskinRigid":true,"unfreezeAnimated":true,"instanceRepeatsFrom":4,"vatCrowdsFrom":4,"keepSourceGI":false,"bakeLights":true,"bakeShadowedLights":false,"keepLights":[],"pointSpotShadowsOff":true,"markStatic":true,"lightmapProbeLit":true,"fixZeroMotionBlur":true,"exclude":[]}'
WAIT=https://raw.githubusercontent.com/babylontoolkit/agent/main/references/scripts/wait.mjs   # the installed copy; run in place

bt_run() {  # bt_run <File: BtOptimize|BtCombine> <Method> '<json args array>'
  unity command run_script --file "AgentScripts/bt-optimize/$1.cs" --entry "$1.$2" --args "$3" \
    --timeout_ms 1800000 --timeout 1900 --project-path "$PROJ" --format json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['data']['result']; print(r.get('result') if r.get('success') else 'FAILED: '+json.dumps(r.get('diagnostics') or r.get('errorDetails') or r)[:4000])"
}
arg() { python3 -c "import json,sys; print(json.dumps([sys.argv[1]]))" "$1"; }   # wraps one JSON options string as a run_script args array
```

Map flags into `MERGE` / `TUNE` (`--no-tune:unskin` → `"unskinRigid":false`, `--no-tune:unfreeze` → `"unfreezeAnimated":false`, `--no-tune:vat` → `"vatCrowdsFrom":0`, `--vat-from:N` → `"vatCrowdsFrom":N`, `--instance-from:N` → `"instanceRepeatsFrom":N`, `--keep-gi` → `"keepSourceGI":true`, `--exclude:A,B*` → both `"exclude":["A","B*"]`, `--keep-lights:` → `keepLights`, `--no-shadergraphs` → `"includeShaderGraphs":false`, `--no-lods` → `"combineLods":false`, `--no-tune:lights` → `"bakeLights":false,"pointSpotShadowsOff":false`, `--no-tune:static` → `"markStatic":false`, `--no-tune:lightmaps` → `"lightmapProbeLit":false`, `--no-tune:post` → `"fixZeroMotionBlur":false`, `--bake-shadowed-lights` → `"bakeShadowedLights":true`).

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
node "$QA/profile-browser.mjs" --scene <source>.gltf --pin 40,60,75 --hold true --toggles none --window 5 --settle 8 --cpuprofile true --casters true \
  --shots "$PROJ/.agents/optimize/$SRC_NAME/profile/shots" --out "$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json"
```

**Hold the Timeline at every pin — `--hold`.** A pinned camera holds the *view*, but a scene with a Timeline keeps playing around it: the sun turns, a second sun switches on, shots cut and fade, and each of those changes the shadow maps, the light count and the draws. `--hold true` pauses the scene's `PlayableDirector` where it is when the pin lands, sets its time and evaluates every track there, re-applies the hold after the settle, and records it as the pin's `heldTimeline` (seconds; `null` when the scene has no director — the run still measures). `--hold 40:24,60:44,75:52` holds each named pin at a fixed director time instead (pin seconds : director seconds) — use it to measure two exports at the same moment of the Timeline. After the measure window the director is read again: a pin whose Timeline moved more than 0.05 s **fails** (`holdCheck.error`, `FAILED pin …` on stderr, exit 1), because its numbers mix two moments. With `--poses`, a pose file's own `heldTimeline` (the output of a held run) holds any pin `--hold` does not name, so replaying `before-pinned.json` measures the same views at the same Timeline moments; `--hold false` turns all holding off.

When an earlier run (or a plan's `tests/poses-pinned.json`) already pinned this scene, replay those poses with `--poses <file>` instead of `--pin`, so every run of the scene is measured from the same views.

`--pin` waits the given seconds after the scene is ready, then detaches the camera from its rig and **records its exact pose** (position, rotation and lens — field of view and clip planes, because Timeline / Cinemachine tracks animate the lens too; the lens fields are made read-only while pinned, because a lens track keeps writing them and TAA builds its projection from them before any observer runs). Every later run replays those poses with `--poses before-pinned.json`, so before and after are measured from the same views — pinning by time alone lands on different views, because a lighter scene loads sooner and its tour runs ahead.

Read the JSON: `census` (engine, render size, meshes, materials, lights, shadow generators and their casters, post passes, prepass), `samples` (FPS, p95 / worst frame, draws, active meshes), and per pin `baseline.passes` / `baseline.byTarget` (draws per frame in shadow maps, `DepthRenderer`, main pass, post), **`drawOwners`** (main-pass draws by owning object, measured per render call in one recorded frame — `mainDraws` equals that frame's main-phase counter `frameMainDraws` by construction and should match `baseline.passes.main`; draws no object owns appear as an `(unowned)` owner whose `sources` name the class that drew them — with each owner's skinned / instanced / lightmapped meshes and shadow casters, plus `repeats`: every shape drawn more than once and what stops its copies sharing one draw), **`shadowCasters`** (`--casters true`: every shadow generator's casters with their draws per cascade), `lightAudit`, and `cpu.top`. **Pin inside the scene's own motion** (a flythrough, a spawn view after compile): the first seconds after load are still compiling shaders and are not comparable. To confirm a suspected cost, re-run with `--toggles shadows,lights,motionblur,taa,bloom,dpr` (each switched off alone and settled on `whenReadyAsync` — never compare a window that follows a toggle without that wait: thousands of materials recompile).

## Phase 2 — Survey and plan

```bash
unity command open_scene --path "$SOURCE" --project-path "$PROJ"     # only when no open scene is dirty
bt_run BtOptimize Survey '[]'                                        # .agents/optimize/<source>/survey.md + .json
bt_run BtOptimize Tune "$(arg "$(echo "$TUNE" | sed 's/}$/,"dryRun":true}/')")"   # tune-plan.md: every change, nothing changed
bt_run BtCombine Analyze "$(arg "$MERGE")"                            # combine-plan.md (on the source: merges before tune unlocks)
```

**Account for every draw before planning — ENFORCED.** From `before-pinned.json` → `pins[].drawOwners`, write the main-pass draws by owner at each pin into the plan (`node "$QA/compare-profiles.mjs"` prints it), then put each owner group of 5% or more beside its Unity cause and its fix: `survey.md` → *Skinned meshes* (every skinned renderer's verdict — rigid, frozen pose, deforms — with the evidence), *Repeated meshes* (copies, draws now, draws if instanced, what stops sharing), *Shadow casters* (flat prune candidates), *Renderers*, *Lights*, *Post-processing and cameras* (cameras building their own post chain). Do the same for the shadow maps when they are a large share of the frame: `pins[].shadowCasters` names every caster and its draws per cascade. A group with no fix gets a measured reason. Do not start Phase 3 with a large group unexplained. Read `combine-plan.md`'s draws saved: when merging saves ~0 draws (a level already drawn as one renderer per material), run with `--no-combine` and say why.

Tell the user in a few lines: the measured frame (FPS, draws per pass, **the draw owners and the top repeated shapes**, the top costs), and the plan with numbers (rigid skinned meshes to convert, static movers to unfreeze, repeated props that will instance, crowds that become VAT, lights to bake, shadow casters to prune, props to mark static, renderers to lightmap, merges). Recommend `--keep-gi` whenever the user wants the current lighting kept or the run is `--no-combine` (with no merge, newly lightmapped props buy no draws, only a different bake). `--analyze` stops here. Otherwise continue — do not wait for approval; the source is safe.

## Phase 3 — Working copy, tune, merge

```bash
bt_run BtCombine PrepareCopy "[\"$SOURCE\",\"$OUT\",<true if --reset else false>]"
bt_run BtOptimize Tune "$(arg "$TUNE")"          # skip with --combine-only
bt_run BtOptimize PruneShadowCasters "$(arg '{"paths":["<prune list from shadow-casters.md>"]}')"   # skip with --no-prune-casters / --combine-only
bt_run BtCombine Analyze "$(arg "$MERGE")"        # skip with --no-combine; plan after the unlocks
bt_run BtCombine Apply "$(arg "$MERGE")"          # skip with --no-combine
# a project script's entry points (planning.md O11), in order, when the run needs one
```

Read the Apply output: every group's `verts a -> b` must be equal. A `WARNING … re-unwrapped` on a few small groups means a lightmapped source had no usable lightmap UVs (no UV2 and UV0 outside 0..1) and was unwrapped on its own — report the count; many or large ones mean the toolkit build lacks packing — stop and report. If Apply refuses ("already combined"), continue from Phase 4 with the existing result or rerun with `--reset`.

## Phase 4 — Bake (skip only with --no-bake)

Light-mode changes, GI-flag changes and merged lightmap UVs all need one bake; a copied scene still points at the source's LightingData.

```bash
bake() {   # never trust lighting_bake_status alone: it can say "completed" before the bake starts
  local started; started=$(date +%s)
  unity command bake_lighting --confirm true --project-path "$PROJ"
  node "$WAIT" cmd "unity command run_script --file AgentScripts/bt-optimize/BtOptimize.cs --entry BtOptimize.BakeState --args '[\"$started\"]' --project-path '$PROJ' --format json" \
    --match '"result": *"done' --fail '"result": *"(stopped|empty)' --interval 15 --timeout 5400 || return 1
  unity command save_all --project-path "$PROJ"      # the bake assigns new LightingData; exports refuse a dirty scene
}
bake                                                 # BakeState prints "done lightmaps=N probes=M lightmapped=R probeGroups=G data=<LightingData>"
bt_run BtCombine CorrectDensity '[]'                 # after a merge: merged meshes get ~84-89% of their sources' texels; raise Scale In Lightmap
# corrected=N with N > 0 → bake once more
bt_run BtCombine Verify '[]'                         # after a merge: must end with problems=0
bt_run BtOptimize Verify "$(arg "$TUNE")"            # always: must end with problems=0 (verify.md lists each problem)
```

**An empty bake fails, never passes.** A bake that fails part-way still writes its LightingData, so its write time proves nothing. `BakeState` answers `empty` when the finished bake has no lightmaps although the scene has lightmapped renderers (Contribute GI static, Receive GI Lightmaps, or a GI-contributing terrain), or no light probes although it has a `LightProbeGroup` with probes — and `bake()` fails on it. `Verify` adds the second check: every renderer or terrain whose `lightmapIndex` names a lightmap the loaded bake does not have (an empty or stale LightingData, or one from another scene) is a problem.

## Phase 5 — Unity side-by-side (browser poses, then LOD0 **and** LOD1)

**First, the browser's pinned poses in Unity**, source and working copy. `PoseView` puts a capture camera named `BtOptimizePoseCamera` at a pose recorded by the profiler (position, rotation, vertical FOV; toolkit scenes keep Unity's coordinates), copying the main camera's URP data so post-processing matches. It renders above the scene's cameras by depth and never touches them, and it is never saved (DontSaveInEditor) — but it lives in the open scene until the scene is reopened, so **reopen the scene before exporting** (Phase 6's `open_scene` does). A DontSaveInEditor object survives `OpenScene`, so `PoseView` first destroys **every** pose camera the Editor holds (`Resources.FindObjectsOfTypeAll`, any scene or none, never an asset) — on entry and again after it opens the scene — so capturing two scenes in a row leaves exactly one pose camera, in the scene asked for. `Verify` and the camera comparison use the same lookup. VAT crowd members draw magenta in URP / HDRP Unity captures — compare them in the browser. Comparing these with the browser shots of the same poses tells you which side of the export a difference is on:

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
unity command open_scene --path "$OUT" --project-path "$PROJ"                            # drops any pose / QA camera
bt_run BtOptimize Verify "$(arg "$TUNE")"                                                # problems=0 before every export
unity command bt_export_level --scene "$OUT" --project-path "$PROJ" --timeout 3600     # record the duration
unity command bt_devserver_start --project-path "$PROJ"
node "$QA/gltf-stats.mjs" <source.gltf> <optimized.gltf>            # .gz.gltf too (gunzipped by magic bytes); buffers on disk and uncompressed
node "$QA/profile-browser.mjs" --scene <optimized>.gltf --times 10,20,30,45,60,75,90 --window 4 --out "$REPORT/profile/after-timeline.json"
node "$QA/profile-browser.mjs" --scene <optimized>.gltf --poses "$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json" --toggles none --window 5 --settle 8 --cpuprofile true \
  --casters true \
  --shots "$REPORT/profile/shots" --out "$REPORT/profile/after-pinned.json"
node "$QA/compare-profiles.mjs" --label Original,Optimized "$PROJ/.agents/optimize/$SRC_NAME/profile/before-pinned.json" "$REPORT/profile/after-pinned.json"
node "$QA/compare-profiles.mjs" --label Original,Optimized "$PROJ/.agents/optimize/$SRC_NAME/profile/before-timeline.json" "$REPORT/profile/after-timeline.json"
node "$QA/compare-browser.mjs" --scenes <source>.gltf,<optimized>.gltf --times 20,25,30,40,50,60 --out "$REPORT/captures"
```

`compare-profiles` prints the report tables. **Before trusting a pinned comparison, look at the paired `--shots` images: the same pose must show the same view** (a lens or camera the pin did not hold shows up there first). The pinned views are the same poses in both runs; compare FPS, p50 / p95 frame time, draws per pass and the CPU top list. In `compare-browser`'s `sheet.png`, pair frames by **view, not timestamp** — a lighter scene finishes loading sooner and its flythrough runs ahead (5–10 s in one measured scene). Both scenes must be free of console errors.

**In the game.** When a web game loads this scene (search its code for the source's lower-cased export name), point it at the optimized export — the one-line scene URL / catalog change — and play to the pinned views through the game's own camera: post-processing on, animated props and crowds animating, 0 console errors. The export viewer's default camera has no post-processing, so a lost post chain only shows here. Never copy exported files into the web project (reference: *Scenes Are Served, Never Copied*).

## Phase 7 — Regression loop (at most 3 rounds)

**Find the side first.** Unity original vs Unity working copy at the same pose: different → the scene changes (tune or merge) did it; same → the export / runtime did it (compare the census and console).

**Then bisect, never guess.** Two plausible stories about one scene's dark room were both wrong; one bake per variant found the truth in about 30 minutes:
1. Control copies: `PrepareCopy` to `<Scene>_TuneOnly.unity` (reset each time), run `Tune` with steps switched off (`{"bakeLights":false,"pointSpotShadowsOff":false}` = static/lightmap steps only; `{"markStatic":false,"lightmapProbeLit":false}` = light steps only; then single steps), bake once, `PoseView` + capture the bad pose.
2. The step that reproduces it → diff renderer state near the spot between source and copy (static flags, Contribute GI, receive GI, shadow casting) to name the object, fix the **rule** in `BtOptimize.cs`, `RemoveCopy` the control, rerun with `--reset`.
3. Unity-side runtime experiments (disabling lights in the Editor) are unreliable when the scene has `[ExecuteAlways]` scripts — one scene's light controller script re-enabled every light each frame. Change only what such scripts do not touch, or bake a control copy.

If a region looks different (darker, flatter, wrong reflections, LOD popping) or a pinned view got slower:
1. Identify the cause: a merge (`combine-manifest.json` → `combinedPaths`, `sources`, probes), a baked light (`tune.md`), a lightmap switch.
2. Exclude it (`--exclude` / `--keep-lights`), say why in one line, rerun from Phase 3 with `--reset`.
3. Still different without it → compare against a re-baked **untouched** copy (`PrepareCopy` to `<Scene>_Control.unity`, bake, export, capture; then `RemoveCopy`). A difference the control also shows is the re-bake (often a stale source bake), not this skill.

## Phase 8 — Report

Reply in plain language with images, and write `$REPORT/report.md`. Both open with **Export this scene** — the first thing the user reads:

- **Export this scene:** the working copy's path and its export file (`scenes/<out, lower-cased>.gltf`), whether the game now loads it, and a short table of what sits beside it: the source (untouched — the baseline; keep it to re-run or compare), `<Out>/` (its baked lighting), `<Out>_UnskinnedMeshes/`, `<Out>_RetargetedClips/`, `<Out>_VatCrowd/`, `<Out>_CombinedMeshes/` (each only when made) — "used by the optimized scene; do not delete". Name any other copies of the scene in the folder (older backups, control copies) as not part of the result, and offer — never do unasked — to tidy them once the user is happy.
- **Result:** FPS and frame time (p50 / p95 / worst) before → after at each pinned view and over the timeline; draws per frame by pass; meshes, primitives, materials, vertices and export size (`gltf-stats`); export time.
- **What changed and why:** skinned meshes unskinned, static movers unfrozen, repeats instanced, VAT crowds, lights baked (count, which), shadows removed, shadow casters pruned (with the capture proof), props marked static, renderers lightmapped, post fixes, merges (static groups, LOD clusters, the biggest by name).
- **Draws by owner, before → after, at each pin** (`compare-profiles` prints it): every group of 5% or more of the main-pass draws, with what changed it or the measured reason it could not change. The repeated shapes that still cost one draw per copy, and why.
- **What stayed and why:** top kept reasons with counts, and what the user could change (UV2 on props, scripts that point at objects, vegetation by design, skinned meshes to convert by hand, repeated deforming crowds for the VAT mode).
- **Toolkit findings:** costs the scene cannot fix (for example a `DepthRenderer` pass owned by soft particles or a Scene Depth node), with the runtime fix to ask for.
- **Checks:** `BtOptimize.Verify` and `BtCombine.Verify` results, Unity captures, browser frames, the in-game look, console errors; anything skipped or unverified, stated as such.
- **Redo after `--reset`:** the exact sequence — Tune JSON, the prune list, any project script's entry points in order, bake, Verify, export — so the result can be rebuilt from the source at any time.
- **How to undo:** `--reset`, or delete the working copy, `<Out>_CombinedMeshes/`, `<Out>_UnskinnedMeshes/`, `<Out>_RetargetedClips/`, `<Out>_VatCrowd/`, `<Out>/` (baked lighting) and `.agents/optimize/<Out>/`, and point the game back at the source's export; re-tick any Volume Profile override listed in `tune.md`.

---

# Files this skill writes

| Path | What |
|---|---|
| `<out scene>` | the working copy (tuned and merged) |
| `<out scene folder>/<Out>_CombinedMeshes/*.asset` | merged meshes |
| `<out scene folder>/<Out>_UnskinnedMeshes/*.asset` | plain meshes baked from skinned meshes: rigid ones whose bind pose was offset and whose object could not be moved, script hosts, and frozen poses (one asset per distinct pose) |
| `<out scene folder>/<Out>_RetargetedClips/` | copied clips (`<clip>_MeshRenderer.anim`) and controllers (`<controller>_MeshRenderer.controller`) whose SkinnedMeshRenderer curves now target the MeshRenderer that replaced it |
| `<out scene folder>/<Out>_VatCrowd/` | the VAT crowds' material copies (`<material>_VAT.mat`) on the toolkit's vertex-animation shader |
| `<out scene folder>/<Out>/` | the copy's baked lighting |
| `.agents/optimize/<Source>/` | survey, tune plan, merge plan and "before" profiles of the source |
| `.agents/optimize/<Out>/` | `working-copy.txt`, `tune.md/json`, `pruned-casters.json`, `shadow-casters.md`, `combine-plan.*`, `combine-manifest.json`, `combine-verify.md`, `verify.md/json`, `profile/`, `captures/`, `report.md` |
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
| A spinning or animated prop stands still in the browser | It is static: `Verify` lists it under "static but moves" — Tune's `unfreezeAnimated` clears it; re-export |
| VAT crowd draws tiny (or huge) in the browser | Its renderers are not at world scale 1 (`Verify` names them): re-run Tune, or set the scale by hand |
| VAT crowd is magenta in Unity captures | Expected: the toolkit's VAT shader has no URP / HDRP pass in the Editor — judge it in the browser |
| The game lost its post-processing / looks flat after the run | A camera was saved disabled: `Verify` compares every camera with the source; re-enable it, reopen, re-export |
| A pruned caster's shadow is missing in a capture | Take it off the prune list, re-run `PruneShadowCasters` (it restores the original mode), re-bake |
| `BakeState` keeps returning `stopped` | The bake never started or failed: `console --level error`, then `bake_lighting` again |
| `BakeState` returns `empty` (`lightmaps=0` or `probes=0`) | The bake finished but wrote nothing: `console --level error` — an unsupported denoiser (OptiX on Apple silicon: set the Lighting Settings' denoisers to OpenImageDenoise, AO included), a GPU lightmapper that ran out of memory (lower the lightmap size or use the CPU lightmapper), or no lightmapped renderers left after a merge; fix it and bake again. Never export an empty bake |
| `Verify`: "lightmapped renderer points past the baked lightmaps" | The scene's LightingData is empty, stale or another scene's — bake again (`bake()`), then Verify |
| `FAILED pin …: Timeline drifted` from `profile-browser` | Something resumed the director during the window (a seek or a script): re-run that pin; when it repeats, hold a time outside the moment that resumes it |
| `gltf-stats`: `Unexpected token` on a `.gz.gltf` | An old copy of the tool: copy `scripts/qa/*` into `.agents/optimize/.qa-tools/` again (gzipped exports are read since this version) |
| Two `BtOptimizePoseCamera`s, or a capture of the wrong scene | An old `BtOptimize.cs`: copy `scripts/*.cs` into `AgentScripts/bt-optimize/` again; `PoseView` now destroys every earlier pose camera |
