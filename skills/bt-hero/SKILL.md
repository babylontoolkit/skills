---
name: bt-hero
description: "The Babylon Toolkit Hero Skill is the one-shot builder for bt-design's 3D-Hero-Scroll pattern. Give it a plain-language idea, an existing hero image/video, explicit answers, or any combination — it uses what you gave, asks only the questions you didn't answer, records everything in a repeatable hero brief file, and builds the cinematic scroll-scrubbed hero immediately via bt-design. Composable into the spec workflow by mentioning it inside a bt-spec brief (`Use bt-hero to create ...`). Use when the user wants a 3D scroll hero/landing page (e.g. `bt-hero a mustang with a race driver`)."
---

Turn a plain-language idea — or an existing hero image/video, or any combination — into a cinematic scroll-scrubbed 3D hero page, **in one shot**. This skill owns the **intake** (gathering the creative decisions into a hero brief) and the **build** (via bt-design). The **mechanics** — engine, footage pipeline, calibration, verification — are owned by bt-design's 3D-Hero-Scroll reference (`bt-design/references/3d-hero-scroll.md`); never restate, re-implement, or override them here.

Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user's message after the skill name as the `arguments`.

---

# Invocation — free-form, any combination

```
/bt-hero <anything>
```

`arguments` is free-form. It may contain, in any mix:

- **an idea sentence** — `create a Mustang GT Shelby decked out for racing, with a race driver — desert dawn to red-rock canyon to night dunes, NFS-style game site`
- **a path to an existing hero image or video** — `@my-hero.jpg`, `@footage/run.mp4`
- **explicit slot answers** — `HUD 0→220 MPH`, `sweep: hero`, `no jump nav`, `call it SIDEWINDER`
- **a previously written brief file** — `@_specs/<name>_hero-brief.md` (rebuilds it exactly, asking nothing)
- **nothing at all** — full interview

Whatever is present is used verbatim; the intake resolves the rest (Step 1). **There are no route keywords and no confirmation gates: `/bt-hero` builds, one shot.** The only permitted stop is the safety stop in Step 3.

**To spec it instead of one-shotting it**, the user invokes bt-spec and mentions this skill in the feature brief — e.g. `/bt-spec Redesign the starter template … Use bt-hero to create a <idea>`. See *Inside the spec loop* at the end. bt-hero never orchestrates bt-spec itself.

---

## The three-tier contract (what gets asked vs. what is decided)

Every piece of a 3D hero scroll belongs to exactly one tier. This is the rule that keeps the intake small and the output deterministic:

- **Tier 1 — Invariants.** How the mechanic works. Owned by bt-design's reference and templates; never asked, never in the brief, never overridable: muted footage, the all-intra scrub encode, blob preload, veiled cuts, film-speed autoplay, cancel semantics, the `HS_CONFIG`/markup syntax, and the **verification protocol — which always runs, without being requested.**
- **Tier 2 — Defaults.** Sensible values supplied silently; the user may override any of them in their input (recorded in the brief's `Overrides` section): aspect ratio (default 16:9), clip duration (**backend-derived — probe the configured video model's real output; never assume a number**), the 4-beat REVEAL → MOTION → SHIFT → FINALE arc, `sweep: page`, controls all-on (`sweep: page`) / HUD+PLAY (`sweep: hero`), the scroll-length formula, poster = first film frame.
- **Tier 3 — Creative slots.** The only things intake deals in — the eight slots below.

If it's how the mechanic works → Tier 1. If it's a value that could legitimately differ per project → Tier 2. If it's a creative decision about *this* product → Tier 3.

---

## Step 1 — Intake: use what was given, fill the rest

Parse `arguments` into the eight slots:

1. **The star** — what travels through the film? Car, character, product, creature, the camera itself. *(The only mandatory slot — but an image/video path can satisfy it if its subject is clear.)*
2. **The look** — the hero anchor: a described look for the star, or the provided image/video path. *(Default: derived from the star.)*
3. **The journey** — where it starts, what it travels through, how it ends; mapped onto the beat arc — a **beat** is one chapter of the film, one generated clip. Explicit beats, or more/fewer than four, are fine. *(Default: an arc invented to fit the star.)*
4. **The gauge (HUD)** — the number that climbs as you scroll: speed, depth, altitude, RPM, distance, watts… "None" = no HUD. *(Default: suggested from the star; never invent a metric that doesn't fit — prefer none.)*
5. **The controls** — PLAY autoplay button (and its label) · TOP/END jump nav — keep or drop. *(Default: per sweep, Tier 2.)*
6. **The sweep** — after the film: **page** = PLAY glides on through the whole page to the bottom (default) · **hero** = stops at the film's end. 
7. **The brand & words** — name, tagline, up to ~3 count-up stats, a feature moment, a closing line. *(Default: invented to match the star; never a fixed house style.)*
8. **Below the journey** — what the rest of the page is. With `sweep: page` it **must be designed to the film's brand and exit tone**, never left as a stock template — and this is precisely **where the scroll-scrubbed hero settles into the full-bleed console home view**: the film is the entrance, the console home (tile wall, edge-anchored HUD/menu, focus states) is the destination it lands into (bt-design's *scroll is the transport* handoff). Build it **full-bleed / full page width** — edge-to-edge console-UI composition per bt-design's *Layout Philosophy — Full-Bleed Console UI*, not a centered fixed-width marketing column (unless the input asks for a contained treatment). *(Default: restyle the page's existing content to the film's exit tone.)*

Then resolve every unfilled slot by exactly one of two paths:

- **Enough to fly** — the input contains a usable star (an idea sentence, or an image/video whose subject is clear): fill every remaining slot from its default, ask **nothing**, and proceed. This is the one-shot path.
- **Not enough to fly** — empty input, or fragments with no discernible star: ask **only the unanswered questions** — inline, conversationally, as ONE compact numbered list (never one-at-a-time interrogation, never a structured question UI). Tell the user loose prose, partial answers, and "you pick" are all fine. What they answer is used; what they skip gets the default. Then proceed — do not re-confirm.

**Footage feasibility check:** if there is no provided footage AND no image/video generation backend configured (KIE MCP, Higgsfield, built-in generation, …), STOP — this pattern is wrong without footage; recommend a static hero instead (per the bt-design reference intake).

## Step 2 — Write the hero brief (the save file)

Write the resolved slots to `_specs/<feature-name>_hero-brief.md` (create `_specs/` if needed). The brief is the **record**, not a gate: the user never has to touch it, but `/bt-hero @<brief-file>` later must rebuild the same hero with zero questions — that is what makes a hero repeatable, shareable, and tweakable (edit a line, re-run). Record **only Tier 3 answers and explicit Tier 2 overrides** — never Tier 1 mechanics; the brief describes the film, not the engine.

```markdown
---
feature: <feature-name>
type: hero-brief
status: draft
---

# Hero Brief — <Title>

## 1. The Star
<what travels through the film — the one clear subject every asset references>

## 2. Footage Source
- Mode: generate | provided
- Anchor: <image-generation prompt for the hero anchor> | <path/to/existing-image-or-video>

## 3. The Journey
| # | Arc | Beat |
|---|--------|------|
| 1 | REVEAL | <how the star is revealed> |
| 2 | MOTION | <the star in motion> |
| 3 | SHIFT  | <terrain/scene/lighting change> |
| 4 | FINALE | <the closing image> |

## 4. HUD
- Metric: <name> | none
- Range: 0 → <max> <unit>
- Segments: <one per beat, named after the beats>

## 5. Controls
- PLAY: yes ("<label>") | no
- TOP/END jump nav: yes | no

## 6. Sweep
- sweep: page | hero
<!-- Behavioral config — carry VERBATIM into any downstream spec (bt-spec Step 2.6).
     Never collapse into a route/scope classifier. -->

## 7. Brand & Overlays
- Name / wordmark: <...>
- Tagline: <...>
- Count-up stats: <A · B · C>
- Feature moment: <...>
- Closing line: <...>
- Palette / type direction: <derived from the star unless specified>

## 8. Below the Journey
<what the rest of the page is; designed to the film's exit tone when sweep: page>

## Tier-2 Overrides
<only values the user explicitly changed, e.g. "aspect: 21:9" — otherwise "none">

## Defaults In Effect
<the Tier-2 defaults applied, listed for the record — aspect, beat count, sweep origin (user/default), controls, clip duration source (backend-probed)>
```

## Step 3 — Build (one shot)

Show the filled brief as a **compact for-the-record report** — which slots came from the user's words, which from defaults — and continue **straight into the build. Do not stop to ask anything.** The user can always interrupt; the brief is on disk if they want to tweak and re-run.

**The one safety stop:** if the build would replace an existing landing page / hero / substantial work that is **not recoverable** (no committed git state covering it), pause, say exactly what would be lost, and wait. If it is committed and recoverable, note that fact and proceed. This is the only stop one-shot mode is allowed.

**Where the hero lands (target resolution — derived, never asked unless ambiguous):**
- **Default target: the app's home/entry page — the root route's PAGE component, never the router shell.** In **Babylon Toolkit projects** that is **`src/pages/Home.tsx` + `Home.css`** — the Home page is deliberately pulled out of `app.tsx`, and `app.tsx` + `src/routing/**` are a READ-ONLY shell that must not be edited (it already routes `/` to `Home`). In other React (Vite/TypeScript) hosts, resolve the `/` route's element (falling back to `App.tsx` only when the app has no router and the page truly lives there) and replace its existing hero (or its top-of-page block) with the `<HeroScroll>` journey, honoring the reference's sticky constraint (no transformed/overflow-clipped ancestors). For non-React hosts, the entry `index.html`. Slot 8 governs everything below the journey: with `sweep: page` the below-journey content is redesigned to the film's brand and exit tone (an unqualified `/bt-hero` therefore redesigns the whole landing page); with `sweep: hero` nothing below the journey is touched beyond the handoff seam.
- **The user may name a different target** in their input ("on the /demo route", "in marketing/landing.html") — use it.
- **No app at all** (empty/near-empty folder): scaffold the minimal host first — default a React + Vite + TypeScript starter, or whatever the user's input names — then build the hero into it, and say that's what happened.

Then build by following bt-design's 3D-Hero-Scroll protocol end-to-end:

1. Read the sibling **bt-design** skill's `bt-design/references/3d-hero-scroll.md` (bt-design is installed alongside this skill in the same skills directory, whether that's the user's `~/.claude/skills/` or the project's `.claude/skills/`) in full before writing any code. For Babylon Toolkit projects, the project's Agent Reference rule applies as usual (fetch it first if not already in context; if using the KIE MCP servers, its `web-kie-servers.md` sub-document too).
2. **Copy the drop-in templates** from `bt-design/templates/3d-hero-scroll/` for the host type (React/TS or plain HTML) — never re-implement the engine from memory.
3. Run the footage pipeline (anchor → chained beats → concat → scrub encode), wire-up, and calibration exactly as the reference specifies, configured from the brief's slots.
4. **Run the reference's verification protocol (§5) in a real browser. This is unconditional** — the hero is not done until it passes; never report done without it.
5. If the project keeps a `SPEC.md`, record the shipped hero per the project's working agreement.

When the build lands, set the brief's `status:` to `built`. The brief is the source of truth for the creative slots; the bt-design reference is the source of truth for the mechanics — on any conflict, mechanics win; flag it rather than bending the engine.

---

## Inside the spec loop (composition with bt-spec — bt-hero never initiates this)

When a **bt-spec / bt-plan / bt-execute** run encounters this skill named in its brief (e.g. `/bt-spec Redesign the starter template … **Use bt-hero to create a <idea>**`), bt-hero contributes **intake only** — the spec loop owns the build and verification:

- **bt-spec:** run Steps 1–2 above (intake → hero brief file), then treat the hero brief **plus bt-design's 3D-Hero-Scroll reference** as the sibling-skill pattern per bt-spec's *Step 2.6*: carry the brief's behavioral config (`sweep`, controls) **verbatim** into the feature spec's Functional Requirements, and reference the brief file from the spec. Intake questions (if the brief text isn't "enough to fly") are asked during spec authoring, not deferred.
- **bt-plan:** normal sibling-skill rules — copy + configure the bt-design templates (never re-implement); every brief behavior becomes a task with observable Acceptance.
- **bt-execute:** its verifier gates every checkbox, including the sibling-skill behaviors (`sweep`, controls, degradation).

In that flow, do **not** run Step 3's build here — the plan's tasks build it.
