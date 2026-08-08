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

export const CARD_W = 300;
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
 * Deterministic height estimate. Deliberately not DOM-measured: the zoom needs a
 * stable layout that doesn't reflow mid-transition, and a card that changes
 * height while you're flying toward it reads as a bug.
 */
export function estimateCardHeight(node: BranchNode): number {
  const titleLines = Math.max(1, Math.ceil(node.title.length / 26));
  const bodyLines = node.body ? Math.max(1, Math.ceil(node.body.length / 46)) : 0;
  const titleH = titleLines * 25;
  const bodyH = bodyLines * 21;
  // Citations wrap, roughly two per row at CARD_W — reserve every row, or the
  // first paint of a heavily-sourced card jumps when the real height lands.
  // Upper bound only: the card dedupes to one chip per account and caps at 6,
  // so this over-reserves for repeat posters and the measurement corrects it.
  const chipRows = Math.ceil(Math.min(6, node.source_post_ids.length) / 2);
  const chipsH = chipRows ? chipRows * 24 + (chipRows - 1) * 6 + 8 : 0;
  const badgeH = node.epistemic ? 22 : 0;
  return 20 + titleH + (bodyH ? bodyH + 10 : 0) + chipsH + badgeH + 20;
}

function byPriority(a: BranchNode, b: BranchNode) {
  return b.priority - a.priority;
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

  const kidsOf = (node: BranchNode) =>
    node.children_ids
      .map((id) => board.nodes[id])
      .filter(Boolean)
      .sort(byPriority);

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
    const own = heights[node.id] ?? estimateCardHeight(node);
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

      if (isPending && kids.length === 0) {
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
  for (const root of board.root_ids
    .map((id) => board.nodes[id])
    .filter(Boolean)
    .sort(byPriority)) {
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
