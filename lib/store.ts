"use client";

import { create } from "zustand";
import type { Board, BranchNode, Fork } from "./schema";
import { computeLayout, type Layout } from "./layout";
import { rollUpCitations } from "./boardBuilder";
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, clamp, frameRect, zoomAbout } from "./lod";

interface BoardState {
  board: Board | null;
  layout: Layout | null;
  expanded: Set<string>;
  /** nodes currently being expanded by Grok */
  pending: Set<string>;
  hoveredId: string | null;
  selectedId: string | null;
  /** last expand failure per node — a silent failure looks identical to a dead card */
  errors: Record<string, string>;

  zoom: number;
  pan: { x: number; y: number };
  viewport: { w: number; h: number };

  setBoard: (b: Board) => void;
  mergeChildren: (
    parentId: string,
    children: BranchNode[],
    posts?: Board["posts"],
    append?: boolean,
    summary?: string,
    /** the dimension these children divide the parent along (options boards) */
    axis?: string,
  ) => void;
  /** a card generated its own picture — record it so it isn't fetched twice */
  setMedia: (nodeId: string, url: string) => void;

  toggle: (id: string) => void;
  expand: (id: string) => void;
  collapse: (id: string) => void;
  setPending: (id: string, on: boolean) => void;
  /** session telemetry — every retrieval, what it cost, where it came from */
  events: BoardEvent[];
  record: (e: BoardEvent) => void;

  /** loading more roots — the root column extends downward */
  loadingRoots: boolean;
  setLoadingRoots: (on: boolean) => void;
  appendRoots: (roots: BranchNode[], posts?: Board["posts"]) => void;
  rootsExhausted: boolean;
  setError: (id: string, message: string | null) => void;

  setHovered: (id: string | null) => void;
  select: (id: string) => void;

  setZoom: (z: number, focal?: { x: number; y: number }) => void;
  nudgeZoom: (delta: number, focal: { x: number; y: number }) => void;
  setPan: (p: { x: number; y: number }) => void;
  setViewport: (v: { w: number; h: number }) => void;
  focusNode: (id: string, targetZoom?: number) => void;
  resetView: () => void;
}

/**
 * Measured card heights. Estimating text height was leaving dead whitespace at
 * the bottom of every card, so we measure the real DOM once per layout change
 * and feed it back in. Measurement happens at layout scale (not screen scale),
 * so it stays stable while zooming — a card that resizes mid-flight reads as a
 * bug.
 */
const heights: Record<string, number> = {};
let flushQueued = false;

function relayout(
  board: Board | null,
  expanded: Set<string>,
  pending: Set<string> = new Set(),
): Layout | null {
  return board ? computeLayout(board, expanded, heights, pending) : null;
}

/**
 * The canvas pans freely, in every direction, without end.
 *
 * There used to be a clamp that kept a slab of the board on screen so you could
 * never fling it away entirely. It worked, but it tied how far you could travel
 * to the board's own size times the zoom — so the reachable distance changed
 * every time you zoomed, and a short board stopped dead after a couple of
 * hundred pixels. Nothing was ever unreachable, but "the canvas stops here, and
 * where here is depends on the zoom" is not a thing a canvas should do.
 *
 * Flying off into empty space is recoverable — 0 resets the view, and the TOC
 * jumps to any node — so the freedom costs nothing that a keystroke can't undo.
 */
function clampPan(
  pan: { x: number; y: number },
  _s: { layout: Layout | null; zoom: number; viewport: { w: number; h: number } },
) {
  return pan;
}

/**
 * Throw away a measured height so the estimate is used again for one frame.
 *
 * A trending root starts with no citations, so it draws no media frame, and
 * that media-less height gets measured and cached. Then its first expand rolls
 * its children's verified posts up onto it — and if any of them carries a
 * picture, the root suddenly has one. Because a measured height short-circuits
 * the estimate, the growth couldn't land until the ResizeObserver fired a
 * frame later, dropping a 200px hole into a column that had already started
 * animating. Forgetting the measurement makes the space appear on the SAME
 * frame as the children, which is the rule the skeletons already follow.
 */
export function forgetHeight(id: string) {
  delete heights[id];
}

export function reportHeight(id: string, h: number) {
  if (Math.abs((heights[id] ?? 0) - h) < 1.5) return;
  heights[id] = h;
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    const { board, expanded, pending } = useBoard.getState();
    useBoard.setState({ layout: relayout(board, expanded, pending) });
  });
}

/**
 * One retrieval, as it happened.
 *
 * The board already produces this signal on every call — which source answered,
 * how long it took, how many citations survived — and then drops it. Surfacing
 * it turns the demo from "trust me, it's grounded" into something a judge can
 * watch: you can SEE that a card came from the X API in 3s and cited four real
 * posts, rather than being told so.
 */
export interface BoardEvent {
  kind: "seed" | "expand" | "roots";
  /** which retrieval answered: x_grounded, x_search, x_replies, timeline… */
  source?: string;
  ms: number;
  /** X posts attached to the result */
  posts?: number;
  /** web sources attached */
  web?: number;
  cached?: boolean;
  error?: string;
  at: number;
}

export const useBoard = create<BoardState>((set, get) => ({
  board: null,
  layout: null,
  expanded: new Set<string>(),
  pending: new Set<string>(),
  hoveredId: null,
  selectedId: null,
  errors: {},
  events: [],
  loadingRoots: false,
  rootsExhausted: false,

  zoom: DEFAULT_ZOOM,
  pan: { x: 0, y: 0 },
  viewport: { w: 1200, h: 800 },

  setBoard: (board) => {
    const expanded = new Set<string>();
    const pending = new Set<string>();
    set({
      board,
      expanded,
      pending,
      layout: relayout(board, expanded, pending),
      /**
       * A new board is a new space, so the camera comes with it.
       *
       * Keeping the old pan parked a freshly-loaded board outside its own
       * clamp: switching from a tall board to a shorter one left pan.y already
       * at the new board's floor, so the first scroll moved nothing and the
       * cards sat shoved off the top edge. It reads as "the board is stuck",
       * which is indistinguishable from broken — and it isn't a clamp bug, it's
       * a stale viewpoint. ZoomSurface re-seats column 0 from pan {0,0}.
       */
      zoom: DEFAULT_ZOOM,
      pan: { x: 0, y: 0 },
    });
  },

  setMedia: (nodeId, url) => {
    const { board, expanded, pending } = get();
    const node = board?.nodes[nodeId];
    if (!board || !node?.media) return;
    const next: Board = {
      ...board,
      nodes: { ...board.nodes, [nodeId]: { ...node, media: { ...node.media, url } } },
    };
    set({ board: next, layout: relayout(next, expanded, pending) });
  },

  mergeChildren: (parentId, children, posts, append = false, summary, axis) => {
    const { board, expanded } = get();
    if (!board) return;

    const nodes = { ...board.nodes };
    const parent = nodes[parentId];
    if (!parent) return;

    // Order the arriving batch here, once. The layout renders children_ids in
    // order, so a fork appends BELOW what's already open instead of a
    // high-priority counter jumping above children you've read. Most server
    // paths already sort, but the ones that don't (media, replies) shouldn't
    // have to know that the column's order depends on it.
    const batch = [...children].sort((a, b) => b.priority - a.priority);
    for (const child of batch) nodes[child.id] = child;
    // a trending root has no posts of its own; it adopts its children's
    // verified citations so every card on the board carries grounding
    nodes[parentId] = rollUpCitations(
      {
        ...parent,
        /**
         * A fork ADDS a branch alongside what's already open; it doesn't
         * replace it. But a second click on the same fork is served from the
         * graph, and appending those ids again wired the same child in twice —
         * two identical cards, and React warning about duplicate keys. The
         * server-side cache was written to prevent exactly this and can't:
         * only the client knows what it already merged.
         */
        children_ids: append
          ? [
              ...parent.children_ids,
              ...batch
                .map((c) => c.id)
                .filter((id) => !parent.children_ids.includes(id)),
            ]
          : batch.map((c) => c.id),
        body: parent.body || summary,
        axis: axis ?? parent.axis,
        has_children: true,
        updated_at: new Date().toISOString(),
      },
      batch,
    );

    // rollUpCitations may have just given this card its first citations — and
    // with them its first picture. Its measured height predates both, so drop
    // it and let the estimate reserve the frame on THIS frame. See forgetHeight.
    if (nodes[parentId].source_post_ids.length !== parent.source_post_ids.length) {
      forgetHeight(parentId);
    }

    const next: Board = {
      ...board,
      nodes,
      posts: posts ? { ...board.posts, ...posts } : board.posts,
    };
    set({ board: next, layout: relayout(next, expanded, get().pending) });
  },

  toggle: (id) => {
    const { expanded } = get();
    (expanded.has(id) ? get().collapse : get().expand)(id);
  },

  expand: (id) => {
    const { board, expanded } = get();
    const next = new Set(expanded);
    next.add(id);
    set({ expanded: next, layout: relayout(board, next, get().pending), selectedId: id });
  },

  collapse: (id) => {
    const { board, expanded } = get();
    if (!board) return;
    const next = new Set(expanded);
    // collapsing a node collapses everything beneath it — collapse is
    // first-class, and leaving orphaned open descendants is how you get spaghetti
    const drop = (nodeId: string) => {
      next.delete(nodeId);
      for (const kid of board.nodes[nodeId]?.children_ids ?? []) drop(kid);
    };
    drop(id);
    set({ expanded: next, layout: relayout(board, next, get().pending) });
  },

  setPending: (id, on) => {
    const { board, expanded } = get();
    const pending = new Set(get().pending);
    if (on) pending.add(id);
    else pending.delete(id);
    // relayout immediately: the skeleton column has to appear on the same
    // frame as the click, otherwise the click feels like it did nothing
    set({ pending, layout: relayout(board, expanded, pending) });
  },

  setError: (id, message) => {
    const errors = { ...get().errors };
    if (message) errors[id] = message;
    else delete errors[id];
    set({ errors });
  },

  record: (e) => set({ events: [...get().events, e].slice(-60) }),

  setLoadingRoots: (loadingRoots) => set({ loadingRoots }),

  appendRoots: (roots, posts) => {
    const { board, expanded, pending } = get();
    if (!board || !roots.length) return;
    const nodes = { ...board.nodes };
    for (const r of roots) nodes[r.id] = r;
    const next: Board = {
      ...board,
      nodes,
      posts: posts ? { ...board.posts, ...posts } : board.posts,
      root_ids: [...board.root_ids, ...roots.map((r) => r.id)],
    };
    set({ board: next, layout: relayout(next, expanded, pending) });
  },

  setHovered: (hoveredId) => set({ hoveredId }),
  select: (selectedId) => set({ selectedId }),

  setZoom: (z, focal) => {
    const { zoom, pan, viewport } = get();
    const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const f = focal ?? { x: viewport.w / 2, y: viewport.h / 2 };
    const s = { ...get(), zoom: next };
    set({ zoom: next, pan: clampPan(zoomAbout(pan, zoom, next, f), s) });
  },

  nudgeZoom: (delta, focal) => {
    // multiplicative so the ramp feels even across the whole range
    get().setZoom(get().zoom * Math.exp(-delta * 0.0016), focal);
  },

  setPan: (pan) => set({ pan: clampPan(pan, get()) }),
  setViewport: (viewport) => set({ viewport }),

  focusNode: (id, targetZoom = 1.15) => {
    const { layout, viewport } = get();
    const card = layout?.byId[id];
    if (!card) return;
    const { zoom, pan } = frameRect(card, viewport, targetZoom);
    set({ zoom, pan, selectedId: id });
  },

  resetView: () => set({ zoom: DEFAULT_ZOOM, pan: { x: 0, y: 0 } }),
}));

export const EPISTEMIC_LABEL: Record<string, string> = {
  widely_shared: "widely shared",
  contested: "contested",
  note_flagged: "note flagged",
  thin_evidence: "thin evidence",
  projection: "projection",
};

export const FORK_LABEL: Record<Fork, string> = {
  deeper: "Deeper",
  replies: "Replies",
  counter: "Counters",
  primary_only: "Primary only",
  people: "People",
  // a model read the picture — say so, the same way a generated image is
  // marked. Nobody should have to guess which cards came from looking.
  media: "Vision",
  falsifiers: "What would change my mind",
};

export { MAX_ZOOM, MIN_ZOOM };
