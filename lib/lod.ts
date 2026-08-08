/**
 * Semantic zoom = text level of detail.
 *
 * The reference capture (SemanticZoom.mov) does exactly one thing, and it is
 * the whole demo:
 *
 *   - titles are legible at EVERY zoom level
 *   - body text fades from gray texture into readable prose as you zoom in
 *   - ancestors do not fade; they're clipped by the viewport edge as you pan
 *
 * So zoom is not a camera trick, it's a legibility ramp. Everything here is
 * pure math on the zoom scalar so it can run inside a transform without
 * re-rendering React.
 */

export const MIN_ZOOM = 0.28;
export const MAX_ZOOM = 1.75;
export const DEFAULT_ZOOM = 0.62;

/** below this, body text is pure texture; above it, prose */
const BODY_FADE_START = 0.5;
const BODY_FADE_END = 1.0;

/**
 * Attribution — who said it, and how well established it is.
 *
 * This is NOT "detail". A claim without its source is a claim we shouldn't be
 * making, so the citation has to be on screen wherever the title is readable.
 * It used to share the late detail ramp, which meant the default view showed
 * confident-looking assertions with no visible grounding — exactly the failure
 * mode the product exists to fix. It now lands well before the resting zoom.
 */
const ATTRIB_FADE_START = 0.34;
const ATTRIB_FADE_END = 0.48;

/** Board chrome — node coordinates, fork provenance. Genuinely last. */
const DETAIL_FADE_START = 0.72;
const DETAIL_FADE_END = 1.05;

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function ramp(z: number, start: number, end: number) {
  return clamp((z - start) / (end - start), 0, 1);
}

/** smoothstep — linear ramps read mechanical at these speeds */
function ease(t: number) {
  return t * t * (3 - 2 * t);
}

export interface Lod {
  zoom: number;
  /** 0 = gray texture, 1 = fully readable prose */
  bodyReveal: number;
  /** interpolated body text color */
  bodyColor: string;
  /** citations + epistemic status — on screen wherever the title is */
  attributionOpacity: number;
  /** node coordinates, fork provenance — board chrome, arrives last */
  detailOpacity: number;
  /** titles never disappear, but they do settle down slightly when zoomed way in */
  titleWeight: number;
}

export function lodFor(zoom: number): Lod {
  const bodyReveal = ease(ramp(zoom, BODY_FADE_START, BODY_FADE_END));
  const attributionOpacity = ease(ramp(zoom, ATTRIB_FADE_START, ATTRIB_FADE_END));
  const detailOpacity = ease(ramp(zoom, DETAIL_FADE_START, DETAIL_FADE_END));

  // #303038 (texture) -> #a2a2ac (prose)
  //
  // Inverted for the black ground: texture is now barely-above-surface, and
  // reading means the glyphs come UP out of the card rather than down onto it.
  // The ramp is the same instrument, played the other direction.
  // the floor sits higher than the light theme's mirror image would suggest:
  // dark-on-light texture stays legible as texture at lower contrast than
  // light-on-dark does, so an exact inversion read as nothing at all.
  const from = 0x30;
  const to = 0xa2;
  const v = Math.round(from + (to - from) * bodyReveal);
  const hex = v.toString(16).padStart(2, "0");
  // hold the faint blue cast of the surface all the way up the ramp
  const b = Math.min(0xff, v + 10).toString(16).padStart(2, "0");

  return {
    zoom,
    bodyReveal,
    bodyColor: `#${hex}${hex}${b}`,
    attributionOpacity,
    detailOpacity,
    // heavy weights bloom on black — titles settle LIGHTER as they get bigger
    titleWeight: zoom > 1.2 ? 500 : 600,
  };
}

/**
 * Zoom toward a screen point instead of the viewport centre, so the thing under
 * the cursor stays under the cursor. Without this the zoom feels like it's
 * fighting you, which kills the whole effect.
 */
export function zoomAbout(
  pan: { x: number; y: number },
  oldZoom: number,
  newZoom: number,
  focal: { x: number; y: number },
): { x: number; y: number } {
  const k = newZoom / oldZoom;
  return {
    x: focal.x - (focal.x - pan.x) * k,
    y: focal.y - (focal.y - pan.y) * k,
  };
}

/** Frame a rect in the viewport at a target zoom — used by "focus as root". */
export function frameRect(
  rect: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  targetZoom: number,
): { zoom: number; pan: { x: number; y: number } } {
  const zoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM);
  return {
    zoom,
    pan: {
      x: viewport.w / 2 - (rect.x + rect.w / 2) * zoom,
      y: viewport.h / 2 - (rect.y + rect.h / 2) * zoom,
    },
  };
}
