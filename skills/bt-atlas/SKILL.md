---
name: bt-atlas
description: "The Babylon Toolkit Texture Atlas Skill generates texture atlas skin variations for a UV-mapped 3D model that stay strictly inside the UV islands, so they are drop-in swaps for the same geometry. Use whenever the user wants new skins / texture variants (different colors, faces, materials, camo, liveries, etc.) from a base color texture and its UV layout. Works for any model — not specific to any one asset."
---

# Invocation

```
/bt-atlas <base-texture> <uv-layout> <variation-brief>
```
- **`<base-texture>`** — the existing skin; defines overall look & feel.
- **`<uv-layout>`** — the wireframe/island map for the same texture.
- **`<variation-brief>`** — how to vary the texture while staying within the UV islands.
- If any input is missing, ask for it before starting. Never guess a file path or URL.

Example:
```
/bt-atlas → base_texture.png → uv_layout.png → "Change clothing + face, keep the horse hide and the eye island"
```

---

# Generate Texture Atlas (UV-safe atlas variations)

Create N variations of a model's base color texture atlas using AI image
generation, guaranteeing every output keeps the **exact same UV layout** as the
base so it can be swapped onto the same model geometry/UVs without re-mapping.

Use the user's message after the skill name as the `arguments`.

The core trick: AI image editors will not respect UV-island edges on their own —
they bleed paint into the empty/padding areas and sometimes shift islands. So we
**never ship the raw AI output**. We generate, then **mask-and-composite**: keep
only the pixels inside the UV-island footprint from the AI image and take
everything else verbatim from the base texture.

This skill is general purpose. It makes no assumption about where islands sit in
the atlas (top/bottom/left/right) — the mask is derived automatically from the
UV layout image.

## Inputs you need from the user (ask if missing)
1. **Base color texture** (PNG) — the existing skin; defines overall look & feel.
   A local file path or an `http(s)://` URL both work.
2. **UV layout image** (PNG) — the wireframe/island map for the same texture
   (white island outlines on dark background is the typical export). If only a
   combined "all submeshes" layout exists, that works too. A local file path or
   an `http(s)://` URL both work.
3. **What to vary vs preserve** — e.g. "change clothing + face, keep the horse
   hide and the eye island". Inspect the base + layout yourself to identify the
   islands; confirm ambiguous ones with the user.
4. **Number of variations and a brief per-variation description** (the creative
   direction: skin tones, faces, color schemes, materials, etc.).
5. **Output directory** — default to a `SkinVariations/` folder next to the base
   texture if not specified.

If the base texture or UV layout isn't supplied at all, ask for it — don't
guess or substitute a placeholder. If it IS supplied (local path or URL) but is
wrong (path doesn't exist, URL isn't reachable / doesn't return an image, or
the content isn't actually an image), STOP before generating anything — do not
guess, substitute a different file, or continue with a partial setup. Tell the
user exactly which input failed and why, and ask for a corrected path/URL.

## Tools
- **Image generation**: pick the backend in this order:
  1. the tool or model the user named (e.g. "use nano-banana-2", "use Flux", "use Higgsfield");
  2. the **kie** image MCP (`kie-image-mcp`), the **default** where configured;
  3. the **Higgsfield CLI** (`@higgsfield/cli`) where installed and signed in;
  4. the host's built-in image generation, or any other configured image tool.

  Whichever tool is used, pass BOTH the base texture and the UV layout as reference
  images to it. Match `aspect_ratio` to the texture (usually `1:1`), request a
  resolution/size close to the texture size (e.g. `2K` for 2048px), and request
  PNG output. If no image-generation tool is available at all, tell the user
  and ask them to configure one before proceeding.

  - **kie**: `generate_image` with `reference_paths: [<base.png>, <uv_layout.png>]`
    (in that order), `out_path: <scratch>/raw/skin_var_NN.png`, `output_format: "png"`.
  - **Higgsfield CLI**: see the Babylon Toolkit reference `web-higgsfield-cli.md`. Install it locally
    (`npm i -D @higgsfield/cli`) and add the reference's download wrapper as `scripts/hf-generate.mjs` in
    the project. The CLI only returns URLs; the wrapper saves the file.
    1. **Upload both references once** and reuse the IDs for every variant, because every call that names
       a local path re-uploads it:
       `node_modules/.bin/higgsfield upload create <base.png> --json` and the same for `<uv_layout.png>`.
       Each returns `{ "id", … }`.
    2. **Use a model that takes several reference images**: `gpt_image_2_5` (default), `nano_banana_2`, or
       `seedream_v4_5`. Never use `z_image`, which accepts no references. Repeat the flag, base first:
       ```
       node scripts/hf-generate.mjs nano_banana_2 --prompt "<prompt>" \
            --image-references <base_id> --image-references <uv_id> \
            --aspect_ratio 1:1 --resolution 2k --out <scratch>/raw/skin_var_NN.png
       ```
    3. **Cost first**: run the same command once with `--cost` in place of `--out` (`nano_banana_2` at
       `2k` with references was 2 credits per image when verified). Tell the user the per-variant cost
       before a large batch.
    4. Run several variants as parallel wrapper calls from the shell, each with its own `--out`.
    5. The wrapper downloads each result to `--out`. `composite_skin.py` resizes it to the base texture's
       size itself, so an output at a different size needs no extra step.
- **Helper scripts** live in the `scripts/` folder next to this SKILL.md
  (need Python 3 + Pillow + numpy):
  - `scripts/uv_island_mask.py`  — build the island mask from the UV layout.
  - `scripts/composite_skin.py`  — composite one AI output through the mask onto the base.
  - `scripts/preview.py`         — `mask-overlay` to verify the mask; `sheet` for a contact sheet.
  Resolve `<skilldir>` as the directory containing this SKILL.md file, so scripts
  are at `<skilldir>/scripts/`. Install deps once if needed:
  `python3 -m pip install -r <skilldir>/scripts/requirements.txt`
  (or `python3 -m pip install pillow numpy`). Each script also auto-installs its
  own missing deps on first run.

## Procedure

### 0. Validate inputs
Confirm the base texture and UV layout are both usable before doing anything
else:
- **Local path**: confirm it exists and opens as a valid image.
- **URL**: confirm it's reachable and actually returns image content, then
  download it once into `<scratch>/` (e.g. `base_source.png` /
  `uv_layout_source.png`) — the helper scripts below only work on local files,
  so use these downloaded copies as "`<base.png>`"/"`<uv_layout.png>`" for every
  step from here on.

If either input fails validation, stop and report which one and why (missing /
wrong path / URL unreachable / not an image) instead of proceeding — never fall
back to a default or unrelated file.

### 1. Inspect
Read the base texture and the UV layout as images. Note the texture pixel size
(`sips -g pixelWidth -g pixelHeight <file>` on macOS, or open the image and check
its dimensions). Decide which islands change and which are preserved.

### 2. Build the UV-island mask
```
python3 <skilldir>/scripts/uv_island_mask.py <uv_layout.png> <scratch>/island_mask.png --size <TEXSIZE>
```
Defaults: `--radius 9 --thresh 35`. Increase `--radius` if big internal triangles
leave holes; lower `--thresh` if the wireframe is faint. Coverage is printed —
sanity check it (a full-body atlas is typically 20–50%).

### 3. Verify the mask (do not skip)
```
python3 <skilldir>/scripts/preview.py mask-overlay <base.png> <scratch>/island_mask.png <scratch>/overlay.png
```
Read `overlay.png`. The red tint MUST cover exactly the islands you intend to
change and NOT the preserved islands / dead space. If it's inverted or off,
re-run step 2 with adjusted params (the script already auto-strips a white border
frame; if the layout has unusual framing, that is the usual culprit).

### 4. Generate each raw variation
Save raw AI outputs to `<scratch>/raw/skin_var_NN.png` (NOT the final folder).
Use this prompt template with the chosen image-generation tool (the platform's
default, or whichever one the user named), filling the per-variation creative
bits and the preserve/change lists for the specific asset:

```
You are editing a {W}x{H} game model TEXTURE ATLAS (UV unwrap). Reference image 1
is the base color atlas (use it as the guide for overall look, layout and
proportions). Reference image 2 is the UV ISLAND MAP showing exact wireframe
outlines of every UV island.

ABSOLUTE LAYOUT RULES (this is a skin swap for one shared model — the UV layout
MUST match exactly):
- Reproduce reference image 1's GEOMETRY/LAYOUT exactly: every UV island stays in
  the same position, size, rotation and shape. Painted detail must fit inside the
  same island outlines.
- Keep these islands unchanged: {LIST WHAT TO PRESERVE}.
- Do NOT add any new art, portrait or object anywhere. Do NOT paint into the
  empty/black/white background. Paint ONLY inside existing colored islands.
- You may recolor/repattern ONLY: {LIST WHAT TO CHANGE}.
- Flat evenly-lit albedo/diffuse texture, no baked shadows.

VARIATION DETAILS: {creative description for this variant}
```
Generating several variants in parallel is fine. The raw output will likely bleed
outside the islands — that is expected and removed in the next step.

### 5. Composite through the mask -> final skins
For each variant:
```
python3 <skilldir>/scripts/composite_skin.py <base.png> <scratch>/island_mask.png \
    <scratch>/raw/skin_var_NN.png <FINAL_DIR>/skin_var_NN.png
```
This writes the shippable skin: island pixels from the AI image, everything else
identical to the base. Optional `--feather` (default 1.0px) softens the seam.

### 6. Review
```
python3 <skilldir>/scripts/preview.py sheet <scratch>/contact_sheet.png <FINAL_DIR>/skin_var_*.png
```
Read the contact sheet (and crop into key islands like faces if needed) to
confirm variety and quality. Regenerate any weak variants by repeating steps 4–5
for just those indices.

## Notes & gotchas
- Always pass BOTH base + UV layout as references to the generator; never rely on
  the prompt alone to hold the layout. On Higgsfield that means two
  `--image-references` flags, base first.
- Generated outputs (kie or Higgsfield) must end up as local files in `<scratch>/raw/`;
  never reference a remote result URL from the finals or the engine project.
- The mask is the safety net. If a variant's island content is shifted inside its
  island, the composite clips it to the island shape — re-prompt that variant
  rather than widening the mask.
- Keep raw AI outputs separate from finals so you can re-composite without
  re-generating (e.g. after tuning the mask).
- For engine import (Unity, Babylon, etc.), the finals go in the project's
  texture folder; the engine generates its own meta/import settings.

## How to use this skill
- Invoke it directly (e.g. the `/bt-atlas` slash command, if your tool derives one
  from this folder), or just ask in chat for new texture/skin variants — this
  skill applies whenever the request matches its description.
- Provide: the base color texture path, the UV layout image path, how many
  variations you want, and which islands to change vs preserve (a short
  creative direction per variation helps too). For example:
  > `/bt-atlas textures/hero_base.png textures/hero_uv_layout.png 4 vary armor color and face, keep the sword and hair`
- Anything you omit will be asked for before generation starts (see **Inputs**
  below). You can also name a specific image-generation tool/model to use (see
  **Tools** below) — otherwise the default available one is used.
- Output lands in `SkinVariations/` next to the base texture unless you specify
  another output directory.
