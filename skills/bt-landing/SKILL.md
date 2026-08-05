---
name: bt-landing
description: "The Babylon Toolkit Landing Page Skill is the one-shot builder for bt-design's landing page redesign pattern. Give it a plain-language idea, and the skill will generate the landing page, splash screen, preloader and custom overlays."
---

Turn a plain-language idea into a complete redesign of the game's entire frontend shell: the landing page, the splash screen, the preloader, and the custom in-game overlay — all four surfaces as ONE cohesive design.

Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user's message after the skill name as the `arguments`.

---

# Invocation — design brief

```
/bt-landing <design brief>
```

`arguments` is free-form design brief text: a whole new direction ("dark synthwave, neon grid, VHS grain"), a targeted change ("keep the layout, swap the palette to desert sunset and redo the splash"), or nothing at all. **This skill is built to be re-run** — if the last design missed, run it again with a sharper brief; each run REPLACES the previous design completely (unless the brief says to keep parts of it).

- **With a brief:** the brief is the design direction. Honor every specific it names; invent boldly where it is silent.
- **Without a brief:** derive the direction from the game itself — its title, genre, GameMode, and any art already in the project. Commit to a BOLD aesthetic per the bt-design skill's Design Thinking section.
- **On a NEW project (the first build turn):** the platform invokes this procedure automatically with the project brief, and pre-loads bt-design alongside it. Same steps, no difference — the prerequisite below is already satisfied, so do not re-load it.

# Prerequisite — load bt-design FIRST, before anything else

**This procedure is built on the bt-design skill's standards and is incomplete without them.** Several steps below defer to bt-design by name (Design Thinking, the full-bleed console UI vocabulary, typography and motion). Those references are instructions to *use* that skill's content, not decoration — designing "to bt-design's standards" without having read them produces generic output that misses the point of running this skill at all.

So, as your FIRST action:

- **If bt-design is already in your context** (a "Skills — already in context" block names it, or you loaded it earlier in this conversation) — proceed straight to Step 0. Do not re-load it.
- **Otherwise, load it now.** Where skills are loaded with a tool (the Babylon Toolkit App Builder platform), call `load_skill('bt-design')`. Where skills are files on disk (Claude Code), read the sibling `bt-design/SKILL.md` from the same skills directory — `~/.claude/skills/` or the project's `.claude/skills/`.

One load, before you write anything. Loading is cheap; discovering halfway through a redesign that you are missing the standards means redrafting the whole thing.

# Step 0 — discover the project facts (never guess them)

Before writing anything, read what is true in THIS project:

- **The play contract:** find the registered GameMode class (look in `src/scripts/*.ts` for `RegisterClass`, and at `src/babylon/globals.ts`'s registration block). Gameplay is entered ONLY via `navigate('/play', { gameMode: '<RegisteredModeClass>', sceneUrl?, ...selections })` through `useUnifiedNavigation`. The redesign may move, restyle, multiply, or remove play buttons — but this call must survive, exactly, with the project's real class name.
- **Images on disk:** list what exists under `src/assets/` and `public/` (including `public/assets/generated/`). Import from these or none — never invent an asset path.
- **The chrome location:** `src/chrome/` — `loading.tsx`, `splash.tsx` + `splash.css`, `overlay.tsx` + `overlay.css`. This folder is a WRITE zone that sits OUTSIDE the read-only `src/babylon`, so its framework imports go through `'../babylon/…'` (e.g. `import GameManager from '../babylon/globals'`) and its bundled logo imports through `'../assets/…'`.

# Step 1 — the design system (`DESIGN.md` at the project root)

The project's committed design direction lives in ONE file: **`DESIGN.md`**, at the project root. Read it before designing anything — this step is what makes ten projects come out looking like ten different games instead of ten flavors of the same one, and what keeps every later edit to THIS project coherent with what already shipped.

- **If `DESIGN.md` has real content** — it IS the design system. Every surface this run touches honors its palette, typography, motion language, and tone; your own instincts defer to it. The brief still outranks it: when the brief names a new direction ("dark synthwave, neon grid, VHS grain"), the new direction wins — and you REWRITE `DESIGN.md` to match as part of this run. The file always records what actually shipped, never what used to be true.
- **If `DESIGN.md` does not exist, is empty, or is only a placeholder** — **CREATE it now (replacing the placeholder wholesale), BEFORE writing any page or chrome code.** A placeholder is recognizable by content, not just by size: the starter template ships one whose Design Overview says *"There are no special design instructions."* (followed by a "Non-design note" link section that is explicitly not guidance) — that file is EMPTY for this step's purposes, as is any DESIGN.md with blank/boilerplate headings, TODO markers, or no committed values (no hex codes, no font names). Committing the direction to the file first is the point: a direction decided mid-draft drifts back to defaults; a direction written down gets built.

**What `DESIGN.md` must contain** — short, concrete, buildable; a design system, not an essay:

- **Direction** — one sentence naming the aesthetic lens and the tone extreme it commits to (per bt-design's Design Thinking), e.g. "sun-bleached desert-rally poster: grainy, analog, high-noon", "cold orbital-station UI: precise, monochrome, quietly threatening".
- **Palette** — actual hex values with roles: dominant, surface, 1–2 sharp accents, text tones. Dominant-with-sharp-accents, never a timid evenly-distributed spread.
- **Typography** — display face and body face BY NAME (distinctive and characterful — never Inter/Roboto/Arial/system fonts).
- **Motion** — the motion language: what animates, easing character, tempo (e.g. "slow drifts + hard snaps", "spring physics everywhere", "near-still, light flickers only").
- **Atmosphere** — background and texture rules: grain, gradient meshes, geometry, scanlines, layered transparency — whatever this direction uses instead of flat fills.
- **Voice** — one line on copy tone for labels and flavor text (a racer barks, a horror game whispers).

**Anti-convergence rule (why this file exists):** you cannot see the other projects this platform has built, so left to instinct you will converge on the same dark-hero-plus-glow-accent design every time. When WRITING a fresh `DESIGN.md`, pick the direction for THIS game and deliberately pass on the first, most obvious treatment for its genre — vary light against dark, loud against restrained, ornate against brutal. If the direction you are about to commit would look at home on any generic game site, it is the wrong one.

# Step 2 — the landing page (`src/pages/Home.tsx` + `Home.css`)

Rewrite BOTH files COMPLETELY, as a landing page designed from scratch for this game. Nothing from the previous page survives unless the brief explicitly says to keep it — no starter hero, no demo buttons, no Vite/React/Babylon links, no footer, no engine/toolkit attribution of any kind. Reach gameplay through the play contract from Step 0.

**FULL-PAGE-WIDTH — the Layout law, checked at the CSS level, not a preference:**

- FORBIDDEN on the page root, the hero, and every top-level section: `max-width` with auto margins (`margin: 0 auto` / `margin-inline: auto`), fixed pixel widths, and any wrapper div whose job is to center a column. `.home { max-width: 1200px; margin: 0 auto }` is THE recurring failure — a website column, not a game frontend.
- REQUIRED: root and every section `width: 100%`; backgrounds, hero art, and bars touch BOTH viewport edges (`background-size: cover` / `object-fit: cover` — an image's natural width must never decide the page width); UI clusters anchored to the viewport edges, never floated in a centered box.
- The ONLY permitted `max-width` is a readable measure (~60–75ch) on a TEXT element inside a section that itself runs edge-to-edge.
- SELF-CHECK before finishing: re-read your Home.css — any structural container with `max-width` + auto margins means the task is failed; fix it first. At 1920px there must be NO empty margin strip on either side of the hero.
- Responsive from ~320px to ~2560px, no horizontal scrollbar at any width, nothing clipped or overlapping.

Design to the bt-design skill's standards — the ones you loaded in the Prerequisite — **through the lens `DESIGN.md` commits to (Step 1)**: full-bleed console UI, the file's palette and typography, real motion in the file's motion language. `src/pages/` and `src/components/` stay Babylon-free — never import `GameManager` or any Babylon module there; navigation goes through `useUnifiedNavigation`.

# Step 3 — the chrome (`src/chrome/**`): splash, preloader, overlay — ALL THREE, one theme

REDESIGN — do not reskin — all three surfaces to the SAME design language as the landing page (the `DESIGN.md` system from Step 1: typography, palette, motion). Doing only the overlay and stopping is the classic miss: the splash and preloader are the two that ship with the Babylon logo + spinner, so skipping them leaves engine branding in the user's game.

1. **Preloader** — `src/chrome/loading.tsx`. First thing on screen, before the app mounts.
2. **Splash / loading screen** — `src/chrome/splash.tsx` + `splash.css`. Shown while the 3D scene loads.
3. **Initial overlay** — `src/chrome/overlay.tsx` + `overlay.css`. The in-game HUD layer — retheme it to match (a title/brand corner, a frame); the full HUD grows later with gameplay.

**The splash must NEVER be derived from the default Babylon splash (centered logo + spinner) — recoloring the default IS the failure.** Think out of the box: design the loading experience as a scene in this game's world, with a progress metaphor native to THIS game — a racer's start-lights counting down, a fuel gauge filling, a platformer's level assembling tile by tile, a warp drive charging — driven by the real progress value, not a bare bar under a logo. Atmosphere worth watching: staggered reveals, ambient motion, flavor text in the game's voice. There is no limit to what you can do here.

**ENGINE CONTRACT — splash element IDs are LAW (STRONGLY ENFORCED, zero exceptions):** the engine's runtime code shows and hides the splash screen and writes its label/status text by looking up these EXACT DOM ids/names — it cannot find renamed elements, and if it can't find them the splash NEVER hides and the scene underneath is never revealed:

- `xbabylonjsSplashScreen` — the main splash screen panel (the root element the engine shows/hides)
- `babylonjsLoadingDiv` — the loading container element
- `babylonjsLoadingText` — the loading label element (the engine writes its text content)
- `babylonjsLoadingDivStyle` — the injected style element for the loading div
- `xbabylonjsStatusTextDiv` — the status text element (the engine writes its text content)

Any redesign of the splash MUST keep every one of these elements present with its id/name byte-for-byte unchanged — never rename, remove, duplicate, or conditionally unmount them. All the creativity happens AROUND this skeleton: restyle them via CSS that targets these ids, nest new decorative elements inside or beside them, reposition and re-animate them freely — but the ids themselves are engine wiring, exactly like the `"OnLoadProgress"` subscription below. Because the engine writes label text into `babylonjsLoadingText` and `xbabylonjsStatusTextDiv` at runtime, those two must remain real text-bearing elements (style the text; don't replace the element with an image or empty it via JS). SELF-CHECK before finishing: grep the redesigned splash for all five ids — any one missing means the task is FAILED; fix it first.

**LIGHTWEIGHT is a hard constraint, not a style choice.** The splash and preloader ARE the progress info — they exist to COVER loading, so they must paint instantly and show progress immediately. Build their creativity from what renders in the first frame: CSS gradients, keyframe animation, typography, particles, inline SVG, canvas-drawn effects, at most small image assets (a compact logo, a texture tile). Do NOT put multi-megabyte generated hero art, photography, or video on these surfaces — a splash that loads its own heavy image defeats itself. Heavy art belongs on the landing page, behind a styled fallback.

**IMPORTS AND FRAMEWORK WIRING ARE COPIED, NEVER RE-DERIVED (STRONGLY ENFORCED):** you are restyling these files, not re-authoring them. Before you write `splash.tsx` / `overlay.tsx` / `loading.tsx`, READ the file you are about to replace and carry its **entire import block** — and every `GameManager`, `EventBus` and `useUnifiedNavigation` line — across **unchanged, character for character**. Rewrite only markup, styles and copy. Do not retype an import from memory, do not "tidy" it, do not change default vs named form, path, or ordering. If a single import in your new file differs from the original's, you have introduced a build error. Concretely: **`GameManager` is a DEFAULT export** — `import GameManager from '../babylon/globals'`, never `import { GameManager } from '../babylon/globals'` (that exact slip has shipped a project that would not compile). The framework's export shape is not something to infer; it is something to copy. SELF-CHECK before finishing: diff your new import block against the original's — they must be identical.

**Keep ONLY each surface's wiring; replace ALL of the visuals:**

- `loading.tsx` re-exports `babylonLogo` / `spinnerLogo` that `splash.tsx` imports — keep those exports (or update `splash.tsx`'s import to match).
- `splash.tsx` keeps its `GameManager.EventBus` `"OnLoadProgress"` subscription — that is REAL load progress; drive your metaphor from it.
- `overlay.tsx` keeps `pointer-events: none` on its container so input reaches the canvas; only genuinely interactive elements get `pointer-events: auto`.
- Never delete image files from disk (`public/babylon.png` + `public/spinner.png` are framework-required, whatever your design shows).
- `src/chrome/**` runs in the viewer context, so it MAY import `GameManager`/`EventBus` and `useUnifiedNavigation` — through `'../babylon/…'` paths (Step 0).

The Layout law from Step 2 binds these surfaces too — full-bleed, responsive, edge-to-edge.

# Step 4 — bespoke art (when media generation is available)

If the platform's `generate_image` / `generate_video` tools are available on this turn, use them to make the design beautiful: a hero background, a logo/wordmark, splash-adjacent accents (16:9 for wide heroes, 1:1 for badges/logos; png when alpha matters). Make ALL generate calls FIRST, in ONE parallel round, before writing any files; reference the returned `/assets/generated/…` paths exactly as returned (the one exception to never-invent-an-asset-path) — the renders land in the background, so every surface must look finished while they do (styled color/gradient fallback behind each image, never a blank box). At most ONE short looping hero video, and only if it truly elevates the design — video costs the user hundreds of credits. If the tools are absent, design with CSS + the images on disk instead.

Generated art goes on the LANDING PAGE — never on the splash/preloader (Step 3's lightweight rule). Art direction for every generate call comes from `DESIGN.md` — prompt the renders in its palette and atmosphere so the art belongs to the same design as the CSS around it.

# Step 5 — finish clean

- Zero unresolved imports after the rewrite (every import points at a file that exists).
- No Toolkit/BabylonJS/engine branding anywhere in the user-facing design.
- The play contract fires with the project's REAL GameMode class.
- All four surfaces read as one designed product, not four separate efforts.
- `DESIGN.md` records the direction that actually shipped — freshly written if it was missing/placeholder, rewritten if the brief redirected it, untouched if this run honored it as-is. A shipped design the file does not describe is a failed Step 1.

State in one short paragraph what design direction you committed to (it is now also in `DESIGN.md`), so the next `/bt-landing` run can be briefed against it.
