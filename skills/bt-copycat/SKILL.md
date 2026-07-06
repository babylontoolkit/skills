---
name: bt-copycat
description: The Babylon Toolkit Copycat Skill forensically studies a live reference website, extracts its full design + motion DNA, and rebuilds a pixel-faithful frontend re-imagined around a new theme/subject for use as our project's Home page. Use when the user gives a URL (often with a creative brief) and wants a site that copies the *mechanics and craft* of the original — scroll choreography, load sequence, animation timing, layout rhythm, the whole "feel" — while re-skinning the subject, palette, and copy to their prompt.
---

Your goal is to **reverse-engineer the reference website down to its DNA and rebuild it, pixel-faithful in mechanics, re-imagined in subject.** Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

## Invocation

```
/bt-copycat <reference-url> <re-imagining brief>
```

Example:
```
/bt-copycat https://www.igloo.inc You don't have to use the igloo object — pick an
object of your choice that makes sense, but it needs that mystical winter, almost
Interstellar vibe: gorgeous, cinematic, otherworldly.
```

- **`<reference-url>`** — the site to study. This is the *blueprint*.
- **`<re-imagining brief>`** — how to re-skin it. This is the *variable*.
- If either is missing, ask for it before starting. Never guess a URL.

## The Prime Directive

**The mechanics are sacred. The skin is the variable.**

You are NOT making "a site loosely inspired by" the reference. You are cloning the *machine that makes it feel amazing* — the exact scroll behavior, the exact load choreography, the exact animation timing and easing, the exact spatial rhythm and section cadence, the exact interaction feedback — and then swapping the subject, palette, typography flavor, imagery, and copy to match the brief.

Split everything you observe into two buckets:

| COPY EXACTLY (the DNA / mechanics) | RE-IMAGINE (the skin) |
| --- | --- |
| Scroll choreography & scrub mechanics | The hero object/subject |
| Page-load sequence & reveal timing | Color palette & mood |
| Animation durations, easings, stagger, delays | Typeface *personality* (not the exact font unless free) |
| Section order, count, and vertical rhythm | Imagery / video content & generated assets |
| Layout grid, alignment, spatial composition | Copywriting, headings, taglines |
| Interaction patterns (hover, cursor, sticky, parallax) | Iconography & decorative motifs |
| Pacing / "breathing" — where it holds and where it moves | Brand name, logo, product specifics |
| Depth, layering, z-order, transitions between sections | |

If in doubt about which bucket something belongs in: **feel-defining → COPY; content-defining → RE-IMAGINE.** A visitor should feel "this moves and breathes exactly like igloo.inc" while seeing something that is unmistakably *ours*.

---

## Phase 1 — Forensic Reconnaissance (DO NOT SKIP)

You cannot recreate what you have not studied frame by frame. **Never build from a memory or a guess of what the site "probably" does.** Go look at the real thing.

Prefer the **chrome-devtools** tools (a real headless browser — you can drive scroll, read the live DOM, capture the network, and profile motion). Fall back to **WebFetch** for raw HTML/CSS/JS only if a browser is unavailable, and **WebSearch** for "site of the year" write-ups, Awwwards case studies, and teardown articles that name the exact techniques used.

Run this teardown against the reference:

1. **Load & watch the entrance.** Navigate to the URL. Capture the loader/preloader, the first paint, and the opening reveal. Note the *sequence and timing* of everything that animates in on load — order, delay, duration, easing. The first 3 seconds define the site's whole personality.
2. **Screenshot the full scroll journey.** Capture the viewport at many scroll depths (e.g. 0%, 10%, 20% … 100%) at desktop width. This is the storyboard you will rebuild. Also capture at a mobile width via `resize_page`/`emulate` — note what reflows, hides, or simplifies.
3. **Dissect the scroll mechanics.** Is the hero scroll-scrubbed (scroll position drives a video/3D timeline)? Sticky sections? Pinned panels? Horizontal scroll? Parallax layers at different speeds? Scroll-triggered reveals? Measure *how much scroll distance* maps to each beat of motion — this is the single most important thing to get right for a cinematic site.
4. **Extract the exact design tokens.** Use `evaluate_script` against the live DOM to pull real values, not eyeballed ones: computed colors (bg/ink/accent), font families & weights, type scale, spacing rhythm, border-radii, shadow recipes, blur/backdrop values, and CSS custom properties. Read the actual CSS.
5. **Time the motion.** Read `transition`/`animation` declarations and, where it matters, run a `performance_start_trace`/`stop_trace` across a scroll to see real durations and frame pacing. Capture easing curves (cubic-bezier values), stagger offsets, and loop timings.
6. **Inventory the assets & tech.** Use `list_network_requests` to see what actually loads: video files (and their length/resolution — critical for a scrub hero), image formats, fonts, and the animation/3D libraries in play (GSAP/ScrollTrigger, Lenis/smooth-scroll, Three.js/Babylon, Lottie, WebGL shaders). Knowing the technique is how you reproduce the feel.
7. **Map interactions.** Hover key elements, move through the nav, trigger the cursor — record custom cursors, magnetic buttons, hover distortions, link transitions, and any sound.

**Deliverable of this phase:** enough captured evidence (screenshots + real numbers) that you could rebuild the site with the tab closed.

## Phase 2 — Write the DNA Blueprint

Before writing a single line of the new site, produce a written **DNA Blueprint** — the machine spec you will build against. Save it (e.g. `DNA-BLUEPRINT.md` in the work dir) so the rebuild is measured against it, not against vibes. It must contain:

- **One-line essence** — the feeling in a sentence ("a lone object drifting through an endless, mystical winter, revealed by scroll").
- **Load sequence** — ordered, timed list of what happens from blank page to interactive.
- **Section-by-section storyboard** — for each section: purpose, layout, what enters/exits, on what trigger, over what scroll distance, with what timing/easing.
- **Scroll model** — scrub vs. reveal vs. pin vs. parallax; scroll-distance-to-motion ratios; smooth-scroll behavior.
- **Motion table** — durations, easings (real cubic-beziers), stagger, delays for the key moments.
- **Design tokens** — the real extracted values, then the **re-imagined** values chosen for the brief beside them.
- **Asset manifest** — every video/image/3D asset the original uses, and what we will generate to replace it under the new theme.
- **Tech approach** — which libraries/techniques reproduce each mechanic.

## Phase 3 — Re-imagine to the Brief

Now apply the creative brief to the *skin only*. Choose the new subject/object, palette, typographic personality, mood, and copy so they serve the prompt — while keeping every mechanic from the blueprint intact. The igloo becomes a lone monolith / a drifting seed / a frozen relic — but it still moves through the world on scroll exactly as the igloo did. Push the aesthetic hard and specific per the brief; do not water it down toward generic.

## Phase 4 — Rebuild with `bt-design`

Hand the DNA Blueprint to the **bt-design** skill to build the actual frontend as our `Home` page (plus any supporting pages the original implies). Instruct bt-design to:

- Match the blueprint's mechanics and timing **exactly** — this is a fidelity job, not a fresh design. Where bt-design would normally improvise, here it executes the blueprint.
- Generate the re-imagined video/image/3D assets (image & video generation) to fill the asset manifest under the new theme — as beautiful and cinematic as the original's.
- Reproduce the load choreography, scroll behavior, and micro-interactions from the motion table.

**Scroll-scrubbed / cinematic scroll heroes:** if the original's hero is scroll-driven (as igloo.inc is), this is a **3D-Hero-Scroll** job. Route through bt-design → `references/3d-hero-scroll.md` and copy the drop-in templates from `templates/3d-hero-scroll/` — do not re-implement the scrub engine from memory. Map the reference's real numbers (footage length, scroll-distance-per-second, telemetry, jump cuts) into `HS_CONFIG` and the `--hs-*` tokens.

**ONLY IF** the user requests to add `3D scroll controls`, use the (bt-design → 3D-Hero-Scroll → playback controls) sub-skill with the requested reach (default: page) to add smooth cinematic playback controls.

## Phase 5 — Verify Fidelity Against the Original

A copycat that "feels off" has failed. Before declaring done, verify the rebuild the same way you studied the original:

- Open the rebuilt site in the browser and capture the **same scroll-depth storyboard** you captured in Phase 1. Compare side by side against the blueprint — does each beat land at the same scroll position with the same motion?
- Check the load sequence, easings, and stagger match the motion table.
- Confirm nothing is janky: smooth scrubbing, no layout shift, motion holds 60fps where the original does.
- Confirm the *skin* fully reads as the new brief, not a recolor of the original's content.

Report any beat where fidelity is imperfect and fix it — do not paper over a mechanic you couldn't reproduce.

---

## Non-Negotiables

- **Study first, build second.** No recreation begins before Phase 1 evidence and a Phase 2 blueprint exist.
- **Numbers, not vibes.** Extract real colors, timings, and scroll ratios from the live site. "Roughly a fade" is not acceptable when you can read the exact `cubic-bezier`.
- **Mechanics are copied; content is re-imagined.** Never invent a different scroll feel; never ship the original's subject/branding.
- **Match the original's craft ceiling.** The reference is award-winning for a reason. The rebuild must be *as* beautiful — no generic AI-slop fallback (see bt-design's anti-slop guidance). If the original holds a held, breathing silence before a reveal, so does ours.
- **Verify against the source.** Done means the storyboards match.
