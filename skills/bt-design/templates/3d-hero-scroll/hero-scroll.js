/* ═══════════════════════════════════════════════════════════════════
   3D-HERO-SCROLL — scroll-scrubbed cinematic hero engine
   Generic, brand-agnostic, config-driven. Pairs with hero-scroll.css.

   FRAMEWORK-AGNOSTIC ESM. One engine, two hosts:

   • Plain HTML — load as a module; it auto-boots against `document` when
     `window.HS_CONFIG` is set and a `#hs-journey` exists:
        <script type="module" src="hero-scroll.js"></script>
   • React / Vue / any bundler — import and mount against your own root, then
     tear down on unmount (see HeroScroll.tsx):
        import { initHeroScroll } from "./hero-scroll";
        const hs = initHeroScroll(rootEl, config);  // rootEl contains the markup
        // ...later: hs.destroy();

   Config (all keys optional; pass as `window.HS_CONFIG` or the 2nd arg):

     {
       video: "media/journey-scrub.mp4", // ALL-INTRA encoded (-g 1) mp4
       smoothing: 0.16,                  // scrub low-pass factor (1 = none)
       motionBlur: true,                 // scroll-velocity blur on footage
       fallbackClass: "hs-no-video",     // body class when footage missing
       telemetry: {                      // omit (null) to disable HUD math
         max: 250, startP: 0.286, endP: 0.95, exponent: 0.45,
         segments: [[0.0,"SEG 01"], [0.25,"SEG 02"]],
       },
       sweep: "page",                    // "page" (default): PLAY glides on to
                                         //   the document bottom and END jumps
                                         //   there (full cinematic ride);
                                         //   "hero": PLAY and END stop at the
                                         //   journey's end — you land on the
                                         //   regular section right after the
                                         //   hero, same as a normal scroll.
                                         //   (Names where autoplay/jumps end;
                                         //   deliberately NOT called "reach" so
                                         //   it never collides with route/DOM
                                         //   scope in a spec/plan.)
       tailRate: 0.5,                    // autoplay px/s after journey,
                                         //   as a fraction of the viewport
                                         //   (sweep: "page" only)
       veilFadeMs: 480,                  // veiled-cut fade duration
       veilHoldMs: 450,                  // hold on black (sweep plays here)
     }

   Required markup (inside `root`; see hero-scroll.html / HeroScroll.tsx):
     #hs-journey > .hs-stage > #hs-video           the scrub stage
   Optional markup — each feature activates only if its element exists:
     #hs-loader (+ #hs-loader-fill, #hs-loader-pct) preload screen
     #hs-hud (+ #hs-hud-value, #hs-hud-progress,
              #hs-hud-seg, #hs-hud-pct)             telemetry HUD
     #hs-play (+ .hs-play-label)                    film-speed autoplay
     #hs-top / #hs-end                              veiled jump nav
     .hs-ovl[data-from][data-to]                    choreographed overlays
       [data-hs-depth] children                     parallax drift
       [data-hs-count][data-target][data-decimals]  count-up stats
   The #hs-veil element is injected automatically (and removed on destroy).

   initHeroScroll(root, config) → { play, stop, veilTo, progress, destroy }
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

const DEFAULTS = {
  video: "media/journey-scrub.mp4",
  smoothing: 0.16,
  motionBlur: true,
  fallbackClass: "hs-no-video",
  telemetry: null,
  sweep: "page",
  tailRate: 0.5,
  veilFadeMs: 480,
  veilHoldMs: 450,
};

/**
 * Mount the hero-scroll engine against a root element (or `document`).
 * Returns a controller; call `.destroy()` to fully tear down (React unmount).
 */
export function initHeroScroll(root = document, userConfig = {}) {
  const CFG = { ...DEFAULTS, ...userConfig };

  const scope = root === document ? document : root;
  const $ = (s) => scope.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const linear = (t) => t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const journey = $("#hs-journey");
  const video = $("#hs-video");
  if (!journey || !video) return { destroy() {} }; // nothing to drive

  // optional chrome — every feature is presence-gated
  const loaderFill = $("#hs-loader-fill");
  const loaderPct = $("#hs-loader-pct");
  const hud = $("#hs-hud");
  const hudValue = $("#hs-hud-value");
  const hudProgress = $("#hs-hud-progress");
  const hudSeg = $("#hs-hud-seg");
  const hudPct = $("#hs-hud-pct");
  const playBtn = $("#hs-play");
  const playLabel = playBtn && playBtn.querySelector(".hs-play-label");
  const gotoTop = $("#hs-top");
  const gotoEnd = $("#hs-end");

  // the veil is engine-owned — inject it
  const veil = document.createElement("div");
  veil.id = "hs-veil";
  veil.setAttribute("aria-hidden", "true");
  document.body.appendChild(veil);

  document.body.dataset.hsState = "loading";

  /* ── scroll container resolution ───────────────────────────────────
     CRITICAL for framework hosts: the page may scroll on `document.body`
     or an overflow ancestor rather than the window (e.g. apps that set
     `html, body { height: 100%; overflow-y: auto }`). Assuming the window
     silently breaks scrubbing. Resolve the element that actually scrolls,
     and read/write scroll through it. */

  function resolveScroller(node) {
    let el = node && node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight)
        return el;
      el = el.parentElement;
    }
    if (
      document.body.scrollHeight > document.body.clientHeight + 1 &&
      getComputedStyle(document.body).overflowY !== "visible"
    )
      return document.body;
    return document.scrollingElement || document.documentElement;
  }

  const scroller = resolveScroller(journey);
  const isDocScroller =
    scroller === document.scrollingElement ||
    scroller === document.documentElement ||
    scroller === document.body;

  const getY = () => scroller.scrollTop;
  const setY = (y) => {
    scroller.scrollTop = y;
  };
  const viewportH = () => (isDocScroller ? innerHeight : scroller.clientHeight);
  const maxY = () => scroller.scrollHeight - viewportH();

  /* ── preload the footage as a blob so seeking is instant ──────── */

  let videoReady = false;
  let duration = 0;
  let objectUrl = null;
  let alive = true;

  function setLoader(p) {
    const pct = Math.round(clamp(p, 0, 1) * 100);
    if (loaderFill) loaderFill.style.width = pct + "%";
    if (loaderPct) loaderPct.textContent = String(pct).padStart(3, "0");
  }

  async function preload() {
    try {
      const res = await fetch(CFG.video);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const total = +res.headers.get("content-length") || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!alive) return;
        chunks.push(value);
        received += value.length;
        setLoader(total ? received / total : 0.5);
      }
      setLoader(1);
      objectUrl = URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
      video.src = objectUrl;
      await new Promise((ok, err) => {
        video.addEventListener("loadedmetadata", ok, { once: true });
        video.addEventListener("error", err, { once: true });
      });
      if (!alive) return;
      duration = video.duration;
      video.currentTime = 0;
      videoReady = true;
    } catch (e) {
      document.body.classList.add(CFG.fallbackClass); // poster still shows
      setLoader(1);
    }
    if (alive) document.body.dataset.hsState = "ready";
  }

  /* ── overlay windows ───────────────────────────────────────────── */

  const overlays = [...scope.querySelectorAll(".hs-ovl")].map((el) => ({
    el,
    from: parseFloat(el.dataset.from),
    to: parseFloat(el.dataset.to),
    active: false,
    parallax: [...el.querySelectorAll("[data-hs-depth]")],
    counters: [...el.querySelectorAll("[data-hs-count]")],
    counting: false,
  }));

  const FADE = 0.035; // progress-units to fade an overlay in/out

  function runCounters(o) {
    if (o.counting || !o.counters.length) return;
    o.counting = true;
    const t0 = performance.now();
    const DUR = reduced ? 0 : 1400;
    const tick = (now) => {
      if (!alive || !o.counting) return;
      const k = DUR ? easeInOutCubic(clamp((now - t0) / DUR, 0, 1)) : 1;
      for (const c of o.counters) {
        const target = parseFloat(c.dataset.target);
        const dec = +(c.dataset.decimals || 0);
        let v = (target * k).toFixed(dec);
        if (c.dataset.group) v = (+v).toLocaleString("en-US");
        c.textContent = v;
      }
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function armCounters(o) {
    o.counting = false;
    for (const c of o.counters)
      c.textContent = (0).toFixed(+(c.dataset.decimals || 0));
  }

  function styleOverlay(o, p) {
    if (p < o.from - 0.01 || p > o.to + 0.01) {
      if (o.el.style.visibility !== "hidden") {
        o.el.style.visibility = "hidden";
        o.el.style.opacity = "0";
      }
      if (o.active) {
        o.active = false;
        o.el.classList.remove("hs-active");
        armCounters(o);
      }
      return;
    }
    // an overlay whose window starts at 0 must be fully risen at p = 0
    const rise = o.from <= 0 ? 1 : clamp((p - o.from) / FADE, 0, 1);
    const fall = clamp((o.to - p) / FADE, 0, 1);
    const vis = Math.min(rise, fall);
    const drift = (1 - rise) * 34 - (1 - fall) * 34;
    const blur = reduced ? 0 : (1 - vis) * 14;

    o.el.style.visibility = "visible";
    o.el.style.opacity = vis.toFixed(3);
    o.el.style.transform = `translateY(${drift.toFixed(1)}px)`;
    o.el.style.filter = blur > 0.4 ? `blur(${blur.toFixed(1)}px)` : "none";

    if (o.parallax.length && !reduced) {
      const local = (p - o.from) / (o.to - o.from) - 0.5;
      for (const m of o.parallax) {
        const depth = parseFloat(m.dataset.hsDepth || "0.5");
        m.style.transform = `translateY(${(-local * 60 * depth).toFixed(1)}px)`;
      }
    }

    if (vis > 0.5 && !o.active) {
      o.active = true;
      o.el.classList.add("hs-active");
      runCounters(o);
    }
  }

  /* ── telemetry value curve ─────────────────────────────────────── */

  const TEL = CFG.telemetry;

  function valueAt(p) {
    if (!TEL || p <= TEL.startP) return 0;
    const span = Math.max(0.001, (TEL.endP ?? 0.95) - TEL.startP);
    return (
      TEL.max *
      Math.pow(clamp((p - TEL.startP) / span, 0, 1), TEL.exponent ?? 0.45)
    );
  }

  /* ── frame loop ────────────────────────────────────────────────── */

  let smoothP = 0;
  let lastP = 0;
  let journeyTop = 0;
  let journeyScroll = 1;
  let frameRaf = null;

  function measure() {
    const sTop = isDocScroller ? 0 : scroller.getBoundingClientRect().top;
    journeyTop = journey.getBoundingClientRect().top - sTop + getY();
    journeyScroll = Math.max(1, journey.offsetHeight - viewportH());
  }

  // where PLAY/END consider "the end": journey end (sweep:"hero") or
  // document bottom (sweep:"page")
  const endY = () =>
    CFG.sweep === "hero"
      ? journeyTop + journey.offsetHeight - viewportH()
      : maxY();

  function frame() {
    const y = clamp(getY() - journeyTop, 0, journeyScroll);
    const p = y / journeyScroll;

    smoothP += (p - smoothP) * (reduced ? 1 : CFG.smoothing);
    if (Math.abs(p - smoothP) < 0.0004) smoothP = p;

    if (videoReady && duration) {
      const t = smoothP * Math.max(0, duration - 0.05);
      if (Math.abs(t - video.currentTime) > 0.02) video.currentTime = t;
    }

    if (CFG.motionBlur && !reduced && videoReady) {
      const blur = Math.min(5, Math.abs(smoothP - lastP) * 620);
      video.style.filter = blur > 0.35 ? `blur(${blur.toFixed(2)}px)` : "none";
    }
    lastP = smoothP;

    if (hud) {
      if (hudValue) hudValue.textContent = Math.round(valueAt(smoothP));
      if (hudProgress)
        hudProgress.style.transform = `scaleX(${smoothP.toFixed(4)})`;
      if (hudPct)
        hudPct.textContent =
          String(Math.round(smoothP * 100)).padStart(3, "0") + "%";
      if (hudSeg && TEL && TEL.segments) {
        let seg = TEL.segments[0][1];
        for (const [at, label] of TEL.segments) if (smoothP >= at) seg = label;
        hudSeg.textContent = seg;
      }
      hud.classList.toggle(
        "hs-hud-off",
        getY() > journeyTop + journey.offsetHeight - viewportH() * 0.55
      );
    }

    if (gotoTop) gotoTop.classList.toggle("hs-nav-dim", getY() < 4);
    if (gotoEnd) gotoEnd.classList.toggle("hs-nav-dim", getY() >= endY() - 4);

    for (const o of overlays) styleOverlay(o, smoothP);

    if (alive) frameRaf = requestAnimationFrame(frame);
  }

  /* ── veiled cut + film-speed autoplay ──────────────────────────── */

  let autoActive = false;
  let autoRaf = null;
  let autoToken = 0; // invalidates in-flight timelines/veil callbacks
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

  function stopAuto() {
    autoToken += 1;
    autoActive = false;
    if (autoRaf !== null) cancelAnimationFrame(autoRaf);
    autoRaf = null;
    veil.classList.remove("hs-on");
    if (playBtn) {
      playBtn.classList.remove("hs-playing");
      playBtn.setAttribute("aria-pressed", "false");
      if (playLabel) playLabel.textContent = playLabel.dataset.idle || "PLAY";
    }
  }

  // Fade to black, reposition + re-sync the scrub under the veil
  // (no visible fast-scroll), lift, then optionally continue.
  function veilTo(targetY, done) {
    const token = ++autoToken;
    veil.classList.add("hs-on");
    later(() => {
      if (token !== autoToken) return;
      setY(targetY);
      const p = clamp((targetY - journeyTop) / journeyScroll, 0, 1);
      smoothP = p; // snap the smoothed scrub — no reverse/fast-forward flash
      lastP = p;
      if (videoReady && duration)
        video.currentTime = p * Math.max(0, duration - 0.05);
      later(() => {
        if (token !== autoToken) return;
        veil.classList.remove("hs-on");
        if (done)
          later(() => {
            if (token === autoToken) done(token);
          }, 200); // continue as the veil lifts
      }, CFG.veilHoldMs);
    }, CFG.veilFadeMs);
  }

  function runFrom(token) {
    if (token !== autoToken) return;
    const max = maxY();
    const journeyEnd = journeyTop + journey.offsetHeight - viewportH();
    const filmRate = journeyScroll / (videoReady && duration ? duration : 30);
    const tailRate = Math.max(420, viewportH() * CFG.tailRate);

    const segs = [];
    let from = getY();
    if (from < journeyEnd)
      segs.push({
        from,
        to: journeyEnd,
        dur: ((journeyEnd - from) / filmRate) * 1000, // real-time film speed
        ease: linear,
      });
    if (CFG.sweep !== "hero" && Math.max(from, journeyEnd) < max)
      segs.push({
        from: Math.max(from, journeyEnd),
        to: max,
        dur: ((max - Math.max(from, journeyEnd)) / tailRate) * 1000,
        ease: easeOutCubic,
      });
    if (!segs.length) {
      stopAuto();
      return;
    }

    let i = 0;
    let t0 = performance.now();
    const step = (now) => {
      if (token !== autoToken) return;
      const s = segs[i];
      const k = s.dur > 0 ? clamp((now - t0) / s.dur, 0, 1) : 1;
      setY(s.from + (s.to - s.from) * s.ease(k));
      if (k >= 1) {
        i += 1;
        t0 = now;
        if (i >= segs.length) {
          stopAuto();
          return;
        }
      }
      autoRaf = requestAnimationFrame(step);
    };
    autoRaf = requestAnimationFrame(step);
  }

  function startAuto() {
    autoActive = true;
    if (playBtn) {
      playBtn.classList.add("hs-playing");
      playBtn.setAttribute("aria-pressed", "true");
      if (playLabel) playLabel.textContent = playLabel.dataset.busy || "STOP";
    }
    if (getY() >= endY() - 8) {
      veilTo(0, (token) => runFrom(token)); // replay: cut to black, re-arm
    } else {
      runFrom(++autoToken);
    }
  }

  /* ── listeners (all tracked for teardown) ──────────────────────── */

  const bound = [];
  const on = (target, ev, fn, opts) => {
    target.addEventListener(ev, fn, opts);
    bound.push([target, ev, fn, opts]);
  };

  if (playBtn)
    on(playBtn, "click", () => (autoActive ? stopAuto() : startAuto()));
  if (gotoTop)
    on(gotoTop, "click", () => {
      stopAuto();
      veilTo(0);
    });
  if (gotoEnd)
    on(gotoEnd, "click", () => {
      stopAuto();
      veilTo(endY());
    });

  // any manual input hands control back to the viewer
  const cancelInput = (e) => {
    if (!autoActive) return;
    const t = e.target; // guard: target may not be a Node (window)
    if (
      e.type === "keydown" &&
      playBtn &&
      t instanceof Node &&
      playBtn.contains(t)
    )
      return; // Enter/Space on the button toggles via its click handler
    stopAuto();
  };
  for (const ev of ["wheel", "touchstart", "keydown"])
    on(window, ev, cancelInput, { passive: true });

  // scroll can happen on window or an overflow element — listen on both
  // (element scroll doesn't bubble to window; capture on document catches it).
  const onResize = () => measure();
  on(window, "resize", onResize);

  /* ── go ────────────────────────────────────────────────────────── */

  measure();
  preload();
  frameRaf = requestAnimationFrame(frame);

  /* ── teardown ──────────────────────────────────────────────────── */

  function destroy() {
    alive = false;
    autoToken += 1;
    if (frameRaf !== null) cancelAnimationFrame(frameRaf);
    if (autoRaf !== null) cancelAnimationFrame(autoRaf);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const [target, ev, fn, opts] of bound)
      target.removeEventListener(ev, fn, opts);
    if (veil.parentNode) veil.parentNode.removeChild(veil);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    delete document.body.dataset.hsState;
    document.body.classList.remove(CFG.fallbackClass);
  }

  return { play: startAuto, stop: stopAuto, veilTo, progress: () => smoothP, destroy };
}

export default initHeroScroll;

/* ── plain-HTML auto-boot ───────────────────────────────────────────
   When loaded as a module in a plain HTML page that sets window.HS_CONFIG
   and has a #hs-journey, boot automatically against the document. Bundler/
   React hosts import initHeroScroll directly and never set HS_CONFIG, so
   this stays dormant there. */
if (
  typeof window !== "undefined" &&
  window.HS_CONFIG &&
  typeof document !== "undefined" &&
  document.getElementById &&
  document.getElementById("hs-journey")
) {
  const boot = () => {
    window.HS = initHeroScroll(document, window.HS_CONFIG);
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
