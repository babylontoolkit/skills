# Pipeline: `unity`

**Deliverable:** anything authored in Unity and shipped through the Babylon Toolkit exporter as interactive
glTF — a whole game level, or an individual asset in it. Baked GI, IBL, reflection probes, terrain, fog and
tonemapping for scenes; geometry, UVs, PBR maps, LODs and skinning for models.

> ### Unity is the content-creation tool and the asset manager. Blender is a tool inside it.
>
> There is **one** Unity pipeline. The entire Unity ecosystem — asset packs, importers, lighting, physics,
> the prefab workflow — is the authoring surface, and `extras.metadata.components` is what makes the exported
> glTF *interactive* rather than dumb geometry.
>
> **Blender is used for low-level model and asset creation and edits.** It does geometry, UVs, bakes, LODs
> and skinning — **in place**, for files that already live in the Unity project, so GUIDs and importer
> settings survive. Its job ends the moment the model is back in Unity. From there the model is simply an
> asset in a scene: it gets its materials, colliders, LOD group, rig and Babylon Toolkit components there,
> and it is judged there, lit by that scene. Blender **cannot** write components — those come from Unity,
> and only under a Pro licence.
>
> **The loop stays in Unity. Do NOT export every round.** Evidence is a Unity camera snapshot —
> `Camera.Render()` straight to a PNG from the locked camera. A bake → export → dev-server → browser round
> trip on every iteration costs minutes and tells the critic nothing extra about the art.
>
> **Export when you are ready** — the user's call, by prompt or from the Unity Export buttons: the whole
> scene as a **game level** (`selection == null`, full scene metadata), or one asset as an **asset
> container** (`selection != null`, components but no scene metadata). A model used in a level ships inside
> that level's export; there is nothing asset-specific to do for it. See § 6.B.

> **Required reading before round 1.** Fetch and read the Agent Reference's
> [Unity Exporter Instructions](https://raw.githubusercontent.com/babylontoolkit/agent/main/references/unity-exporter-cli.md)
> in full — and, for any round that touches Blender, the
> [Blender Headless CLI Instructions](https://raw.githubusercontent.com/babylontoolkit/agent/main/references/unity-blender-cli.md).
> Section numbers below (§4B, §8, §10 …) refer to whichever is named. Builder subagents must be given them
> too — a subagent does not inherit your context.

---

## 1. Prerequisite gate — before round 1, and again on every resume

**A gauntlet that starts without these spends its whole budget polishing something that never exports.**
Run the gate, write the result to `_gauntlet/<name>/pipeline.md`, and refuse to start if it fails.

```bash
unity command bt_status --project-path "$PROJ"
```

| Must be true | Why it is fatal |
|---|---|
| `pro : True` | **Community silently drops Terrain**, plus Rigidbody, Animator, AudioSource, NavMeshAgent, CharacterController, ParticleSystem, Canvas, VideoPlayer, **PostProcess volumes** and **LOD groups**. The export still succeeds and still writes scene metadata — it just quietly omits them. See §0. |
| An Editor is reachable | `unity command` needs a live Editor (§6). |
| **A graphics device is available** | In-loop evidence is a real Unity render. `-nographics` has **no** graphics device and cannot render, so this pipeline runs in **copilot mode** (a resident Editor) or batchmode *with* graphics — never `-nographics`. Verify on round 1 by taking one snapshot and confirming the PNG is non-empty. |
| All three packages installed | `com.unity.pipeline` + `org.khronos.unitygltf` + `com.babylontoolkit.editor` (§4.1). |
| Scene Exporter panel bootstrapped once, in a GUI session | Seeds layers, FreeImage, shader list and root namespace, and writes `package.json` (§5.1). **A cold machine that has never run the GUI cannot start a gauntlet.** |
| `npm install` run in the project root | Any build with `CompileProjectScript` needs the local `tsc` (§5.2). |
| `unity list --format json \| grep bt_` returns the eight `bt_*` commands | The shipped CLI bridge (`com.babylontoolkit.editor` 9.22.3+, §11). If empty: `recompile` + `recompile_status`. |
| `baking : False` | A lightmap bake in progress hard-blocks every export. |

The combined three-things check from §0, worth running verbatim:

```bash
unity command eval 'string r = UnityTools.GetRootPath();
return "pro="   + ToolkitManager.IsPro()
     + " tsc="  + System.IO.File.Exists(System.IO.Path.Combine(r, CanvasTools.CVPanel.TscLocalPath))
     + " scene=" + UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene().path;' \
  --project-path "$PROJ"
# want: pro=True tsc=True scene=Assets/Scenes/<the one you meant>.unity
```

**Licence is a loop-card boundary, not a warning.** If `pro` is `False`, park immediately and tell the user
that a valid `Assets/[Config]/license.json` is required — the two service grant paths
(`HasActiveSubscription()`, `GenerateDeveloperLicense()`) are documented as **not live yet**.

**When Blender is in scope**, also check:

```bash
blender --version
blender -b --factory-startup --python-exit-code 1 \
        --python-expr "import bpy; print('bpy', bpy.app.version_string)"
```

### `pipeline.md` for this kind

```markdown
# Pipeline — unity
Unity project : /abs/path/UnityProject
Editor mode   : copilot (resident GUI)   <- REQUIRED; -nographics cannot render
Editor version: 6000.5.10f1
Toolkit       : 9.22.3   licence: professional
Scene         : Assets/Scenes/Level01.unity     <- authored, rendered and judged here
Export root   : /abs/path/UnityProject/Export
Dev server    : http://localhost:8888   (started via bt_devserver_start)
Player page   : /index.html?scene=level01.gltf  (needs a web-project build — § 6.B)
Bake tier     : preview | production
Capture mode  : unity-snapshot (in-loop)  ·  export+browser (checkpoints only)
Checkpoints   : round 1 calibration done [y/n] · last checkpoint round N
Blender       : 5.1.2 (/Applications/Blender.app/Contents/MacOS/Blender)  [if in scope]
Model assets  : Assets/Models/mech.fbx  — write mode IN PLACE, backup mech.fbx.bak
```

> **None of this survives a pause.** A resident Editor, a warm asset database and a running dev server are
> all session-scoped. On resume, re-launch and re-run the gate before touching anything.

---

## 2. Build surface — the Unity scene

Everything runs against the **live active scene** through the CLI. The Editor keeps its in-memory state in
sync; raw file edits cannot.

```bash
unity command eval_file /tmp/round-12-lighting.cs --project-path "$PROJ" --format json
```

> ⚠️ **Never hand-edit `.unity`, `.prefab` or `.asset` YAML while a live Editor is reachable.** fileIDs and
> GUIDs are easy to get wrong, the Editor will not see the change until a reimport, and it is very easy to
> write valid-looking YAML into the wrong scene. Only edit files directly when `unity status` /
> `unity command` show no reachable Editor — and say so explicitly in the round journal.

### The LightingSettings trap — round 1 must handle it

A scene created with `EditorSceneManager.NewScene` in batch mode has **no LightingSettings asset**, and the
export throws `Lightmapping.lightingSettings is null`. Worse, *reading* the property throws when unset, so a
plain null-check raises the very error it checks for. Probe with `TryGetLightingSettings`, and note the order
and the `MarkSceneDirty` — without it the assignment is never written to disk and the *second* export of that
scene fails, which reads as "the fix stopped working" (§8.1):

```
NewScene -> build hierarchy -> SaveScene -> assign LightingSettings
         -> MarkSceneDirty -> SaveOpenScenes -> AssetDatabase.SaveAssets -> BuildProject
```

```bash
grep -n "m_LightingSettings" Assets/Scenes/Level01.unity
#  bad: m_LightingSettings: {fileID: 0}
# good: m_LightingSettings: {fileID: 4890085278179872738, guid: 64c317a2..., type: 2}
```

Scenes authored in the GUI already have one.

---

## 3. Blender — the low-level modelling tool

Used when a round needs geometry, UVs, bakes, LODs or skinning that Unity cannot do. **Its output is the
model back in the Unity project — nothing further.**

**The canonical invocation — use all four flags every time:**

```bash
blender --background --factory-startup --python-exit-code 1 \
        --python /path/to/script.py -- arg1 arg2
```

> ⚠️ **A Python exception does not fail the process.** Blender prints the traceback and exits `0`. Without
> `--python-exit-code 1` the loop records a crashed round as a success and hands the critic stale evidence.

Introspect before relying on any operator — names moved in 5.x (`bpy.ops.wm.fbx_import` is native now):

```python
print(sorted(n for n in dir(bpy.ops.export_scene) if not n.startswith('_')))
print(bpy.ops.export_scene.gltf.__doc__)
```

### In place vs. new file — the rule that protects the whole project

| | **Edit in place** (overwrite the FBX) | **Create a new model** (new path) |
|---|---|---|
| Unity GUID | ✅ preserved | ❌ new GUID |
| Existing scene / prefab references | ✅ all survive and pick up the change | ➖ referenced by nothing |
| Importer settings — rig, avatar, clips, scale | ✅ preserved (`.meta` untouched) | ❌ **reset to defaults** |
| Use for | iterating on an asset already in scenes | variants, LODs, experiments |

**A gauntlet iterates on the same asset for many rounds. In place is the default, and this is a hard rule:**

- **Always back up first** — the write is destructive: `cp "$FBX" "$FBX.bak"`.
- **Never delete-then-recreate.** Removing the file removes its `.meta`, destroying the GUID and breaking
  every scene and prefab that referenced it. Overwrite the bytes; leave the `.meta` alone.
- A round that genuinely needs a new path (an LOD, a variant) must **copy the importer settings across** —
  Unity will not (`unity-blender-cli.md` §8.3) — and say so in the round journal.

After every Blender write, refresh Unity and confirm the GUID survived:

```bash
cp "$FBX" "$FBX.bak"
blender --background --factory-startup --python-exit-code 1 \
        --python /tmp/round-07-bevels.py -- "$FBX" "$FBX"     # same path in and out
unity command eval 'UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceSynchronousImport); return "ok";' --project-path "$PROJ"

unity command eval 'string p="Assets/Models/mech.fbx";
var i=(UnityEditor.ModelImporter)UnityEditor.AssetImporter.GetAtPath(p);
return UnityEditor.AssetDatabase.AssetPathToGUID(p) + " rig=" + i.animationType + " scale=" + i.globalScale;' \
  --project-path "$PROJ"
```

**Conventions to preserve for BabylonJS:** ≤ 4 influences per vertex, weights normalised to 1.0, bone names
matching the Unity Avatar/Animator rig, and `add_leaf_bones=False` on FBX export.

**Textures are generated, not procedural.** Where the toolkit's `kie-image` MCP is configured, use
`generate_image` for albedo, normals, roughness masks and detail maps. Substituting procedural noise or flat
colours for maps the target needs is a gate failure, and the commonest reason an asset reads as plastic.

---

## 4. Where the work is judged

In the **scene it belongs to**, from **locked cameras**, under a **frozen lighting rig**. For scene-level
work that is simply the level. For an individual asset it is the level the asset lives in — more truthful
than an artificial rig, because the model is lit by the lighting it will really have, next to the props it
will really sit beside. Use a dedicated lookdev scene only for a library asset with no home yet.

Locked cameras are real Unity cameras named `gauntlet_<slug>`, recorded in `cameras.md` with exact
transforms, fov and resolution — three to five, including a detail crop. They export with the level, so the
same viewpoints are available at a checkpoint. Changing the rig or the cameras mid-run is a loop card
amendment that resets the affected parts' score history.

---

## 5. Part taxonomy — pick what is in scope

Round 1 records the checklist in `progress.md`. A job takes the scene block, the asset block, or both.

### Scene parts

| Part | Owns | Exported metadata it drives |
|---|---|---|
| **Landform & terrain** | heightmap, terrain layers, splat weights, trees/details | Terrain component (**Pro-gated**) |
| **Blockout & composition** | major masses, silhouette, sightlines, framing at each locked camera | geometry |
| **Set dressing & scatter** | props, clutter, decals, LOD groups | geometry, LOD (**Pro-gated**) |
| **Materials & surfacing** | albedo/roughness/metallic/normal, texel density, wear | materials, textures |
| **Light rig** | sun angle + colour temp, practicals, shadow distance and softness | `light`, `sunposition`, `sunrotation` |
| **GI / lightmap bake** | lightmapper, resolution, bounces, denoiser, AO, UV padding | `ambientlightmap`, `lightmaplevel`, lightmap textures |
| **IBL / skybox / ambient** | skybox material or cubemap, ambient mode/source, SH, sky reflections | `skybox`, `skyreflections`, `createpolynomials`, `ambientlighting`, `ambientskymode`, `ambientskysource`, `ambientskycolor`, `ambientgroundcolor`, `ambientlightintensity` |
| **Reflection probes** | placement, resolution, box projection, intensity | `reflectionprobeintensity` |
| **Atmosphere & fog** | fog type/mode/colour/density, height fog, volumetrics | `fogtype`, `fogmode`, `fogcolor`, `fogdensity`, `fogstart`, `fogend`, `fogvolumetric`, `fogbaseheight`, `fogmaximumheight`, `fogmeanfreepath`, `foganisotropy` |
| **Image processing** | exposure, tonemapping, gamma, clear colour | `exposure`, `tonemapping`, `gammacorrection`, `imageprocessing`, `clearcolor` |
| **Perf & budget** | draw calls, texture format, lightmap memory, render groups | `webptextures`, `ktxtextures`, `webplightmaps`, `ktxlightmaps`, `rendergroups`, `freezeactivemeshes`, `prewarmup`, `performancepriority` |

### Asset parts (Blender + Unity)

| Part | Owns | Where |
|---|---|---|
| **Silhouette & proportion** | primary forms, scale against reference, thumbnail readability | Blender |
| **Secondary forms** | panel breaks, bevels, boolean/remesh cleanup | Blender |
| **UVs & texel density** | unwrap, seam placement, uniform px/m, atlas packing | Blender |
| **Baked maps** | high-to-low normal and AO bakes, curvature, cavity | Blender |
| **PBR materials** | albedo, roughness, metallic, normal, AO | Blender → Unity materials |
| **Detail pass** | wear, edge damage, grime in crevices, micro-normal | Blender |
| **Topology & LODs** | tri budget, decimate chain, recalculated normals | Blender → Unity **LODGroup** (Pro-gated) |
| **Rig & skinning** | ≤ 4 influences/vertex, normalised weights, matching bone names | Blender → Unity Animator |
| **Unity assembly** | prefab hierarchy, materials assigned, colliders / physics proxies, LODGroup, Animator, Toolkit script components | **Unity** |
| **Integration** | scale, orientation, pivot, naming, `add_leaf_bones=False` | Blender + Unity importer settings |

---

## 6. Verify recipe — the round's step 4

Two modes. **Almost every round uses mode A.**

### 6.A In-loop verification — Unity snapshot (the default, every round)

#### 1. Bake

```bash
unity command eval 'UnityEditor.Lightmapping.BakeAsync(); return "started";' --project-path "$PROJ"
unity command eval 'return UnityEditor.Lightmapping.isRunning;' --project-path "$PROJ"   # poll to False
```

**Bake tiering is the dominant cost** now that the export is out of the loop. Converge on a **preview** tier
(low lightmap resolution, few bounces, fast/no denoiser); switch to **production** only for the final rounds
and the integration pass. Record the tier in `progress.md` and every round journal — *a preview-tier score is
not comparable to a production-tier score*, and the critic must be told which it is looking at. Skip the bake
entirely on rounds that change nothing GI-dependent (a roughness tweak, a prop move) and say so.

#### 2. Snapshot the locked camera

Render the actual camera through the actual pipeline, straight to a PNG. No export, no server, no browser.

```csharp
// eval_file: snapshot one locked camera to disk
string camName = "gauntlet_hero";
string outPath = "/abs/_gauntlet/<name>/evidence/round-12-p7-hero.png";
int w = 1920, h = 1080;

var go = UnityEngine.GameObject.Find(camName);
if (go == null) throw new System.Exception("locked camera missing: " + camName);
var cam = go.GetComponent<UnityEngine.Camera>();

var rt = new UnityEngine.RenderTexture(w, h, 24, UnityEngine.RenderTextureFormat.ARGB32);
rt.antiAliasing = 8;
var prevTarget = cam.targetTexture; var prevActive = UnityEngine.RenderTexture.active;
cam.targetTexture = rt;
cam.Render();
UnityEngine.RenderTexture.active = rt;
var tex = new UnityEngine.Texture2D(w, h, UnityEngine.TextureFormat.RGB24, false);
tex.ReadPixels(new UnityEngine.Rect(0, 0, w, h), 0, 0);
tex.Apply();
UnityEngine.RenderTexture.active = prevActive; cam.targetTexture = prevTarget;
System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(outPath));
System.IO.File.WriteAllBytes(outPath, tex.EncodeToPNG());
UnityEngine.Object.DestroyImmediate(tex); rt.Release(); UnityEngine.Object.DestroyImmediate(rt);
return "wrote " + outPath + " bytes=" + new System.IO.FileInfo(outPath).Length;
```

Repeat per locked camera. **Check the returned byte count** — a zero-length or tiny PNG means no graphics
device (§ 1), not a dark scene.

#### 3. Collect what Unity can measure

Into `evidence/round-NN-<part>-metrics.json`, via `UnityEditor.UnityStats` after the render: `drawCalls`,
`batches`, `setPassCalls`, `triangles`, `vertices`, lightmap count and memory — and, for asset parts,
triangle/vertex counts, material and texture counts, texture memory, texel density, max influences per
vertex, whether weights normalise to 1.0, LOD chain ratios. These are **Unity-side indicators, not the
BabylonJS perf gate**; they catch a scene going wildly heavy, they do not predict browser FPS.

That is the whole in-loop verify. Seconds, not minutes.

### 6.B Checkpoint verification — export + browser (rare, deliberate)

Run a checkpoint **only** at round 1 (calibration — proves the chain works before investing 40 rounds, and
records what actually crosses the export boundary), and when the work is done. An optional every-N cadence
exists; set it in the loop card, **off by default**.

**What you export is the user's call — by prompt, or from the Unity Export buttons.**

#### Game level (the default)

```bash
unity command bt_export_level --scene Assets/Scenes/Level01.unity --project-path "$PROJ" --timeout 900
unity command bt_devserver_start --project-path "$PROJ"
jq '.scenes[0].extras.metadata
    | {license, skybox, ambientlighting, ambientskymode, ambientlightmap, lightmaplevel,
       reflectionprobeintensity, exposure, tonemapping, fogmode, fogvolumetric, sunposition}' \
  "$PROJ/Export/scenes/level01.gltf" > evidence/checkpoint-NN-metadata.json
```

`selection == null` gates the **entire scene-metadata block** — skybox, ambient/IBL, SH, reflection probe
intensity, fog, tonemapping, exposure, gravity, navmesh, sun position: 73 keys versus a container's 23 (§10).
**Any asset in the scene ships inside this export**, with its components, lit by the baked lighting. Nothing
asset-specific is required.

#### Asset container (when you want one)

For a standalone reusable asset — a prop instantiated many times at runtime, or one shared across levels:

```bash
unity command bt_export_prefab --paths "Props/Mech" --filename mech \
  --folder "$PROJ/Export/containers" --metadata true --project-path "$PROJ"
```

`selection != null` means **no** scene metadata, `PrefabFileFormat`, and it writes straight into the folder
given with no `scenes/` subfolder. Correct for a container; wrong for anything meant to carry a scene look.

#### Either way

- **`metadata: true` is what makes the output interactive** — it emits `extras.metadata.components`. Set it
  `false` only for pure geometry or animation-only exports. Which components survive is **licence-gated**.
- Scene metadata is at `scenes[0].extras.metadata`; per-object components at
  `nodes[i].extras.metadata.components`. Neither is at the document root.
- **Always pass `--scene`** on a level export. A fresh Editor session opens the *template's* default scene
  and would silently export that one (§8.1).
- `bt_export_level` throws on `EditorApplication.isCompiling` and on `Lightmapping.isRunning`.
- `BuildProject` calls `SaveOpenScenes()` and `SaveSettings()` — **anything you toggle in memory is persisted
  to disk.** Snapshot and restore, as the shipped bridge does for `geometryOnly`.
- ⚠️ `bt_export_level` defaults to `--geometryOnly true`, which skips the web-project emit — so
  `/index.html` 404s. Run `bt_build_project` (or `--geometryOnly false`) once so the player page exists, or
  point your own BabylonJS loader at the raw `scenes/*.gltf` URL. Decide at the round-1 checkpoint and record
  it in `pipeline.md`.

| URL | Serves |
|---|---|
| `http://localhost:8888/index.html` | the generated web project, default scene |
| `http://localhost:8888/index.html?scene=level01.gltf` | the player pointed at one scene (**file name, not a path**) |
| `http://localhost:8888/scenes/level01.gltf` | the raw exported asset |
| `http://localhost:8888/containers/mech.glb` | an asset container written to an explicit folder |

### 6.C What the Unity snapshot cannot tell you

The honest reason checkpoints exist at all:

- **It renders through Unity's pipeline, not BabylonJS.** A URP/HDRP frame is not what the toolkit runtime
  produces. In-loop scores measure "is the Unity scene right", the correct question while authoring — only a
  checkpoint answers "does it survive export". Material translation is where an *asset* most often diverges.
- **Browser perf and load time** are unmeasurable in Unity. `UnityStats` draw calls are an indicator.
- **Console errors** in the toolkit runtime only appear in the browser.
- **Whether components actually exported** is only visible in the emitted glTF.

So: parts pass on Unity evidence for the **visual rubric**; the **perf, console, component and
export-boundary gates** are evaluated at checkpoints and at the final integration pass. A part that passed
in-loop and then fails a checkpoint gate is **reopened** — log it as a failed approach with the checkpoint as
evidence.

---

## 7. Extra critic inputs and gates

Added to the standard contract in `critic-rubrics.md`. **Which rubric applies depends on the part**: scene
parts use the scene/level rubric, asset parts use the model/asset rubric. **Which gates apply depends on the
evidence mode.**

### In-loop rounds (Unity snapshot)

**Inputs:** the Unity camera snapshot(s), the `UnityStats` metrics, **the bake tier**, and the previous
round's snapshot and verdict.

| Gate | Fails when |
|---|---|
| **Camera lock + frozen rig** | evidence not rendered from the `cameras.md` transforms, or the rig changed |
| **Bake tier honesty** | the journal does not state the tier, or a production score is compared to a preview one |
| **Snapshot validity** | the PNG is empty or degenerate — no graphics device, not a dark scene |
| **Component authority** | a protected `TOOLKIT.*` component reimplemented, bypassed or deleted without the replacement-evidence checklist |
| **Unity budget indicators** | draw calls / triangles / lightmap memory / tri budget past the loop card's Unity-side ceiling |
| **Engine-legal skinning** *(asset parts)* | any vertex has > 4 influences, or weights do not normalise to 1.0 |
| **Rig names** *(asset parts)* | bone names no longer match the Unity Avatar/Animator rig |
| **Transform hygiene** *(asset parts)* | scale, orientation or pivot wrong at import |
| **GUID survival** *(asset parts)* | an in-place round changed the GUID, or importer settings were reset |
| **No placeholder maps** *(asset parts)* | flat-colour or procedural-noise stand-ins for maps the target needs |

### Checkpoint rounds (export + browser)

**Additional inputs:** the exported metadata dump, the browser frame, browser perf and console log — **and
the Unity snapshot of the same camera from the same round**, so the two are directly comparable.

| Gate | Fails when |
|---|---|
| **Export boundary** | a metadata key a passed part owns is absent, default, or contradicts what the round claims it set |
| **Licence tier** | `extras.metadata.license` is not `"professional"` |
| **Right export shape** | a level export has `properties: false` (a selection was passed), or a container carries scene metadata it should not |
| **Components present** | `nodes[i].extras.metadata.components` is missing what the asset is supposed to carry |
| **Perf** | the loop card's browser FPS / draw-call / load-time budget is missed |
| **Console** | any error in the browser console |

**The Unity-vs-export gap.** A checkpoint is the only place this is visible, and it is the whole reason
checkpoints exist. With both frames of the same camera in hand, the critic must state **which side of the
boundary the gap is on**:

- *Unity frame right, browser frame wrong* → the export path or the material/metadata translation. Do not
  re-light the scene or re-model the asset. Reopen the part with the export as the named gap.
- *Both wrong the same way* → it is genuinely the art; carry on in-loop.

---

## 8. Scope the target to what can actually cross the boundary

The 73-key metadata list **is** the export surface for scene-level look. Anything the target image depends on
that has no key — screen-space reflections, SSGI/SSAO, custom render passes, bespoke volume stacks — does not
survive, and a critic that keeps raising it will name the same gap forever.

During the interview's target-reachability pass, walk the target against that key list and record whatever
cannot cross in the loop card's **`OUT OF REACH`** slot. Critics are instructed not to raise gaps against it.
Where an effect can be *approximated* on the BabylonJS side instead (a reflection probe standing in for SSR,
baked contact shadows for SSAO), record that as the approach rather than as out of reach.

> The precise URP/HDRP boundary is worth **measuring on your first real export** rather than assuming. Export
> one scene with the effects you care about, dump `scenes[0].extras.metadata`, and record what actually
> landed in `pipeline.md`. Do that before finalizing the rubric for a job that leans on them.

---

## 9. Known failure modes — check these before blaming the art

| Symptom | Cause | Fix |
|---|---|---|
| Export produced geometry but no terrain / physics / LODs / components | community licence | §0 — install a valid `license.json`; the log line is `Pro Tools Disabled` |
| Snapshot PNG is empty or 0 bytes | Editor started with `-nographics` — no graphics device | copilot mode / batchmode with graphics; § 1 |
| Rounds take minutes each | exporting every round instead of snapshotting | § 6.A — export is a checkpoint, not a step |
| Scores jump around for no reason | preview- and production-tier bakes being compared | record the tier every round |
| `Lightmapping.lightingSettings is null` | programmatic scene with no LightingSettings asset | § 2, and remember `MarkSceneDirty` |
| The fix "stopped working" on the second export | `MarkSceneDirty` was missed, so the assignment never persisted | check `m_LightingSettings` in the `.unity` file |
| `A lightmap bake is in progress.` | `Lightmapping.isRunning` | poll it out before exporting |
| Exported the wrong scene | fresh session opened the template default | always pass `--scene` |
| `/index.html` 404s | `--geometryOnly true` skipped the web-project emit | § 6.B |
| Skybox/fog missing from a level export | a non-null selection made it a container | §10 — `selection == null` for a level |
| An asset is missing from the level export | it is not in the exported scene, or the wrong scene was exported | check the model root path; pass `--scene` |
| Exporter settings changed on their own | `BuildProject` calls `SaveSettings()` every run | snapshot and restore what you toggle |
| A crashed Blender round recorded as success | missing `--python-exit-code 1` | always pass all four canonical flags |
| `bpy.ops.import_scene.fbx` not found | operator names moved in 5.x | enumerate the operators in *this* build |
| Every scene reference to a model broke | wrote to a new path, or delete-then-recreate | edit in place; never remove the `.meta` |
| Model imports at 1/100 scale or on its side | FBX unit mismatch, or a generated asset's orientation | `transform_apply` after fixing scale/rotation |
| Unity Hub cannot open the project | copilot mode leaves a resident Editor holding the lock | `bt-stop-editor.sh <ProjectPath>` (§4B.3) |
| `unity command` cannot connect | Safe Mode, or a batch Editor invisible to `status` | `unity pipeline list`; gate on `unity command`, not `unity status` |
