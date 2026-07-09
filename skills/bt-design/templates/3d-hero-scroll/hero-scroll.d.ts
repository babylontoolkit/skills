/* Type declarations for the framework-agnostic hero-scroll engine. */

export interface HeroScrollTelemetry {
  /** HUD value at endP. */
  max: number;
  /** Progress (0–1) where the value leaves 0 — CALIBRATE from footage frames. */
  startP: number;
  /** Progress where the value reaches max (default 0.95). */
  endP?: number;
  /** Curve exponent: <1 = violent launch, 1 = linear (default 0.45). */
  exponent?: number;
  /** [progressThreshold, label] pairs; the HUD shows the last one reached. */
  segments?: Array<[number, string]>;
}

export interface HeroScrollConfig {
  /** Path to the ALL-INTRA (`-g 1`) scrub-encoded mp4. */
  video?: string;
  /** Scrub low-pass factor, 1 = no smoothing (default 0.16). */
  smoothing?: number;
  /** Scroll-velocity motion blur on the footage (default true). */
  motionBlur?: boolean;
  /** Body class applied when the footage can't load (default "hs-no-video"). */
  fallbackClass?: string;
  /** Telemetry HUD curve; omit/null to disable HUD math. */
  telemetry?: HeroScrollTelemetry | null;
  /**
   * Where PLAY/END consider "the end":
   * - "page" (default): PLAY glides on to the document bottom, END jumps there.
   * - "hero": PLAY/END stop at the journey's end (land on the next section).
   * Named `sweep` (not `reach`) so it never collides with a spec/plan's
   * route/DOM-scope terminology.
   */
  sweep?: "page" | "hero";
  /** Autoplay tail speed after the journey, as a fraction of the viewport
   *  (sweep: "page" only; default 0.5). */
  tailRate?: number;
  /** Veiled-cut fade duration in ms (default 480). */
  veilFadeMs?: number;
  /** Hold-on-black duration in ms while the sweep re-arms (default 450). */
  veilHoldMs?: number;
}

export interface HeroScrollController {
  /** Start film-speed autoplay. */
  play(): void;
  /** Stop autoplay / veil. */
  stop(): void;
  /** Fade to black, jump to `y`, re-sync, lift; optional continuation. */
  veilTo(y: number, done?: (token: number) => void): void;
  /** Current smoothed journey progress (0–1). */
  progress(): number;
  /** Tear everything down (listeners, rAF, injected veil, blob URL). */
  destroy(): void;
}

/**
 * Mount the hero-scroll engine against a root element (or `document`).
 * The root must already contain the `#hs-journey` markup. Returns a
 * controller — call `.destroy()` on unmount.
 */
export function initHeroScroll(
  root?: ParentNode,
  config?: HeroScrollConfig,
): HeroScrollController;

export default initHeroScroll;
