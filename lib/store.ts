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
  ) => void;

  toggle: (id: string) => void;
  expand: (id: string) => void;
  collapse: (id: string) => void;
  setPending: (id: string, on: boolean) => void;
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
 * Keep a slab of the board on screen no matter how hard you fling it. Ancestors
 * are still free to clip off the left edge — that's the reference behaviour —
 * but you can never lose the board entirely, which on stage would be fatal.
 */
const KEEP_VISIBLE = 220;

function clampPan(
  pan: { x: number; y: number },
  s: { layout: Layout | null; zoom: number; viewport: { w: number; h: number } },
) {
  if (!s.layout) return pan;
  const w = s.layout.width * s.zoom;
  const h = s.layout.height * s.zoom;
  return {
    x: Math.min(s.viewport.w - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - w, pan.x)),
    y: Math.min(s.viewport.h - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - h, pan.y)),
  };
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

export const useBoard = create<BoardState>((set, get) => ({
  board: null,
  layout: null,
  expanded: new Set<string>(),
  pending: new Set<string>(),
  hoveredId: null,
  selectedId: null,
  errors: {},
  loadingRoots: false,
  rootsExhausted: false,

  zoom: DEFAULT_ZOOM,
  pan: { x: 0, y: 0 },
  viewport: { w: 1200, h: 800 },

  setBoard: (board) => {
    const expanded = new Set<string>();
    const pending = new Set<string>();
    set({ board, expanded, pending, layout: relayout(board, expanded, pending) });
  },

  mergeChildren: (parentId, children, posts, append = false, summary) => {
    const { board, expanded } = get();
    if (!board) return;

    const nodes = { ...board.nodes };
    const parent = nodes[parentId];
    if (!parent) return;

    for (const child of children) nodes[child.id] = child;
    // a trending root has no posts of its own; it adopts its children's
    // verified citations so every card on the board carries grounding
    nodes[parentId] = rollUpCitations(
      {
        ...parent,
        // a fork ADDS a branch alongside what's already open; it doesn't replace it
        children_ids: append
          ? [...parent.children_ids, ...children.map((c) => c.id)]
          : children.map((c) => c.id),
        body: parent.body || summary,
        has_children: true,
        updated_at: new Date().toISOString(),
      },
      children,
    );

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
  media: "Media",
  falsifiers: "What would change my mind",
};

export { MAX_ZOOM, MIN_ZOOM };
