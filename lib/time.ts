import type { XPost } from "./schema";

/**
 * When the evidence was posted.
 *
 * X gives us `created_at` on every post — we ask for it in TWEET_FIELDS, pay for
 * it on every call and ship it to the client whole — and until now the only
 * place it surfaced was inside a hover panel. On a board whose seed is a DATE
 * that's the wrong place for it: "is this from twenty minutes ago or from
 * Tuesday" is the first question you ask of a claim about what's happening, and
 * it was answerable only by hovering each citation in turn.
 */

/** Formatting options only differ by whether the year is worth the pixels. */
function dateOpts(d: Date): Intl.DateTimeFormatOptions {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" };
}

/**
 * "8 AUG 14:32" — the absolute stamp.
 *
 * 24h, always, even where the locale would prefer AM/PM: this renders in the
 * mono telemetry voice next to the node's coordinates, and "02:32 PM" is three
 * characters of clutter plus a column that no longer aligns between siblings.
 * The date itself stays locale-ordered because that part is genuinely regional.
 */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const date = d.toLocaleDateString(undefined, dateOpts(d));
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time}`;
}

/** "2H", "3D" — relative, for when the exact minute isn't the point. */
export function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M`;
  if (m < 1440) return `${Math.round(m / 60)}H`;
  if (m < 43_200) return `${Math.round(m / 1440)}D`;
  return new Date(iso)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase();
}

/**
 * The one timestamp a card gets to show, out of the several it's built from.
 *
 * The NEWEST, because the question a stamp on a node answers is "how current is
 * this" — an older corroborating post doesn't make the claim staler. The spread
 * is still readable post by post in the citation panel, which is the right place
 * for it; a range on the card would cost a second line to say something most
 * cards can't say (their posts are minutes apart).
 *
 * Unverified posts are excluded outright, and this is the important part: when
 * Grok reports a post we can't confirm against the X API, `postFromUrl` stamps
 * it with `new Date()` because it has nothing else to put there. That is a
 * placeholder, not a time. Displaying it would print "NOW" on the one class of
 * citation the whole verification pass exists to mark as untrustworthy — a
 * fabricated fact rendered in the same voice as a retrieved one.
 */
export function postedAt(posts: XPost[]): string | null {
  let newest: string | null = null;
  let best = -Infinity;
  for (const p of posts) {
    if (p.unverified) continue;
    const t = new Date(p.created_at).getTime();
    if (!Number.isFinite(t) || t <= best) continue;
    best = t;
    newest = p.created_at;
  }
  return newest;
}
