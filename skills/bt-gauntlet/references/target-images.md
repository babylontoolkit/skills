# The Target — locking the bar as pixels

A gauntlet cannot converge on prose. "AAA quality" is not a bar; an image is. This document covers how the
target gets created, checked, locked, and paired with cameras.

Borrowed from the dream-loop pattern and adapted: the target is generated *first*, then the loop closes the
gap to it.

---

## 1. Where the target comes from

**In priority order:**

1. **The user supplied reference media.** Use it directly. Copy into `_gauntlet/<name>/reference/`, named
   per part/camera where possible (`hero-01.png`, `alley-02.png`).
2. **There is an existing artifact to improve.** Capture the current state first, then feed that screenshot
   to the image model as the **baseline** and ask for a refinement along the user's direction — so the
   target is an *improvement on what exists*, not a divergence from it. This matters: a target that
   reimagines the scene sends the loop chasing a layout it was never asked to build.
3. **Starting fresh.** Generate the target directly from the brief.

### 1a. Generation backends — kie by default, Higgsfield supported

Every `generate_image(...)` call in this skill is written in the **kie** shape. Pick the backend once, at
the interview, and record it in `pipeline.md` so a resumed session uses the same one:

1. **The user named a backend or model** → use it.
2. **kie** (`kie-image` MCP) is configured → **default**.
3. **Higgsfield** MCP (`mcp__higgsfield__*`) is configured → use it.
4. Otherwise → the host's built-in image tool.

**kie (default)** — see
[Image, Video And Sound Generation](https://raw.githubusercontent.com/babylontoolkit/agent/main/references/web-kie-servers.md):

```
generate_image(prompt, out_path, reference_paths?, model?, aspect_ratio?, resolution?, output_format?)
```

- `out_path` → `_gauntlet/<name>/reference/target-<camera>.png`
- `reference_paths` → the current-state screenshot for the refinement path (up to 14 files)
- `aspect_ratio` → match the locked camera's aspect; `resolution: "2K"` or `"4K"`; `output_format: "png"`

**Higgsfield** — see
[Higgsfield MCP Server](https://raw.githubusercontent.com/babylontoolkit/agent/main/references/web-higgsfield-mcp.md).
It has no `out_path` and does not read local files. It returns a job, and you download the result. Map each
kie-shaped call like this:

| kie shape | Higgsfield equivalent |
|---|---|
| `reference_paths: [local.png, …]` | Upload first: `media_upload {files:[{filename}]}` → `curl -f -X PUT --upload-file local.png '<upload_url>'` → `media_confirm {type:"image", media_ids:[…]}`. Then pass `medias: [{role:"image_references", value:"<media_id>"}]`. A previous Higgsfield output needs no upload: pass its `job_id` as the `value` |
| `model` | A Higgsfield id that accepts references — `gpt_image_2_5` (default), `nano_banana_2`, `seedream_v4_5` (4K). `z_image` is the cheapest draft model but takes **no** references |
| `resolution: "2K"` / `"4K"` | `resolution: "2k"` / `"4k"` (lower case, where the model supports it) |
| `output_format: "png"` | Nothing to set. Image results are PNG |
| `out_path` | `job_status {jobId, sync:true}` until `completed`, then `curl -fL -o <out_path> '<results.rawUrl>'` |

Higgsfield rules for this loop:
- **Preflight** each new model/setting with `get_cost: true` and **log the credits per image** in
  `pipeline.md`. A gauntlet may generate dozens of images, so check `balance` before the run and treat
  running out of credits as a boundary that parks the run.
- Always send `use_unlim: false`. Never call a billing-confirm tool.
- **Never hot-link** a Higgsfield CDN URL. The locked target must be a file inside `_gauntlet/<name>/`.
- For several independent images (one per locked camera), use `generate_image_batch` → `jobs_wait` →
  download each.

If no image-generation tool is available **and** the user supplied no reference media, **stop and ask** for
either a target image or an image-generation credential. Do not start a gauntlet against a prose bar.

---

## 2. Prompting for a target — the rule that decides everything

**Prompt for a real, in-engine screenshot. Never for concept art.**

Words like *concept art*, *cinematic*, *illustration*, *matte painting*, *artstation* produce an artist's
interpretation with lighting and detail no real-time renderer will ever produce — and the loop will chase it
forever and never pass.

| Write this | Not this |
|---|---|
| "in-engine screenshot, real-time game engine, gameplay camera" | "concept art", "key art" |
| "baked global illumination, reflection probes, real-time shadows" | "cinematic lighting", "dramatic atmosphere" |
| named framing, focal length, time of day, weather | "epic", "moody", "stunning" |
| the reference game's actual look, named | a mood board of five different games |

State the engine and the constraints in the prompt: *"a real-time in-engine screenshot from a modern
WebGL/WebGPU game, baked lightmaps, 1920×1080, gameplay camera at eye height"*. You will try to match it to
the pixel — so it has to be a thing a renderer could actually have output.

---

## 3. The reachability pass — before locking

**Do this once, before round 1, and it will save the whole run.** Walk the target against what the chosen
pipeline can physically deliver, and split it three ways:

| Verdict | Meaning | Goes in |
|---|---|---|
| **Reachable** | the pipeline exports it | the rubric |
| **Approximable** | not directly, but a stand-in gets close — a reflection probe for SSR, baked contact shadows for SSAO, a fog gradient for volumetrics | the loop card as the declared approach |
| **Out of reach** | no path across the export boundary at all | the loop card's `OUT OF REACH` slot |

Critics are instructed never to raise gaps against `OUT OF REACH` items. Without this list the critic names
the same impossible gap every round, the stall ladder fires, and the run parks for no good reason.

For `unity` jobs the boundary is concrete: the 73 scene-metadata keys the exporter emits. See
`unity-pipeline.md` § *Scope the target to what can actually cross the boundary*.

---

## 4. Locking

Once the target is agreed, **it is frozen for the run.** Record in the loop card:

```
REFERENCE: _gauntlet/<name>/reference/target-hero.png  (locked round 1, 2026-09-09)
           _gauntlet/<name>/reference/target-alley.png (locked round 1, 2026-09-09)
```

A moving target makes every score incomparable and every failed-approach log meaningless. If the user
genuinely wants a new bar mid-run, that is a **loop card amendment**: append it, date it, note which parts
must be re-judged, and reset those parts' best-score history. Never silently regenerate the target.

> **The optional dream-again step.** Once the artifact has passed against the current target, the user may
> ask to raise the bar — generate a *new* target using the current state as the baseline and run the loop
> again. That is a new amendment and, usually, a new set of rounds. It is a deliberate user decision, never
> something the loop does on its own.

---

## 5. Cameras — one target per locked camera

**A comparison against a target image is meaningless if the viewpoint drifts.** Every target image is paired
with exactly one locked camera, recorded in `_gauntlet/<name>/cameras.md`:

```markdown
# Locked cameras
| Name           | Target                    | Transform (pos / rot)              | FOV | Res       |
|----------------|---------------------------|------------------------------------|-----|-----------|
| gauntlet_hero  | reference/target-hero.png | (12.0, 1.7, -8.5) / (4, 145, 0)    | 60  | 1920x1080 |
| gauntlet_alley | reference/target-alley.png| (-3.2, 1.7, 22.0) / (0, -90, 0)    | 50  | 1920x1080 |
| gauntlet_detail| reference/target-detail.png| (5.0, 0.9, 2.1) / (10, 200, 0)    | 35  | 1920x1080 |
```

- Three to five cameras is usually right: a hero establishing shot, one or two secondary angles, and a
  detail crop that forces the critic to look closely.
- For `unity` jobs these are **real Unity cameras** named `gauntlet_<slug>` saved in the scene: the in-loop
  snapshot renders through them, and they export with the level too. When the subject is a single asset,
  frame it in the scene it lives in under that scene's frozen lighting rig — see `unity-pipeline.md`
  § *Where the work is judged*.
- Evidence not captured from a locked transform is **inadmissible** — it fails the camera-lock gate.

Add a camera mid-run only by amendment, and generate its target at the same time.
