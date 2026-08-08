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
/** padding inside the rounded track that sits behind a column */
export const TRACK_PAD = 18;
export const TOP_PAD = 88;
export const LEFT_PAD = 56;

export interface PositionedCard {
  node: BranchNode;
  x: number;
  y: number;
  w: number;
  /** rendered height — an expanded parent stretches to cover its whole subtree */
  h: number;
  /** vertical extent this node's entire subtree occupies */
  band: number;
  col: number;
  expanded: boolean;
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
  const chipsH = node.source_post_ids.length > 0 ? 30 : 0;
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
 * An expanded parent also stretches to its band height, so its surface visibly
 * contains everything it opened.
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
  const byId: Record<string, PositionedCard> = {};

  const kidsOf = (node: BranchNode) =>
    node.children_ids
      .map((id) => board.nodes[id])
      .filter(Boolean)
      .sort(byPriority);

  /** Places `node` with its top at `top`; returns the band height it consumed. */
  const place = (node: BranchNode, depth: number, top: number): number => {
    const own = heights[node.id] ?? estimateCardHeight(node);
    const isPending = pending.has(node.id);
    const isOpen = expanded.has(node.id) || isPending;
    const childX = LEFT_PAD + (depth + 1) * (CARD_W + COL_GAP);

    let childrenExtent = 0;
    // hard depth stop: spaghetti is a product bug (doc §3.4)
    if (isOpen && depth < 8) {
      const kids = kidsOf(node);
      let cursor = top;

      if (isPending && kids.length === 0) {
        // Reserve the band NOW, before Grok answers. The parent stretches and
        // the siblings below drop immediately, so when real text lands it
        // fills space that was already made for it — no jump, no reflow.
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
      } else {
        for (const kid of kids) {
          cursor += place(kid, depth + 1, cursor) + CARD_GAP;
        }
        if (kids.length) childrenExtent = cursor - CARD_GAP - top;
      }
    }

    const band = Math.max(own, childrenExtent);
    const card: PositionedCard = {
      node,
      x: LEFT_PAD + depth * (CARD_W + COL_GAP),
      y: top,
      w: CARD_W,
      // an open parent grows to contain its subtree
      h: isOpen && childrenExtent > own ? band : own,
      band,
      col: depth,
      expanded: isOpen,
    };
    cards.push(card);
    byId[node.id] = card;
    return band;
  };

  let cursor = TOP_PAD;
  for (const root of board.root_ids
    .map((id) => board.nodes[id])
    .filter(Boolean)
    .sort(byPriority)) {
    cursor += place(root, 0, cursor) + CARD_GAP;
  }

  const boxes = [...cards, ...skeletons];
  const width = boxes.reduce((m, c) => Math.max(m, c.x + c.w), 0) + LEFT_PAD;
  const height = boxes.reduce((m, c) => Math.max(m, c.y + c.h), 0) + TOP_PAD;

  return { cards, skeletons, byId, width, height };
}

/** Where the hover ghost sits: one column right, aligned to the hovered card. */
export function ghostSlot(card: PositionedCard): { x: number; y: number; w: number } {
  return { x: card.x + CARD_W + COL_GAP, y: card.y, w: CARD_W };
}
