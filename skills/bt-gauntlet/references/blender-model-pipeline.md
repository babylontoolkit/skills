# Pipeline: `blender-model`

**Deliverable:** a high-fidelity model or asset authored/refined in headless Blender — geometry, UVs, PBR
maps, LODs, skinning, animation — delivered either as a `.glb` straight to BabylonJS, or as an FBX inside a
Unity project for a `unity-level` job to compose with.

> **Required reading before round 1.** Fetch and read the Agent Reference's
> [Blender Headless CLI Instructions](https://raw.githubusercontent.com/babylontoolkit/agent/main/references/unity-blender-cli.md)
> in full. Section numbers below refer to it. Builder subagents must be given it too.

---

## 1. Decide the destination first — it changes everything downstream

| The asset needs… | Route |
|---|---|
| Interactive components (Rigidbody, Animator, AudioSource, NavMeshAgent, LODGroup …) | **Blender fixes the model → Unity composes → Toolkit exports.** Blender **cannot** write `extras.metadata.components`; those come from Unity, and only under a Pro licence. |
| Geometry / materials / animation only — a prop, a clip, a static mesh | **Export `.glb` straight from Blender and skip Unity entirely.** |

Record the route in `pipeline.md`. It decides where the artifact lives, how it is verified, and whether the
`unity-level` pipeline's licence gate applies.

## 2. Prerequisite gate — before round 1, and again on every resume

```bash
blender --version
blender -b --factory-startup --python-exit-code 1 \
        --python-expr "import bpy; print('bpy', bpy.app.version_string)"
```

| Must be true | Why |
|---|---|
| Blender resolves on PATH (or the `bpy` pip module is importable) | no builder can run |
| The canonical four flags are used on **every** invocation | see below |
| The importers/exporters you need exist **in this build** | operator names moved in 5.x — enumerate, never assume (§3) |
| For the Unity route: the `unity-level` prerequisite gate also passes | components and the export come from Unity |

**The canonical invocation — use all four flags every time:**

```bash
blender --background --factory-startup --python-exit-code 1 \
        --python /path/to/script.py -- arg1 arg2
```

> ⚠️ **A Python exception does not fail the process.** Blender prints the traceback and exits `0`. Without
> `--python-exit-code 1` the loop will record a crashed round as a success and the critic will be handed
> stale evidence. This is the single most dangerous gotcha in this pipeline.

Introspect before relying on any operator (§7):

```python
print(sorted(n for n in dir(bpy.ops.export_scene) if not n.startswith('_')))
print(bpy.ops.export_scene.gltf.__doc__)
```

### `pipeline.md` for this kind

```markdown
# Pipeline — blender-model
Route          : glb-direct | via-unity
Blender        : 5.1.2  (path: /Applications/Blender.app/Contents/MacOS/Blender)
Source asset   : /abs/path/UnityProject/Assets/Models/character.fbx
Write mode     : IN PLACE (GUID preserved)  |  NEW PATH (GUID reset — settings copied)
Backup         : character.fbx.bak
Viewer page    : http://localhost:8888/viewer.html?asset=character.glb
Viewer lighting: FIXED — hdri studio.hdr, exposure 1.0, no post   (never change mid-run)
Tri budget     : 45k  ·  Texel density: 512 px/m
```

---

## 3. In place vs. new file — the rule that protects the whole project

| | **Edit in place** (overwrite the FBX) | **Create a new model** (new path) |
|---|---|---|
| Unity GUID | ✅ preserved | ❌ new GUID |
| Existing scene / prefab references | ✅ all survive and pick up the change | ➖ referenced by nothing |
| Importer settings — rig, avatar, clips, scale | ✅ preserved (`.meta` untouched) | ❌ **reset to defaults** |
| Use for | iterating on an asset already in scenes | variants, LODs, experiments |

**A gauntlet iterates on the same asset for many rounds. That makes in-place the default, and it makes this
a hard loop rule:**

- **Always back up first** — the write is destructive: `cp "$FBX" "$FBX.bak"`.
- **Never delete-then-recreate.** Removing the file removes its `.meta`, which destroys the GUID and breaks
  every scene and prefab that referenced it. Overwrite the bytes; leave the `.meta` alone.
- When a round genuinely needs a new path (an LOD, a variant), **copy the importer settings across** — Unity
  will not (§8.3) — and record it in the round journal.

After any write, refresh Unity and confirm the GUID survived:

```bash
unity command eval 'UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceSynchronousImport); return "ok";' --project-path "$PROJ"

unity command eval 'string p="Assets/Models/character.fbx";
var i=(UnityEditor.ModelImporter)UnityEditor.AssetImporter.GetAtPath(p);
return UnityEditor.AssetDatabase.AssetPathToGUID(p) + " rig=" + i.animationType + " scale=" + i.globalScale;' \
  --project-path "$PROJ"
```

---

## 4. Part taxonomy — the default decomposition

| Part | Owns |
|---|---|
| **P1 Silhouette & proportion** | primary forms, scale against reference, readability at thumbnail size |
| **P2 Secondary forms** | panel breaks, bevels, structural detail, booleans and remesh cleanup |
| **P3 UVs & texel density** | unwrap, seam placement, uniform px/m, no stretching, atlas packing |
| **P4 PBR materials** | albedo, roughness, metallic, normal, AO — generated or baked, never flat placeholders |
| **P5 Baked maps** | high-to-low normal and AO bakes, curvature, cavity |
| **P6 Detail pass** | wear, edge damage, grime in crevices, decals, micro-normal |
| **P7 Topology & LODs** | tri budget, decimate chain, normals recalculated, no n-gons where they matter |
| **P8 Rig & skinning** *(if animated)* | weights ≤ 4 influences/vertex, normalised to 1.0, bone names matching the Unity Avatar rig |
| **P9 Integration** | scale, orientation, pivot, naming, `add_leaf_bones=False` on FBX export, collision proxies |

**Textures are generated, not procedural.** Where an image-generation tool is configured (the toolkit's
`kie-image` MCP — `generate_image`), use it for albedo, normals, roughness masks and detail maps. Do not
substitute procedural noise or flat colours for missing maps; that is the fastest route to a plastic-looking
asset and the critic will name it every round.

---

## 5. Verify recipe — the round's step 4

### 5.1 The engine is the truth, not the Cycles render

**Primary evidence: the asset loaded in BabylonJS, in a browser, under the fixed viewer lighting rig.** A
Cycles/EEVEE render flatters a model in ways the real-time engine will not — it is a diagnostic, not the
verdict.

- **Via Unity route:** re-export the level and load it off the toolkit dev server
  (`unity-exporter-cli.md` §12) — that is how you verify the round trip actually survived.
- **glb-direct route:** serve the `.glb` into a minimal BabylonJS viewer page and screenshot that.

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "http://localhost:8888/scenes/level01.gltf"
```

### 5.2 Lock the viewer, not just the camera

Two variables must be frozen or every round changes more than the model:

1. **The camera set** — fixed orbit angles recorded in `cameras.md`: a hero 3/4, a front elevation, and at
   least one detail crop. Same distance, same fov, same resolution, every round.
2. **The lighting rig** — one HDRI, one exposure, no post. Written into `pipeline.md` and never changed
   mid-run. A model that "got better" under a different HDRI did not get better.

### 5.3 The Blender-vs-engine gap

Render the same locked angles from Blender as a **secondary** frame. When the Blender render looks right and
the engine frame looks wrong, the round's problem is the export or the material translation — not the
sculpt. Make the critic say which side the gap is on, exactly as the `unity-level` pipeline does for the
Unity-vs-export boundary.

### 5.4 Metrics

Collect into `evidence/round-NN-<part>-metrics.json`: triangle count, material and texture count, texture
memory, texel density, influence count per vertex (max), whether weights normalise to 1.0, load time, and
browser console errors.

---

## 6. Extra critic inputs and gates for this pipeline

Scored on the **model / asset rubric** in `critic-rubrics.md` (Silhouette & Proportion, Surface & Material,
Detail Density, Topology & Efficiency, Integration Readiness).

**Hard gates:**

| Gate | Fails when |
|---|---|
| **Tri / texture budget** | the loop card's budget is exceeded |
| **Engine-legal skinning** | any vertex has > 4 influences, or weights do not normalise to 1.0 |
| **Rig names** | bone names no longer match the Unity Avatar/Animator rig |
| **Transform hygiene** | scale, orientation or pivot is wrong at import — the most common silent defect on generated and converted assets |
| **GUID survival** | an in-place round changed the GUID, or importer settings were reset |
| **Console** | the `.glb` produces errors on load |
| **No placeholder maps** | a material ships with flat-colour or procedural-noise stand-ins for maps the target needs |

---

## 7. Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| A crashed round recorded as success | missing `--python-exit-code 1` | always pass all four canonical flags |
| `bpy.ops.import_scene.fbx` not found | operator names moved in 5.x (`bpy.ops.wm.fbx_import` is native now) | enumerate the operators in *this* build (§3) |
| Every scene reference to the model broke | wrote to a new path, or delete-then-recreate | edit in place; never remove the `.meta` |
| Importer settings silently reset | new file path | copy them across explicitly (§8.3) |
| Model imports at 1/100 scale or lying on its side | FBX unit mismatch, or a generated asset's arbitrary orientation | `transform_apply` after fixing scale/rotation; check on every generated asset |
| Model looks great in Blender, dead in the engine | material translation or missing maps | §5.3 — isolate the side before re-sculpting |
| Components missing from the exported asset | Blender cannot write them, or community licence | components come from Unity under Pro only (§8.5) |
| `blender -b in.fbx` does nothing | not a valid invocation | import inside the script instead (§5) |
