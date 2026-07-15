---
name: bt-prototype
description: "The Babylon Toolkit Prototype Skill fans out subagents to build N fundamentally-different, jaw-dropping landing-page prototypes for a game theme — each a self-contained frontend candidate for the project's starter template, so the user can pick one and continue building their real front end from it. Every prototype re-imagines the same game world (anchored to attached level/model screenshots) through a different design lens, using advanced visual craft: high-quality 3D, otherworldly animation, exceptional palettes, novel type. Design directions can be seeded from the public motionsites.ai catalog or the awwwards.com showcase (technique harvest, never cloning). Use when the user wants a batch of stunning game landing-page prototypes to choose from (e.g. `bt-prototype --count:10 AAA Need For Speed style racing`)."
---

Build **N radically-different, mind-blowing landing-page prototypes** for a single game theme, as **candidate front-ends** the user will browse and pick one from to continue their real project. This is a **batch, autonomous fan-out**: launch subagents, one per prototype, each self-contained in its own folder. The quality bar is the Original Fable spirit — *go nuts, out-of-the-box, fundamentally different, mind-blowing* — applied to game front-ends: high-quality 3D tactics, otherworldly beautiful animation, exceptional color palettes, novel/interesting type, and whatever else best shows off advanced design skill.

The **mechanics of any 3D-scroll hero** are owned by **bt-hero** / bt-design's 3D-Hero-Scroll reference — never re-implement them here. This skill owns the **batch**: intake, direction spread, fan-out, per-prototype asset pipeline, and the iteration-pass quality gate.

Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-prototype [--type:html|react] [--count:N] [--motionsites] [--awwwards[:forensic]] [--3d-hero-scroll] <theme> <attached screenshots + notes>
```

**Flags** (all optional; `--flag:value` or `--flag`):

- **`--type: html | react`** — output kind. `html` = plain HTML/CSS/JS; `react` = `.tsx`/CSS + supporting files. **Default: `html`.**
- **`--count: N`** — how many prototypes to build. **Default: `10`.**
- **`--motionsites`** — seed the direction spread from the **public** [motionsites.ai](https://motionsites.ai/) catalog: read it, pick N genuinely-different design directions, re-imagine each for the theme. *(Public catalog only — the paid copy-paste prompts are gated and are never scraped. If the user wants a specific paid one, they download it and hand the text over for adaptation.)*
- **`--awwwards`** — seed the direction spread from the **public** [awwwards.com](https://www.awwwards.com/) showcase: harvest award-winning sites' **technique vocabulary** (motion system, scroll choreography, layout archetype, WebGL approach) and **palette language**, then re-imagine each fully for the theme. **`--awwwards:forensic`** additionally routes each direction through bt-copycat's live-site reconnaissance for a deeper mechanics study. See *Sourcing directions from awwwards* — including the inspiration-vs-cloning line, which is not optional.
- **`--3d-hero-scroll`** — the prototypes that suit a cinematic hero are built with **bt-hero**. Because this is a non-interactive batch, **every bt-hero answer must be pre-specified** (in `arguments` or derived up front) so bt-hero never stops to ask mid-batch. See *The 3D-hero-scroll batch rule* below.

`--motionsites` and `--awwwards` may be combined — split the N directions across both sources for a wider spread.

**`<theme>`** — the game theme every prototype re-imagines (e.g. *AAA Need For Speed–style racing*). **The one required input.** If it's missing, ask once, then run.

**Attached screenshots** — level shots, car/character models, environment art. These are the **truth anchor for the game's world** (see *Screenshots are the world anchor*).

**Examples:**
```
/bt-prototype --type:react --count:25 --motionsites AAA Need For Speed style racing  [attached: track + car model screenshots]
```
```
/bt-prototype --3d-hero-scroll  Cosmic horror survival game, derelict space station  [attached: level screenshots]
```
```
/bt-prototype --type:react --count:12 --awwwards --motionsites  Neon cyberpunk street-racing  [attached: city + car screenshots]
```

**To spec it instead of one-shotting the batch**, the user invokes bt-spec and names this skill in the brief — e.g. `/bt-spec Create 25 prototype landing pages for my game using bt-prototype --type:react --count:25 --motionsites <theme>`. See *Inside the spec loop*. bt-prototype never orchestrates bt-spec itself.

---

## ⚠️ Required reading before any build

For any Babylon / BabylonJS / Babylon Toolkit work, ensure the **Agent Reference** is already read in this session/context (fetch `https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md` first if not; and its `web-kie-servers.md` sub-document if using the KIE MCP servers). If a required fetch fails, STOP and tell the user. Do not refetch what you already remember.

If the project keeps a root **SPEC.md**, read it first and conform to its architecture/conventions; record the shipped prototypes per the project's working agreement when the batch lands.

---

## Screenshots are the world anchor

Every prototype must feel like it belongs to **this** game — same cars, tracks, materials, lighting, mood — while being **fundamentally different from the others** in layout and technique. **Same world, N different lenses on it.**

From the attached screenshots, extract and carry into every prototype: the **palette** (dominant + accent colors sampled from the art), the **environment mood** (biome, time of day, weather, atmosphere), the **hero subject silhouettes** (vehicle/character forms), **materials & lighting** (metallics, emissive, neon, grime, dust), and any **signature motifs**. Generated/borrowed assets must match these anchors, not drift into generic stock. If no screenshots are attached, derive the world from the theme text and say so.

The **difference** between prototypes is in the *design language* — layout, motion system, typographic voice, interaction model, 3D approach — never in contradicting the game's established world.

---

## Step 1 — Parse & intake

1. Read the flags (`--type`, `--count`, `--motionsites`, `--awwwards[:forensic]`, `--3d-hero-scroll`) and the `<theme>`. Apply defaults (`html`, `10`).
2. **Theme gate:** if no theme is discernible, ask **once** — one short inline question — then proceed. This is the only interactive stop; once the batch starts, it runs autonomously.
3. Ingest attached screenshots into a world anchor (above). Note the host: React (Vite/TS) vs plain HTML, per `--type` and any existing project.
4. **Asset-backend check:** the Fable-grade bar assumes asset generation is available. Confirm what's configured — KIE MCP (image/video/Kling), Higgsfield, GPT Image 2 keys, Pinterest source. If none is available, say so and proceed with hand-authored CSS/SVG/WebGL craft rather than silently producing flat pages.

## Step 2 — Compose the direction spread (N genuinely-different lenses)

Before building anything, decide the **N distinct directions** so the batch doesn't converge on one look. Each direction names a different *design language*: layout archetype, motion system, typographic voice, and 3D/animation approach. Spread across techniques — e.g. cinematic 3D scroll, WebGL particle field, editorial/brutalist type, glassmorphic HUD, kinetic-type reveal, immersive full-bleed video, generative/otherworldly motion, retro-future dashboard — pick what fits **this** theme, don't checklist blindly.

- **With `--motionsites`:** fetch the public catalog, pick N cards that are genuinely different from each other (vary category + hero style), and record which catalog entry inspired each direction — for traceability, **not** copying. Re-imagine each fully for the theme.
- **With `--awwwards`:** see *Sourcing directions from awwwards* below.
- **With neither:** invent the N directions from the theme + world anchor.

**Full-bleed console UI is the baseline for every direction.** These are **game front-ends**, so each prototype defaults to a **full-page-width, full-viewport, edge-to-edge** layout that feels like a modern console dashboard / AAA game menu (Xbox / PS5), per bt-design's *Layout Philosophy — Full-Bleed Console UI* section — every view owns the whole viewport, full-bleed atmosphere, UI anchored to the edges with a TV-safe gutter, console focus/selection states. The directions still vary the *design language* (motion system, type voice, 3D approach) on top of that shared full-bleed baseline; they do **not** vary down to a centered fixed-width marketing column unless a specific direction deliberately calls for a contained treatment (e.g. an editorial/long-form lens) — and when one does, note it in `_directions.md` and still keep a full-bleed backdrop behind the contained element.

**Full-bleed does not mean a single locked screen — these are landing pages, so scroll stays first-class** (bt-design's *scroll is the transport, not the enemy* rule). Full-viewport views scroll between and through each other, and any **3D-hero-scroll direction plays its cinematic scroll, then settles into the full-bleed console home view at the end** (the sweep-into-console handoff) rather than dead-ending or dropping into a stock template. Compose each view full-bleed; let scroll carry the user between them.

Write the plan to `_prototypes/_directions.md` (id, name, one-line design language, inspiration source + attribution if any, whether it's a 3D-hero-scroll direction). This is the batch's manifest.

## Sourcing directions from awwwards

Awwwards is a **directory of real, live, award-winning websites** — which makes it far richer than a template gallery, and also means it carries obligations a template gallery doesn't.

**What's public and fetchable** (verified): the `/websites/` listing gives each winner's name, **live site URL**, award type (Site of the Day / Developer / Honorable Mention), studio, and date. Each entry page `/sites/<slug>` gives **color-palette swatches**, **technique tags** (e.g. WebGL, Animation, Webflow), categories, jury scores, and a named "Elements" breakdown of specific techniques (e.g. "infinite fullscreen slider").

**Respect robots.txt.** Fetch only `/websites/` and `/sites/<slug>`. Awwwards disallows the search/filter endpoints — never request `/websites/?…` (filtered), `/search-websites`, `/gallery/`, `/tag/`, `/inspiration/search`, `/elements/*`, or `/directory/search/…`. Page politely; don't hammer the site.

### ⚠️ The line: harvest technique, never clone the work

Every awwwards entry is a **real, copyrighted, credited work by a named studio.** Batch-reproducing them is not the goal and is not acceptable output.

| HARVEST (the vocabulary) | NEVER TAKE (the work) |
| --- | --- |
| Motion system & scroll choreography *as a technique* | Their layout, verbatim |
| Layout archetype (split-screen, full-bleed, editorial grid) | Their copy, logo, branding, imagery |
| WebGL / 3D approach and interaction model | Their assets, fonts, exact palette hexes |
| Palette *language* (e.g. "monochrome + one hot accent") | Their identity or subject matter |
| Typographic voice (e.g. "oversized condensed grotesk") | Anything that makes it recognizably *theirs* |

Each direction must be **re-imagined 100% for the user's game world** (the theme + screenshot world anchor). A viewer should recognize the *craft level and technique*, never the source site. **Attribute** each direction's inspiration in `_directions.md` (site name, studio, URL) — for traceability and credit, not because a copy was made.

### Selection

Pick N winners that are genuinely different from one another — vary technique tags, layout archetype, and palette language, not just subject. Prefer entries whose techniques actually serve a **game front-end** (immersive 3D, cinematic scroll, high-motion heroes) over, say, a corporate SaaS layout. Record for each: site name, studio, URL, its technique tags, and the one-line design language you're extracting.

### `--awwwards:forensic` (deeper study, explicit opt-in)

With `:forensic`, each selected direction additionally runs the sibling **bt-copycat** skill's Phase-1 forensic reconnaissance against the **live URL** (real-browser study of scroll choreography, load sequence, animation timing, spatial rhythm) to extract its *mechanics* precisely. The harvest/never-take table still governs the output: bt-copycat's "mechanics are sacred, skin is the variable" split applies, and the **skin is always the user's game world**. This is a knowing opt-in because it is slower, hits real sites, and studies them closely.

If the user wants a genuine faithful rebuild of **one specific** award-winning site, that is not this flag — point them at **`/bt-copycat <url> <re-imagining brief>`**, the deliberate, single-site, user-chosen tool.

## Step 3 — Fan out (one subagent per prototype)

Build the N prototypes **in parallel via subagents** — if a subagent-spawning/workflow tool is available (Claude Code's `Task`/Agent, a Workflow, or the host's equivalent), launch one per prototype (cap concurrency to what the host allows; queue the rest). If no subagent tool is available, build them sequentially yourself. Never call a subagent tool you don't have.

Each prototype subagent gets: its **direction**, the **theme**, the **world anchor** (screenshots + extracted palette/mood/silhouettes), the **`--type`**, and the **asset workflows** available. It must:

1. **Own its folder.** Create `_prototypes/<NN-slug>/` and put **everything self-contained inside it** — markup, styles, scripts, and all generated/downloaded assets. No shared globals; a prototype is copy-out-able on its own.
2. **Build to the Fable bar for its lens** — advanced 3D tactics, otherworldly animation, exceptional palette, novel type. Not a template with the colors swapped; a distinct, *mind-blowing* execution of that direction for this game. **Full-bleed console UI by default** (bt-design's *Layout Philosophy*): fill the whole viewport edge-to-edge like a console dashboard / game menu, not a centered fixed-width website — unless this direction is the noted contained exception.
3. **Produce assets** via any mix of the available workflows: Pinterest pulls for reference, **GPT Image 2** for stills, **KIE MCP servers / Higgsfield (Kling, etc.)** for motion/video, hand-authored WebGL/SVG/CSS. All assets stay faithful to the world anchor and live in the prototype's folder.
4. **3D-hero-scroll directions:** follow *The 3D-hero-scroll batch rule* below.
5. Run its own **iteration passes** (Step 4) before returning.

## The 3D-hero-scroll batch rule

When `--3d-hero-scroll` is set (or a direction inherently calls for the cinematic hero), that prototype is built via **bt-hero → bt-design's 3D-Hero-Scroll protocol** — copy the templates, run the footage pipeline, calibrate, verify. **But this is a batch: bt-hero must never prompt.** So all of bt-hero's creative slots must be **pre-resolved before the subagent starts** — the star, look/anchor, journey/beats, HUD, controls, sweep, brand/overlays, and below-the-journey are derived from the theme + world anchor + direction and written into a hero brief (`_prototypes/<NN-slug>/_hero-brief.md`) up front. The subagent runs bt-hero's build against that brief with **zero questions** ("enough to fly," always). If a slot genuinely can't be resolved without the user, resolve it with a sensible default and note it — do **not** pause the batch.

## Step 4 — Iteration passes (the quality gate)

No prototype is "ok'd" until it has had **at least three iteration passes**. An iteration pass is a **fine-toothed-comb review** of the finished prototype looking for design problems and **opportunities to improve/complexify** — spacing/rhythm, contrast, motion timing and easing, hierarchy, type detail, asset quality, responsiveness, the small touches that separate stunning from fine — followed by actually applying the improvements. Each pass should measurably raise the craft, not just rubber-stamp. Record a one-line note per pass in the prototype's folder (`_notes.md`) so the passes are auditable, not assumed.

For prototypes with real interaction (3D scroll, WebGL, video heroes), a pass **must** include a real-browser check (chrome-devtools): it loads, the hero/animation runs, nothing errors, it degrades gracefully. A prototype that looks right in source but breaks in the browser fails the pass.

## Step 5 — Report & record

When the batch lands, report a compact index: each prototype's id, direction/design-language, folder path, whether it's a 3D-hero-scroll build, and its inspiration source (if `--motionsites`). Point the user at how to preview them and remind them the purpose is to **pick one as the starter front-end**. If the project keeps `SPEC.md`, record the batch per the project's working agreement.

---

## Inside the spec loop (composition with bt-spec — bt-prototype never initiates this)

When a **bt-spec / bt-plan / bt-execute** run encounters this skill named in its brief (e.g. `/bt-spec Create 25 prototype landing pages … **using bt-prototype --count:25 --motionsites <theme>**`), bt-prototype contributes **intake + direction spread**; the spec loop owns the batch build and verification:

- **bt-spec:** run Steps 1–2 (intake → the direction manifest `_directions.md`), then treat that manifest **plus bt-design's 3D-Hero-Scroll reference** (for any `--3d-hero-scroll` directions) as the sibling-skill pattern per bt-spec's *Step 2.6*: each direction becomes a feature-spec requirement, and the 3D-hero brief's behavioral config (`sweep`, controls) is carried **verbatim**. Pre-resolve all bt-hero slots at spec time so nothing prompts later.
- **bt-plan:** normal sibling-skill rules — each prototype is a task; copy + configure bt-design templates for 3D-hero directions (never re-implement); Acceptance is observable ("prototype NN renders its direction, self-contained in its folder, passes 3 iteration passes").
- **bt-execute:** its verifier gates each prototype, including the 3D-hero-scroll behaviors and the iteration-pass evidence.

In that flow, do **not** run Step 3's fan-out here — the plan's tasks build the batch.
