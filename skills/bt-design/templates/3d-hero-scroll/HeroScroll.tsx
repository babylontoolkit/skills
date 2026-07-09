/* ═══════════════════════════════════════════════════════════════════
   HeroScroll.tsx — React wrapper for the framework-agnostic hero-scroll
   engine. Renders the `hs-` markup as JSX and mounts `initHeroScroll`
   against its own root, tearing down cleanly on unmount.

   The engine (hero-scroll.js) is the SAME code the plain-HTML template
   uses — do NOT re-implement the scrubbing/autoplay/veil logic in React.
   Copy this file + hero-scroll.js + hero-scroll.d.ts + hero-scroll.css
   into the app, import your scrub mp4 + poster as assets, and configure.

   Example (Vite/React):

     import HeroScroll from "./HeroScroll";
     import scrub from "./assets/journey-scrub.mp4";
     import poster from "./assets/poster.jpg";

     // Values below are placeholders — derive every label, metric, segment,
     // and overlay from the prompt's own subject; do not copy these verbatim.
     <HeroScroll
       config={{ video: scrub, sweep: "page",
                 telemetry: { max: MAX, startP: START_P, endP: 0.95,
                   segments: [[0,"SEG A"],[0.25,"SEG B"],
                              [0.5,"SEG C"],[0.75,"SEG D"]] } }}
       posterSrc={poster}
       journeyVh={640}
       hud={{ unit: "UNIT" }}
       play={{ idle: "PLAY" }}
       jumpNav
       overlays={
         <>
           <section className="hs-ovl" data-from="0" data-to="0.115">
             <h1>WORDMARK</h1>
           </section>
           <section className="hs-ovl hs-scrim" data-from="0.26" data-to="0.46">
             <span data-hs-count data-target={STAT} data-group="1">0</span> STAT
           </section>
         </>
       }
     />

   Brand: map --hs-* tokens to the host design system in hero-scroll.css
   (or override on a wrapper). Sticky constraint: no ancestor of this
   component may have transform / filter / perspective / overflow:hidden —
   it breaks position:sticky and kills the effect.
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useRef, type ReactNode } from "react";
import { initHeroScroll, type HeroScrollConfig } from "./hero-scroll";
import "./hero-scroll.css";

export interface HeroScrollProps {
  /** Engine config — video path (imported asset URL), telemetry, sweep, etc. */
  config: HeroScrollConfig;
  /** Poster = the FIRST frame of the scrub file (not a glamour still). */
  posterSrc?: string;
  /** Scroll length in vh: ~15–20vh per second of footage (default 640). */
  journeyVh?: number;
  /** Preload gate. Pass a node for the loader mark, `true` for a bare bar,
   *  or omit/false to skip the gate. */
  loader?: ReactNode | boolean;
  /** Telemetry HUD (requires config.telemetry). `unit` is the label text. */
  hud?: { unit: string } | false;
  /** Film-speed autoplay control with its idle/busy labels. */
  play?: { idle: string; busy?: string } | false;
  /** Veiled TOP/END jump nav. */
  jumpNav?: boolean;
  /** `.hs-ovl[data-from][data-to]` overlay sections (author as children). */
  overlays?: ReactNode;
  /** Extra class on the journey wrapper. */
  className?: string;
}

function HeroScroll({
  config,
  posterSrc,
  journeyVh = 640,
  loader,
  hud,
  play,
  jumpNav,
  overlays,
  className,
}: HeroScrollProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    const hs = initHeroScroll(rootRef.current, config);
    return () => hs.destroy();
    // Re-init only if the video source changes; other config is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.video]);

  return (
    <div ref={rootRef} className={className}>
      {loader ? (
        <div id="hs-loader" role="status" aria-label="Loading">
          {typeof loader !== "boolean" ? (
            <div className="hs-loader-mark">{loader}</div>
          ) : null}
          <div className="hs-loader-bar">
            <span id="hs-loader-fill" />
          </div>
          <span id="hs-loader-pct">000</span>
        </div>
      ) : null}

      {play ? (
        <button id="hs-play" aria-pressed="false" title="Play — cinematic auto-scroll">
          <span className="hs-play-icon" aria-hidden="true" />
          <span
            className="hs-play-label"
            data-idle={play.idle}
            data-busy={play.busy ?? "STOP"}
          >
            {play.idle}
          </span>
        </button>
      ) : null}

      {jumpNav ? (
        <nav id="hs-jump-nav" aria-label="Quick navigation">
          <button id="hs-top" title="Go to top">
            <span className="hs-arrow" aria-hidden="true">↑</span>
            <span>TOP</span>
          </button>
          <button id="hs-end" title="Skip to the end">
            <span className="hs-arrow" aria-hidden="true">↓</span>
            <span>END</span>
          </button>
        </nav>
      ) : null}

      {hud ? (
        <aside id="hs-hud" aria-label="Telemetry">
          <div>
            <span id="hs-hud-value">0</span>{" "}
            <span className="hs-hud-unit">{hud.unit}</span>
          </div>
          <div className="hs-hud-bar">
            <span id="hs-hud-progress" />
          </div>
          <div className="hs-hud-meta">
            <span id="hs-hud-seg" />
            <span id="hs-hud-pct">000%</span>
          </div>
        </aside>
      ) : null}

      <div id="hs-journey" style={{ height: `${journeyVh}vh` }}>
        <div className="hs-stage">
          <video
            id="hs-video"
            muted
            playsInline
            preload="none"
            poster={posterSrc}
          />
          <div className="hs-stage-shade" aria-hidden="true" />
          {overlays}
        </div>
      </div>
    </div>
  );
}

export default HeroScroll;
