# Use 3D-Hero-Scroll — For Dummies (developer edition)

**TL;DR: the prompt is a config file written in prose.** Every named field maps
1:1 to code the skill generates. You already know the output (the VANTA site) —
this doc shows which prompt line produced which file.

```
PROMPT FIELD          →  WHAT IT BECOMES IN CODE
─────────────────────────────────────────────────────────────────────
reach: page|hero      →  HS_CONFIG.reach
FOOTAGE (the beats)   →  media pipeline → journey-scrub.mp4 + poster.jpg
                         → HS_CONFIG.video
CONTROLS              →  which optional HTML blocks exist (#hs-hud,
                         #hs-play, #hs-jump-nav) + HS_CONFIG.telemetry
OVERLAYS              →  <section class="hs-ovl" data-from data-to> blocks
BELOW THE JOURNEY     →  plain HTML sections after #hs-journey  (PAGE only)
BRAND                 →  the --hs-* CSS custom properties        (PAGE only*)
HANDOFF               →  styling of the seam under the journey   (HERO only)
```
\* in HERO mode brand is "inherit the host site's tokens", so you don't write it.

Field names are fixed. PAGE prompts use: FOOTAGE, CONTROLS, OVERLAYS,
BELOW THE JOURNEY, BRAND. HERO prompts use: FOOTAGE, CONTROLS, OVERLAYS,
HANDOFF. Omit any field → documented default (defaults in the playbook §6).

---

## 1 · FOOTAGE — "the beats" are literally the video clips

Each numbered beat in the prompt = **one ~8s generated clip**. Four beats =
four Kling calls = a 32s film. That's the entire relationship.

```
PROMPT                                          CODE
──────────────────────────────────────────────────────────────────────
"Hero anchor image first: low, wide,      generate_image({
 matte obsidian, thin cyan light-bar"       prompt: "...low wide matte obsidian...",
                                            out_path: "media/hero.jpg" })

"1. REVEAL — dust settles to reveal       generate_video({
 the VANTA motionless"                      prompt: "<beat 1 text>",
                                            image_paths: [dust.jpg, hero.jpg],
                                            out_path: "clip1.mp4" })
                                                        │
                                            ffmpeg -sseof -0.1 -i clip1.mp4
                                              -frames:v 1 clip1-last.jpg   ◄─ last frame
                                                        │
"2. THE RUN — launches across             generate_video({
 the desert flats"                          prompt: "<beat 2 text>",
                                            image_paths: [clip1-last.jpg],  ◄─ becomes
                                            out_path: "clip2.mp4" })           first frame
                                            ... repeat for beats 3, 4 ...
                                                        │
all beats                                 ffmpeg concat → journey.mp4
                                          ffmpeg -g 1 ... → journey-scrub.mp4
                                                        │
                                          HS_CONFIG.video = "media/journey-scrub.mp4"
```

**"Chain last-frame-to-first-frame" decoded:** Kling's `image_paths[0]` pins a
clip's FIRST frame. The pipeline extracts clip N's LAST frame with ffmpeg and
passes it as clip N+1's first frame. So clip 2 starts on the exact pixel clip 1
ended on → the film is continuous.

**Why lighting changes go INSIDE a beat:** clip 4 can't start at night if clip
3 ended in daylight — its first frame IS clip 3's last frame. So you write
"light dies to dusk as it exits the canyon" in beat 3's text, and the model
does the transition within those 8 seconds. You can't cut day→night between
clips; you can only fade day→night inside one.

**Already have a video?** Skip all of this: `FOOTAGE — use existing video at
media/flyover.mp4`. The skill still does the scrub re-encode (`-g 1`).

---

## 2 · CONTROLS — HTML blocks that exist or don't, plus one JSON object

Each control is one HTML block. The engine (`hero-scroll.js`) activates
features by element presence — delete the block, feature's gone. No flags.

```
"CONTROLS — HUD: MPH 0→250, ..."     →  keep <aside id="hs-hud">…
"· PLAY ('PLAY THE RUN')"            →  keep <button id="hs-play">… with
                                          data-idle="PLAY THE RUN"
"· TOP/END jump nav"                 →  keep <nav id="hs-jump-nav">…
"no jump nav"                        →  delete that block. Done.
```

The HUD numbers come from one config object. **"The metric matches the
journey" decoded:** the HUD is just a number that animates 0 → `max` as you
scroll through the film. Pick a quantity that plausibly *rises during the
footage you described* — that's all the sentence means:

```js
// VANTA (car accelerating)         // AERIE (aircraft climbing)
telemetry: {                        telemetry: {
  max: 250,        // ← mph           max: 12000,      // ← feet
  startP: 0.286,   // calibrated      startP: 0.14,    // when it lifts off
  endP: 0.95,                         endP: 0.9,
  exponent: 0.45,                     exponent: 0.7,
  segments: [                         segments: [
    [0.00, "SEG 01 · WHITE SANDS"],     [0.00, "PAD"],
    [0.25, "SEG 02 · THE FLATS"],       [0.25, "FJORD"],
    [0.50, "SEG 03 · RED CANYON"],      [0.50, "RIDGE"],
    [0.75, "SEG 04 · NIGHT RUN"],       [0.75, "APPROACH"],
  ],                                  ],
}                                   }
```

**"Segments are the beats renamed" decoded:** four equal clips means clip
boundaries sit at progress 0.25 / 0.50 / 0.75. `segments` is just the label
the HUD shows in each quarter — i.e. which clip you're currently scrubbing.
Three clips → thresholds 0, 0.33, 0.66. The unit text ("MPH", "FT") is plain
markup in the HUD block: `<span class="hs-hud-unit">MPH</span>`.

`startP` is the one hand-tuned value: the progress where the number leaves 0
(the frame the car actually launches, found by extracting frames around the
clip boundary — the skill does this calibration; playbook §4).

---

## 3 · OVERLAYS — the marketing text riding the film

Each item in the OVERLAYS prompt line = one `<section>` inside the sticky
stage. You write normal HTML; two data attributes place it on the film's
timeline (0 = film start, 1 = film end):

```
PROMPT: "OVERLAYS — ultrawide wordmark → count-up stats (1.9s · 1,200 hp
         · 520 mi) → design macros → night copy"

CODE:
<section class="hs-ovl" data-from="0" data-to="0.115">
  <h1>VANTA</h1>                                   <!-- rides the reveal -->
</section>

<section class="hs-ovl hs-scrim" data-from="0.26" data-to="0.46">
  <span data-hs-count data-target="1.9" data-decimals="1">0</span>s 0–60
  <span data-hs-count data-target="1200" data-group="1">0</span> HP
  <span data-hs-count data-target="520">0</span> MI    <!-- rides the run -->
</section>

<section class="hs-ovl hs-scrim" data-from="0.52" data-to="0.70">
  <img src="media/macro-1.jpg" data-hs-depth="0.4" />  <!-- rides the canyon -->
</section>

<section class="hs-ovl" data-from="0.78" data-to="0.96">
  <h2>THE BODY DISAPPEARS.</h2>                    <!-- rides the night -->
</section>
```

The engine choreographs every `.hs-ovl` automatically: blur+drift fade at the
window edges, `hs-active` class when it lands (hook CSS animations to it),
`[data-hs-count]` numbers count up on entry and re-arm on exit,
`[data-hs-depth]` children parallax. `.hs-scrim` adds a dark gradient behind
copy that sits over bright footage. The gaps between windows (0.115–0.26 etc.)
are intentional — moments of pure film.

---

## 4 · BELOW THE JOURNEY (PAGE mode) — just normal sections

Nothing magic. Everything after `</div><!-- #hs-journey -->` is regular page:

```html
<div id="hs-journey" style="height: 640vh"> …the film… </div>

<section id="configurator"> …normal HTML/CSS… </section>   ◄ these lines of
<section id="reserve"> …normal HTML/CSS… </section>        ◄ the prompt
```

With `reach: "page"`, PLAY glides through these to the bottom after the film
ends, and END jumps to the very bottom. That's the only relationship.

---

## 5 · BRAND — six CSS variables

```
PROMPT: "BRAND — abyssal blue-black, lume-green accent, luxury serif display"

CODE (hero-scroll.css):
:root {
  --hs-bg: #030b10;
  --hs-ink: #e8f0ee;
  --hs-dim: #7d8c8a;
  --hs-accent: #b8ff5e;             /* ← the lume green            */
  --hs-accent-soft: rgba(184,255,94,.35);
  --hs-display: "Cormorant Garamond", serif;
  --hs-mono: "IBM Plex Mono", monospace;
}
```

That's the whole sentence "brand changes everything visually, nothing
mechanically": HUD, PLAY pill, veil sweep, jump nav all read these variables.
Same JavaScript, different six values.

---

## 6 · HANDOFF (HERO mode) — one design decision at the seam

In HERO mode the film ends and the *existing* page continues below. The
HANDOFF line tells the skill what the film's final frame should look like so
that seam isn't a jump cut between two websites:

```
PROMPT: "HANDOFF — grade the final summit frame toward warm sand so it hands
         off cleanly into the existing product-buy section"

CODE EFFECT: beat 3's generation prompt ends with "...warm sand-toned morning
light floods the frame", and/or the last overlay/stage gets a bottom gradient
toward the host page's background color. No JS involved.
```

---

## 7 · Complete worked example — PAGE mode (AERIE)

**Prompt** (what you type):

```
Redesign this starter template as a cinematic "3D scroll" website for AERIE —
a two-seat electric VTOL aircraft. (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE (Kling 3, 16:9, ~8s clips). Hero anchor first:
bone-white fuselage, glass canopy, six rotors, cliff-edge helipad at dawn.
Chain:
1. Morning fog rolls off the pad to reveal AERIE motionless; nav lights blink on.
2. Rotors spin up, it lifts vertically, tilts, accelerates out over a fjord.
3. It threads a mountain ridgeline banking through cloud gaps, camera chasing.
4. Dusk city approach — it descends between towers onto a rooftop pad.

CONTROLS — HUD: ALTITUDE 0→12,000 FT, segments PAD/FJORD/RIDGE/APPROACH ·
PLAY ("FLY THE ROUTE") · TOP/END.

OVERLAYS — "AERIE" wordmark → stats (250 km range · 45 min charge · 62 dBA) →
cabin macro → approach copy.

BELOW THE JOURNEY — route-planner teaser → "Join the waitlist — $500" CTA.

BRAND — bone white + graphite, amber accent, engineered grotesk.
```

**What lands on disk:**

```
media/hero.jpg              ← "hero anchor first: bone-white fuselage..."
media/clip1..4.mp4          ← beats 1–4, chained
media/journey-scrub.mp4     ← concat + all-intra encode  → HS_CONFIG.video
media/poster.jpg            ← first frame of the film

index.html
  #hs-loader                ← default (footage needs preloading)
  #hs-play  data-idle="FLY THE ROUTE"        ← CONTROLS
  #hs-jump-nav                               ← CONTROLS "TOP/END"
  #hs-hud   unit markup "FT"                 ← CONTROLS "ALTITUDE ... FT"
  #hs-journey (height ~640vh)
    .hs-ovl data-from=0     data-to=0.115    ← OVERLAYS "wordmark"
    .hs-ovl data-from=0.28  data-to=0.46     ← OVERLAYS "stats" (data-hs-count)
    .hs-ovl data-from=0.52  data-to=0.70     ← OVERLAYS "cabin macro"
    .hs-ovl data-from=0.78  data-to=0.96     ← OVERLAYS "approach copy"
  #route-teaser, #waitlist                   ← BELOW THE JOURNEY
  window.HS_CONFIG = {
    video: "media/journey-scrub.mp4",
    reach: "page",                           ← "(reach: page)"
    telemetry: { max: 12000, startP: <calibrated>, endP: 0.9,
      segments: [[0,"PAD"],[0.25,"FJORD"],[0.5,"RIDGE"],[0.75,"APPROACH"]] },
  }

hero-scroll.css  → --hs-bg:#f4f2ed; --hs-ink:#1c1e21; --hs-accent:#ffb400; …
                                             ← BRAND (light theme!)
```

---

## 8 · Complete worked example — HERO mode (KOA TRAIL 2)

**Prompt:**

```
Redesign the hero section with 3D scrolling. (bt-design → 3D-Hero-Scroll,
reach: hero) Do not touch anything below the hero; match existing tokens.

FOOTAGE — generate via KIE: hero anchor first (KOA TRAIL 2, burnt-orange knit,
studded outsole, on granite at first light), then chain:
1. Dust kicks as the shoe plants on a switchback and launches uphill.
2. Low tracking shot along a ridgeline at speed, scree spraying.
3. It crests the summit as the sun breaks — slows, holds, settles.

CONTROLS — HUD: ELEV GAIN 0→2,400 M · PLAY ("RUN THE RIDGE") only, no jump nav.

OVERLAYS — "UP IS THE WAY." headline at the start → three stats mid-run
(228 g · 6 mm drop · Vibram Litebase).

HANDOFF — grade the final summit frame toward warm sand so it hands off
cleanly into the existing product-buy section.
```

**What lands on disk (the diffs from PAGE mode):**

```
index.html (existing site — only the old 100vh hero div is replaced)
  #hs-play data-idle="RUN THE RIDGE"   ← CONTROLS
  (NO #hs-jump-nav — "no jump nav" = block simply not present)
  #hs-hud  unit markup "M"             ← "ELEV GAIN 0→2,400 M"
  #hs-journey (height ~480vh — 3 beats ≈ 24s of film)
    .hs-ovl data-from=0    data-to=0.12    ← headline
    .hs-ovl data-from=0.4  data-to=0.62    ← three stats
  window.HS_CONFIG = {
    video: "media/ridge-scrub.mp4",
    reach: "hero",                     ← PLAY/END stop when the film ends
    telemetry: { max: 2400, startP: <calibrated>, endP: 0.92,
      segments: [[0,"SWITCHBACK"],[0.33,"RIDGE"],[0.66,"SUMMIT"]] },
  }                                    ← 3 clips → thirds, not quarters

hero-scroll.css → --hs-* mapped to the site's EXISTING variables (no BRAND
                  line: hero mode inherits the host design system)
beat 3's text ends "...warm sand-toned light floods the frame"  ← HANDOFF
```

---

## 9 · Blank skeletons (copy-paste)

**PAGE:**
```
Redesign this starter template as a cinematic "3D scroll" website for <NAME> —
<one-liner>. (bt-design → 3D-Hero-Scroll, reach: page)
FOOTAGE — generate via KIE (Kling 3, 16:9, ~8s clips). Hero anchor first:
<product look>. Chain: 1. <reveal> 2. <motion> 3. <terrain change> 4. <finale>
CONTROLS — HUD: <METRIC> 0→<MAX> <UNIT>, segments <A/B/C/D> · PLAY ("<label>")
· TOP/END.
OVERLAYS — <wordmark> → <count-up stats> → <feature moment> → <finale copy>.
BELOW THE JOURNEY — <sections> → <CTA>.
BRAND — <palette>, <accent>, <type>.
Launch on localhost and run the skill's verification protocol.
```

**HERO:**
```
Redesign the hero section with 3D scrolling. (bt-design → 3D-Hero-Scroll,
reach: hero) Do not touch anything below the hero; match existing tokens.
FOOTAGE — <existing file at <path> | generate via KIE: anchor + beats 1..3>
CONTROLS — <HUD: METRIC 0→MAX UNIT | no HUD> · <PLAY ("<label>") | + TOP/END>.
OVERLAYS — <headline> → <stats/copy mid-run>.
HANDOFF — grade the final frame toward <tone> for the existing <next section>.
Verify scrub sync and controls per the skill's protocol.
```

---

## 10 · Real Examples (copy-paste) — all 10, both modes

Adapted from the "One-Prompt Website Pack" (Zubair Trabzada · AI Workshop),
rewritten into this skill's grammar. Everything the pack had to spell out —
"pass the hero image as reference to every clip", "use each clip's final
frame as the next clip's start frame", "scrub as a canvas frame sequence",
generation settings, "launch and verify before telling me it's done" — is
**deleted**, because the skill guarantees all of it. What's left is only the
creative brief.

**Every one of the 10 is written twice** so you can see exactly what changes:

- **PAGE** = the whole landing page is the film's world. Fields: FOOTAGE,
  CONTROLS, OVERLAYS, **BELOW THE JOURNEY**, **BRAND**. PLAY/END run to the
  document bottom. Usually the fuller clip chain (4–5 beats).
- **HERO** = drop the film into an existing page's hero only. Fields:
  FOOTAGE, CONTROLS, OVERLAYS, **HANDOFF**. Opens with "do not touch anything
  below; match existing tokens" (so no BRAND line). PLAY/END stop where the
  film ends. Usually a shorter chain (2–3 beats) and lighter controls.

**The diff between the two columns, every time:** PAGE adds BELOW THE JOURNEY
+ BRAND and gets `reach: page`; HERO swaps those for HANDOFF + "match
existing tokens" and gets `reach: hero`. FOOTAGE and OVERLAYS stay
recognizably the same product — the film doesn't change, only who owns the
page around it.

| #  | Product              | PAGE headline metric   | HERO trim                    |
|----|----------------------|------------------------|------------------------------|
| 1  | Luxury watch         | COMPONENTS 0→217       | HUD dropped, 2 beats         |
| 2  | Deep-sea expedition  | DEPTH 0→3,800 M        | shorter descent, keep depth  |
| 3  | Personal portfolio   | (no HUD)               | work grid stays as host page |
| 4  | Penthouse listing    | FLOOR 0→60             | 2-room tour, keep floor HUD  |
| 5  | Hypercar (VANTA)     | MPH 0→250              | reveal+run only              |
| 6  | Streetwear drop      | COUNTDOWN (timer)      | its native mode              |
| 7  | Restaurant           | (no HUD)               | its native mode              |
| 8  | AI SaaS              | SIGNAL 0→94 %          | its native mode              |
| 9  | Creative agency      | (no HUD)               | zero-controls variant        |
| 10 | Gym                  | PR / MEMBERS count     | its native mode              |

---

### 10.1 · AURUM & NOIR (luxury watch)

**PAGE**
```
Redesign this starter template as a cinematic "3D scroll" website for
AURUM & NOIR — a fictional Swiss luxury watch brand launching its tourbillon
chronograph, the "Eclipse." (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Hero anchor first: brushed black titanium case,
gold tourbillon visible through sapphire glass, floating in a black void,
dramatic rim lighting. Chain:
1. A slow, perfectly smooth 360° turntable of the watch in the void, faint
   gold dust drifting.
2. The camera dives to macro and glides across the dial — engraved indices,
   the tourbillon cage spinning, light rippling over brushed metal.
3. The watch drifts apart into floating components — gears, springs, bezel,
   strap — then converges back into the finished piece, holding on a hero frame.

CONTROLS — HUD: COMPONENTS 0 → 217, segments ORBIT / DIAL / ASSEMBLY ·
PLAY ("WIND THE MOVEMENT") · TOP/END.

OVERLAYS — "AURUM & NOIR" tracking in → "Crafted in Darkness" story line →
spec callouts over the assembly (42 mm grade-5 titanium · 72 h reserve ·
217 components).

BELOW THE JOURNEY — "Edition of 88 — $48,000" → private waitlist CTA.

BRAND — off-black, gold accent, high-contrast serif display + minimal sans.
Copy tone: quiet, expensive, very few words.
```

**HERO** *(drop the reveal into an existing product page)*
```
Redesign the hero section with 3D scrolling for AURUM & NOIR's "Eclipse"
product page — a Swiss tourbillon chronograph.
(bt-design → 3D-Hero-Scroll, reach: hero) The product details, specs, and
buy module below stay; match existing tokens.

FOOTAGE — generate via KIE. Hero anchor first: brushed black titanium case,
gold tourbillon through sapphire glass, floating in a black void. Chain:
1. A slow 360° turntable of the watch in the void, faint gold dust drifting.
2. The camera dives to macro across the dial — the tourbillon cage spinning,
   light rippling over brushed metal — settling on a hero frame.

CONTROLS — PLAY ("WIND THE MOVEMENT") only · no HUD · no jump nav.

OVERLAYS — "AURUM & NOIR" tracking in → "Crafted in Darkness."

HANDOFF — hold the final macro frame on off-black so it hands off cleanly
into the existing spec-and-buy section.
```

*What changed:* the exploded-assembly beat (and its COMPONENTS 0→217 HUD) is
a PAGE luxury — HERO keeps the two most iconic shots, drops the HUD, and ends
on a still the product page can continue from. Same watch, same anchor image.

---

### 10.2 · ABYSSAL (deep-sea expedition)

**PAGE**
```
Redesign this starter template as a cinematic "3D scroll" website for ABYSSAL
— a fictional deep-sea expedition company that takes 8 civilians per year to
the ocean floor aboard its submersible, the EREBUS.
(bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Hero anchor first: sleek deep-black hull, glowing
cyan viewport ring, twin floodlights. Chain:
1. Aerial dawn over open ocean; the EREBUS slips beneath the waves, ending
   fully submerged in sunlit blue.
2. Descent through god rays and bubble columns, a whale silhouette gliding
   past; the blue deepens.
3. Light dies to near-black, ghostly jellyfish drift, the floodlights flicker on.
4. Total darkness; bioluminescent creatures spark around the hull like a
   starfield.
5. Floodlights sweep across hydrothermal vents; the EREBUS holds on a final
   hero frame.

CONTROLS — HUD: DEPTH 0 → 3,800 M, segments SURFACE / SUNLIT / TWILIGHT /
MIDNIGHT / THE FLOOR · PLAY ("BEGIN THE DESCENT") · TOP/END.

OVERLAYS — "How deep will you go?" → one striking fact per zone → EREBUS
spec callouts.

BELOW THE JOURNEY — "8 seats. $250,000. Departing March 2027." → "Join the
Manifest" CTA.

BRAND — deep navy grading to pure black with depth, bioluminescent cyan
accent, thin technical sans with HUD micro-details.
```

**HERO** *(the descent as a hero atop an existing expedition site)*
```
Redesign the hero section with 3D scrolling for ABYSSAL — a deep-sea
expedition company (submersible: EREBUS).
(bt-design → 3D-Hero-Scroll, reach: hero) The itinerary, pricing, and booking
sections below stay; match existing tokens.

FOOTAGE — generate via KIE. Hero anchor first: sleek deep-black hull, glowing
cyan viewport ring, twin floodlights. Chain:
1. Aerial dawn; the EREBUS slips beneath the waves into sunlit blue.
2. Descent through god rays, the blue deepening, a whale gliding past.
3. Light dies to near-black; floodlights flicker on over the abyss.

CONTROLS — HUD: DEPTH 0 → 3,800 M · PLAY ("BEGIN THE DESCENT") · no jump nav.

OVERLAYS — "How deep will you go?" at the surface → one line at depth.

HANDOFF — hold the final abyss frame on pure black so it hands off into the
existing itinerary section.
```

*What changed:* 5 zones → 3 (surface, mid, abyss); depth HUD survives because
it's the whole point, but loses its per-zone segment labels; the "$250,000 /
Join the Manifest" close is now the host page's job.

---

### 10.3 · Personal portfolio (starring you)

**PAGE**
```
Redesign this starter template as a cinematic "3D scroll" PERSONAL PORTFOLIO
website for me — [YOUR NAME]. The central element is ME.
(bt-design → 3D-Hero-Scroll, reach: page) My attached photo is the identity
anchor; keep my wardrobe identical throughout [black t-shirt, dark overshirt].

FOOTAGE — generate via KIE, my photo referenced on every generation. Chain:
1. I stand confident, arms crossed, in a black-void studio with [emerald]
   rim lighting; the camera does one slow 360° orbit around me.
2. The camera settles as I sit at a dark desk surrounded by floating
   holographic screens showing my work; slow cinematic push-in.
3. I rise and walk toward camera down a dark gallery lined with glowing
   screens, stopping in a hero pose.

CONTROLS — PLAY ("ROLL THE REEL") · TOP/END · no HUD.

OVERLAYS — "[YOUR NAME]" in massive display type + "[what you do in one
line]" → count-up stats strip ([your 3–5 best numbers]) → THREE PILLARS
revealing [your three main offers] one at a time.

BELOW THE JOURNEY — WORK grid: cards for [your 3 best projects] with hover
motion → "[your main CTA]" with two buttons → footer socials.

BRAND — ink black, [emerald] accent, cream typography, bold condensed
display font, kinetic type, subtle grain.
```

**HERO** *(cinematic intro on top of an existing portfolio)*
```
Redesign the hero section with 3D scrolling for my portfolio — [YOUR NAME].
(bt-design → 3D-Hero-Scroll, reach: hero) My existing about, work grid, and
contact sections below stay; match existing tokens. My attached photo is the
identity anchor; wardrobe [black t-shirt, dark overshirt] consistent.

FOOTAGE — generate via KIE, my photo referenced on every generation. Chain:
1. I stand arms crossed in a black-void studio with [emerald] rim lighting;
   the camera does one slow 360° orbit around me.
2. I turn and walk toward camera down a dark gallery of glowing screens,
   stopping in a hero pose.

CONTROLS — PLAY ("ROLL THE REEL") only · no HUD.

OVERLAYS — "[YOUR NAME]" in massive display type → "[what you do in one line]".

HANDOFF — end the walk on ink black so it hands off into my existing about
section.
```

*What changed:* both are HUD-less (no honest metric for a person). PAGE owns
the whole story incl. stats + pillars + work grid; HERO is just the orbit-and-
walk intro, letting your real portfolio below do the rest.

---

### 10.4 · THE MERIDIAN (penthouse listing)

**PAGE**
```
Redesign this starter template as a cinematic single-property "3D scroll"
website for THE MERIDIAN — a fictional $12.5M penthouse on the 60th floor
in [CITY]. (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Hero anchor first: the glass tower at dusk. Chain:
1. Aerial drone shot curving around the tower, city lights igniting below.
2. The camera glides from the private elevator into a vast living room —
   floor-to-ceiling windows, Italian marble, a fireplace flickering on.
3. Continuous move through the chef's kitchen and primary suite toward
   glowing terrace doors.
4. Out onto the wraparound terrace at night — infinity pool reflecting the
   skyline, timelapse clouds.

CONTROLS — HUD: FLOOR 0 → 60, segments APPROACH / ARRIVAL / THE FLOW /
TERRACE · PLAY ("TAKE THE TOUR") · TOP/END.

OVERLAYS — "Sixty floors above everything" → residence facts (4 bed ·
5.5 bath · 7,200 sq ft · private elevator) → amenity reveals room by room.

BELOW THE JOURNEY — photo gallery → "$12,500,000" price section →
"Request a Private Showing" form with agent card.

BRAND — ink background, champagne-gold accent, thin elegant serif,
generous whitespace.
```

**HERO** *(the tour as a hero atop an existing MLS-style listing)*
```
Redesign the hero section with 3D scrolling for THE MERIDIAN — a $12.5M
60th-floor penthouse in [CITY].
(bt-design → 3D-Hero-Scroll, reach: hero) The photo gallery, facts table, and
showing-request form below stay; match existing tokens.

FOOTAGE — generate via KIE. Hero anchor first: the glass tower at dusk. Chain:
1. Aerial drone curving around the tower, city lights igniting below.
2. The camera glides from the private elevator into the living room —
   floor-to-ceiling windows, marble, a fireplace flickering on — settling
   at the terrace doors.

CONTROLS — HUD: FLOOR 0 → 60 · PLAY ("TAKE THE TOUR") · no jump nav.

OVERLAYS — "Sixty floors above everything" → the address line.

HANDOFF — settle the final frame on the warm interior tone so it hands off
into the existing gallery and facts.
```

*What changed:* the full 4-room walkthrough compresses to approach + arrival;
FLOOR 0→60 stays (great cheap metric); the price + agent form are the
existing listing page.

---

### 10.5 · VANTA (hypercar)

**PAGE** — the canonical build. Full prompt in playbook §6; this repo's
`site/` is the result.
```
Redesign this starter template as a cinematic "3D scroll" website for VANTA —
a fictional 1,200 hp electric hypercar. Model it on the Scout Motors
Site-of-the-Year style. (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Hero anchor first: low, wide, matte obsidian body,
thin cyan light-bar face. Chain:
1. REVEAL — dust settles in a white-sand desert at dawn to reveal the VANTA
   motionless; light-bar ignites.
2. THE RUN — low tracking shot as it launches across the flats, sand
   ribboning off the wheels.
3. THE CANYON — it threads a red-rock canyon at speed, camera whipping around
   a corner to follow.
4. NIGHT MODE — full dark; only its light signature and taillight trails
   carving through dunes under stars.

CONTROLS — HUD: MPH 0 → 250, segments WHITE SANDS / THE FLATS / RED CANYON /
NIGHT RUN · PLAY ("PLAY THE RUN") · TOP/END.

OVERLAYS — "VANTA" ultrawide wordmark → count-up stats (0–60 in 1.9s ·
1,200 hp · 520 mi) → design macros → night-mode copy.

BELOW THE JOURNEY — configurator teaser (3 paint options recolor a hero
still) → "Reserve — $1,000 deposit" CTA.

BRAND — black on black, electric-cyan accent, ultrawide condensed type,
subtle motion-blur transitions.
```

**HERO** *(same film as a hero atop an existing VANTA marketing site)*
```
Redesign the hero section with 3D scrolling for VANTA — a 1,200 hp electric
hypercar. (bt-design → 3D-Hero-Scroll, reach: hero) The specs, configurator,
and reserve sections below stay; match existing tokens.

FOOTAGE — generate via KIE. Hero anchor first: low, wide, matte obsidian body,
thin cyan light-bar. Chain:
1. REVEAL — dust settles at dawn to reveal the VANTA motionless; light-bar
   ignites.
2. THE RUN — low tracking shot as it launches across the desert flats, sand
   ribboning off the wheels, ending in a hero stance.

CONTROLS — HUD: MPH 0 → 250 · PLAY ("PLAY THE RUN") · no jump nav.

OVERLAYS — "VANTA" ultrawide wordmark → "1,200 horsepower. Raised by the desert."

HANDOFF — end the run frame on the dawn-lit flats; grade toward the site's
dark body so it hands off into the existing specs section.
```

*What changed:* PAGE runs the full reveal→run→canyon→night journey with the
configurator + reserve built below; HERO keeps reveal + run (canyon/night are
the back half of a long scroll) and lets the existing site own everything past
the hero.

---

### 10.6 · ONYX SUPPLY (streetwear drop)

**PAGE** *(the drop as a full destination site)*
```
Redesign this starter template as a cinematic "3D scroll" e-commerce site for
ONYX SUPPLY's "Midnight Drop" — a heavyweight hoodie, cargo pants, and a
chrome-accent puffer. (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Lookbook anchor first: a model in the full fit —
matte black garments, chrome zippers — on a foggy rooftop at night. Chain:
1. The model walks slowly toward camera through rooftop fog, neon city glow
   behind, wind moving the fabric.
2. The camera arcs to a low hero stance; the city lights streak behind.
3. Extreme macro travelling across stitching, zipper teeth, embossed logo.

CONTROLS — HUD: DROP LIVE IN (countdown timer, not a 0→max value) ·
PLAY ("WATCH THE DROP") · TOP/END.

OVERLAYS — "ONYX SUPPLY — MIDNIGHT DROP" in massive type → "Built heavy.
Cut clean." over the macro.

BELOW THE JOURNEY — product grid (3 cards, hover-play spin clips, prices
$180/$210/$340, size + Add to Cart) → "Notify me" email capture.

BRAND — concrete gray + matte black, one acid-green accent, brutalist
condensed type.
```

**HERO** *(scrub hero on top of an existing store — its native mode)*
```
Redesign the hero section with 3D scrolling for ONYX SUPPLY's "Midnight Drop"
store page. (bt-design → 3D-Hero-Scroll, reach: hero)
Do not touch the store below; match its existing tokens.

FOOTAGE — generate via KIE. Lookbook anchor first: a model in the full fit —
matte black garments, chrome zippers — on a foggy rooftop at night. Chain:
1. The model walks slowly toward camera through rooftop fog, neon glow behind,
   wind moving the fabric.
2. The camera arcs around to a low front hero stance as the fog thickens.

CONTROLS — PLAY ("WATCH THE DROP") only · no HUD · no jump nav.

OVERLAYS — "ONYX SUPPLY — MIDNIGHT DROP" → live countdown timer to the drop.

HANDOFF — the fog thickens toward the store's concrete-gray so the film hands
off cleanly into the existing product grid.
```

*What changed:* PAGE builds the product grid + email capture below and adds a
macro beat; HERO is the pack's original intent — a cinematic topper on a store
you already have. Note the "HUD" here is a countdown timer, so PAGE keeps it
but HERO drops it for pure drama.

---

### 10.7 · EMBER & OAK (restaurant)

**PAGE** *(full restaurant site)*
```
Redesign this starter template as a cinematic "3D scroll" website for
EMBER & OAK — a wood-fire steakhouse in [CITY].
(bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Anchor first: a ribeye searing over open flame,
embers rising into darkness, amber light. Chain:
1. Slow-motion macro of the sear, embers lifting into black.
2. The camera pulls back into the dining room at golden hour — leather booths,
   candlelight, a bartender stirring a cocktail.
3. Overhead of a chef's hands plating a dish, steam curling up on dark slate.

CONTROLS — no HUD · PLAY ("STOKE THE FIRE") · TOP/END.

OVERLAYS — "EMBER & OAK" in elegant serif → "Wood fire. Nothing else." →
"Six dishes. One fire." over the room.

BELOW THE JOURNEY — menu (two columns, Fire / Field) → private dining →
hours + map + "Reserve a Table" form.

BRAND — near-black, warm cream text, ember-orange accent, film grain, slow
parallax.
```

**HERO** *(fire hero on top of an existing menu site — its native mode)*
```
Redesign the hero section with 3D scrolling for EMBER & OAK — a wood-fire
steakhouse in [CITY]. (bt-design → 3D-Hero-Scroll, reach: hero)
The story, menu, and reservation sections below stay; match existing tokens.

FOOTAGE — generate via KIE. Anchor first: a ribeye searing over open flame,
embers rising into darkness, amber light. Chain:
1. Slow-motion macro of the sear, embers lifting into black.
2. The camera pulls back through the ember drift into the dining room at
   golden hour, settling on the open fire.

CONTROLS — PLAY ("STOKE THE FIRE") only · no HUD.

OVERLAYS — "EMBER & OAK" in an elegant serif tracking in → "Wood fire.
Nothing else."

HANDOFF — settle the final frame into candlelit near-black so it hands off
into the existing story and menu sections.
```

*What changed:* both are HUD-less (a steakhouse has no rising metric). PAGE
adds the plating beat and builds menu + reservation form below; HERO is just
the sear-into-room and lets the existing site carry the menu.

---

### 10.8 · PULSE (AI SaaS)

**PAGE** *(full landing page)*
```
Redesign this starter template as a cinematic "3D scroll" landing page for
PULSE — an AI analytics platform that predicts customer churn before it
happens. (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Anchor first: a clean floating dashboard UI with a
rising, heartbeat-pulsing graph in a dark void. Chain:
1. Thousands of glowing data particles swirl and assemble into the dashboard;
   the graph pulses alive as the build completes.
2. Macro glide across holographic charts; one red anomaly lights up and is caught.
3. The dashboard sits on a laptop in a bright minimal office, coffee steam
   drifting — everything under control.

CONTROLS — HUD: SIGNAL 0 → 94 %, segments ASSEMBLY / THE CATCH / THE CALM ·
PLAY ("SEE IT COMING") · TOP/END.

OVERLAYS — "See churn coming." → one line per feature window (Predict ·
Explain · Prevent).

BELOW THE JOURNEY — logo strip → metrics counters (94% accuracy · 12,000
teams · $40M saved) → pricing (3 tiers, middle highlighted) → FAQ → final CTA.

BRAND — near-black hero fading to white body, single violet accent, crisp
geometric sans, glassmorphism cards.
```

**HERO** *(dark scrub hero handing off to a light body — its native mode)*
```
Redesign the hero section with 3D scrolling for PULSE — an AI analytics
platform that predicts customer churn before it happens.
(bt-design → 3D-Hero-Scroll, reach: hero) The feature blocks, pricing table,
and FAQ below already exist; match their tokens.

FOOTAGE — generate via KIE. Anchor first: a clean floating dashboard UI with a
rising, heartbeat-pulsing graph in a dark void. Chain:
1. Data particles swirl and assemble into the dashboard; the graph pulses
   alive as the build completes.
2. Macro glide across holographic charts; one red anomaly lights up and is
   caught.

CONTROLS — HUD: SIGNAL 0 → 94 % · PLAY ("SEE IT COMING") · no jump nav.

OVERLAYS — "See churn coming." → one line per feature window (Predict ·
Explain · Prevent). The "Start free" CTA lives in the existing body, not an
overlay.

HANDOFF — grade the final frame from near-black toward white so it hands off
into the existing light-bodied page.
```

*What changed:* the "everything under control" office beat and the whole
pricing/FAQ stack are PAGE; HERO stops after the anomaly catch and grades to
white — the textbook dark-film-over-light-page handoff.

---

### 10.9 · NOIR&CO (creative agency)

**PAGE** *(full agency site)*
```
Redesign this starter template as a cinematic "3D scroll" website for NOIR&CO
— a creative studio that designs brands "for companies that refuse to be
ignored." (bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Anchor first: black ink mid-bloom in water,
flashing into gold. Chain:
1. Black ink blooms and morphs through water in slow motion, flashing gold.
2. A dolly past oversized posters and screens with bold type on gallery walls.
3. Silhouettes of a small team working late in a moody studio, city bokeh
   through the window.

CONTROLS — no HUD · PLAY ("ENTER THE STUDIO") · TOP/END.

OVERLAYS — "NOIR&CO" filling 80% of the viewport → manifesto one word per
window (LOUD. · PRECISE. · UNFORGETTABLE.).

BELOW THE JOURNEY — selected-work grid (4 case studies, hover video reveals)
→ services (editorial two-column) → team → "Got a brand worth fighting for?"
footer. Cursor = small gold dot with trailing ring.

BRAND — pure black + bone white, gold accent used exactly three times,
brutalist display + refined serif body.
```

**HERO** *(the zero-controls variant — scrub only)*
```
Redesign the hero section with 3D scrolling for NOIR&CO — a creative studio.
(bt-design → 3D-Hero-Scroll, reach: hero) The work grid, services, and footer
below stay; match existing tokens.

FOOTAGE — generate via KIE. Anchor first: black ink mid-bloom in water,
flashing into gold. Chain:
1. Black ink blooms and morphs through water in extreme slow motion, flashing
   gold.
2. The bloom collapses inward and snaps to pure black.

CONTROLS — none. No HUD, no PLAY, no jump nav — scrub only.

OVERLAYS — "NOIR&CO" filling 80% of the viewport → manifesto one word per
window (LOUD. · PRECISE. · UNFORGETTABLE.).

HANDOFF — the ink snaps to the same pure black as the site body — an
invisible seam.
```

*What changed:* PAGE keeps PLAY + jump nav and builds the case-study grid
below; HERO is the deliberate zero-controls proof — delete every optional
block and the engine is still a silky scrub with choreographed type.

---

### 10.10 · FORGE (gym)

**PAGE** *(full gym site)*
```
Redesign this starter template as a cinematic "3D scroll" website for FORGE —
a strength gym in [CITY], motto "Earn it."
(bt-design → 3D-Hero-Scroll, reach: page)

FOOTAGE — generate via KIE. Anchor first: an athlete mid-clap, chalk cloud
blooming through a single overhead shaft of light in a dark gym. Chain:
1. Slow motion — the chalked hands clap, the cloud blooms through the shaft.
2. Macro tracking along a loaded barbell as hands grip it, knurling and chalk
   in sharp detail, plates settling.
3. A runner sprinting an outdoor track at dawn, breath visible, camera low
   and fast alongside.

CONTROLS — HUD: PRs THIS MONTH 0 → 1,240, segments CHALK / IRON / GRIND ·
PLAY ("EARN IT") · TOP/END.

OVERLAYS — "FORGE" in industrial type punching in → "Earn it." → one
philosophy line per window ("No mirrors." · "No machines that do the work
for you.").

BELOW THE JOURNEY — programs grid (Strength / Conditioning / Team) → coaches
→ pricing (3 tiers, middle highlighted, "First week free") → schedule + map +
signup.

BRAND — charcoal, bone-white type, one blood-red accent, heavy condensed
display, grain + vignette.
```

**HERO** *(chalk-cloud hero on top of an existing gym site — its native mode)*
```
Redesign the hero section with 3D scrolling for FORGE — a strength gym in
[CITY], motto "Earn it." (bt-design → 3D-Hero-Scroll, reach: hero)
Programs, coaches, pricing, and schedule below stay; match existing tokens.

FOOTAGE — generate via KIE. Anchor first: an athlete mid-clap, chalk cloud
blooming through a single overhead shaft of light in a dark gym. Chain:
1. Slow motion — the chalked hands clap, the cloud blooms through the shaft.
2. The camera pushes through the chalk cloud and lands on a loaded barbell as
   hands grip it, knurling and chalk in sharp detail.

CONTROLS — PLAY ("EARN IT") only · no HUD.

OVERLAYS — "FORGE" in massive industrial type punching in → "Earn it."

HANDOFF — settle the final frame into charcoal so it hands off into the
existing programs grid.
```

*What changed:* PAGE adds the outdoor-sprint beat, a PRs-this-month HUD, and
builds programs/pricing/schedule below; HERO is the clap-into-barbell topper
over a gym site you already have.
