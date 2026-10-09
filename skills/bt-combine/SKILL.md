---
name: bt-combine
description: "The Babylon Toolkit Combine Skill analyses a Unity scene and merges the static meshes and LOD groups that can safely be merged — fewer meshes, fewer draw calls, faster export and load — without changing how the scene looks in Unity or in BabylonJS. It works on a copy of the scene, explains every keep/merge decision in a report, merges with the Babylon Toolkit MeshCombiner (packed source lightmap UVs, no vertex bloat), clusters LOD groups level by level with corrected switch distances, re-bakes, exports, and verifies the result against the original in Unity and in the browser. Use when the user wants to combine, merge, batch or optimize static meshes or LOD groups in a scene (e.g. `/bt-combine Assets/Scenes/Garden/GardenScene.unity`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com)
---

You are an EXPERT Babylon Toolkit and Unity technical artist. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md).

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-combine [<scene asset path>] [--out:<asset path>] [--analyze] [--reset] [--cell:15] [--spread:3] [--atlas-share:0.45]
            [--include-shadergraphs] [--no-lods] [--exclude:Name1,Prefix*] [--only:Path/A,Path/B] [--shaders:Name1,Name2]
            [--no-bake] [--no-export] [--no-browser] [--times:10,15,20,30]
```

- **`<scene asset path>`** — the scene to optimize. Default: the Editor's active scene.
- **`--out:`** — the working copy. Default: `<scene folder>/<SceneName>_Combined.unity`. **The source scene is never edited.**
- **`--analyze`** — report only: analyse the source scene, write the report, change nothing, stop.
- **`--reset`** — start again from the source (re-copies it over the working copy and deletes the previous merged meshes).
- **`--cell:`** — area "patch" size in meters that merged meshes must stay inside (default 15).
- **`--spread:`** — meters a merge may extend past its largest piece (default 3). Keeps merges to pieces that touch.
- **`--atlas-share:`** — largest share of one lightmap atlas a merged lightmapped mesh may use (default 0.45).
- **`--include-shadergraphs`** — also merge Shader Graph materials that pass the object-space / vertex-animation scan.
- **`--no-lods`** — leave every LOD group alone.
- **`--exclude:`** — object names (or prefixes ending in `*`) whose subtrees are never merged.
- **`--only:`** — limit merging to these hierarchy paths.
- **`--shaders:`** — extra shader names to treat as safe (custom shaders that do not use the pivot or object space).
- **`--no-bake` / `--no-export` / `--no-browser`** — skip those phases (each skip is stated in the final report as unverified).
- **`--times:`** — seconds after page load at which the browser comparison captures frames.

---

# What this skill guarantees

1. **The source scene — and any scene the user has open — is untouched.** All work happens in the working copy, which only `PrepareCopy` can create (it leaves a `working-copy.txt` marker; `Apply` and `RemoveCopy` refuse any scene without it). Nothing switches scenes while an open scene has unsaved changes. A bad result is undone with `--reset`.
2. **Every decision has a written reason.** `_combine/<Scene>_Combined/analysis.md` lists every merge (pieces, vertices, draw calls before → after, reflection probe, lights, lightmap share, spread) and every object kept separate, grouped by reason.
3. **No vertex bloat.** Merges use the toolkit's `UnityMeshSimplifier.MeshCombiner` in *Pack Source Lightmap UVs* mode: each source keeps its own lightmap UVs, packed side by side at its original texel density. Apply refuses to run on a toolkit build without that mode.
4. **It looks the same.** The result is re-baked and compared with the original — numerically (lightmap slots, UV range, texel density, LOD transitions) and visually (Unity captures and browser frames at the same moments).

# Talk to the user while you work

Long runs lose people. At every phase change, post one short plain-language update: **Done** (what changed, with numbers) · **Doing now** · **Next**. Say plainly that the merging itself is done by their toolkit's MeshCombiner. If you change the plan (exclude a group, reset, re-bake), say why in one line.

---

# The merge rules — and why each exists

These rules are enforced by `scripts/BtCombine.cs`; know them so you can explain the report. Each one comes from a real regression.

**A piece can merge only if it is:**

| Rule | Why |
|---|---|
| Marked static (Contribute GI or Batching Static) | Anything else may move at runtime |
| Not scripted, animated, a particle system, a Rigidbody, or under one | Merged geometry cannot move or toggle on its own |
| Not referenced by any component (scripts, timeline bindings, cameras, signals…) | A script that toggles or moves it would lose its target |
| Opaque or alpha-tested (not transparent) | Transparent meshes are sorted per mesh; merging breaks draw order |
| A safe shader: URP/HDRP/Built-in Lit/Simple Lit/Unlit/Standard, `--shaders`, or a Shader Graph that passes the scan (`--include-shadergraphs`) | Graphs that read object space, use the Object node / model matrix, or move vertices (wind) change look when many objects share one pivot |
| Not mirrored (negative scale), not vertex-painted, not on toolkit layers 28–31 | The combiner does not flip winding; vertex streams and reserved layers are lost |
| **Lightmapped** (Contribute GI + Receive GI: Lightmaps) when the scene has light probes | A merged light-probe-lit mesh gets **one** probe sample at its centre — metal rails merged across a room turned black |

**A group of pieces merges only if they:**

| Rule | Why |
|---|---|
| Share a container (highest ancestor with no scripts, animation or references) | Toggling or moving anything above still applies to the merged mesh |
| Share every renderer setting (shadows, GI, probes, Scale In Lightmap, lightmap parameters, layer, tag, static flags) | One mesh has one set |
| Share their dominant **reflection probe**, and the merged centre stays inside that probe's box | Probes are chosen from a mesh's bounds centre; merging two corridors moved the centre into a different probe zone and darkened both |
| Stay inside one area cell, and extend at most `--spread` past their largest piece | Keeps merges physically adjacent: culling, probes and light choice stay local |
| Fit the lightmap atlas budget, and stay under 200k vertices | One mesh must fit one lightmap; huge meshes cull badly |
| Are not reached by more runtime lights than BabylonJS applies per mesh (scene `maximumLights`, default 4), beyond what their most-lit piece already had | Merging must never cost a piece one of its lights |

**LOD groups** are merged as **LOD clusters**: nearby groups with the same level count, the same transition heights (typically instances of one prefab), the same fade mode and the same per-level settings. Level *i* of every member becomes one merged mesh, held by a new LOD group with exactly one renderer per level (BabylonJS's fast native LOD path). Because a bigger group switches later, the new transition heights are the old ones × (cluster size ÷ member size), and a cluster is split when a member would sit more than 20% of its LOD0→LOD1 switch distance from the cluster centre, or when the rescaled LOD0 height would reach 0.95. LOD levels above 0 may be probe-lit (seen only at distance).

**Lower LODs borrow LOD0's lightmap.** In Unity, a LOD1/LOD2 renderer that receives lightmaps but does not Contribute GI gets **LOD0's lightmap region** (same index and scale/offset), so its UV2 is authored to line up with LOD0's. The engine therefore records where each member's LOD0 UV2 was packed and applies that exact scale and offset to the member's lower levels; packing them independently turned merged rocks black at LOD1. Such clusters need exactly one LOD0 renderer per member and UV2 on every sharing level, otherwise the group is kept separate. Billboard / SpeedTree / skinned LODs, empty levels, and renderers shared between levels are left alone too.

---

# Pipeline

Read the Babylon Toolkit Agent Reference router and its `unity-exporter-cli.md`, `unity-editor-commands.md` and `unity-authoring-recipes.md` (§4 lightmaps, §5–6 probes, §17 LOD, §19 static flags, §21 verification) before the first run in a session — unless your prompt already carries those excerpts.

Set these once:

```bash
PROJ=<absolute Unity project path>          # folder holding Assets/
SKILL_DIR=<absolute path of this skill's folder>
SOURCE=Assets/.../Scene.unity               # from the arguments, or the active scene (bt_status → scene)
OUT=Assets/.../Scene_Combined.unity         # --out, or <source folder>/<SceneName>_Combined.unity
NAME=$(basename "$OUT" .unity)              # reports live in $PROJ/_combine/$NAME/
OPTIONS='{"cellSize":15,"maxSpread":3,"maxAtlasShare":0.45,"includeShaderGraphs":false,"combineLods":true,"exclude":[],"only":[],"extraShaders":[]}'

bt_run() {  # bt_run <Method> '<json args array>'
  unity command run_script --file AgentScripts/bt-combine/BtCombine.cs --entry "BtCombine.$1" --args "$2" \
    --timeout_ms 1800000 --timeout 1900 --project-path "$PROJ" --format json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['data']['result']; print(r.get('result') if r.get('success') else 'FAILED: '+json.dumps(r.get('diagnostics') or r.get('errorDetails') or r)[:4000])"
}
OPTS_ARG=$(python3 -c "import json,sys; print(json.dumps([sys.argv[1]]))" "$OPTIONS")   # options JSON wrapped as a one-string args array
```

Map flags into `OPTIONS` (`--exclude:A,B*` → `"exclude":["A","B*"]`, `--include-shadergraphs` → `true`, `--no-lods` → `"combineLods":false`, …).

## Phase 0 — Preflight

```bash
unity pipeline list                                   # Editor running, Pipeline reachable, not in Safe Mode
unity command editor_status --project-path "$PROJ"    # ready, not in Play mode (editor_stop if it is)
mkdir -p "$PROJ/AgentScripts/bt-combine" && cp "$SKILL_DIR/scripts/BtCombine.cs" "$PROJ/AgentScripts/bt-combine/"
bt_run Preflight "[\"$SOURCE\"]"
```

Stop and report if: no Editor is reachable (say how to start one — `unity-exporter-cli.md` §6), the source does not exist, **any open scene has unsaved changes** (`activeScene=… dirty=True`, or a `PrepareCopy` error naming the scene — ask the user to save or discard; never save or discard their scene for them, and never open another scene over it), or `packSourceLightmapUVs=False` (their `CanvasTools.dll` predates the packing combiner — merging would split vertices; tell them to update the toolkit, or proceed only if they explicitly accept with `allowUnityUnwrap`).

## Phase 1 — Analyse

- `--analyze`: `unity command open_scene --path "$SOURCE"`, then `bt_run Analyze "$OPTS_ARG"`, summarise `_combine/<SourceName>/analysis.md`, stop.
- Otherwise: `bt_run PrepareCopy "[\"$SOURCE\",\"$OUT\",<true if --reset else false>]"`, then `bt_run Analyze "$OPTS_ARG"`.

If the working copy already holds merges (Apply refuses: "already combined"), either continue from Phase 3 with the existing result or rerun with `--reset` — ask only if the user's intent is unclear.

Tell the user, in a few lines: meshes and estimated draw calls before → after, number of static merges and LOD clusters, the top three "kept separate" reasons, and anything they could change to merge more (for example: "142 rocks are skipped only because they are not marked Static"). Then continue — do not wait for approval; the source is safe.

## Phase 2 — Apply

```bash
bt_run Apply "$OPTS_ARG"
```

Read the output: every group's `verts a -> b` must be equal (a mismatch or a `WARNING … re-unwrapped` line means bloat — stop and report). `needsBake=True` means Phase 3 is required.

## Phase 3 — Bake (skip only with --no-bake)

The working copy needs its own lightmaps: merged meshes have new lightmap UVs, and a copied scene still points at the source's LightingData.

```bash
unity command bake_lighting --dry_run true --project-path "$PROJ"
unity command bake_lighting --confirm true --project-path "$PROJ"
deadline=$((SECONDS+5400)); seen=""
while :; do
  s=$(unity command lighting_bake_status --project-path "$PROJ" --result-only 2>/dev/null)
  case "$s" in
    *completed*) break;;
    *failed*) echo "bake failed: $s"; break;;
    *baking*|*running*|*in_progress*) seen=1;;
    *idle*) [ -n "$seen" ] && { echo "bake stopped without completing"; break; };;
  esac
  [ $SECONDS -ge $deadline ] && { echo "bake timed out"; break; }
  sleep 15
done
unity command save_all --project-path "$PROJ"        # the bake assigns new LightingData; exports refuse a dirty scene
bt_run CorrectDensity '[]'
```

**Density correction (one extra bake).** Unity sizes a merged mesh in the lightmap slightly smaller than the sum of its parts — measured on a 900-piece garden: median 84–89% of the sources' texel density, down to 73% for clusters of many small pieces. `CorrectDensity` measures every merged lightmapped mesh against its sources and raises its Scale In Lightmap by exactly the shortfall (target 95%, at most ×2). When it reports `corrected=N` with N > 0, run the bake loop above **once more**, `save_all`, then:

```bash
bt_run Verify '[]'
```

`Verify` must end with `problems=0` (it flags density below 80% of the sources, missing lightmap slots, UV2 outside 0..1, malformed LOD clusters, and LightingData that is not this scene's). Typical fixes: no lightmap slot → bake again; density still low → lower `--atlas-share` and `--reset`; LightingData not this scene's → the bake did not finish or was not saved.

## Phase 4 — Unity side-by-side (LOD0 **and** LOD1)

The spawn view alone is not enough: a merge can look right up close and wrong at distance (lower LOD levels), or right in the open and wrong in a corridor. Capture the spawn view, then the three largest merges at LOD0 and forced LOD1, in both scenes (GPU Resident Drawer must be off in batch Editors — `unity-editor-commands.md` §8.1):

```bash
CAPS="$PROJ/_combine/$NAME/captures"; mkdir -p "$CAPS"
CAM=$(unity command eval 'return UnityEngine.Camera.main != null ? UnityEngine.Camera.main.name : "";' --project-path "$PROJ" --result-only | python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")
cap() { unity command capture_game_view --camera "$CAM" --width 1280 --height 720 --project-path "$PROJ" --result-only --timeout 300 \
  | python3 -c "import json,sys,base64; d=json.load(sys.stdin); d=json.loads(d) if isinstance(d,str) else d; open(sys.argv[1],'wb').write(base64.b64decode(d['base64']))" "$1"; }

cap "$CAPS/unity_spawn_combined.png"
unity command open_scene --path "$SOURCE" --project-path "$PROJ"; cap "$CAPS/unity_spawn_source.png"
unity command open_scene --path "$OUT" --project-path "$PROJ"

bt_run QaPoints '[3]' > "$CAPS/points.txt"                 # name|x|y|z|size of the largest merges (LOD clusters first)
while IFS='|' read -r name x y z size; do
  [ -z "$name" ] && continue
  dist=$(python3 -c "print(max(4.0, float('$size') * 1.5))")
  for lod in 0 1; do
    for which in source combined; do
      scene=$([ "$which" = source ] && echo "$SOURCE" || echo "$OUT")
      bt_run QaView "[\"$scene\",$x,$y,$z,$dist,$lod]" >/dev/null && cap "$CAPS/unity_${name}_lod${lod}_${which}.png"
    done
  done
done < "$CAPS/points.txt"
unity command open_scene --path "$OUT" --project-path "$PROJ"     # QaView never saves; reopening discards the QA camera
```

Open every source/combined pair and compare: material, moss/detail, baked shadows and brightness must match. A merged object that is darker, black or blotchy **only at LOD1** is a lower-LOD lightmap problem; one that is wrong at LOD0 is a probe or lightmap problem — exclude that merge (Phase 6 loop) and report it.

## Phase 5 — Export and numbers (skip only with --no-export)

```bash
unity command bt_export_level --scene "$OUT" --project-path "$PROJ" --timeout 3600
```

The source's export must exist for comparison: find `<exportRoot>/scenes/<source name>.gltf` (`bt_status` → `exportRoot`; the project may lower-case file names). If it is missing or older than the source scene file, export the source too (`bt_export_level --scene "$SOURCE"`). Record both export durations.

```bash
mkdir -p "$PROJ/_combine/.qa-tools" && cp "$SKILL_DIR"/scripts/qa/* "$PROJ/_combine/.qa-tools/"
(cd "$PROJ/_combine/.qa-tools" && npm install --silent)      # puppeteer-core, kept out of the Unity project's package.json
node "$PROJ/_combine/.qa-tools/gltf-stats.mjs" <source.gltf> <combined.gltf>
```

## Phase 6 — Browser comparison (skip only with --no-browser)

```bash
unity command bt_devserver_start --project-path "$PROJ"        # rerun after any domain reload — it stops the server
node "$PROJ/_combine/.qa-tools/compare-browser.mjs" --base http://localhost:<port> \
  --scenes <source>.gltf,<combined>.gltf --times 10,15,20,30 --out "$PROJ/_combine/$NAME/captures"
```

Use the harness's own browser tool instead when it has one and it works. The script prints `{ sheet, results }`: open **`sheet.png`** first — one row per moment, one column per scene — then the full-size frames you need. Load time and console errors are in `results` (both scenes must be error-free).

Flythroughs start when the scene is ready, so **the two runs are usually offset by a few seconds** (on a 900-piece garden the combined scene ran 5–10 s ahead of the original — it finished loading sooner). Pair frames by matching view, not by timestamp: find the same view in both columns, note the offset, and compare those pairs at full size. Report the offset as a load-time observation (headless, single run). Capture enough moments (`--times 20,25,…,90`) to cover the offset.

**Regression loop (at most 3 rounds).** If a region looks different (darker, flatter, wrong reflections, LOD popping):

1. Identify the merge: match the region against `manifest.json` (`combinedPaths`, `sources`, `containers`, probe names).
2. Add its sources' container or names to `exclude`, say why in one line, then `PrepareCopy … true` (reset), Analyze, Apply, Bake, Verify, export, compare again.
3. If it is still different without that merge, the cause is not merging — compare against a re-baked **uncombined** copy (PrepareCopy to `<Scene>_Control.unity`, bake, export, capture; delete it afterwards with `RemoveCopy`). A difference that the control also shows is the re-bake (often a stale source bake), not this skill — report it as such.

## Phase 7 — Report

Reply in plain language, with images. Put this structure in the reply and in `_combine/$NAME/report.md`:

- **Result:** working copy path; meshes, drawn mesh nodes, primitives, drawn vertices and export size before → after (`gltf-stats`); export time before → after; draw calls estimated before → after.
- **What merged:** static merges and LOD clusters, the biggest ones by name.
- **What stayed separate and why:** the top reasons with counts, and which ones the user can unlock (mark static, opt into Shader Graphs, fix mirrored prefabs…).
- **Checks:** Verify result, Unity captures, browser frames with load time and console errors; anything skipped or unverified, stated as such.
- **How to undo or redo:** `--reset`, or delete the working copy and `<SceneName>_CombinedMeshes/`.

---

# Files this skill writes

| Path | What |
|---|---|
| `<out scene>` | the working copy (combined) |
| `<out scene folder>/<OutName>_CombinedMeshes/*.asset` | merged meshes |
| `<out scene folder>/<OutName>/` | the copy's baked lighting |
| `_combine/<OutName>/analysis.md`, `analysis.json` | the plan and every reason |
| `_combine/<OutName>/manifest.json`, `verify.md`, `report.md`, `captures/` | what was done and how it was checked |
| `AgentScripts/bt-combine/BtCombine.cs`, `_combine/.qa-tools/` | the engine and the QA tools (outside `Assets/`, no recompiles) |

# Troubleshooting

| Symptom | Fix |
|---|---|
| `FAILED: … Compilation Failed` from `bt_run` | Read the diagnostics; the toolkit DLL may be older than this skill (`UnityMeshSimplifier.MeshCombiner`, `UnityTools.GetMaxSimultaneousLights` must exist) |
| Apply: "no Pack Source Lightmap UVs mode" | Update the Babylon Toolkit (`CanvasTools.dll`); never accept bloat silently |
| Apply: "already combined" | `--reset`, or continue from Phase 3 |
| Bake never completes | Check `console --level error`; GPU lightmapper may fall back to CPU and take much longer — raise the deadline |
| Export refuses: unsaved changes | `unity command save_all` after the bake |
| Browser: connection refused | The dev server stops on every domain reload — `bt_devserver_start` again |
| Merged area darker in the browser only | Probe or light choice: lower `--spread` / `--cell`, or `--exclude` that container; then the control test above |
