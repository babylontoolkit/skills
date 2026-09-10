# Pipeline: `unity-level`

**Deliverable:** a Unity-authored scene exported by the Babylon Toolkit as a **game level** — baked GI,
IBL/skybox, reflection probes, terrain, fog, tonemapping — consumed by a BabylonJS game.

The loop protocol in `SKILL.md` does not change. What changes is **what the builder edits** (a Unity scene,
via the CLI) and **what the verifier produces** (a browser screenshot of the *exported* level, plus the
exported scene metadata). No gameplay code is in scope here — the level is the artifact.

> **Required reading before round 1.** Fetch and read the Agent Reference's
> [Unity Exporter Instructions](https://raw.githubusercontent.com/babylontoolkit/agent/main/references/unity-exporter-cli.md)
> in full. Section numbers below (§4B, §8, §9 …) refer to it. Builder subagents must be given it too — a
> subagent does not inherit your context.

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
| An Editor is reachable | `unity command` needs a live Editor — resident headless or a GUI copilot session (§6). |
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
(`HasActiveSubscription()`, `GenerateDeveloperLicense()`) are documented as **not live yet**, so
`license.json` is the only working path today.

### `pipeline.md` for this kind

```markdown
# Pipeline — unity-level
Unity project : /abs/path/UnityProject
Editor mode   : copilot (resident GUI) | headless (-batchmode -nographics)
Editor version: 6000.5.10f1
Toolkit       : 9.22.3   licence: professional
Scene         : Assets/Scenes/Level01.unity
Export root   : /abs/path/UnityProject/Export
Dev server    : http://localhost:8888   (started via bt_devserver_start)
Player page   : /index.html?scene=level01.gltf   (requires a web-project build — see §4.3)
Bake tier     : preview | production
```

> **None of this survives a pause.** A resident Editor, a warm asset database and a running dev server are
> all session-scoped. On resume, re-launch and re-run the gate before touching anything.

---

## 2. Build surface — what a builder may edit

Everything runs against the **live active scene** through the CLI. The Editor keeps its in-memory state in
sync; raw file edits cannot.

```bash
unity command eval_file /tmp/round-12-lighting.cs --project-path "$PROJ" --format json
```

> ⚠️ **Never hand-edit `.unity`, `.prefab` or `.asset` YAML while a live Editor is reachable.** fileIDs and
> GUIDs are easy to get wrong, the Editor will not see the change until a reimport, and it is very easy to
> write valid-looking YAML into the wrong scene. Only edit files directly when `unity status` /
> `unity command` show no reachable Editor — and say so explicitly in the round journal.

Models come from Blender via the `blender-model` pipeline reference; **edit FBX files in place** so the
Unity GUID and importer settings survive and every scene reference picks up the change.

### The LightingSettings trap — round 1 must handle it

A scene created with `EditorSceneManager.NewScene` in batch mode has **no LightingSettings asset**, and the
export throws `Lightmapping.lightingSettings is null`. Worse, *reading* the property throws when unset, so
a plain null-check raises the very error it checks for. Probe with `TryGetLightingSettings`, and note the
order and the `MarkSceneDirty` — without it the assignment is never written to disk and the *second* export
of that scene fails, which reads as "the fix stopped working" (§8.1):

```
NewScene -> build hierarchy -> SaveScene -> assign LightingSettings
         -> MarkSceneDirty -> SaveOpenScenes -> AssetDatabase.SaveAssets -> BuildProject
```

```bash
grep -n "m_LightingSettings" Assets/Scenes/Level01.unity
#  bad: m_LightingSettings: {fileID: 0}
# good: m_LightingSettings: {fileID: 4890085278179872738, guid: 64c317a2..., type: 2}
```

---

## 3. Part taxonomy — the default decomposition

Round 1 records this as the part checklist in `progress.md`, ordered roughly by impact. Drop parts the
brief puts out of scope; never add gameplay code parts to a `unity-level` job.

| Part | Owns | Exported metadata it drives |
|---|---|---|
| **P1 Landform & terrain** | terrain heightmap, terrain layers, splat weights, trees/details | Terrain component (**Pro-gated**) |
| **P2 Blockout & composition** | major masses, silhouette, sightlines, the framing at each locked camera | geometry |
| **P3 Set dressing & scatter** | props, clutter, decals, LOD groups | geometry, LOD (**Pro-gated**) |
| **P4 Materials & surfacing** | albedo/roughness/metallic/normal, texel density, wear | materials, textures |
| **P5 Light rig** | sun angle + colour temp, practicals, shadow distance and softness, light modes | `light` components, `sunposition`, `sunrotation` |
| **P6 GI / lightmap bake** | lightmapper, resolution, bounces, denoiser, AO, UV padding | `ambientlightmap`, `lightmaplevel`, lightmap textures |
| **P7 IBL / skybox / ambient** | skybox material or cubemap, ambient mode/source, SH, sky reflections | `skybox`, `skyreflections`, `createpolynomials`, `ambientlighting`, `ambientskymode`, `ambientskysource`, `ambientskycolor`, `ambientgroundcolor`, `ambientlightintensity` |
| **P8 Reflection probes** | placement, resolution, box projection, intensity | `reflectionprobeintensity` |
| **P9 Atmosphere & fog** | fog type/mode/colour/density, height fog, volumetrics | `fogtype`, `fogmode`, `fogcolor`, `fogdensity`, `fogstart`, `fogend`, `fogvolumetric`, `fogbaseheight`, `fogmaximumheight`, `fogmeanfreepath`, `foganisotropy` |
| **P10 Image processing** | exposure, tonemapping, gamma, clear colour | `exposure`, `tonemapping`, `gammacorrection`, `imageprocessing`, `clearcolor` |
| **P11 Perf & budget** | draw calls, texture format, lightmap memory, render groups, freeze/prewarm | `webptextures`, `ktxtextures`, `webplightmaps`, `ktxlightmaps`, `rendergroups`, `freezeactivemeshes`, `prewarmup`, `performancepriority` |

---

## 4. Verify recipe — the round's step 4, in order

Four things can fail independently. Run them in this order and stop at the first failure.

### 4.1 Bake

```bash
# kick the bake
unity command eval 'UnityEditor.Lightmapping.BakeAsync(); return "started";' --project-path "$PROJ"

# poll — the export hard-throws while this is true
unity command eval 'return UnityEditor.Lightmapping.isRunning;' --project-path "$PROJ"
```

**Bake tiering is a budget, and it is the dominant cost of this pipeline.** Converge on a **preview** tier
(low lightmap resolution, few bounces, fast/no denoiser) and switch to the **production** tier only for the
final rounds and the integration critic. Record the tier in `progress.md` under `Budgets:` and in every
round journal — *a preview-tier score is not comparable to a production-tier score*, and the critic must be
told which tier it is looking at.

### 4.2 Export as a **game level**

The distinction that matters: **`selection == null` means game level.** That single flag gates the entire
scene-metadata block — skybox, ambient/IBL, SH, reflection probe intensity, fog, tonemapping, exposure,
gravity, navmesh, sun position. Pass a non-empty selection and you get an asset container with **none** of
it (§10). A level export writes 73 metadata keys; a container writes 23.

```bash
unity command bt_export_level --scene Assets/Scenes/Level01.unity \
  --project-path "$PROJ" --timeout 900
```

- **Always pass `--scene`.** A fresh Editor session opens the *template's* default scene, and exporting
  without opening yours silently exports the wrong one (§8.1).
- `bt_export_level` throws on `EditorApplication.isCompiling` and on `Lightmapping.isRunning`.
- `BuildProject` calls `SaveOpenScenes()` and `SaveSettings()` — **anything you toggle in memory is
  persisted to disk.** Snapshot and restore, as the shipped bridge does for `geometryOnly`.

### 4.3 Serve — and the `index.html` trap

```bash
unity command bt_devserver_start  --project-path "$PROJ"
unity command bt_devserver_status --project-path "$PROJ"
```

| URL | Serves |
|---|---|
| `http://localhost:8888/index.html` | the generated web project, default scene |
| `http://localhost:8888/index.html?scene=level01.gltf` | the same player pointed at one scene (**file name, not a path**) |
| `http://localhost:8888/scenes/level01.gltf` | the raw exported asset |

> ⚠️ **`bt_export_level` defaults to `--geometryOnly true`, which skips the web-project emit — so
> `/index.html` 404s and there is nothing to screenshot.** Decide once, in round 1, and record it in
> `pipeline.md`: either run `bt_build_project` (or `--geometryOnly false`) to generate the player, or point
> your own BabylonJS loader page at the raw `scenes/*.gltf` URL. This is the most common first-round dead
> end in this pipeline.

### 4.4 Capture from the locked camera

Locked cameras are **real Unity cameras** in the scene, named `gauntlet_<slug>` (e.g. `gauntlet_hero`), one
per target image, with their exact transform and fov recorded in `cameras.md`. They export as `camera`
components under both licence tiers.

In the browser, select the camera by name before the screenshot rather than trusting whichever camera the
player defaulted to — via the host's browser tool (`chrome-devtools` `evaluate_script` on Claude Code):

```js
// select the locked camera, settle, then screenshot
const cam = scene.getCameraByName("gauntlet_hero");
if (!cam) throw new Error("locked camera missing from export");
scene.activeCamera = cam;
```

Then capture to `_gauntlet/<name>/evidence/round-NN-<part>-hero.png`, and collect
`round-NN-<part>-metrics.json`: FPS, draw calls, load time, console errors.

> Confirm the camera-selection call against your player page on the first round and record what worked in
> `pipeline.md` — the toolkit's player may already expose its own camera switching, in which case use that.

### 4.5 Read back the export boundary

The objective check this pipeline gets for free — assert that what the part was supposed to change actually
crossed the boundary. Scene metadata lives at **`scenes[0].extras.metadata`**, not the document root:

```bash
jq '.scenes[0].extras.metadata
    | {license, skybox, ambientlighting, ambientskymode, ambientlightmap, lightmaplevel,
       reflectionprobeintensity, exposure, tonemapping, fogmode, fogvolumetric, sunposition}' \
  "$PROJ/Export/scenes/level01.gltf"
```

Write the result to `evidence/round-NN-<part>-metadata.json` and hand it to the critic. `license` must read
`"professional"`.

---

## 5. Extra critic inputs and gates for this pipeline

Added to the standard contract in `critic-rubrics.md`:

**Inputs:** the exported metadata dump, the bake tier, and — when a Unity-side capture exists — the Editor
viewport frame alongside the browser frame.

**Hard gates:**

| Gate | Fails when |
|---|---|
| **Export boundary** | a metadata key the part owns is absent, default, or contradicts what the round claims it set |
| **Licence tier** | `scenes[0].extras.metadata.license` is not `"professional"` |
| **Level, not container** | `properties` is `false`, or the scene-metadata block is missing — the export was made with a non-null selection |
| **Bake tier honesty** | the round journal does not state which tier the evidence was baked at |

**The Unity-vs-export gap — make the critic isolate it.** If the Editor viewport looks right and the
exported browser frame looks flat, the round's problem is the *export path*, not the art — and a critic
looking only at the browser frame will send the builder off to "fix the lighting" forever. When both frames
are available, the critic must state which side of the boundary the gap is on.

> Capturing the Unity side needs a graphics device — it works in **copilot mode** (a resident GUI Editor),
> via a `Camera.Render()` to a `RenderTexture` and `EncodeToPNG`. A `-nographics` headless Editor cannot
> render, so in headless mode this diagnostic is unavailable; say so rather than skipping it silently.
> Verify which you have on round 1 and record it in `pipeline.md`.

---

## 6. Scope the target to what can actually cross the boundary

The 73-key metadata list **is** the export surface for scene-level look. Anything the target image depends
on that has no key — screen-space reflections, SSGI/SSAO, custom render passes, bespoke volume stacks —
does not survive, and a critic that keeps raising it will name the same gap forever.

During the interview's target-reachability pass, walk the target against that key list and record whatever
cannot cross in the loop card's **`OUT OF REACH`** slot. Critics are instructed not to raise gaps against
it. Where an effect can be *approximated* on the BabylonJS side instead (a reflection probe standing in for
SSR, baked contact shadows standing in for SSAO), record that as the approach rather than as out of reach.

> The precise URP/HDRP boundary is worth **measuring on your first real export** rather than assuming.
> Export one scene with the effects you care about, dump `scenes[0].extras.metadata`, and record what
> actually landed in `pipeline.md`. Do that before finalizing the rubric for a job that leans on them.

---

## 7. Known failure modes — check these before blaming the art

| Symptom | Cause | Fix |
|---|---|---|
| Export produced geometry but no terrain / physics / LODs | community licence | §0 — install a valid `license.json`; the log line is `Pro Tools Disabled` |
| `Lightmapping.lightingSettings is null` | programmatic scene with no LightingSettings asset | §8.1, and remember `MarkSceneDirty` |
| The fix "stopped working" on the second export | `MarkSceneDirty` was missed, so the assignment never persisted | check `m_LightingSettings` in the `.unity` file |
| `A lightmap bake is in progress.` | `Lightmapping.isRunning` | poll it out before exporting |
| Exported the wrong scene | fresh session opened the template default | always pass `--scene` |
| `/index.html` 404s | `--geometryOnly true` skipped the web-project emit | §4.3 |
| Skybox/fog missing from the export | a non-null selection made it a container | §10 — `selection == null` for a level |
| Exporter settings changed on their own | `BuildProject` calls `SaveSettings()` every run | snapshot and restore what you toggle |
| Unity Hub cannot open the project | copilot mode leaves a resident Editor holding the lock | `bt-stop-editor.sh <ProjectPath>` (§4B.3) |
| `unity command` cannot connect | Safe Mode, or a batch Editor invisible to `status` | `unity pipeline list`; gate on `unity command`, not `unity status` |
