"use client";

import { create } from "zustand";
import type { Board, BranchNode, Fork } from "./schema";
import { computeLayout, type Layout } from "./layout";
import { rollUpCitations } from "./boardBuilder";
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, clamp, frameRect, zoomAbout } from "./lod";

export type BoardKind = "news" | "options";

/** A news board predates the field, so an absent kind is the news board. */
export function boardKind(board: Board): BoardKind {
  return board.kind ?? "news";
}

/**
 * A board you looked away from, whole.
 *
 * Everything here is session, not file: which columns you opened, what you
 * asked, where the camera is. None of it survives a re-read off disk, which is
 * why looking away used to cost it.
 */
interface Stashed {
  board: Board;
  expanded: Set<string>;
  selectedId: string | null;
  errors: Record<string, string>;
  zoom: number;
  pan: { x: number; y: number };
  rootsExhausted: boolean;
}

type Stash = Partial<Record<BoardKind, Stashed>>;

function without(stash: Stash, kind: BoardKind): Stash {
  const next = { ...stash };
  delete next[kind];
  return next;
}

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
  /**
   * The boards you stepped away from, one per kind, whole.
   *
   * Flipping tabs used to re-read the other kind's snapshot off disk. That is
   * right for a board you have never opened and wrong for one you have: the
   * columns you expanded, the questions you asked and the pictures Grok drew
   * came from the session, not the file, so the disk read handed back a board
   * you had never seen and called it yours. Looking away is not starting over.
   * The only things that start a board over are the buttons that say so.
   */
  stash: Stash;
  /** set the board on screen aside under its own kind, keeping all of it */
  stashCurrent: () => void;
  /** put a stashed board back exactly as it was; false if there isn't one */
  restoreKind: (kind: BoardKind) => boolean;
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

  /**
   * The card whose ghost slot is currently a question box, if any.
   *
   * Only ever one: the composer occupies the slot where that card's children
   * will land, and two open at once would be two cards claiming one piece of
   * canvas. Opening a second closes the first.
   */
  asking: string | null;
  startAsk: (nodeId: string) => void;
  cancelAsk: () => void;
  /**
   * Mint a question node under `parentId` and graft it in immediately.
   *
   * Returns the new node so the caller can expand it. This happens BEFORE the
   * request goes out: the question is the user's own words, so there is nothing
   * to wait for and nothing a server could add. The card is on screen in the
   * slot they typed into on the next frame, and the answer fills in underneath
   * it — the board's "never open on a spinner" rule applied to asking.
   *
   * `parentId: null` asks the BOARD rather than a card, and the question
   * becomes a root. Nothing else about the node changes — it is the same
   * question card, on the same "ask" fork, answered by the same agent — so a
   * question that spawns a topic and a question that spawns a claim are one
   * mechanism seen from two columns.
   */
  addQuestion: (parentId: string | null, question: string) => BranchNode | null;
  /**
   * Put the cursor in the board-level ask plot.
   *
   * A nonce rather than a boolean: pressing @ twice in a row should focus twice,
   * and a flag that is already true is indistinguishable from one nobody set.
   * The plot owns its own text, so there is no question state to hold here.
   */
  rootAskFocus: number;
  focusRootAsk: () => void;
  /**
   * Attach an answer's own citations to the question card.
   *
   * Every other node gets its citations from its children rolling up. A
   * question card can't rely on that, because the good outcome for an ask is
   * often a straight answer and NO cards — and an uncited answer sitting alone
   * on the board is exactly what the epistemic layer exists to prevent. So the
   * answer carries its own sources, like an @grok reply on X does.
   *
   * `grounded: false` means nothing stood behind it at all, which is allowed
   * (asking always answers) but must be visible — thin_evidence is what that
   * already means everywhere else here.
   */
  applyAnswer: (
    nodeId: string,
    a: {
      postIds?: string[];
      web?: { url: string; title: string; siteName?: string }[];
      grounded?: boolean;
      /**
       * A picture for the answer itself, when Grok asked for one.
       *
       * Only ever set on a decision board, where seeing the thing is half the
       * point of a card. It arrives as a PROMPT and no bytes, exactly as an
       * option's does — the card requests its own image once it's on screen, so
       * a 7.6s generation never sits inside the wait for the answer.
       */
      imagePrompt?: string;
    },
  ) => void;

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
  stash: {},

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
      /**
       * ...and so does what's left to read.
       *
       * "Exhausted" is a fact about one board's remaining roots, and it hides
       * the affordance outright. Carried across a switch it hid "More
       * directions" on a brand-new decision board because a news board had run
       * out of trends earlier in the session — a dead-looking column with no
       * way to tell it wasn't broken.
       */
      rootsExhausted: false,
      loadingRoots: false,
      /**
       * ...and so does what you had hold of.
       *
       * A selection, a hover and an open ask box are all ids, and an id from
       * the board you just left names nothing on this one — a TOC row lit for
       * a card that isn't here, or a question box parked in an empty slot.
       */
      selectedId: null,
      hoveredId: null,
      asking: null,
      errors: {},
      /**
       * The copy we were holding of this kind is now the stale one.
       *
       * This is the reset: asking for a board by name — reseed, load snapshot,
       * three options — is the user saying they want THIS one, so the version
       * they set aside earlier must not come back the next time they flip.
       */
      stash: without(get().stash, boardKind(board)),
    });
  },

  stashCurrent: () => {
    const { board, expanded, selectedId, errors, zoom, pan, rootsExhausted, stash } =
      get();
    if (!board) return;
    set({
      stash: {
        ...stash,
        [boardKind(board)]: {
          board,
          expanded,
          selectedId,
          errors,
          zoom,
          pan,
          rootsExhausted,
        },
      },
    });
  },

  restoreKind: (kind) => {
    const held = get().stash[kind];
    if (!held) return false;
    set({
      board: held.board,
      expanded: held.expanded,
      selectedId: held.selectedId,
      errors: held.errors,
      zoom: held.zoom,
      pan: held.pan,
      rootsExhausted: held.rootsExhausted,
      layout: relayout(held.board, held.expanded),
      /**
       * Everything else comes back empty, and `pending` is the one that
       * matters. An expand still in flight when you looked away either landed
       * on a board that no longer held its parent — mergeChildren dropped it —
       * or is still running and will merge when it returns. Either way the id
       * is not a wait any longer, and restoring it would draw a skeleton
       * column with nothing coming to fill it.
       */
      pending: new Set<string>(),
      hoveredId: null,
      asking: null,
      loadingRoots: false,
      // it is on screen; it is not also set aside
      stash: without(get().stash, kind),
    });
    return true;
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

  asking: null,
  startAsk: (nodeId) => set({ asking: nodeId, selectedId: nodeId }),
  cancelAsk: () => set({ asking: null }),

  rootAskFocus: 0,
  focusRootAsk: () => set((s) => ({ rootAskFocus: s.rootAskFocus + 1 })),

  addQuestion: (parentId, question) => {
    const { board, expanded } = get();
    const parent = parentId ? board?.nodes[parentId] : null;
    // a card ask needs its card; a board ask needs only the board
    if (!board || (parentId && !parent)) return null;

    const now = new Date().toISOString();
    const q: BranchNode = {
      // minted here rather than server-side, unlike every other node, because
      // nothing about a question needs a round trip — the user already wrote it
      id: `ask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type: "fork",
      title: question,
      parent_id: parentId,
      children_ids: [],
      // sits above that card's other children: you asked it last, so it is the
      // thing you are looking at
      priority: 1,
      /**
       * A question asked of the board is as general as the board gets.
       *
       * Column index IS generality (doc §3.3), so a root has to read as 1 or
       * the axis stops meaning anything at the left edge — and its answers,
       * clamped to parent - 0.05 by childrenToNodes, then land in column 1
       * exactly where a trend's stories do.
       */
      generality: parent ? Math.max(0, parent.generality - 0.05) : 1,
      depth: parent ? parent.depth + 1 : 0,
      /**
       * A question cites nothing.
       *
       * It is not a claim, so there is nothing for it to be grounded in — the
       * same reason an option carries attributes instead of an epistemic
       * status. Its ANSWERS carry the citations, and roll up onto it from
       * below like any other parent.
       */
      source_post_ids: [],
      has_children: true,
      fork: "ask",
      created_at: now,
      updated_at: now,
    };

    const nodes = {
      ...board.nodes,
      [q.id]: q,
      ...(parent && parentId
        ? {
            [parentId]: {
              ...parent,
              children_ids: [...parent.children_ids, q.id],
              has_children: true,
              updated_at: now,
            },
          }
        : {}),
    };
    /**
     * A board question joins root_ids, and only ever at the end.
     *
     * Same rule the layout states for "more of your day": the root column is
     * appended to, never re-sorted, because a question inserted above roots
     * the user had already read would shove the whole board down under their
     * cursor. You asked it last, so it is last.
     */
    const rootIds = parentId ? board.root_ids : [...board.root_ids, q.id];
    // open the parent so the question card it just grew is visible. The
    // question is opened too, for the evidence card Grok may hang off it —
    // its own wait is drawn inside it now, not as a column beneath it.
    const next = new Set(expanded);
    if (parentId) next.add(parentId);
    next.add(q.id);
    const nextBoard = { ...board, nodes, root_ids: rootIds };
    set({
      board: nextBoard,
      expanded: next,
      asking: null,
      selectedId: q.id,
      layout: relayout(nextBoard, next, get().pending),
    });
    return q;
  },

  applyAnswer: (nodeId, a) => {
    const { board, expanded } = get();
    const n = board?.nodes[nodeId];
    if (!board || !n) return;
    const postIds = (a.postIds ?? []).filter((id) => board.posts[id]);
    const next: Board = {
      ...board,
      nodes: {
        ...board.nodes,
        [nodeId]: {
          ...n,
          // union, because children rolling up may already have contributed —
          // and a chip rendered twice is a duplicate React key
          source_post_ids: [...new Set([...n.source_post_ids, ...postIds])],
          source_urls_meta: a.web?.length
            ? [
                ...new Map(
                  [...(n.source_urls_meta ?? []), ...a.web].map((w) => [w.url, w]),
                ).values(),
              ]
            : n.source_urls_meta,
          epistemic: a.grounded === false ? "thin_evidence" : n.epistemic,
          /**
           * A prompt and no url: the card fetches its own bytes.
           *
           * Never overwrites a picture the card already has — on a decision
           * board a re-asked question could otherwise swap the image out from
           * under a card the user is looking at, and the old one is already
           * paid for and on disk.
           */
          media:
            a.imagePrompt && !n.media
              ? { kind: "generated_image" as const, alt: a.imagePrompt }
              : n.media,
        },
      },
    };
    // the card just grew a citation row (and possibly a picture with it), so
    // its measured height predates its content — see forgetHeight
    forgetHeight(nodeId);
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
  // An answer's provenance is the question, and the question is right there on
  // the parent card — so the badge says how it was found, not what was asked.
  ask: "Asked",
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
