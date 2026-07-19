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
- **On a NEW project (the creation turn):** the platform invokes this procedure automatically with the project brief. Same steps, no difference.

# Step 0 — discover the project facts (never guess them)

Before writing anything, read what is true in THIS project:

- **The play contract:** find the registered GameMode class (look in `src/scripts/*.ts` for `RegisterClass`, and at `src/babylon/globals.ts`'s registration block). Gameplay is entered ONLY via `navigate('/play', { gameMode: '<RegisteredModeClass>', sceneUrl?, ...selections })` through `useUnifiedNavigation`. The redesign may move, restyle, multiply, or remove play buttons — but this call must survive, exactly, with the project's real class name.
- **Images on disk:** list what exists under `src/assets/` and `public/` (including `public/assets/generated/`). Import from these or none — never invent an asset path.
- **The chrome location:** `src/custom/` — `loading.tsx`, `splash.tsx` + `splash.css`, `overlay.tsx` + `overlay.css`. This folder is a WRITE zone that sits OUTSIDE the read-only `src/babylon`, so its framework imports go through `'../babylon/…'` (e.g. `import GameManager from '../babylon/globals'`) and its bundled logo imports through `'../assets/…'`.

# Step 1 — the landing page (`src/pages/Home.tsx` + `Home.css`)

Rewrite BOTH files COMPLETELY, as a landing page designed from scratch for this game. Nothing from the previous page survives unless the brief explicitly says to keep it — no starter hero, no demo buttons, no Vite/React/Babylon links, no footer, no engine/toolkit attribution of any kind. Reach gameplay through the play contract from Step 0.

**FULL-PAGE-WIDTH — the Layout law, checked at the CSS level, not a preference:**

- FORBIDDEN on the page root, the hero, and every top-level section: `max-width` with auto margins (`margin: 0 auto` / `margin-inline: auto`), fixed pixel widths, and any wrapper div whose job is to center a column. `.home { max-width: 1200px; margin: 0 auto }` is THE recurring failure — a website column, not a game frontend.
- REQUIRED: root and every section `width: 100%`; backgrounds, hero art, and bars touch BOTH viewport edges (`background-size: cover` / `object-fit: cover` — an image's natural width must never decide the page width); UI clusters anchored to the viewport edges, never floated in a centered box.
- The ONLY permitted `max-width` is a readable measure (~60–75ch) on a TEXT element inside a section that itself runs edge-to-edge.
- SELF-CHECK before finishing: re-read your Home.css — any structural container with `max-width` + auto margins means the task is failed; fix it first. At 1920px there must be NO empty margin strip on either side of the hero.
- Responsive from ~320px to ~2560px, no horizontal scrollbar at any width, nothing clipped or overlapping.

Design to the bt-design skill's standards: full-bleed console UI, bold committed aesthetic, distinctive typography, real motion. `src/pages/` and `src/components/` stay Babylon-free — never import `GameManager` or any Babylon module there; navigation goes through `useUnifiedNavigation`.

# Step 2 — the chrome (`src/custom/**`): splash, preloader, overlay — ALL THREE, one theme

REDESIGN — do not reskin — all three surfaces to the SAME design language as the landing page (typography, palette, motion). Doing only the overlay and stopping is the classic miss: the splash and preloader are the two that ship with the Babylon logo + spinner, so skipping them leaves engine branding in the user's game.

1. **Preloader** — `src/custom/loading.tsx`. First thing on screen, before the app mounts.
2. **Splash / loading screen** — `src/custom/splash.tsx` + `splash.css`. Shown while the 3D scene loads.
3. **Initial overlay** — `src/custom/overlay.tsx` + `overlay.css`. The in-game HUD layer — retheme it to match (a title/brand corner, a frame); the full HUD grows later with gameplay.

**The splash must NEVER be derived from the default Babylon splash (centered logo + spinner) — recoloring the default IS the failure.** Think out of the box: design the loading experience as a scene in this game's world, with a progress metaphor native to THIS game — a racer's start-lights counting down, a fuel gauge filling, a platformer's level assembling tile by tile, a warp drive charging — driven by the real progress value, not a bare bar under a logo. Atmosphere worth watching: staggered reveals, ambient motion, flavor text in the game's voice. There is no limit to what you can do here.

**LIGHTWEIGHT is a hard constraint, not a style choice.** The splash and preloader ARE the progress info — they exist to COVER loading, so they must paint instantly and show progress immediately. Build their creativity from what renders in the first frame: CSS gradients, keyframe animation, typography, particles, inline SVG, canvas-drawn effects, at most small image assets (a compact logo, a texture tile). Do NOT put multi-megabyte generated hero art, photography, or video on these surfaces — a splash that loads its own heavy image defeats itself. Heavy art belongs on the landing page, behind a styled fallback.

**Keep ONLY each surface's wiring; replace ALL of the visuals:**

- `loading.tsx` re-exports `babylonLogo` / `spinnerLogo` that `splash.tsx` imports — keep those exports (or update `splash.tsx`'s import to match).
- `splash.tsx` keeps its `GameManager.EventBus` `"OnLoadProgress"` subscription — that is REAL load progress; drive your metaphor from it.
- `overlay.tsx` keeps `pointer-events: none` on its container so input reaches the canvas; only genuinely interactive elements get `pointer-events: auto`.
- Never delete image files from disk (`public/babylon.png` + `public/spinner.png` are framework-required, whatever your design shows).
- `src/custom/**` runs in the viewer context, so it MAY import `GameManager`/`EventBus` and `useUnifiedNavigation` — through `'../babylon/…'` paths (Step 0).

The Layout law from Step 1 binds these surfaces too — full-bleed, responsive, edge-to-edge.

# Step 3 — bespoke art (when media generation is available)

If the platform's `generate_image` / `generate_video` tools are available on this turn, use them to make the design beautiful: a hero background, a logo/wordmark, splash-adjacent accents (16:9 for wide heroes, 1:1 for badges/logos; png when alpha matters). Make ALL generate calls FIRST, in ONE parallel round, before writing any files; reference the returned `/assets/generated/…` paths exactly as returned (the one exception to never-invent-an-asset-path) — the renders land in the background, so every surface must look finished while they do (styled color/gradient fallback behind each image, never a blank box). At most ONE short looping hero video, and only if it truly elevates the design — video costs the user hundreds of credits. If the tools are absent, design with CSS + the images on disk instead.

Generated art goes on the LANDING PAGE — never on the splash/preloader (Step 2's lightweight rule).

# Step 4 — finish clean

- Zero unresolved imports after the rewrite (every import points at a file that exists).
- No Toolkit/BabylonJS/engine branding anywhere in the user-facing design.
- The play contract fires with the project's REAL GameMode class.
- All four surfaces read as one designed product, not four separate efforts.

State in one short paragraph what design direction you committed to, so the next `/bt-landing` run can be briefed against it.
