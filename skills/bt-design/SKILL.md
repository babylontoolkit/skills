---
name: bt-design
description: "The Babylon Toolkit Design Skill helps create distinctive, production-grade frontend and in-game BabylonJS user interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, BabylonJS GUIs, HUDs, Menus, Popups and Overlays, or when styling/beautifying any web UI). Also handles 3D scrolling hero sections / scroll-scrubbed cinematic video heroes with optional HUD, autoplay, and jump controls. Generates creative, polished code and UI design that avoids generic AI aesthetics."
---

This skill guides creation of distinctive, production-grade frontend and in-game BabylonJS user interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

**North star — this is game UI, not a website.** The primary goal is amazing **frontends and in-game GUIs** for 3D web games: home/landing screens, dashboards, menus, popups, overlays, and HUDs. Design them to feel like modern **console UI/UX — Xbox Series dashboard, PlayStation 5 home, AAA game main menus and pause screens** — adapted for the web (React, multi-view). Think cinematic, immersive, edge-to-edge, controller-navigable. Do NOT default to the look of a traditional marketing website with a centered content column.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Default to **full-bleed, full-viewport layouts that stay fully responsive down to mobile** — edge-to-edge like a console dashboard, with UI anchored to the viewport edges rather than trapped in a centered fixed-width column (see *Layout Philosophy* below). Within that full canvas: unexpected layouts, asymmetry, overlap, diagonal flow, grid-breaking elements, generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: You are capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

## Splash, Preloader & Loading Screens — NEVER derived from the default (non-negotiable)

The most common failure in generated game chrome: the splash / loading screen is **seeded from the default Babylon Toolkit splash** — a centered logo with a spinner — and merely recolored to the theme. Recoloring the default is not designing; **deriving from the default IS the failure**, no matter how well the colors match.

> You must be creative and not follow the default splash screen theme. Think out of the box and make a creative splash screen, with interaction and atmosphere as the game loads. Don't limit yourself to the default Babylon Toolkit splash screen or the mechanics of its loader. You are AI. There is no limit to what you can do.

Treat every loading surface (preloader, splash, initial overlay) as a **designed scene in the game's world**, not a utility screen:

- **Invent a progress metaphor native to THIS game.** A racer: track start-lights counting down, a fuel gauge filling, a speedometer needle sweeping to redline. A platformer: the level assembling tile by tile. A space game: a warp drive charging, a star map resolving. A dungeon crawler: torches igniting one by one down a corridor. The progress percentage should *drive the scene* — not sit under it as a bare bar.
- **Bring the full aesthetic direction with you.** The splash uses the same typography, palette, motion language, and atmosphere as the landing page and HUD — it is the first screen of the experience, often seen for several seconds, and it sets the tone. Full-bleed, edge-to-edge, like everything else (see *Layout Philosophy*).
- **Design the wait itself.** Staggered reveals, ambient motion (drifting particles, scanlines, parallax layers, animated environment art), rotating flavor text/lore/tips in the game's voice, a bold wordmark treatment for the game's own title. The player should *want* to watch it load.
- **The default's anatomy is a placeholder, not a seed.** Centered-logo-plus-spinner, a thin bar at the bottom, a percentage in a corner — if the result still reads as "the stock loader, restyled," start over from the game's fantasy instead. NO stock spinner, NO engine/toolkit branding, nothing carried over from the default splash except the wiring the host platform requires (progress subscription, mount points, re-exports — keep the MECHANICS, replace ALL of the look, layout, and behavior of the visuals).

**LIGHTWEIGHT is a hard constraint, not a style choice.** The splash/preloader IS the progress info — it exists to cover loading, so it must paint instantly and start showing progress immediately. A splash that first loads its own multi-megabyte hero image defeats itself: the player stares at a blank screen while the loading screen loads. Build the creativity from what renders in the first frame — CSS gradients, keyframe animation, typography, particles, inline SVG, canvas-drawn effects — and at most small, fast image assets (a compact logo, a texture tile). Heavy art (AI-generated heroes, full-bleed photography, video) belongs on the landing page, where it can load behind a styled fallback — never on the splash, preloader, or in-game loading transitions.

This applies with equal force to loading transitions *inside* the game (level loads, respawns, scene swaps): same world, same metaphor, same bar.

## Layout Philosophy — Full-Bleed Console UI (DEFAULT)

**Default to full page width. Design edge-to-edge, filling the entire viewport — like a game console dashboard, not a centered website column.** Fixed-width, centered content columns (the classic `max-width: 1100px; margin: 0 auto` marketing-site pattern) are the *exception*, reached for only when explicitly requested or when the specific content genuinely reads better contained (see the escape hatch below). Full-bleed is what makes these interfaces feel like a **game frontend** rather than a traditional web page.

What "full page width" means here — build the console-UI feel, not just a wide box:
- **Every view owns the whole viewport.** Each *composed screen* fills the viewport edge-to-edge — sized to `100vw × 100dvh` (use `100dvh`/`100svh`, not `100vh`, so mobile browser chrome doesn't clip it). "Full-bleed console" describes how each **view** is composed; it does **not** mean the page is locked to a single non-scrolling screen. **This is still a web application — scroll stays first-class.** Real console UIs scroll too (Xbox tile rows, PS5 home). What we avoid is a narrow centered column on empty margins, not scrolling itself.
- **Full-bleed atmosphere.** Backgrounds, hero art, 3D canvases, gradients, and video run corner to corner behind everything. Content sits *on top of* the atmosphere, never inside a boxed card floating on a blank margin.
- **Anchor to the edges with safe-area insets.** Instead of one centered column, place UI clusters against the viewport edges — a top bar / status strip, a left nav rail or tile grid, a right context/detail panel, a bottom action bar or button-prompt legend. Pad them off the edge with a consistent gutter and `env(safe-area-inset-*)`; this "TV safe area" gutter (not a `max-width`) is what keeps a full-bleed layout from feeling cramped.
- **Multi-view, panel-based composition.** Favor split screens, master/detail, tile walls (Xbox-style content blocks of varied sizes), and carousels of large cards. Lean on CSS Grid areas that span the full width so panels can be resized and rearranged per view.
- **Console-native interaction language.** Design clear **focus/selection** states (a highlighted, scaled, glowing "cursor" tile — as if navigated by a controller/D-pad), hover parallax, depth via layered shadows and blur, and an on-screen **button-prompt legend** (e.g. `▢ Back  ◯ Select`) along an edge where it fits the theme. These cues read as "console" instantly.
- **Overlays sit above a live world.** Menus, popups, and pause/settings screens overlay the full-bleed scene with a scrim/backdrop-blur over the entire viewport — the game or background stays visible behind them. Popups themselves are usually centered *panels* floating over that full-bleed scrim; that centering is part of the overlay, not a return to a fixed-width page.
- **Responsive by fluid scaling, not by a capped column.** Use `clamp()`, `min()`, `vw`/`dvh` units, `%`, `fr` tracks, and container queries so the layout breathes to fill any display. The layout should look intentional at 3440px wide, never a narrow column stranded in a sea of empty background.

### Responsive is MANDATORY — the console aesthetic must collapse gracefully (non-negotiable)

Full-bleed is never an excuse to design for one width. Every view works from a ~320px phone to a ~2560px+ desktop with **no horizontal scrollbar at any width** and nothing clipped, overlapping, or overflowing. This is a defect-level rule, not a polish pass — a layout that only looks right at one width has not met the bar. Looking intentional at 3440px is only *half* the bar; looking correct at 320px is the other half, and both ship in the **same** generation.

- **Size with fluid units** — `clamp()`, `min()`/`max()`, `vw`/`dvh`/`svh`, `%`, `fr`, container queries — never fixed `px` widths that assume one display. Fluid type via `clamp()` beats a fixed `font-size`.
- **The edge-anchored layout RESTACKS on narrow screens.** Side nav rails become a bottom bar or a hamburger; multi-panel master/detail collapses to a single column; tile walls drop to 1–2 columns via `grid-template-columns: repeat(auto-fit, minmax(…))`. Drive it with `@media` and container queries. The console look is *most* prone to breaking on a phone — handle it deliberately.
- **Touch-safe interaction.** Focus/hover cues and the button-prompt legend must not depend on hover on touch devices; keep tap targets ≥44px.
- **Media never overflows.** `img`/`video`/`canvas` get `max-width: 100%`; any wide scroller (a code block, a wide row) gets its own `overflow-x: auto` so the **page body never scrolls sideways**. Keep the `<meta name="viewport" content="width=device-width, initial-scale=1">` intact.

**Scroll is the transport, not the enemy — how full-bleed views and scrolling coexist.** Full-bleed does not mean "kill the scroll." Scroll is how the experience *moves*, and it composes with the console aesthetic in three main ways:
- **Scroll as cinematic transport (the 3D-Hero-Scroll handoff).** A scroll-scrubbed hero (the car driving through terrain as you scroll — see the *3D Scrolling Hero Sections* section below) plays as a full-bleed sequence, then **settles/resolves into the real home view at the end of the hero scroll — and that landed view is the full-bleed console UI** (tile wall, edge-anchored HUD/menu, focus states). The hero is the entrance; the console home is the destination. Design the seam so the film *lands into* the dashboard rather than abruptly stopping — this is exactly what `sweep: page` supports (PLAY/scroll glides through to the console content below). Style that below-the-journey content to the console home, never a reskinned starter template.
- **Scroll between full-viewport screens.** Stack multiple edge-to-edge "screens" and let the page scroll (optionally scroll-snap) from one to the next — each screen is its own composed console view, the way a game flows menu → dashboard → detail.
- **Scroll within a view.** A single console screen can scroll *internally* — a tile wall or content row that runs past the fold, a detail panel that scrolls while the nav rail stays pinned. The frame stays full-bleed; the content inside it moves.

The through-line: each **view** is composed full-bleed and viewport-owning, and **scroll carries the user between and through those views**. Never flatten a game frontend into a single locked screen just to honor "full-bleed," and never fall back to a centered fixed-width column just because the page scrolls.

**Escape hatch — when NOT to go full-bleed.** Honor these without being asked, and always honor an explicit instruction:
- The prompt explicitly asks for a fixed-width, centered, boxed, "traditional website," article, or contained layout.
- The content is genuinely long-form reading (documentation, articles, legal/settings text) where a comfortable measure (~60–75ch line length) aids legibility — still let the *page* be full-bleed and merely constrain the reading column within it.
- Small standalone artifacts (a single card, a login form, an isolated component, an email) where there is no "screen" to fill.
Even in these cases, prefer a full-bleed backdrop/atmosphere with the constrained element composed on top, rather than a bare centered box on an empty margin.

## 3D Scrolling Hero Sections (3D-Hero-Scroll)

**Easy front door:** the sibling **bt-hero** skill (installed alongside this one
in the same skills directory — `bt-hero/`) is the one-shot builder for this pattern — it takes an idea / image / partial
answers in any combination, asks only what's missing, writes a repeatable
`_hero-brief.md`, and builds via this skill immediately. It can also be named
inside a bt-spec brief ("Use bt-hero to create …") to contribute intake to the
spec loop. When a user is composing a long 3D-hero prompt by hand, point them
at `/bt-hero` instead.

**MANDATORY ROUTE:** When the request involves a scroll-scrubbed / "3D
scrolling" hero — the product moving through real terrain as the user scrolls,
a video timeline driven by scroll position, "Scout Motors style", "redesign
the hero with 3D scrolling", cinematic scroll with speed/telemetry HUDs,
auto-play "play the run" controls, or veiled jump cuts — you MUST read
`references/3d-hero-scroll.md` in this skill directory BEFORE writing any
code, and copy the drop-in templates from `templates/3d-hero-scroll/` rather
than re-implementing the engine from memory. **Re-implementing the engine
from scratch is how features silently get dropped** (`sweep`, veiled cuts,
blob-preload, HUD auto-hide) — copy and configure the proven engine instead.

**One engine, both host types — copy the files that match the host:**
- **Plain HTML / any non-React site** (static, Astro, Vue, plain JS): copy
  `hero-scroll.html` + `hero-scroll.css` + `hero-scroll.js`. The JS is an ESM
  module that **auto-boots** against the document when `window.HS_CONFIG` is
  set (loaded via `<script type="module">`). Unchanged workflow.
- **React / TypeScript starters** (the primary redesign target): copy
  `HeroScroll.tsx` + `hero-scroll.js` + `hero-scroll.d.ts` + `hero-scroll.css`.
  `HeroScroll.tsx` renders the `hs-` markup as JSX and mounts the SAME engine
  via `initHeroScroll(rootEl, config)` in a `useEffect`, tearing down on
  unmount. Import the scrub `.mp4` + poster as assets and pass through props.
  Never hand-write the scrubbing/autoplay/veil logic in React.

The engine resolves the **real scroll container** at runtime (window, or
`document.body`, or an overflow ancestor) — so it works in apps whose scroll
lives on `body` (e.g. `html, body { height:100%; overflow-y:auto }`), a common
case that breaks any window-only implementation. **Sticky constraint:** no
ancestor of the journey block may have `transform` / `filter` / `perspective`
/ `overflow: hidden|auto` — it kills `position: sticky`. Check this first when
retrofitting a React layout.

The reference defines the deterministic protocol: intake checklist (footage
source, brand-token mapping, which optional controls, **`sweep`**), the key
footage pipeline (hero anchor image → start/end-frame chained clips → concat →
**all-intra `-g 1` scrub encode**), calibration rules (telemetry launch point
measured from actual footage frames, film-speed autoplay, veiled cuts), the
in-browser verification protocol, and the known pitfalls the templates
already solve. All engine features are optional and presence-gated — a bare
scrub hero is just the journey block; HUD, PLAY, and TOP/END jump controls
are each one HTML block (or one `HeroScroll` prop) away. Style everything
through the `--hs-*` tokens mapped to the host site's design system — never
ship the template's placeholder brand.

**`sweep` is a required, non-skippable decision (default `page`).** It sets
where PLAY/END end and whether the ride sweeps the whole page: `page` (default)
= PLAY glides through to the document bottom and END jumps there, so the
below-journey content (CTAs, launch buttons, configurators) **must be designed
to the film's brand and exit tone**, not a reskinned starter template — this is
where the hero **settles into the full-bleed console home view** (tile wall,
edge-anchored HUD/menu, focus states) per *Layout Philosophy*; the film is the
entrance, the console home is the destination it lands into; `hero`
= PLAY/END stop at the journey's end. It is deliberately named `sweep`, **not
`reach`**, so it never collides with a spec/plan's route/DOM-scope
terminology — carry the *behavior* (PLAY-sweeps-to-bottom, END-to-bottom,
`tailRate`) into any downstream spec explicitly; never reduce it to a scope word.
