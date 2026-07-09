# 3D Scrolling Hero Section With Optional Cinematic Controls (3D-Hero-Scroll)

A scroll-scrubbed cinematic hero: the product moves through real terrain as the
user scrolls — the scroll position IS the film's playhead. Proven pattern
(Scout-Motors-style site-of-the-year mechanics) with optional chrome: telemetry
HUD, film-speed autoplay, veiled jump cuts.

**Triggers:** "3D scrolling hero", "scroll-scrub", "cinematic scroll",
"redesign the hero with 3D scrolling", "the product drives/flies/moves as you
scroll", "Scout Motors style".

**Human quickstart:** `3d-hero-docs.md` (this directory)
maps every prompt field to the exact code it generates — hand it to developers
writing invocation prompts.

**Templates (drop-in, in this skill) — `templates/3d-hero-scroll/`:**
`hero-scroll.js` is one framework-agnostic ESM engine shared by both hosts;
copy the files that match the target:
- **Non-React (plain HTML/static/Astro/Vue/plain JS):** `hero-scroll.html` +
  `hero-scroll.css` + `hero-scroll.js`. The engine **auto-boots** against the
  document when `window.HS_CONFIG` is set, loaded via
  `<script type="module" src="hero-scroll.js">`.
- **React / TypeScript:** `HeroScroll.tsx` + `hero-scroll.js` +
  `hero-scroll.d.ts` + `hero-scroll.css`. `HeroScroll.tsx` renders the markup
  as JSX and mounts the SAME engine via `initHeroScroll(rootEl, config)` in a
  `useEffect` (destroy on unmount). Props gate the optional chrome; import the
  scrub mp4 + poster as assets.

The engine is config-driven (`HS_CONFIG` / the config arg) and presence-gated:
delete an optional element (or omit a `HeroScroll` prop) and its feature
vanishes cleanly. It resolves the real scroll container (window / `body` /
overflow ancestor) so body-scroll apps work. Do NOT rewrite the engine from
memory in any framework; copy it and configure it.

---

## 1 · Intake — resolve these BEFORE coding

1. **Footage source** (pick one):
   - **(a) Provided video** — skip to §3 (still needs the scrub re-encode).
   - **(b) Generate the footage** with whatever image/video generation is
     configured — KIE MCP servers (`kie-image-mcp` / `kie-video-mcp`),
     Higgsfield MCP, the model's own built-in image/video generation, or any
     other configured image/video tool — §2.
   - **(c) No footage possible** — this pattern is wrong; use a static hero.
2. **Brand tokens** — map `--hs-bg / --hs-ink / --hs-dim / --hs-accent /
   --hs-display / --hs-mono` to the host site's design system (DESIGN.md or
   existing CSS custom properties). Never ship the template defaults into a
   branded site.
3. **Optional controls** — ask or infer which to include:
   HUD (telemetry value + segments) · PLAY (film-speed autoplay) ·
   TOP/END (veiled jumps) · overlays (copy choreographed over the film) ·
   loader gate. Each is one HTML block; the engine self-configures.
4. **Telemetry metric** — mph is only the obvious one. Altitude, depth, RPM,
   temperature, distance, watts — pick what fits the product. Configure
   `max`, `unit` (in markup), and the curve in `HS_CONFIG.telemetry`.
5. **Scroll length** — 15–20vh of journey height per second of footage
   (32s film → 560–640vh). Shorter feels rushed; longer feels sticky.
6. **Sweep** — the engine is page-aware by default, hero-scoped by option
   (`HS_CONFIG.sweep`). It only ever owns the journey block + fixed chrome;
   it never touches the host page's DOM below the hero. `sweep: "page"`
   (default): PLAY glides on through the rest of the page to the bottom and
   END jumps there — the full cinematic ride, for when the whole landing
   page shares the film's design system and should be swept through.
   `sweep: "hero"`: PLAY and END stop at the journey's end — you land on the
   regular HTML section right after the hero, exactly as a normal scroll
   would, the polite mode that never drives the user through the rest of
   the page uninvited; opt into this explicitly in the prompt (or
   `HS_CONFIG`) when only the hero should be owned.
   Scrub smoothness is identical in both modes; sweep only changes where
   autoplay/jumps consider "the end". (Named `sweep`, never `reach`, so it
   can't be confused with a spec/plan's route/DOM-scope terminology.)

## 2 · Footage pipeline (generation path)

The generation backend is pluggable — the pipeline below is the same whatever
produces the frames. Route the image/video calls to whatever is configured:
KIE MCP servers (`kie-image-mcp` / `kie-video-mcp`), Higgsfield MCP, the model's
own built-in image/video generation, or any other configured image/video tool.
The parameter names below (`reference_paths`, `image_paths`) are KIE/Kling's;
other backends expose the equivalent reference-image and first/last-frame inputs
under their own names — map to whichever you're using.

> **If using the KIE MCP servers** (Babylon Toolkit projects): fetch the
> Babylon Toolkit Agent Reference and its `web-kie-servers.md` sub-document
> first (per CLAUDE.md). Those servers read the key from `.env` — a file named
> `env` is ignored.

1. **One hero anchor image first** (image model, e.g. nano-banana-pro, 16:9,
   2K). Every other asset references it (reference/anchor image input) so it is
   the same product everywhere.
2. **Chain clips start→end frame** so the journey is continuous (pin each
   clip's first frame, and where supported its last frame — KIE/Kling exposes
   this as `image_paths`: `[0]` = first frame, `[1]` = last frame):
   - Clip 1: first = a generated "concealed" variant (dust/fog/dark), last =
     the hero anchor → the reveal.
   - Clip N: first = **ffmpeg-extracted last frame of clip N-1**:
     `ffmpeg -y -sseof -0.1 -i clipN-1.mp4 -frames:v 1 -update 1 -q:v 2 last.jpg`
   - Final clip: pin the last frame to a generated destination still.
   - Big lighting changes (day→night) must happen INSIDE a clip's prompt
     ("light dies to dusk as…"), never across a cut — chaining can't bridge a
     lighting jump.
3. **Know your video model's real output** (example — KIE/Kling 3: `std` mode
   returns 1284×716, not 1080p — use `pro` if that matters; clips run ~8.04s
   for a requested 8s). Whatever the backend, ffprobe everything; never assume
   resolutions or durations.
4. **Concat + scrub encode** (the scrub encode is NON-NEGOTIABLE):
   ```
   ffmpeg -y -f concat -safe 0 -i list.txt -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -an journey.mp4
   ffmpeg -y -i journey.mp4 -vf "scale=1280:720,fps=24" -c:v libx264 -preset slow -crf 21 \
          -g 1 -keyint_min 1 -pix_fmt yuv420p -movflags +faststart -an journey-scrub.mp4
   ```
   `-g 1` makes every frame a keyframe → `currentTime` seeks are instant.
   Without it, scrubbing stutters and the whole illusion dies. Expect the
   scrub file to be LARGER than the source (~20MB for 32s @720p — fine, it's
   blob-preloaded once).
5. **Poster** = the FIRST frame of journey.mp4 (`-frames:v 1`), not a glamour
   still — otherwise the video swap after preload is a visible jump-cut.

## 3 · Wire-up

0. **Pick the host path (§ Templates above).** Non-React: copy
   `hero-scroll.{html,css,js}`. React/TS: copy `HeroScroll.tsx` +
   `hero-scroll.js` + `hero-scroll.d.ts` + `hero-scroll.css`, render
   `<HeroScroll config={…} … />` where the hero goes, and import the scrub
   mp4 + poster as assets. Either way the engine (`hero-scroll.js`) is
   identical — do not fork it per framework. In React, `HeroScroll.tsx`
   already handles mount (`initHeroScroll`) and unmount (`.destroy()`); under
   StrictMode the init/destroy cycle runs twice in dev — that's fine, teardown
   is complete.
1. Copy the files; rename/prefix if the host has conflicts (everything is
   `hs-` namespaced already).
2. Replace the placeholder 100vh hero with the `#hs-journey` block (or the
   `<HeroScroll>` element); with `sweep: "page"` the rest of the page below it
   automatically becomes the autoplay "tail". **Sticky constraint:** the
   journey block must sit in plain document flow — ideally a direct child of
   `<body>` (in React, avoid wrapping it in transformed/overflow-clipped
   layout containers). Any ancestor with `transform`, `filter`, `perspective`,
   or `overflow: hidden/auto` breaks `position: sticky` and kills the entire
   effect. Check for this FIRST when retrofitting. (The engine auto-resolves
   whether the window or `document.body`/an overflow ancestor is the scroller,
   so body-scroll apps scrub correctly without config.)
3. **Handoff rule:** the first section below the journey must tonally
   continue the film's final frame (e.g. a film that ends dark must hand off
   into a dark section, not a bright one).
   If the host page goes bright the pixel after the sticky stage releases,
   the cut is jarring and no engine work hides it. Either restyle that first
   section to match the film's exit tone, insert a short bridge section that
   grades from the film's last frame to the host palette, or use
   `sweep: "hero"` and let the user cross the seam themselves.
4. Author overlays as `.hs-ovl` sections with `data-from`/`data-to` progress
   windows. Leave gaps between windows — moments of pure film are what make
   it cinematic. Overlay copy over bright footage gets `.hs-scrim`.
5. Set the config: `window.HS_CONFIG` in the page (non-React) or the
   `config` / control props on `<HeroScroll>` (React) — video path, telemetry
   curve, segments, sweep.
6. The engine blob-preloads the footage with a loading bar, locks scroll
   until ready (`body[data-hs-state]`), degrades to the poster if footage is
   missing, and honors `prefers-reduced-motion`.

## 4 · Calibration (what makes it feel expensive)

- **Telemetry launch point:** extract frames around the moment the subject
  first MOVES (`ffmpeg -ss <t> -i journey-scrub.mp4 -frames:v 1 f.jpg`, eye
  them) and set `telemetry.startP = t_launch / film_duration`. Generated
  clips hold the subject still for a beat after a cut — the clip boundary is
  NOT the launch. A needle pinned at 0 until the exact frame motion begins,
  then ripping (exponent ≈ 0.45), reads as real telemetry; starting early
  reads as fake and users notice immediately.
- **Segments** align to the source clips (equal clips → quarters).
- **Autoplay speed is film speed:** the engine converts journey pixels ÷ film
  seconds so PLAY scrubs at exactly 1× real time. Do not "improve" this with
  a fixed px/s rate.
- **Veiled cuts, never visible rewinds:** replay/jumps fade to black, snap
  scroll + smoothed progress + video time UNDER the veil, then lift. The
  smoothed-progress snap is mandatory — skipping it causes a reverse-scrub
  flash when the veil lifts.

## 5 · Verification protocol (do not skip; run in a real browser)

Drive the page with chrome-devtools MCP and require ALL of:

1. **Scrub sync sweep** — for p in {0, .1, .25, .34, .5, .62, .75, .87, 1}:
   scroll to `p × (journeyHeight − innerHeight)`, wait ~1.5s for the lerp,
   assert `|video.currentTime − p × duration| ≤ 0.05s`.
2. **Telemetry** — value is 0 for all p ≤ startP (sample densely around
   startP: e.g. startP − .01, startP + .01), monotonic after, max at endP,
   segment labels flip at their thresholds.
3. **Autoplay** — after PLAY, video.currentTime advances ≈1.0s per real
   second; reaches document bottom; button resets.
4. **Cancel** — dispatch a wheel event mid-autoplay: scroll halts within a
   frame, button resets. (Dispatch on `document.body`, not `window` — and the
   engine's guard must survive non-Node targets.)
5. **Veiled cut timeline** — sample during replay-from-end: scrollY must NOT
   change until veil computed opacity = 1; video time snaps while opacity =
   1; veil fully lifts; film rolls.
6. **Console** — zero errors across the whole run.

## 6 · What the prompt supplies vs. what this skill decides

The mechanics are deterministic — the invoking prompt should NEVER need to
specify scrub encoding, preloading, autoplay speed, veils, cancel semantics,
or verification. It supplies only the creative decisions; everything missing
falls back to the defaults in parentheses:

- **Product + footage beats** — what moves through what terrain, per clip
  (or an existing video file path).
- **Sweep** — `page` or `hero` (default `page`: PLAY/END sweep through to the
  document bottom; specify `sweep: hero` explicitly to have PLAY/END stop at
  the journey's end so the next HTML section follows normally instead).
- **Controls** — which of HUD / PLAY / TOP+END to include (default: all
  three on `sweep: page`, HUD + PLAY only on `sweep: hero`).
- **Telemetry metric** — value, unit, max, segment names (default: none —
  omit the HUD rather than invent a metric that doesn't fit the product).
- **Overlays** — the marketing copy and which film moment each block rides
  (default: a single title overlay at the start).
- **Brand** — tokens/typography, mapped onto `--hs-*` (default: inherit the
  host site's design system; never ship the template placeholders).

The subject is whatever the prompt names — the mechanics are identical for a
watch, a submarine, a building, a person, a dashboard, a landscape. Do NOT
default to any one look (a vehicle, a desert, cyan-on-black); derive every
visual from the prompt's own subject. The skeletons below are product-agnostic.

> **Easy front door:** the sibling `bt-hero` skill automates this intake — it
> takes an idea / image / partial answers in any combination, asks only the
> unanswered questions, applies the defaults, writes a repeatable
> `_hero-brief.md`, and builds in one shot (or contributes intake when named
> inside a bt-spec brief). The skeletons below are the manual alternative.
> Note the skeletons carry ONLY creative slots — pipeline facts (aspect, clip
> duration, muting, encode, verification) are skill/backend-owned and never
> belong in an invoking prompt.

**Example — greenfield, full-page (skeleton):**
> Redesign this starter template as a cinematic 3D-scroll site for `<PRODUCT>` —
> `<one-line description>` (bt-design → 3D-Hero-Scroll, sweep: page).
> FOOTAGE (generate) — hero anchor first: `<the product, one
> clear look>`; chain: ① `<reveal beat>` ② `<motion beat>` ③ `<terrain/scene
> change>` ④ `<finale beat>`. CONTROLS — HUD: `<METRIC> 0→<MAX> <UNIT>`,
> segments `<A/B/C/D>` · PLAY (`"<label>"`) · TOP/END. OVERLAYS — `<wordmark>`
> → count-up stats (`<A · B · C>`) → `<feature moment>` → `<closing line>`.
> BELOW THE JOURNEY — `<sections>` → `<CTA>`. BRAND — `<palette>`, `<accent>`,
> `<type>` (derived from the subject, not a fixed house style).

**Example — retrofit, hero only (skeleton):**
> Redesign the hero section with 3D scrolling (sweep: hero). Footage:
> `<existing file | generate: anchor + beats 1..N>`. HUD: `<METRIC> 0→<MAX>
> <UNIT>` (or none). PLAY only, no jump nav. One headline overlay at the start,
> `<N>` stats mid-run. Match our existing design tokens; don't touch anything
> below the hero.

Anything below the journey (configurators, CTAs, footers) is ordinary
bt-design work — this reference governs only the journey block, its
overlays, and the fixed chrome. Apply the handoff rule (§3) at the seam.

## 7 · Known pitfalls (all hit in production; all handled by the template)

- Overlay windows starting at 0 must skip their fade-in (`rise = 1` when
  `from ≤ 0`) or the hero overlay renders invisible at page load.
- Cancel-input handlers must tolerate non-Node event targets, and must
  exempt keydown on the play button itself (else Enter = stop-then-restart).
- All veil/autoplay callbacks are token-guarded: any stop/cancel increments
  the token, so a cancel during a fade can't leave a ghost timeline running.
- Blob-preload (not streaming) is what makes seeking instant even without
  range-request support on the dev server.
- Count-up stats re-arm when their overlay fully exits, so they replay on
  re-entry in either scroll direction.
- The HUD hides itself when the journey hands off to normal-flow sections;
  jump-nav buttons dim at the end they're already at.
