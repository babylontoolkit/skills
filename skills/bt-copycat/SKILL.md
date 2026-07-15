---
name: bt-copycat
description: "The Babylon Toolkit Copycat Skill forensically studies a live reference website, extracts its full design + motion DNA, and rebuilds a pixel-faithful frontend re-imagined around a new theme/subject for use as our project's Home page. Use when the user gives a URL (often with a creative brief) and wants a site that copies the *mechanics and craft* of the original — scroll choreography, load sequence, animation timing, layout rhythm, the whole `feel` — while re-skinning the subject, palette, and copy to their prompt."
---

Your goal is to **reverse-engineer the reference website down to its DNA and rebuild it, pixel-faithful in mechanics, re-imagined in subject.** Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

---

# Invocation

```
/bt-copycat [--copilot] <reference-url> <re-imagining brief>
```
- **`<reference-url>`** — the site to study. This is the *blueprint*.
- **`<re-imagining brief>`** — how to re-skin it. This is the *variable*.
- **`--copilot`** *(optional flag)* — force **Mode B (User-Driven / Co-Pilot)** from the very start: the agent launches the shared chrome-devtools browser, you drive the scroll, it snapshots each beat. Skip the headless attempt entirely. Aliases: `--copilot`, `--co-pilot`, `--mode-b`. You can also just say "use co-pilot mode" / "I'll drive" anywhere in the prompt and it means the same thing.
- If either the URL or brief is missing, ask for it before starting. Never guess a URL.

Example (co-pilot from the jump):
```
/bt-copycat --copilot → https://www.igloo.inc/ → <re-imagining brief>
```

Example:
```
/bt-copycat --copilot → https://www.igloo.inc/ → Redesign this starter template to be the frontend for the prototype of a third person action adventure game called `Project Alpha`. Make sure there is `copy` on each phase of the hero stages. You don't have to use the igloo object — pick some sort of monolith or something that makes sense, but it needs that mystical winter, almost interstellar vibe: gorgeous, cinematic, otherworldly. The 3D scrolling cinematic should end with some engaging `Enter The Void` user interface that launches the `Player Demo` to start the prototype.
```

---

# The Prime Directive

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
| Depth, layering, z-order, transitions between sections | Sound *design* content (the actual tracks/SFX & their theme) |
| Audio behavior (ambient bed, scroll/hover SFX, mute UX, autoplay-gating) | |

If in doubt about which bucket something belongs in: **feel-defining → COPY; content-defining → RE-IMAGINE.** A visitor should feel "this moves and breathes exactly like igloo.inc" while seeing something that is unmistakably *ours*.

---

## Phase 1 — Forensic Reconnaissance (DO NOT SKIP)

You cannot recreate what you have not studied frame by frame. **Never build from a memory or a guess of what the site "probably" does.** Go look at the real thing.

Prefer the **chrome-devtools** tools (a real headless browser — you can drive scroll, read the live DOM, capture the network, and profile motion). Fall back to **WebFetch** for raw HTML/CSS/JS only if a browser is unavailable, and **WebSearch** for "site of the year" write-ups, Awwwards case studies, and teardown articles that name the exact techniques used.

### Choosing a Capture Mode

Scroll-scrubbed 3D/video heroes (igloo.inc-class sites) are often **painfully slow or unreliable to drive headlessly** — the agent-driven scroll stutters, the WebGL timeline doesn't settle between frames, and a full teardown can stall out. When that happens, **do not keep grinding the headless scroll.** Switch to co-pilot mode. Pick the mode up front and tell the user which one you're using:

- **Mode A — Agent-Driven (default).** You drive everything through chrome-devtools: navigate, scroll, screenshot, read the DOM, trace motion. Use this for standard sites and whenever headless scrolling is smooth.
- **Mode B — User-Driven / Co-Pilot.** *You launch and share the chrome-devtools browser; the user drives the scroll while you direct and snapshot.* Use this when: the hero is a heavy scroll-scrubbed 3D/video timeline; headless scroll is janky, stalling, or not advancing the animation; the site blocks automation / needs a login or cookie wall; or the user simply asks to drive.

**Start directly in Mode B when asked.** If the invocation includes the **`--copilot`** flag (or `--co-pilot` / `--mode-b`), or the user says anything like "use co-pilot mode" / "I'll drive" / "let me scroll", **begin in Mode B immediately — skip the headless Mode A attempt entirely** and go straight to the Mode B setup below.

**Announce a switch:** if you start in Mode A and the scroll teardown is taking too long or not progressing after a couple of attempts, stop and say so — e.g. *"The headless scroll isn't keeping up with this 3D hero. Let's switch to co-pilot mode — I'll launch the browser, you drive the scroll, and I'll snapshot each beat."* — then follow the protocol below.

### Mode B — User-Driven Co-Pilot Protocol

You become the director; the user is the hands. Give **one clear instruction at a time, wait for the user's signal, then capture, then advance.** Never fire a wall of steps at once.

**Setup (agent launches the browser, user parks it at the top)**
1. **You launch the browser.** Open the reference URL in the shared **chrome-devtools** browser, maximized at desktop width. Let it fully load, then **say you're ready** and hand control to the user — e.g. *"Chrome DevTools is up on the reference site and fully loaded. It's yours — scroll it all the way back to the very top, get it parked and holding still, then say 'ready' and I'll take the first snapshot."*
2. **The user positions the page.** The user takes the shared browser, scrolls fully back to the very top of the experience, and lets it settle.
3. **Tell them the cadence + signal words** up front: the default checkpoint cadence is **~10% of page height per step**, plus any moment where the motion visibly changes. From the top the user signals **"ready"**; after that they follow your lead — scroll the amount you ask, let it hold still, and say **"ok"** / **"next"** (or "ready for the next snapshot") for each beat.

> **Shared browser is the default here.** Because *you* launched the chrome-devtools browser, *you* take every screenshot and read live values yourself (`evaluate_script`, `list_network_requests`) at each checkpoint — the user only drives the scroll. Only fall back to asking the user to paste screenshots/snippets if the browser can't be shared.

**Signal words (tell the user these up front)**
- **"ready"** — user has parked the page at the very top and it's holding still; you take the **first snapshot** now, then begin the loop.
- **"ok"** / **"next"** — user has completed the scroll step you asked for and the frame is holding still; safe for you to capture the next beat.
- **"done"** — user has reached the bottom / end of the sequence.
- **"back"** — user needs you to re-describe or repeat the previous step.
- **"stop"** — abort the capture.

**The loop (repeat until "done")**
0. **User:** signals **"ready"** at the top. **You:** take the first snapshot and read the load/first-paint values before asking for any scroll.
1. **You:** give exactly one instruction — e.g. *"Scroll down slowly until the object is roughly centered and the text has just finished fading in, then hold still and say 'ok'."* Be specific about what beat to stop on, not just a pixel amount.
2. **User:** performs it and replies **"ok"** / **"next"**.
3. **You:** capture the checkpoint yourself in the shared chrome-devtools browser — take the screenshot and read any live values you can. Note the scroll depth, what entered/exited, and the apparent timing/easing of that beat. (Only if the browser can't be shared, ask the user to paste/attach a screenshot.)
4. **You:** confirm and advance — *"Got it, checkpoint 3 captured. Next: keep scrolling until the horizon tilts and a new panel pins — hold and say 'ok'."*
5. Repeat. When the user says **"done"**, confirm you have top-to-bottom coverage; if a beat is missing, ask them to scroll back to it (**"back"**) and re-capture.

**What you still must extract in Mode B.** Manual scrolling replaces only the *screenshotting of the journey*. You still need the real numbers — design tokens, easings, asset/network inventory, scroll-distance ratios. If you share the chrome-devtools browser with the user, pull these yourself via `evaluate_script` / `list_network_requests` between checkpoints. If you cannot, ask the user to run small snippets (e.g. `getComputedStyle`, `document.body.scrollHeight`, the Network tab's asset list) and paste the results. **Screenshots alone are not enough — vibes fail Phase 5 verification.**

**Reuse this loop in Phase 5.** When verifying the rebuild's fidelity, run the exact same co-pilot protocol against *our* site so the storyboards are captured identically and compared beat-for-beat.

Run this teardown against the reference (in either mode):

1. **Load & watch the entrance.** Navigate to the URL. Capture the loader/preloader, the first paint, and the opening reveal. Note the *sequence and timing* of everything that animates in on load — order, delay, duration, easing. The first 3 seconds define the site's whole personality.
2. **Screenshot the full scroll journey.** Capture the viewport at many scroll depths (e.g. 0%, 10%, 20% … 100%) at desktop width. This is the storyboard you will rebuild. Also capture at a mobile width via `resize_page`/`emulate` — note what reflows, hides, or simplifies.
3. **Dissect the scroll mechanics.** Is the hero scroll-scrubbed (scroll position drives a video/3D timeline)? Sticky sections? Pinned panels? Horizontal scroll? Parallax layers at different speeds? Scroll-triggered reveals? Measure *how much scroll distance* maps to each beat of motion — this is the single most important thing to get right for a cinematic site.
4. **Extract the exact design tokens.** Use `evaluate_script` against the live DOM to pull real values, not eyeballed ones: computed colors (bg/ink/accent), font families & weights, type scale, spacing rhythm, border-radii, shadow recipes, blur/backdrop values, and CSS custom properties. Read the actual CSS.
5. **Time the motion.** Read `transition`/`animation` declarations and, where it matters, run a `performance_start_trace`/`stop_trace` across a scroll to see real durations and frame pacing. Capture easing curves (cubic-bezier values), stagger offsets, and loop timings.
6. **Inventory the assets & tech.** Use `list_network_requests` to see what actually loads: video files (and their length/resolution — critical for a scrub hero), image formats, fonts, and the animation/3D libraries in play (GSAP/ScrollTrigger, Lenis/smooth-scroll, Three.js/Babylon, Lottie, WebGL shaders). Knowing the technique is how you reproduce the feel.
7. **Map interactions.** Hover key elements, move through the nav, trigger the cursor — record custom cursors, magnetic buttons, hover distortions, link transitions, and any sound.
8. **Check for audio (do not skip).** Determine whether the site has sound at all — many award-winning cinematic sites ship an ambient audio bed, scroll/hover SFX, or a reveal sting. Inspect the network inventory for audio files (`.mp3`/`.ogg`/`.wav`/`.m4a`) and the DOM/JS for `<audio>` elements, `AudioContext`/Web Audio, Howler.js, or muted-autoplay video used purely for sound. Record: is there an ambient loop, per-interaction SFX, or scroll-synced audio? How is playback gated (autoplay policy — first user gesture, an explicit sound toggle)? Is there a mute/unmute control, and where does it live? What is the default state (on/off)? If the site has **no audio**, note that explicitly so the rebuild doesn't invent it.

**Deliverable of this phase:** enough captured evidence (screenshots + real numbers) that you could rebuild the site with the tab closed.

## Phase 2 — Write the DNA Blueprint

Before writing a single line of the new site, produce a written **DNA Blueprint** — the machine spec you will build against. Save it (e.g. `DNA-BLUEPRINT.md` in the work dir) so the rebuild is measured against it, not against vibes. It must contain:

- **One-line essence** — the feeling in a sentence ("a lone object drifting through an endless, mystical winter, revealed by scroll").
- **Load sequence** — ordered, timed list of what happens from blank page to interactive.
- **Section-by-section storyboard** — for each section: purpose, layout, what enters/exits, on what trigger, over what scroll distance, with what timing/easing.
- **Scroll model** — scrub vs. reveal vs. pin vs. parallax; scroll-distance-to-motion ratios; smooth-scroll behavior.
- **Motion table** — durations, easings (real cubic-beziers), stagger, delays for the key moments.
- **Audio model** — whether the site has sound at all; if so, the ambient bed / per-interaction SFX / scroll-synced audio, the playback-gating mechanism (autoplay policy, first-gesture unlock), the mute/unmute control and its default state — plus the **re-imagined** audio direction chosen for the brief. If the original is silent, say so.
- **Design tokens** — the real extracted values, then the **re-imagined** values chosen for the brief beside them.
- **Asset manifest** — every video/image/3D/audio asset the original uses, and what we will generate to replace it under the new theme.
- **Tech approach** — which libraries/techniques reproduce each mechanic.

## Phase 3 — Re-imagine to the Brief

Now apply the creative brief to the *skin only*. Choose the new subject/object, palette, typographic personality, mood, and copy so they serve the prompt — while keeping every mechanic from the blueprint intact. The igloo becomes a lone monolith / a drifting seed / a frozen relic — but it still moves through the world on scroll exactly as the igloo did. Push the aesthetic hard and specific per the brief; do not water it down toward generic.

**Fidelity governs the layout — but skin toward game-frontend console UI.** The reference's layout width and spatial composition live in the COPY-EXACTLY bucket, so match the original: if it's full-bleed / full page width (as the cinematic, award-winning references this skill targets almost always are), reproduce that faithfully; if it is genuinely fixed-width, keep it fixed-width — do **not** force full-bleed onto a reference that isn't. Within whatever width the blueprint dictates, push the *skin* toward the modern-console game-frontend feel from bt-design's *Layout Philosophy — Full-Bleed Console UI* (edge-anchored HUD/menu clusters, console focus/selection states, cinematic overlays), since the output is our game's Home page — never at the cost of a mechanic.

## Phase 4 — Rebuild with `bt-design`

Hand the DNA Blueprint to the **bt-design** skill to build the actual frontend as our `Home` page (plus any supporting pages the original implies). Instruct bt-design to:

- Match the blueprint's mechanics and timing **exactly** — this is a fidelity job, not a fresh design. Where bt-design would normally improvise, here it executes the blueprint.
- Generate the re-imagined video/image/3D assets (image & video generation) to fill the asset manifest under the new theme — as beautiful and cinematic as the original's.
- Reproduce the load choreography, scroll behavior, and micro-interactions from the motion table.
- **Reproduce the audio model from the blueprint** — if the original has sound, rebuild the equivalent behavior (ambient bed, interaction/scroll SFX, mute toggle, autoplay-gating on first user gesture per browser policy) and generate re-imagined audio assets that match the new theme. If the original is silent, do not add audio unless the brief asks for it.

**Enforced build mandate (always apply):**
- Make the new site **as cinematic and award-winning as the original**, and make it **feel like a real game prototype, not a generic template**.
- **The user provides the prototype's own assets.** You may generate any *additional* cinematic imagery or video needed to fill out the storyboard — use image & video generation to create every necessary asset.
- Make the new site **fully responsive** and working on all devices.
- **Create a `DESIGN.md`** reflecting the new theme if it does not exist or is only an empty stub; otherwise update it.
- **Update `SPEC.md`** with any significant architectural changes, if any.

**Scroll-scrubbed / cinematic scroll heroes:** if the original's hero is scroll-driven (as igloo.inc is), this is a **3D-Hero-Scroll** job. Route through bt-design → `references/3d-hero-scroll.md` and copy the drop-in templates from `templates/3d-hero-scroll/` — do not re-implement the scrub engine from memory. Map the reference's real numbers (footage length, scroll-distance-per-second, telemetry, jump cuts) into `HS_CONFIG` and the `--hs-*` tokens.

**ONLY IF** the user requests to add `3D scroll controls`, use the (bt-design → 3D-Hero-Scroll → playback controls) sub-skill with the requested `sweep` (default: `page`) to add smooth cinematic playback controls.

## Phase 5 — Verify Fidelity Against the Original

A copycat that "feels off" has failed. Before declaring done, verify the rebuild the same way you studied the original:

- Open the rebuilt site in the browser and capture the **same scroll-depth storyboard** you captured in Phase 1. Compare side by side against the blueprint — does each beat land at the same scroll position with the same motion?
- Check the load sequence, easings, and stagger match the motion table.
- Confirm nothing is janky: smooth scrubbing, no layout shift, motion holds 60fps where the original does.
- Confirm the audio behavior matches the blueprint: if the original had sound, ours has the equivalent ambient bed / SFX, a working mute toggle, and correct autoplay-gating; if the original was silent, ours is too (unless the brief asked otherwise).
- Confirm the *skin* fully reads as the new brief, not a recolor of the original's content.

Report any beat where fidelity is imperfect and fix it — do not paper over a mechanic you couldn't reproduce.

---

## Non-Negotiables

- **Study first, build second.** No recreation begins before Phase 1 evidence and a Phase 2 blueprint exist.
- **Numbers, not vibes.** Extract real colors, timings, and scroll ratios from the live site. "Roughly a fade" is not acceptable when you can read the exact `cubic-bezier`.
- **Mechanics are copied; content is re-imagined.** Never invent a different scroll feel; never ship the original's subject/branding.
- **Match the original's craft ceiling.** The reference is award-winning for a reason. The rebuild must be *as* beautiful — no generic AI-slop fallback (see bt-design's anti-slop guidance). If the original holds a held, breathing silence before a reveal, so does ours.
- **Ship a prototype, not a template.** The result must feel like a real game prototype — cinematic and award-winning — fully responsive on all devices. The user supplies the prototype's assets; generate any additional cinematic imagery/video to complete the storyboard. Create `DESIGN.md` for the new theme (if missing or an empty stub) and update `SPEC.md` for any significant architectural changes.
- **Verify against the source.** Done means the storyboards match.
