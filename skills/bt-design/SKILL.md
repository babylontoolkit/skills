---
name: bt-design
description: The Babylon Toolkit Design Skill helps create distinctive, production-grade frontend and in-game BabylonJS user interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, BabylonJS GUIs, HUDs, Menus, Popups and Overlays, or when styling/beautifying any web UI). Also handles 3D scrolling hero sections / scroll-scrubbed cinematic video heroes with optional HUD, autoplay, and jump controls. Generates creative, polished code and UI design that avoids generic AI aesthetics.
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

**MANDATORY ROUTE:** When the request involves a scroll-scrubbed / "3D
scrolling" hero — the product moving through real terrain as the user scrolls,
a video timeline driven by scroll position, "Scout Motors style", "redesign
the hero with 3D scrolling", cinematic scroll with speed/telemetry HUDs,
auto-play "play the run" controls, or veiled jump cuts — you MUST read
`references/3d-hero-scroll.md` in this skill directory BEFORE writing any
code, and copy the drop-in templates from `templates/3d-hero-scroll/`
(`hero-scroll.html`, `hero-scroll.css`, `hero-scroll.js`) rather than
re-implementing the engine from memory.

The reference defines the deterministic protocol: intake checklist (footage
source, brand-token mapping, which optional controls), the key footage
pipeline (hero anchor image → start/end-frame chained clips → concat →
**all-intra `-g 1` scrub encode**), calibration rules (telemetry launch point
measured from actual footage frames, film-speed autoplay, veiled cuts), the
in-browser verification protocol, and the known pitfalls the templates
already solve. All engine features are optional and presence-gated — a bare
scrub hero is just the journey block; HUD, PLAY, and TOP/END jump controls
are each one HTML block away. Style everything through the `--hs-*` tokens
mapped to the host site's design system — never ship the template's
placeholder brand.
