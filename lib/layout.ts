import { cardMedia, frameAspect } from "./media";
import type { Board, BranchNode } from "./schema";

/**
 * Column layout.
 *
 * The two screen axes ARE the two data axes (design doc §3.3):
 *   x = column index = depth = generality   (general -> specific, left -> right)
 *   y = order within column = priority      (high -> low, top -> bottom)
 *
 * There is no separate "priority plane" view. Zooming out IS that view.
 */

export const CARD_W = 540;
/** px-4 on .gb-card, both sides — the only thing between CARD_W and text width */
const CARD_PAD = 16;
const INNER_W = CARD_W - CARD_PAD * 2;
export const COL_GAP = 44;
export const CARD_GAP = 26;
export const TOP_PAD = 88;
export const LEFT_PAD = 56;
/** breathing room between a track's edge and the cards it encloses */
export const TRACK_PAD = 16;

export interface PositionedCard {
  node: BranchNode;
  x: number;
  y: number;
  w: number;
  /** rendered height — always the card's own content height */
  h: number;
  /** vertical extent this node's entire subtree occupies */
  band: number;
  col: number;
  expanded: boolean;
}

/**
 * The containment slab drawn behind an open node AND its whole subtree.
 *
 * This is the parent link. The board previously implied it by stretching the
 * parent card down over its band, which produced a 600px card with 130px of
 * text in it — read as "giant empty box", not "this contains those". A slab
 * states the relationship directly and lets the card go back to its own size.
 */
export interface TrackBox {
  key: string;
  nodeId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** nesting level — deeper slabs sit brighter and on top */
  depth: number;
}

/** A child that Grok is still writing. Occupies real space so nothing jumps. */
export interface SkeletonBox {
  key: string;
  parentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** how many body lines to draw — varied so it doesn't look like a grid */
  lines: number;
}

export interface Layout {
  cards: PositionedCard[];
  skeletons: SkeletonBox[];
  /** shallowest first, so deeper slabs paint on top of their ancestors */
  tracks: TrackBox[];
  byId: Record<string, PositionedCard>;
  width: number;
  height: number;
}

/** Heights we reserve per pending child, roughly matching real card sizes. */
const SKELETON_SHAPES = [
  { h: 224, lines: 5 },
  { h: 196, lines: 4 },
  { h: 236, lines: 6 },
];

/**
 * An ask reserves NOTHING out here.
 *
 * A fork spends the wait building a column, so skeletons one column right are
 * an honest forecast of where its output lands. An ask's output lands on the
 * question card ITSELF — the reply is that card's body — so previewing it in
 * the next column pointed at a plot that stays empty, and the pan that flew you
 * there left you looking away from the card the answer was about to fill.
 *
 * The wait is drawn inside the question card instead (BranchCard, `pending`),
 * which is both where the answer arrives and where the space for it has to be
 * reserved. Grok may still add a single evidence card beside it, but that is a
 * separate finding it usually doesn't have — not the answer — so it arrives on
 * its own rather than being promised in advance.
 *
 * A question asked of the BOARD is the exception, and keeps its skeletons: it
 * has no card to answer onto, so its whole result IS the column of topics under
 * it (see askAgent's `parent: null`). There the forecast is honest.
 */
const asksInPlace = (node: BranchNode) =>
  node.fork === "ask" && node.parent_id !== null;

/**
 * Deterministic height estimate. Deliberately not DOM-measured: the zoom needs a
 * stable layout that doesn't reflow mid-transition, and a card that changes
 * height while you're flying toward it reads as a bug.
 */
export function estimateCardHeight(
  node: BranchNode,
  /** aspect ratio of the media frame this card will draw, if any */
  mediaAspect?: number,
): number {
  // Chars per line comes from the measured average glyph width at each size
  // (17px title, 13px body), so the estimate follows CARD_W instead of being
  // silently wrong the next time the column gets wider.
  const titlePerLine = INNER_W / 10.3;
  const bodyPerLine = INNER_W / 5.83;
  const titleLines = Math.max(1, Math.ceil(node.title.length / titlePerLine));
  const bodyLines = node.body ? Math.max(1, Math.ceil(node.body.length / bodyPerLine)) : 0;
  const titleH = titleLines * 25;
  const bodyH = bodyLines * 21;
  // Citations wrap — reserve every row, or the first paint of a heavily-sourced
  // card jumps when the real height lands. A chip is ~130px with its gap, so how
  // many fit is a function of CARD_W, not the 2 it happened to be at 300px.
  // Upper bound only: the card dedupes to one chip per account and caps at 6,
  // so this over-reserves for repeat posters and the measurement corrects it.
  const chipsPerRow = Math.max(1, Math.floor(INNER_W / 130));
  const chipRows = Math.ceil(Math.min(6, node.source_post_ids.length) / chipsPerRow);
  const chipsH = chipRows ? chipRows * 24 + (chipRows - 1) * 6 + 8 : 0;
  const badgeH = node.epistemic ? 22 : 0;
  // The media frame at the card's inner width, plus its top margin. Exact
  // rather than approximate, because it can be: the aspect ratio comes from
  // the X API, so CardMedia's box never depends on the bytes arriving.
  const mediaH = mediaAspect ? Math.round(INNER_W / mediaAspect) + 12 : 0;
  return 20 + titleH + (bodyH ? bodyH + 10 : 0) + mediaH + chipsH + badgeH + 20;
}

/**
 * The shape of the frame this card will actually draw, or undefined for none.
 *
 * Asking cardMedia rather than re-deriving it is the only way the estimate and
 * the measurement can't disagree — and a disagreement here is a 200px hole
 * punched into a column that has already animated in.
 */
function mediaAspectOf(board: Board, node: BranchNode): number | undefined {
  const hero = cardMedia(board, node)[0];
  return hero ? frameAspect(hero) : undefined;
}

/**
 * Band layout.
 *
 * A node's subtree owns a horizontal BAND of the canvas. Children start level
 * with their parent and stack downward; the parent's next sibling begins below
 * that entire block, not below the parent card. This is what the reference
 * does, and it's what makes the board read as organised instead of as cards
 * that happen to be near each other.
 *
 * An open node's whole band is then wrapped in a TrackBox — the slab that
 * makes "these belong to that" explicit instead of merely implied by adjacency.
 */
export function computeLayout(
  board: Board,
  expanded: ReadonlySet<string>,
  /** real measured card heights, keyed by node id; falls back to the estimate */
  heights: Readonly<Record<string, number>> = {},
  /** nodes Grok is currently expanding — they get skeleton children */
  pending: ReadonlySet<string> = new Set(),
): Layout {
  const cards: PositionedCard[] = [];
  const skeletons: SkeletonBox[] = [];
  const tracks: TrackBox[] = [];
  const byId: Record<string, PositionedCard> = {};

  // children_ids order is authoritative, for the same reason root_ids is (see
  // below): a fork ADDS a branch to a node that may already be open, and
  // re-sorting the whole column by priority let a fresh counter land above
  // children you had already read. Each batch is ordered when it's merged.
  const kidsOf = (node: BranchNode) =>
    node.children_ids.map((id) => board.nodes[id]).filter(Boolean);

  /**
   * Places `node` with its top at `top`. Returns the band height it consumed
   * and the rightmost edge anything in its subtree reached — the track needs
   * both to enclose the whole family.
   */
  const place = (
    node: BranchNode,
    depth: number,
    top: number,
  ): { band: number; right: number } => {
    // Reserve the picture's space in the ESTIMATE too. The measurement lands a
    // frame later and would otherwise drop a 150px hole into a column that had
    // already animated in — the one way media could still thrash the bands.
    const own =
      heights[node.id] ?? estimateCardHeight(node, mediaAspectOf(board, node));
    const isPending = pending.has(node.id);
    const isOpen = expanded.has(node.id) || isPending;
    const x = LEFT_PAD + depth * (CARD_W + COL_GAP);
    const childX = LEFT_PAD + (depth + 1) * (CARD_W + COL_GAP);

    let childrenExtent = 0;
    let right = x + CARD_W;

    // hard depth stop: spaghetti is a product bug (doc §3.4)
    if (isOpen && depth < 8) {
      const kids = kidsOf(node);
      let cursor = top;

      if (isPending && kids.length === 0 && !asksInPlace(node)) {
        // Reserve the band NOW, before Grok answers. The siblings below drop
        // immediately, so when real text lands it fills space that was already
        // made for it — no jump, no reflow.
        SKELETON_SHAPES.forEach((shape, i) => {
          skeletons.push({
            key: `${node.id}:skel:${i}`,
            parentId: node.id,
            x: childX,
            y: cursor,
            w: CARD_W,
            h: shape.h,
            lines: shape.lines,
          });
          cursor += shape.h + CARD_GAP;
        });
        childrenExtent = cursor - CARD_GAP - top;
        right = Math.max(right, childX + CARD_W);
      } else {
        for (const kid of kids) {
          const sub = place(kid, depth + 1, cursor);
          cursor += sub.band + CARD_GAP;
          right = Math.max(right, sub.right);
        }
        if (kids.length) childrenExtent = cursor - CARD_GAP - top;
      }
    }

    const band = Math.max(own, childrenExtent);
    const card: PositionedCard = {
      node,
      x,
      y: top,
      w: CARD_W,
      // The card is its own size, always. Containment is the track's job now;
      // stretching the card to its band was what produced the empty boxes.
      h: own,
      band,
      col: depth,
      expanded: isOpen,
    };
    cards.push(card);
    byId[node.id] = card;

    // Only draw a slab where there is actually a family to enclose.
    if (isOpen && childrenExtent > 0) {
      tracks.push({
        key: `${node.id}:track`,
        nodeId: node.id,
        x: x - TRACK_PAD,
        y: top - TRACK_PAD,
        w: right + TRACK_PAD - (x - TRACK_PAD),
        h: band + TRACK_PAD * 2,
        depth,
      });
    }

    return { band, right };
  };

  let cursor = TOP_PAD;
  // root_ids order is authoritative — the list is APPENDED to, by "more of your
  // day". Re-sorting by priority here scored each batch against the whole
  // column, so a fresh root with a high score landed in the middle of roots you
  // had already read and shoved everything below it down. Order is decided once,
  // when a root enters the board (buildBoard/buildBoardFromTrends sort their own
  // batch); after that the column only ever grows downward. It's also what makes
  // "trends first, then your timeline" in /api/seed actually hold.
  for (const root of board.root_ids.map((id) => board.nodes[id]).filter(Boolean)) {
    cursor += place(root, 0, cursor).band + CARD_GAP;
  }

  // Recursion emits children before parents; painting order has to be the
  // reverse or an ancestor's slab would cover every slab nested inside it.
  tracks.sort((a, b) => a.depth - b.depth);

  const boxes = [...cards, ...skeletons, ...tracks];
  const width = boxes.reduce((m, c) => Math.max(m, c.x + c.w), 0) + LEFT_PAD;
  const height = boxes.reduce((m, c) => Math.max(m, c.y + c.h), 0) + TOP_PAD;

  return { cards, skeletons, tracks, byId, width, height };
}

/** Where the hover ghost sits: one column right, aligned to the hovered card. */
export function ghostSlot(card: PositionedCard): { x: number; y: number; w: number } {
  return { x: card.x + CARD_W + COL_GAP, y: card.y, w: CARD_W };
}

/**
 * The foot of the root column — where column 0 carries on below the last root.
 *
 * Two affordances live down here (the board-level ask, then "more of your
 * day"), and both need this number, so it is derived once from the layout
 * rather than recomputed at each call site.
 */
export function rootFootY(layout: Layout): number {
  return (
    layout.cards
      .filter((c) => c.col === 0)
      .reduce((m, c) => Math.max(m, c.y + c.h), 0) + CARD_GAP
  );
}

/**
 * How tall the board-level ask plot is, fixed.
 *
 * Every other card here is measured, because its height is whatever its text
 * turned out to be. This one is a plot, not a card: "more of your day" is
 * stacked directly beneath it, so a box that grew on focus would shove that
 * button out from under the cursor mid-click. The component sets this height
 * explicitly rather than growing into it, which makes the constant true by
 * construction instead of an estimate that can drift.
 */
export const ROOT_ASK_H = 142;

/**
 * Where a question asked of the BOARD is typed, and where its answer lands.
 *
 * Same principle as ghostSlot: you write the question in the plot the card is
 * about to occupy. The difference is only which column that is — a question
 * asked of a card grows a child one column right, a question asked of the board
 * grows a root at the bottom of column 0.
 */
export function rootAskSlot(layout: Layout): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return { x: LEFT_PAD, y: rootFootY(layout), w: CARD_W, h: ROOT_ASK_H };
}
