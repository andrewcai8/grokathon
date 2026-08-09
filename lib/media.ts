import type { Board, BranchNode, XPost } from "./schema";

/**
 * The pictures behind a card.
 *
 * We have always fetched these — xClient asks for media.fields and expands
 * attachments.media_keys on every call — and then dropped them on the floor.
 * On a real timeline read, 25 of 99 posts carried media and NOT ONE had
 * alt_text, which is the whole argument for both halves of this file: the
 * image is a large part of what was actually said, and the only way to know
 * what it says is to look at it.
 *
 * One item per media object, not per post: a post with four photos is four
 * things to look at. Ordered by the reach of the post it hangs off, so a cap
 * drops the long tail rather than whatever happened to be first.
 */

export interface CardMediaItem {
  /**
   * m1, m2… — how a vision claim names the image it read. The model never
   * sees a URL or a post ID, so it cannot cite one it wasn't shown; we map the
   * ref back to the post on this side.
   */
  ref: string;
  postId: string;
  handle: string;
  /** what the poster wrote alongside it — context, and the thing vision adds to */
  text: string;
  kind: "photo" | "video" | "animated_gif";
  /** for video this is the preview frame. We never autoplay. */
  url: string;
  alt?: string;
  /** intrinsic pixels, straight from the X API */
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Six images is ~7s and ~$0.04 through vision. Past that it's a contact sheet. */
export const MEDIA_CAP = 6;

/**
 * Too small to be worth the space it would take.
 *
 * X serves link-preview thumbnails alongside real photographs, and a 176px
 * image blown up to fill a 268px card frame is a blurry rectangle that says
 * nothing — the card is better off without it. Only applied when we actually
 * know the size: snapshots written before width/height were requested must
 * keep rendering rather than silently going blank.
 */
const MIN_DIMENSION = 240;

function bigEnough(m: { width?: number; height?: number }) {
  if (!m.width || !m.height) return true;
  return Math.min(m.width, m.height) >= MIN_DIMENSION;
}

/**
 * The frame's shape, decided before the bytes arrive.
 *
 * Knowing the intrinsic size is what lets media be laid out to its own shape
 * AND stay deterministic: the box is final on first paint, so the DOM
 * measurement that feeds the band layout is right immediately and nothing
 * reflows when the image loads.
 *
 * Clamped, because the true ratio isn't always a good card. A real timeline
 * read spanned 0.56 (portrait video) to 3.15 (wide banner): unclamped, the
 * first eats 480px of column and the second is a letterbox slit. The bounds
 * cost a modest centre-crop at the extremes and keep every card a card.
 */
const MIN_ASPECT = 1.25;
const MAX_ASPECT = 1.91; // X's own upper bound for photos
const DEFAULT_ASPECT = 16 / 9;

export function frameAspect(m: { width?: number; height?: number }): number {
  if (!m.width || !m.height) return DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, m.width / m.height));
}

/** "5:22" — a 30-second clip and a five-minute talk are different things. */
export function formatDuration(ms?: number): string | undefined {
  if (!ms || ms < 1000) return undefined;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function reach(p: XPost) {
  return (p.metrics?.likes ?? 0) + (p.metrics?.reposts ?? 0);
}

export function mediaFromPosts(
  posts: XPost[],
  cap = MEDIA_CAP,
  /** URLs to leave out — the caller has already shown them somewhere */
  exclude?: ReadonlySet<string>,
): CardMediaItem[] {
  const out: CardMediaItem[] = [];
  const seen = new Set<string>();
  for (const p of [...posts].sort((a, b) => reach(b) - reach(a))) {
    for (const m of p.media ?? []) {
      // exclusion and dedupe happen BEFORE the ref is minted, so refs are
      // always m1..mN with no holes — the model is told to answer with one of
      // them and a gap is an invitation to invent
      if (!m.url || seen.has(m.url) || exclude?.has(m.url)) continue;
      if (!bigEnough(m)) continue;
      seen.add(m.url);
      out.push({
        ref: `m${out.length + 1}`,
        postId: p.id,
        handle: p.author.handle,
        text: p.text.replace(/\s+/g, " ").slice(0, 200),
        kind: m.kind,
        url: m.url,
        alt: m.alt,
        width: m.width,
        height: m.height,
        durationMs: m.duration_ms,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * What a card should show.
 *
 * Two rules, and the second is the interesting one.
 *
 * A vision child owns exactly one image — the one the model read — and that
 * image IS the card's subject, so it wins outright, ancestors included. That
 * exception is deliberate: a reading of a picture has to sit next to the
 * picture, or you can't check it. It is the ONE place a repeat earns its space.
 *
 * Every other card shows the media of the posts it cites, MINUS anything an
 * ancestor is already showing. A child usually cites its parent's posts, so
 * without this a single screenshot rendered on the topic AND on each claim
 * under it, three copies in one viewport. That's the same failure novelty
 * already guards against in the text — the board repeating itself as you go
 * deeper — and it deserves the same answer: the picture is shown where you
 * first meet it, and again only where it is the subject.
 *
 * Generated images are not handled here; those are an options-board concern
 * and carry a prompt rather than a retrieved URL (see OptionImage).
 */
/**
 * Memoised per board object.
 *
 * computeLayout asks for this for EVERY card on every relayout, and a naive
 * ancestor walk re-derives each ancestor's media from scratch — which is
 * exponential in depth, at a depth cap of 8, on the hot path of a 60fps zoom.
 * Boards are replaced immutably on every merge, so keying the cache on the
 * board object gets correct invalidation for free.
 */
const memo = new WeakMap<Board, Map<string, CardMediaItem[]>>();

export function cardMedia(
  board: Board,
  node: BranchNode,
  cap = MEDIA_CAP,
): CardMediaItem[] {
  // only the default cap is cached; a caller asking for a different one is
  // asking a different question
  const cache = cap === MEDIA_CAP ? (memo.get(board) ?? new Map()) : null;
  if (cache) {
    memo.set(board, cache);
    const hit = cache.get(node.id);
    if (hit) return hit;
  }
  const out = computeCardMedia(board, node, cap);
  cache?.set(node.id, out);
  return out;
}

function computeCardMedia(
  board: Board,
  node: BranchNode,
  cap: number,
): CardMediaItem[] {
  const own = node.media;
  if (own?.url && (own.kind === "image" || own.kind === "video")) {
    const post = own.post_id ? board.posts[own.post_id] : undefined;
    return [
      {
        ref: "m1",
        postId: own.post_id ?? "",
        handle: post?.author.handle ?? "",
        text: post?.text ?? "",
        kind: own.kind === "video" ? "video" : "photo",
        url: own.url,
        alt: own.alt,
        width: own.width,
        height: own.height,
      },
    ];
  }

  const above = new Set<string>();
  // `seen` guards against a cycle in parent_id. The graph should be a tree and
  // a cycle would be a bug elsewhere — but the cost of one here is a hung tab
  // mid-demo, which is not a risk worth carrying for two lines.
  const seen = new Set<string>([node.id]);
  for (let p = node.parent_id ? board.nodes[node.parent_id] : undefined; p; ) {
    if (seen.has(p.id)) break;
    seen.add(p.id);
    for (const m of cardMedia(board, p, cap)) above.add(m.url);
    p = p.parent_id ? board.nodes[p.parent_id] : undefined;
  }

  const mine = node.source_post_ids.map((id) => board.posts[id]).filter(Boolean);
  return mediaFromPosts(mine, cap, above);
}

/**
 * Every image on this board that vision has already read.
 *
 * Two callers, one fact. The card needs it so "Read image" isn't offered on a
 * picture that has already been read from some other branch — the server will
 * refuse, and a button that reliably errors is worse than no button. The
 * request needs it because the server's own graph is only authoritative when
 * it happens to own this board.
 *
 * Memoised on the board object, which is replaced on every merge, so
 * invalidation is free.
 */
const readMemo = new WeakMap<Board, Set<string>>();

export function readMediaUrls(board: Board): Set<string> {
  const hit = readMemo.get(board);
  if (hit) return hit;
  const urls = new Set<string>();
  for (const n of Object.values(board.nodes)) {
    if (n.media?.url && n.media.vision_summary) urls.add(n.media.url);
  }
  readMemo.set(board, urls);
  return urls;
}

/**
 * Does the model's answer point at an image we actually showed it?
 *
 * A vision claim that cites nothing is a claim about an image nobody can check,
 * which is the same failure as a fabricated post URL wearing a different hat.
 */
export function resolveRef(items: CardMediaItem[], ref: string) {
  const want = String(ref ?? "").trim().toLowerCase();
  return items.find((m) => m.ref.toLowerCase() === want);
}

/**
 * Drop images the host will not serve.
 *
 * Measured against the live API: ONE unreachable URL fails the entire vision
 * request with a 400, taking every other image on the card with it. Media URLs
 * on a replayed snapshot are exactly the ones likely to have rotted, so a
 * cheap HEAD per image is the difference between a degraded answer and a dead
 * fork on stage.
 */
export async function reachableMedia(items: CardMediaItem[]): Promise<CardMediaItem[]> {
  const checked = await Promise.all(
    items.map(async (m) => {
      try {
        const res = await fetch(m.url, {
          method: "HEAD",
          signal: AbortSignal.timeout(4000),
          cache: "no-store",
        });
        return res.ok ? m : null;
      } catch {
        return null;
      }
    }),
  );
  // re-number so the refs handed to the model are contiguous
  return checked
    .filter((m): m is CardMediaItem => Boolean(m))
    .map((m, i) => ({ ...m, ref: `m${i + 1}` }));
}
