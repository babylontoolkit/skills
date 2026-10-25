---
name: bt-unwrap
description: "The Babylon Toolkit Unwrap Skill turns a rough AI-generated (or any) 3D model into a clean, game-ready asset in one headless Blender run, and rebuilds its texture so it is crisp instead of smeared. It repairs the geometry (duplicate vertices, floating debris, holes, flipped normals, broken shading), decimates to a face budget while re-baking the lost detail into a normal map, turns the model to the glTF / BabylonJS forward direction (detected from reference silhouettes) at real-world scale with a sensible origin, and gives it a new UV layout of large, undistorted islands, with less texture spent on surfaces nobody can see. It bakes the source color, metallic-roughness and normal maps onto that layout with Cycles, then paints sharp reference images back on: straight views and three-quarter views alike, each with its camera solved from the silhouette (direction, perspective, scale, offset) and warped smoothly onto the mesh. Every face takes its color from the one view that sees it best — or keeps the model's own texture where the images disagree with the geometry, as they do on engines and cockpits — with seams steered away from logos and the lighting of every view evened out, so there are no ghosts, smears or collages. It ships web-ready output: one single-sided PBR material, 2048 WebP textures supersampled from 4096 (4096 on request), MikkTSpace tangents, optional Draco and LODs, plus before/after renders, coverage and clutter maps that show why each surface got its paint, the UV island map bt-atlas uses for new skins, and a JSON report an agent can check. Reads GLB, glTF, FBX, OBJ, USD/USDZ, PLY, STL, Alembic and .blend; writes GLB, glTF, FBX, OBJ, USD/USDZ and .blend. Use when a model from Tripo / Meshy / Hunyuan / Higgsfield image-to-3D (or a scan) has a melted or blurry texture, a fragmented UV atlas, too many faces, or the wrong orientation or scale (e.g. `/bt-unwrap models/kart.glb --refs kart_refs --faces 100000 --length 1.8`, `/bt-unwrap creature.fbx --unwrap smart --texture-size 4096`)."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

You are an EXPERT Babylon Toolkit technical artist who owns the asset pipeline end to end. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md).

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-unwrap <model> [--refs <folder>] [--ref <view>=<image>]... [--output <file> | --format <fmt>] [--out-dir <dir>]
           [--faces <n>] [--length <m> | --height <m> | --width <m>] [--origin bottom|center|keep]
           [--forward auto|keep|+x|-x|+y|-y] [--rotate <x,y,z>]
           [--unwrap views|smart|keep] [--projections 6|10|14] [--view-density <view=x,...>] [--hidden-density <x>]
           [--texture-size <px>] [--maps auto|color,metallic_roughness,normal] [--roughness <v>] [--metallic <v>]
           [--image-format webp|png|jpeg] [--draco] [--double-sided] [--lods <ratios>] [--analyze] [--no-preview]
```

- **`<model>`**: the model to clean up: `.glb .gltf .fbx .obj .usd .usda .usdc .usdz .ply .stl .abc .blend`.
  If it is missing, ask for it. Never guess a path.
- Plain words in the request map to flags. Translate them yourself: "100k faces" → `--faces 100000`,
  "1.8 m long" → `--length 1.8`, "hero asset" / "close-ups" → `--texture-size 4096`, "make the side panels
  sharper" → `--view-density left=1.5,right=1.5`, "as FBX" → `--format fbx`.

**Output**
- **`--output <file>`**: the output model; its extension picks the format (`.glb .gltf .fbx .obj .usd .usda .usdc .usdz .blend`).
  Default `<out-dir>/<name>.glb`.
- **`--out-dir <dir>`**: where everything goes. Default `<input folder>/<name>_unwrap/`. The input model is never
  modified, and an `--output` that would overwrite it is refused.
- **`--format <fmt>`**: `glb` (default), `gltf`, `fbx`, `obj`, `usd`, `usdz` or `blend`, used when `--output` is not given.
- **`--lods <ratios>`**: extra decimated copies that share the textures, e.g. `0.5,0.25` → `<name>_lod1.glb`, `<name>_lod2.glb`.
- **`--draco`**: Draco-compress the glTF / GLB geometry (several times smaller; BabylonJS needs its Draco decoder at
  load time).
- **`--analyze`**: detect the orientation and solve the reference cameras only. Writes the overlays and the
  report, no model. Seconds instead of minutes.
- **`--no-preview`** / **`--preview-size <px>`** (1024): skip, or size, the renders, check images and UV images.

**Geometry cleanup**
- **`--faces <n>`**: decimate to about n triangles (default: keep). A full-detail copy is kept for baking, so the detail
  survives in the normal map.
- **`--merge-distance <m>`**: merge vertices closer than this. Default: 0.001% of the model diagonal, which rejoins the
  vertices AI exporters split along UV seams.
- **`--debris-faces <n>`** (8): delete loose parts with fewer faces. `0` keeps everything.
- **`--fill-holes <n>`** (off): fill open holes bounded by up to n edges.
- **`--no-fix-normals`**: keep the original face winding (normally recalculated to point outward).
- **`--shading auto|smooth|flat|keep`** (auto) and **`--smooth-angle <deg>`** (30): `auto` = smooth with hard edges above
  the angle. Every mode except `keep` clears broken custom normals first.
- **`--keep-objects`**: keep separate objects and pivots (wheels, doors) instead of joining into one mesh. They still
  share one texture. Forced on for rigged models.

**Orientation and size.** The result always faces glTF +Z (Blender -Y), the glTF / BabylonJS forward direction.
- **`--forward auto|keep|+x|-x|+y|-y`** (auto): the Blender axis the model's front faces after import. `auto` detects
  it from the straight reference views (a side view, plus a front or rear view, settle it). Without them, the
  imported heading is kept.
- **`--rotate <x,y,z>`**: extra rotation in degrees applied first, for models imported lying down.
- **`--length <m>`**, **`--height <m>`**, **`--width <m>`**: scale to a real size; checked in that order, the first one given wins.
- **`--origin bottom|center|keep`** (bottom): `bottom` = centre of the footprint at floor level.

**UV layout**
- **`--unwrap views|smart|keep`** (views):
  - `views` lays every face out from the front, rear, left, right, top or bottom it faces most, for hard-surface
    models (vehicles, props, buildings, weapons);
  - `smart` is Blender Smart UV Project, for organic models (characters, creatures, rocks);
  - `keep` keeps the existing UVs.
- **`--projections 6|10|14`** (6): `views` directions: the box, plus horizontal diagonals (10), or plus corners (14).
  More directions mean less stretch on rounded bodies, but more islands.
- **`--hidden-density <x>`** (0.4): texel density of surfaces that none of 26 directions around the model can see
  (insides, undersides of covers), relative to visible surfaces. The space saved goes to what players see.
  `1` = uniform density.
- **`--view-density <view=x,...>`**: give chosen views more texture space, e.g. `left=1.5,right=1.5` for livery side
  panels, `bottom=0.5` for floors.
- **`--label-smoothing <n>`** (6), **`--min-island-faces <n>`** (24), **`--max-facing-angle <deg>`** (65): how noisy face
  groups merge into clean islands. Islands under the minimum are absorbed by their largest neighbour.
- **`--smart-angle <deg>`** (66): angle limit for `smart`.
- **`--pack-rotate any|cardinal|none`** (any): island rotation while packing. Islands render correctly at any angle;
  `any` packs tightest, `cardinal` turns in 90° steps, `none` keeps every island upright for painting by hand.
- **`--padding <px>`** (texture size / 512, at least 2): gap between islands, and edge padding, in output pixels.
- **`--no-fix-overlaps`**: don't repair folds. By default, where a surface doubles back inside its own island, the
  faces that see the island's view only at a grazing angle move to their next-best view. The report's
  `unwrap.fold_repair` says how many moved.

**Texture**
- **`--texture-size <px>`** (2048): output texture size. Textures are built at twice this (up to 4096, or
  `--work-size <px>`) and filtered down, so edges and text are as crisp as the size allows. 2048 suits game
  assets; use 4096 for hero assets seen in close-up.
- **`--image-format webp|png|jpeg`** (webp) and **`--image-quality <0..100>`** (90): how glTF / GLB stores its textures.
  WebP (`EXT_texture_webp`, which BabylonJS reads) keeps a 100K-triangle model with its 2048 maps around 5–7 MB.
  The files in `textures/` are always lossless PNG masters.
- **`--double-sided`**: render both sides of faces. Off by default, because a closed model never shows its back
  faces and culling them halves the shading work. Use it only for open, single-sheet surfaces.
- **`--maps auto|<list>`** (auto): `auto` bakes:
  - color, when the source has a color texture or vertex colors, or when references are given;
  - metallic-roughness, when the source has it;
  - a normal map, when the mesh was decimated: the shape detail the decimation removed, baked from the
    full-detail surface (exported with MikkTSpace tangents).

  A bare mesh (an STL, an untextured OBJ) with no references bakes nothing: it keeps its constant colour and gets
  the clean layout plus its island map, ready for painting. Or list the maps from `color,metallic_roughness,normal`.
- **`--roughness <0..1>`** / **`--metallic <0..1>`**: constants instead of the baked maps (AI metal/rough maps are often noise).
- **`--no-normal-map`**: never produce a normal map.
- **`--keep-source-normal-map`**: carry the source's own normal map over too. Off by default: a generator's normal
  map is mostly relief guessed from its own texture — logos embossed where it painted them, noise on smooth
  panels — and under real lighting it draws ghost logos and crumpled panels next to the repainted texture. Turn
  it on for a source whose normal map is genuine (a sculpt bake, a photogrammetry scan).
- **`--bake-distance <fraction>`** (0.004 of the diagonal), **`--bake-samples <n>`** (4), **`--device auto|cpu|gpu`** (auto):
  Cycles bake controls.

**Reference images**
- **`--refs <folder>`**: the folder of reference images, matched by file name:
  - straight views: `front`, `rear`/`back`, `left`, `right`, `top`/`plan`, `bottom`/`under`
    (e.g. `01_front_ortho.png`, `car_left_side.jpg`); with two candidates for one view, names containing `ortho` win;
  - angled views: names with `three_quarter`, `3-4`, `iso`, `angle`, `perspective`, or two neighbouring views
    (`front_left`, `top_rear`). All of them are used. Their camera is solved from the silhouette, so the left/right
    in a name does not need to be right (file names often give it from the viewer's side; the report says which
    way it really was). A `front` or `rear` in the name narrows the search;
  - detail, close-up, cutaway and turnaround-sheet images are skipped: they do not show the whole model.
- **`--ref <view>=<image>`**: name one image (repeatable; paths may contain `=` or `,`): a straight view, an angled
  view such as `front_left` or `top_rear_right`, or `oblique` for an angle to be found anywhere around the model.
- **`--no-oblique`**: use straight views only.
- **`--ref-rotate <view>=<deg>`**: fix a straight reference's in-plane rotation. Top and bottom views are detected otherwise.
- **`--ref-bg-tolerance <0..1>`** (0.08): background separation. Transparent PNGs use their alpha instead.
- **`--ref-min-iou <0..1>`** (0.80): references whose fitted silhouette matches worse than this are skipped.
- **`--ref-align fit|refine`** (refine): `refine` also searches small scale and offset corrections. The camera
  direction (a few degrees of tilt for straight views — AI "orthographic" images are often taken from slightly
  above), perspective and rotation are always fitted.
- **`--no-ref-warp`** / **`--ref-warp-max <fraction>`** (0.04): local alignment. Each reference is matched patch by
  patch against the source texture rendered from the same camera, and a smooth correction is fitted to the
  matches (close to a uniform stretch, so straight edges stay straight). The max caps the shift at a fraction of
  the subject size.
- **`--ref-consistency <0..1>`** (0.5): how closely, in cluttered parts of the model, a reference's features (part
  edges, letters, stripes) must line up with the model's own texture before it may paint them. Engines, cockpits
  and suspension are where a generated image and a generated mesh draw different parts; there the model keeps its
  own coherent texture instead of a projected collage. Smooth panels take references as decals regardless.
  Higher = stricter; `0` = trust references everywhere.
- **`--ref-source-score <0..1>`** (0.35): how good a view must be on a face (how head-on × how much of the face it
  sees × its consistency) to replace the model's own texture there. Higher keeps more of the source.
- **`--ref-seam-smoothness <x>`** (0.12): how strongly neighbouring faces take the same view. Higher = larger
  single-view patches and fewer seams; seams cost more where the two views look different, so they settle in plain
  areas instead of cutting through logos.
- **`--ref-max-angle <deg>`** (70): surfaces turned further than this from a view get nothing from it.
- **`--ref-strength <0..1>`** (1.0): overall reference opacity.
- **`--ref-normal-smoothing <n>`** (8): views are weighed by normals smoothed over n edge rings, so a lumpy AI panel
  is painted evenly from one view instead of in patches.
- **`--ref-edge-inset <px>`** (3), **`--depth-tolerance <fraction>`** (0.01): edge-fringe and visibility-test slack.
- **`--no-color-match`**: don't match the source texture's colours to the references.
- **`--no-exposure-match`**: don't even out the lighting baked into each reference. By default each view gets a
  gain measured against the source texture where both agree (overall brightness kept, at most ×1.8), so a
  backlit rear view does not paint the back of the model darker. The gains are in the report
  (`textures.compose.exposure_gains`).

**Launcher only**
- **`--blender <path>`**: use this Blender (else `$BLENDER`, then PATH, then the usual install folders).
- **`--verbose`**: show Blender's full log, and the Python traceback behind a `FAILED` line.
- **`--which-blender`**: print the Blender it would use.

## Examples

```
/bt-unwrap models/kart.glb --refs f1_kart_refs --faces 100000 --length 1.8
/bt-unwrap models/kart.glb --refs f1_kart_refs --analyze
/bt-unwrap models/kart.glb --refs f1_kart_refs --texture-size 4096 --roughness 0.45 --metallic 0
/bt-unwrap models/kart.glb --ref front=shots/a.png --ref oblique=shots/hero_angle.png --ref left=shots/b.png
/bt-unwrap hero_highpoly.glb --faces 30000 --lods 0.5,0.25 --draco
/bt-unwrap creature.fbx --unwrap smart --format fbx
/bt-unwrap scan.obj --unwrap keep --faces 50000 --no-preview
```

---

# What it does

One command runs the whole clean-up in headless Blender:

1. **Import** any supported format.
2. **Orient and size.** Turn the model so its front faces glTF +Z. With straight references, the forward axis is
   **detected** by fitting the model's silhouette into every view. Then scale it to real size and set the origin.
3. **Repair geometry.** Merge duplicate vertices, dissolve zero-area faces, delete loose geometry and
   floating debris, optionally fill holes, make normals point outward, and set clean shading.
4. **Decimate** to the face budget. A full-detail copy is kept, and its detail is baked into the normal map.
5. **New UV layout.** `views` lays every face out flat as seen from the view it faces most: large, undistorted,
   never-mirrored islands, with seams where the facing direction changes. Noisy face groups are smoothed, small
   islands are absorbed, folds are split off, density is evened out, surfaces nobody can see are given less
   space, and everything is packed tightly with padding.
6. **Bake** the source base color, metallic-roughness and normal maps onto the new layout with Cycles, at twice
   the output size. The normal map is baked in the new tangent space, so it stays correct.
7. **Solve each reference's camera.** Each image is cut out from its background (only background connected
   to the image border counts, so white logos on a light backdrop are kept), then fitted to the mesh by its
   silhouette: camera direction (a small tilt for straight views; a full search around the model for angled
   views), perspective strength (AI "orthographic" images are really perspective renders), in-plane rotation,
   scale and offset. A smooth local warp then lines the image up with the model's own texture.
8. **Check consistency.** Each reference is compared with the model's own texture seen from the same camera.
   Where the model's texture shows features, a trustworthy reference shows the same ones in the same places.
   The model also knows where it is cluttered: where much of the surface around a face is hidden from the views
   that face it (engines, cockpits, suspension).
9. **Choose one source per face** — the view that sees the face most head-on and most completely, discounted in
   cluttered parts by how far it disagrees with the model's own texture, or that texture itself. Neighbouring
   faces then vote, so panels come from one view, and seams are steered to places where the two candidates look
   alike instead of through logos. Colours blend only across the one ring of faces at a seam, so nothing is
   averaged into a ghost. **Exposure is evened out** between views, the source texture's colours are matched to
   the references, and island edges are padded.
10. **Filter down and ship.** The maps are filtered to the output size, and the model gets one single-sided PBR
    material, MikkTSpace tangents when it has a normal map, WebP textures, and optional Draco and LODs. The
    bake reads an untouched copy of the imported model, so its shading is carried over as authored; a
    generator's guessed normal map is left out (see `--keep-source-normal-map`).
11. **Proof:** before/after renders from seven views, a comparison sheet, the coverage and clutter maps, one
    alignment overlay, warp check and consistency check per reference, the UV images, and a JSON report.

**Why this fixes the "melted" look.** Image-to-3D generators project a few generated views onto the mesh.
Surfaces no view saw head-on (tops of wings, noses, seats) get stretched or invented pixels, and the texture is
scattered over thousands of tiny UV fragments. bt-unwrap replaces both: big clean islands, painted from the sharp
source images at the angle they were drawn from — including the top and three-quarter views generators cannot
take — and only where those images agree with the geometry.

## Requirements

- **Blender 4.2+** (5.x recommended). The launcher finds it on macOS, Windows and Linux.
- **Node 18+** for the launcher. Nothing to install: the pipeline uses the numpy bundled with Blender.
- Scripts live in `<skilldir>/scripts/`: the launcher `bt-unwrap.mjs` and the pipeline `blender/*.py`.
  Resolve `<skilldir>` as the folder that holds this SKILL.md. Always copy the whole `scripts/` folder with it.

---

# Procedure

### 0. Validate the input
Confirm the model file exists and has a supported extension. If references were given (a folder, or
images per view), confirm they exist. Never downscale reference images: full resolution is detail.

### 1. Check the references first (when there are any)
```
node <skilldir>/scripts/bt-unwrap.mjs <model> --refs <folder> --analyze
```
Read the summary lines and open `preview/align_<view>.png`. The red-tinted area is the mesh silhouette as the
solved camera sees it, and it should cover the subject.

- `iou` of **0.90+** is a good fit; **0.80–0.90** is usable, because AI meshes are blobbier than their images.
- Below `--ref-min-iou`, the image is skipped with a warning.
- Wrong heading (the outline shows the model's back on the front image): set `--forward`.
- An oddly rotated top view: `--ref-rotate top=90`.
- A shadow or floor counted as subject: raise `--ref-bg-tolerance`.
- The report's `references.notes` lists every skipped file, and every angled view whose name disagreed with
  where its camera really is.

### 2. Run
```
node <skilldir>/scripts/bt-unwrap.mjs <model> [options]
```
Measured on an Apple-silicon laptop with the Metal GPU, with eight references (five straight, three angled):
- a 100K-triangle model takes about 2 to 2.5 minutes at the default 2048 output (built at 4096);
- a 1.9M-triangle model decimated to 100K adds about 40 seconds and peaks around 12 GB of memory (Cycles holds
  the full-detail source for the bake). On a 16 GB machine, add `--work-size 2048` for very heavy inputs.

The CPU is slower. Run it in the background and wait for it to finish. Exit codes:
- `0`: done.
- `1`: failed (the reason follows `FAILED`).
- `2`: bad options.

### 3. Verify by looking
1. `preview/comparison.png`: before (left) and after (right), one row per view (front, left, rear, right,
   top, two three-quarters).
2. `preview/coverage_three_quarter_front.png` and `_rear.png`: which view painted what (legend below).
3. `textures/<name>_uv_layout.png`: islands packed tightly, none overlapping.
4. The summary lines and `<name>_report.json` (thresholds under **Running from a spec or plan**).

Judge the after renders honestly. Logos and numbers should be sharp and whole where a reference sees them, top
surfaces should no longer be smeared, and complex parts should look coherent, not like a collage. Tune (below)
and run again. Each run takes minutes, so change related options together.

### 4. Deliver
Report the output paths, the before/after numbers, the file size, and show the comparison image.

- For a Babylon Toolkit project, import the GLB into the Unity asset project, or load it straight into BabylonJS
  (it needs no extra loader beyond glTF; `EXT_texture_webp` is built in, and `--draco` models need the Draco
  decoder BabylonJS loads by default).
- For new skins of the same model, hand `textures/<name>_basecolor.png` and `textures/<name>_uv_islands.png`
  to **bt-atlas**.

---

# Running from a spec or plan

When a bt-execute task (or any plan) calls for bt-unwrap, run it unattended and prove the result.

**What the task should state** (and what to assume when it does not): the input model, the reference folder,
the face budget (default: keep), the real-world size (`--length` / `--height` / `--width`; default: keep), the
texture size (default 2048; 4096 for hero assets seen in close-up), the output format (default GLB) and where
the output goes (default `<input folder>/<name>_unwrap/`, never over the input).

**Acceptance checks, all from `<name>_report.json`:**

| Check | Pass | If it fails |
|---|---|---|
| Exit code | `0` and a `DONE` line | Read the `FAILED` reason; rerun with `--verbose` for the traceback |
| `steps.references.alignment[].silhouette_iou` | ≥ 0.85 for straight views, ≥ 0.80 for angled ones | Check `align_<view>.png`; fix heading, rotation or background tolerance |
| `steps.references.alignment[].used` | every image the task relies on | See the warning; a skipped image paints nothing |
| `steps.unwrap.overlap_percent` | ≤ 0.5 | `--projections 10`, or `--unwrap smart` for organic models |
| `steps.unwrap.uv_coverage_percent` | ≥ 30 (hard-surface) | `--label-smoothing 10 --min-island-faces 64` |
| `steps.textures.compose.reference_painted_percent` | the share the references can reach: typically 30–50 % for a vehicle with five to eight views | Open the coverage map: red = hidden (add a view), black = inconsistent (see Tuning) |
| `steps.export.file_megabytes` | within the task's budget (about 5–7 MB for 100K triangles at 2048 WebP) | `--draco`, `--texture-size 1024`, or `--faces` |
| `warnings` | empty, or each one understood and reported | — |

Then look at `preview/comparison.png` and the two three-quarter coverage renders before calling the task done —
numbers alone do not prove a texture looks right. Report the final paths, the checks above with their values,
and the comparison image. Never ask the user to pick options: choose them from the task and this document, state
the assumption, and iterate (each run takes minutes; change related options together, at most three runs).

---

# Outputs

```
<out-dir>/
  <name>.glb                         the model (or .gltf/.fbx/.obj/.usd*/.blend)
  <name>_lod1.glb …                  with --lods
  <name>_report.json                 every step's numbers, the options used, warnings, timings
  textures/
    <name>_basecolor.png             sRGB base color (lossless master; the model stores --image-format)
    <name>_metallic_roughness.png    glTF packing: G = roughness, B = metallic (when baked)
    <name>_normal.png                tangent-space normal map (when the mesh was decimated, or with --keep-source-normal-map)
    <name>_uv_islands.png            white islands on black: bt-atlas's <uv-layout> input
    <name>_uv_layout.png             island outlines over the base color
  preview/
    comparison.png                   before (left) | after (right), one row per view
    before_<view>.png, after_<view>.png
    align_<view>.png                 the solved camera's view of the mesh over each reference
    warp_<view>.png                  source render | reference as fitted | reference after the smooth warp
    consistency_<view>.png           source render | warped reference | reference with disagreeing features in red
    coverage_<view>.png              the coverage map on the model (legend below), and coverage_texture.png
    clutter_<view>.png               the clutter map on the model, and clutter_texture.png
```

**Coverage map legend.** Each colour names the view that painted the texel; brighter means fuller coverage:
front blue, rear yellow, left green, right cyan, top magenta, bottom orange; angled views front_left white,
front_right lime, rear_left brown, rear_right navy (other angles get olive, teal, lavender or salmon — the report's
`textures.compose.coverage.legend` lists every colour). Texels that kept the model's own texture show why:
- **red**: the view facing it could not see it (hidden behind other geometry);
- **pink**: it projected outside the reference's subject;
- **black**: the part is cluttered and the view's features disagree with the model's own texture there;
- **dark grey**: no view faces it closely enough, or the model's own texture scored higher.

**Clutter map legend.** Blue = open surface (references paint it as a decal), orange = cluttered (a reference
must agree with the model's own texture to paint it). The report's `textures.compose.cluttered_face_percent`
gives the share of faces.

# Reference images that work

- **The same design as the model.** The images the model was generated from are ideal.
- **The whole subject in frame**, on a plain or transparent background.
- **Straight views and three-quarter views.** Straight views (front, rear, sides, top) paint most of the surface;
  three-quarter views fill what they cannot see head-on (seat fronts, 45° panels, inner sides). Name angled
  images with `three_quarter` or a view pair; the camera is solved, so the exact angle does not matter.
- **Flat, even lighting** gives the cleanest albedo. Reflections in a reference are painted in as colour.
  Ask the image generator for "flat even studio lighting, no reflections, no shadows".
- **A top view matters most for vehicles.** Generators can't take one, and it fixes wings, noses, seats and roofs.
- **Full resolution.** Never downscale references.

# Tuning

| Symptom | Fix |
|---|---|
| Where did the references paint, and why not elsewhere? | Open `preview/coverage_<view>.png` (legend under Outputs) |
| Complex parts (engine, cockpit) still look like a collage | Stricter consistency: `--ref-consistency 0.7`; check `clutter_<view>.png` marks them orange |
| A logo on a panel is missing or cut | `consistency_<view>.png` shows it red: lower `--ref-consistency` (0.3); or larger patches: `--ref-seam-smoothness 0.2` |
| Too much of the model keeps its blurry own texture | Lower `--ref-source-score` (0.25) |
| Lots of pink on the coverage map | The subject cut-out is wrong: raise or lower `--ref-bg-tolerance`; check `align_<view>.png` |
| Logos land slightly off | Open `warp_<view>.png`: the third panel should line up with the first. If a whole region is off, raise `--ref-warp-max` (0.06) |
| A reference is SKIPPED (low iou) | Check `align_<view>.png`. Wrong heading: `--forward`. Rotated image: `--ref-rotate`. Background leaking into the subject: `--ref-bg-tolerance`. A genuinely different design: accept the skip, or lower `--ref-min-iou` slightly |
| An angled view solved to the wrong side | Name it with its true side (`--ref rear_left=…`); a `front` / `rear` in the name narrows the search |
| Visible seam where reference paint hands over to the source | Raise `--ref-max-angle` (80), or lower `--ref-source-score` |
| Texture soft in close-ups | `--texture-size 4096`; or `--view-density left=1.5,right=1.5,top=1.3` for key panels |
| GLB too big for the web | `--draco`; `--texture-size 1024`; `--faces` |
| Too many small islands | `--label-smoothing 10 --min-island-faces 64` |
| Stretching on rounded bodies | `--projections 10` or `14` |
| Organic model, messy layout | `--unwrap smart` |
| Black specks in the bake after heavy decimation | `--bake-distance 0.01` (up to 0.02) |
| Reflections painted into the colour | Flat-lit references, or a lower `--ref-strength` |
| Holes when seen from behind (open sheets: leaves, cards) | `--double-sided` |
| Lit in an engine, panels look crumpled or logos have embossed ghosts | Leave `--keep-source-normal-map` off (the default) |
| Lit in an engine, fine sculpted detail went missing | `--keep-source-normal-map` when the source's normal map is genuine; `--faces` decimation bakes lost shape automatically |
| Wrong heading, no references | `--forward +x` / `-x` / `+y` / `-y` |

# Limits

- It re-lays and re-paints. It does not retopologise to quads, or split a fused mesh into parts (wheels that
  spin, doors that open). Separate those in Blender, keeping the shared texture.
- References paint colour only. Metallic and roughness come from the source model, and normal detail from its
  geometry (and its own normal map, with `--keep-source-normal-map`).
- A reference can only paint what it shows. Surfaces no view sees keep the colour-matched source texture.
- Where the generated images and the generated mesh disagree, the model's own (softer) texture is kept on
  purpose: a sharp projection of the wrong part looks worse than a soft right one.
- Interactive Babylon Toolkit components still come from Unity: import the GLB into the Unity asset project.
