---
name: bt-design
description: "The Babylon Toolkit Design Skill helps create distinctive, production-grade frontend and in-game BabylonJS user interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, BabylonJS GUIs, HUDs, Menus, Popups and Overlays, or when styling/beautifying any web UI). Also handles 3D scrolling hero sections / scroll-scrubbed cinematic video heroes with optional HUD, autoplay, and jump controls. Generates creative, polished code and UI design that avoids generic AI aesthetics."
---

This skill guides creation of distinctive, production-grade frontend and in-game BabylonJS user interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

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
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: You are capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

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
to the film's brand and exit tone**, not a reskinned starter template; `hero`
= PLAY/END stop at the journey's end. It is deliberately named `sweep`, **not
`reach`**, so it never collides with a spec/plan's route/DOM-scope
terminology — carry the *behavior* (PLAY-sweeps-to-bottom, END-to-bottom,
`tailRate`) into any downstream spec explicitly; never reduce it to a scope word.
