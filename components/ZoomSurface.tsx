"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useBoard } from "@/lib/store";
import { lodFor, clamp, frameRect } from "@/lib/lod";
import { CARD_GAP, CARD_W, COL_GAP, LEFT_PAD, ROOT_ASK_H, rootFootY } from "@/lib/layout";
import { readMediaUrls } from "@/lib/media";
import { coveredGround } from "@/lib/boardBuilder";
import { BranchCard } from "./BranchCard";
import { GhostColumn } from "./GhostColumn";
import { AskComposer } from "./AskComposer";
import { SkeletonCard } from "./SkeletonCard";
import { MoreRootsCard } from "./MoreRootsCard";
import { RootAskCard } from "./RootAskCard";
import type { Board, BranchNode } from "@/lib/schema";

/** Titles from root down to (not including) this node, for prompt context. */
function ancestorsOf(board: Board | null, id: string): string[] {
  const out: string[] = [];
  let cur = board?.nodes[id]?.parent_id ? board.nodes[board.nodes[id].parent_id!] : undefined;
  while (cur) {
    out.unshift(cur.title);
    cur = cur.parent_id ? board?.nodes[cur.parent_id] : undefined;
  }
  return out;
}

/**
 * The demo payload.
 *
 * Zoom and pan are applied IMPERATIVELY to a single element via transform and
 * CSS custom properties. React never re-renders on a wheel tick — it only
 * re-renders when the layout actually changes (expand/collapse). That's the
 * difference between buttery and janky, and buttery is the entire pitch.
 */
export function ZoomSurface() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);

  const board = useBoard((s) => s.board);
  const layout = useBoard((s) => s.layout);
  const expanded = useBoard((s) => s.expanded);
  const pending = useBoard((s) => s.pending);
  const hoveredId = useBoard((s) => s.hoveredId);
  const selectedId = useBoard((s) => s.selectedId);
  const errors = useBoard((s) => s.errors);
  const setHovered = useBoard((s) => s.setHovered);

  // ---- imperative view application -----------------------------------------
  useEffect(() => {
    const apply = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const { zoom, pan } = useBoard.getState();
      const lod = lodFor(zoom);
      stage.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`;
      stage.style.setProperty("--body-color", lod.bodyColor);
      stage.style.setProperty("--attribution-opacity", String(lod.attributionOpacity));
      // a fully-faded citation chip / fork button must not still be clickable
      stage.style.setProperty(
        "--attribution-events",
        lod.attributionOpacity < 0.05 ? "none" : "auto",
      );
      stage.style.setProperty("--detail-opacity", String(lod.detailOpacity));
      stage.style.setProperty("--body-reveal", String(lod.bodyReveal));
      stage.style.setProperty("--title-weight", String(lod.titleWeight));
      stage.style.setProperty("--ghost-opacity", String(0.55 + 0.45 * lod.bodyReveal));

      // The grid is locked to the BOARD, not the screen: it scales and slides
      // with the transform, so the surface reads as a plane you're flying over.
      const el = containerRef.current;
      if (el) {
        const g = 96 * zoom;
        el.style.backgroundSize = `${g}px ${g}px, ${g}px ${g}px`;
        el.style.backgroundPosition = `${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px`;
      }
      if (hudRef.current) hudRef.current.textContent = `${Math.round(zoom * 100)}%`;
    };
    apply();
    return useBoard.subscribe(apply);
  }, []);

  // ---- viewport ------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      useBoard.getState().setViewport({
        w: el.clientWidth,
        h: el.clientHeight,
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- initial framing: open on the day, already built ---------------------
  useEffect(() => {
    if (!layout || !containerRef.current) return;
    const s = useBoard.getState();
    if (s.pan.x !== 0 || s.pan.y !== 0) return;
    // seat column 0 a comfortable margin in from the rail
    s.setPan({ x: 64 - LEFT_PAD * s.zoom, y: 0 });
  }, [layout]);

  /** Slide horizontally so a column at layout-x `right` isn't born off-screen. */
  const panToRevealX = useCallback((right: number) => {
    const s = useBoard.getState();
    const overflow = right * s.zoom + s.pan.x - (s.viewport.w - 48);
    if (overflow <= 0) return;

    const from = s.pan.x;
    const to = from - overflow;
    const start = performance.now();
    const dur = 420;
    const tick = (now: number) => {
      const t = clamp((now - start) / dur, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      const cur = useBoard.getState();
      useBoard.setState({ pan: { x: from + (to - from) * e, y: cur.pan.y } });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  const revealColumn = useCallback(
    (childId: string) => {
      const card = useBoard.getState().layout?.byId[childId];
      if (card) panToRevealX(card.x + card.w);
    },
    [panToRevealX],
  );

  /** Reveal the column the skeletons are about to occupy, before they resolve. */
  const revealChildColumnOf = useCallback(
    (parentId: string) => {
      const card = useBoard.getState().layout?.byId[parentId];
      if (card) panToRevealX(card.x + CARD_W + COL_GAP + CARD_W);
    },
    [panToRevealX],
  );

  // ---- animated fly-to (used by TOC jumps and focus) ------------------------
  const flyTo = useCallback((nodeId: string, targetZoom = 1.12) => {
    const { layout: lay, viewport, zoom: z0, pan: p0 } = useBoard.getState();
    const card = lay?.byId[nodeId];
    if (!card) return;
    const { zoom: z1, pan: p1 } = frameRect(card, viewport, targetZoom);

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const dur = 620;
    const tick = (now: number) => {
      const t = clamp((now - start) / dur, 0, 1);
      // easeInOutCubic — the motion curve is product work here, not polish
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      useBoard.setState({
        zoom: z0 + (z1 - z0) * e,
        pan: { x: p0.x + (p1.x - p0.x) * e, y: p0.y + (p1.y - p0.y) * e },
      });
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    (window as unknown as { __gbFlyTo?: typeof flyTo }).__gbFlyTo = flyTo;
  }, [flyTo]);

  // ---- input ---------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const focal = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const s = useBoard.getState();

      // trackpad pinch arrives as ctrlKey+wheel; plain wheel pans
      if (e.ctrlKey || e.metaKey) {
        s.nudgeZoom(e.deltaY, focal);
      } else if (e.shiftKey) {
        s.nudgeZoom(e.deltaY, focal);
      } else {
        s.setPan({ x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY });
      }
    };

    // Drag anywhere — including across cards. A card only counts as clicked if
    // the pointer barely moved; past the threshold it was a pan, and the click
    // that browsers synthesise afterwards gets swallowed below.
    const DRAG_SLOP = 4;
    let dragging = false;
    let moved = false;
    let start = { x: 0, y: 0 };
    let last = { x: 0, y: 0 };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("a,button,input")) return;
      dragging = true;
      moved = false;
      start = { x: e.clientX, y: e.clientY };
      last = start;
      // NOTE: deliberately NOT capturing the pointer here. Pointer capture
      // retargets the follow-up `click` to the capture element, which silently
      // ate every card click. We only capture once it's provably a drag.
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      if (
        !moved &&
        Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP
      ) {
        moved = true;
        el.style.cursor = "grabbing";
        // now that it's a drag, capture so it survives leaving the element
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* pointer may already be gone */
        }
      }
      if (!moved) return;
      const s = useBoard.getState();
      s.setPan({
        x: s.pan.x + (e.clientX - last.x),
        y: s.pan.y + (e.clientY - last.y),
      });
      last = { x: e.clientX, y: e.clientY };
    };

    const onUp = (e: PointerEvent) => {
      if (dragging) {
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be gone */
        }
      }
      dragging = false;
      el.style.cursor = "";
    };

    // capture phase: kill the click a drag would otherwise trigger on a card
    const onClickCapture = (e: MouseEvent) => {
      if (!moved) return;
      e.stopPropagation();
      e.preventDefault();
      moved = false;
    };

    const onKey = (e: KeyboardEvent) => {
      /**
       * Never steal a keystroke from something being typed into.
       *
       * These are bare character bindings on `window`, so before @ existed they
       * were already firing inside the seed bar — typing "under $30k" zoomed the
       * board out twice and reset the view. Asking makes that unignorable, since
       * every question contains letters.
       */
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }

      const s = useBoard.getState();
      const c = { x: s.viewport.w / 2, y: s.viewport.h / 2 };

      /**
       * @ opens the composer on whatever you're pointing at — or on the board.
       *
       * The muscle memory is X's: you reply to a post by typing @grok, and here
       * the card under the cursor IS the post you're replying to.
       *
       * Pointing at nothing is a question too, and it used to fall through to
       * the selection — but there is nearly always a selection, so the board
       * itself was unreachable by keyboard: every @ went to whichever card you
       * last clicked, whether or not you were still looking at it. Hover now
       * decides outright, and an empty hand asks the board.
       */
      if (e.key === "@") {
        e.preventDefault();
        if (s.hoveredId && s.board?.nodes[s.hoveredId]) s.startAsk(s.hoveredId);
        // ...and on a decision board there is no board-level plot to put the
        // cursor in (see canAskBoard), so an empty hand does nothing rather
        // than focusing something unrendered
        else if (s.board?.kind !== "options") s.focusRootAsk();
        return;
      }
      if (e.key === "Escape" && s.asking) {
        s.cancelAsk();
        return;
      }

      if (e.key === "=" || e.key === "+") s.setZoom(s.zoom * 1.22, c);
      else if (e.key === "-" || e.key === "_") s.setZoom(s.zoom / 1.22, c);
      else if (e.key === "0") s.resetView();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("click", onClickCapture, true);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /** Ask Grok for children on a given fork and graft them into the graph. */
  const requestExpand = useCallback(
    (
      id: string,
      fork: string,
      append: boolean,
      /**
       * fork "ask" only — the question, the corpus to start from, and the card
       * it was asked of. The last one is what "this" points at, and on a
       * decision board it also carries the attribute labels an answer has to be
       * comparable against.
       */
      ask?: {
        question: string;
        corpus: string[];
        covered: string[];
        askParent?: BranchNode;
      },
    ) => {
      const s = useBoard.getState();
      const startedAt = performance.now();
      s.setPending(id, true);
      // skeletons are laid out on this same frame — show them straight away.
      // An ask has none: its answer lands on the card the user just typed into,
      // so panning to the next column would be panning away from it.
      if (fork !== "ask") requestAnimationFrame(() => revealChildColumnOf(id));
      void fetch("/api/expand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: id,
          fork,
          // send our copy so expand works even if the server's board differs
          node: s.board?.nodes[id],
          ancestors: ancestorsOf(s.board, id),
          posts: s.board?.posts,
          // ...and what the board is FOR, for exactly the same reason
          kind: s.board?.kind,
          // the decision this board is narrowing — a root's own title never
          // contains the subject, so without this the web query for
          // "Budget frames under $250" is about no particular thing
          boardQuestion: s.board?.seed.label,
          /**
           * Images the board has already read.
           *
           * The server strips these itself from its own graph, but it only has
           * a graph when it happens to own this node — the same reason we send
           * the node at all. Watched vision read one screenshot twice because
           * of it. Novelty is structural, so the fact travels with the request
           * rather than depending on which side remembers.
           */
          readMedia: s.board ? [...readMediaUrls(s.board)] : [],
          ...(ask ?? {}),
        }),
      })
        .then(async (r) => {
          const data = await r.json().catch(() => null);
          if (!r.ok) throw new Error(data?.error ?? `expand failed (${r.status})`);
          return data;
        })
        .then((data) => {
          /**
           * An ask succeeds on the ANSWER, not on the children.
           *
           * For every other fork, no children means nothing happened and the
           * card must say so. For an ask the reply itself is the result — it
           * lands on the question card as its body — and plenty of good
           * questions have one straight answer and no evidence cards behind
           * it. Throwing here was discarding a perfectly good answer and
           * showing an error in its place.
           */
          const answered = Boolean(data?.summary);
          if (!data?.children?.length && !answered) {
            throw new Error("Grok returned nothing for this branch");
          }
          useBoard.getState().setError(id, null);
          useBoard.getState().record({
            kind: "expand",
            source: data.source ?? (data.cached ? "cache" : undefined),
            ms: Math.round(performance.now() - startedAt),
            posts: Object.keys(data.posts ?? {}).length,
            web: (data.children ?? []).reduce(
              (n: number, c: { source_urls_meta?: unknown[] }) =>
                n + (c.source_urls_meta?.length ?? 0),
              0,
            ),
            cached: Boolean(data.cached),
            at: Date.now(),
          });
          useBoard
            .getState()
            .mergeChildren(id, data.children, data.posts, append, data.summary, data.axis);
          // The answer's own citations land on the question card, so an ask
          // that returns no cards is still visibly grounded. Must run AFTER
          // mergeChildren, which rebuilds this node from its children.
          // "x_agent" on a news board, "web_agent" on a decision board — the
          // same answer landing on the same question card, differing only in
          // what it is allowed to cite
          if (data.source === "x_agent" || data.source === "web_agent") {
            useBoard.getState().applyAnswer(id, {
              postIds: data.answerPostIds,
              web: data.answerWeb,
              grounded: data.grounded,
              // only ever set on a decision board, and only when Grok decided
              // the answer wanted a picture
              imagePrompt: data.answerImagePrompt,
            });
          }
          useBoard.getState().expand(id);
          // with no children there is no new column to fly to — the answer
          // landed on the card the user is already looking at
          if (data.children?.length) {
            requestAnimationFrame(() => revealColumn(data.children[0].id));
          }
        })
        .catch((err: unknown) => {
          // a silent failure is indistinguishable from a dead card — say it
          const message = err instanceof Error ? err.message : "expand failed";
          useBoard.getState().setError(id, message);
          useBoard.getState().record({
            kind: "expand",
            ms: Math.round(performance.now() - startedAt),
            error: message,
            at: Date.now(),
          });
        })
        .finally(() => useBoard.getState().setPending(id, false));
    },
    [revealColumn, revealChildColumnOf],
  );

  /**
   * A fork you've already run is already on the board.
   *
   * The server caches this too, but only when it happens to own the node —
   * and when it doesn't, a second click ran the whole fork again and grafted a
   * second copy of the same branch. Vision made that impossible to miss: two
   * cards, same screenshot, two rewordings of one reading. The client always
   * knows what it merged, so the check belongs here as well.
   */
  const onFork = useCallback(
    (id: string, fork: string) => {
      const s = useBoard.getState();
      const node = s.board?.nodes[id];
      const existing = node?.children_ids.filter(
        (cid) => s.board?.nodes[cid]?.fork === fork,
      );
      if (existing?.length) {
        s.select(id);
        s.expand(id);
        requestAnimationFrame(() => revealColumn(existing[0]));
        return;
      }
      requestExpand(id, fork, true);
    },
    [requestExpand, revealColumn],
  );

  const onToggle = useCallback(
    (id: string) => {
      const s = useBoard.getState();
      if (s.expanded.has(id)) {
        s.collapse(id);
        return;
      }
      const node = s.board?.nodes[id];
      if (!node) return;

      // Always select first. Even when nothing else happens, the click has to
      // register — selection is what reveals the fork actions, and an inert
      // card is indistinguishable from a broken one.
      s.select(id);
      s.setError(id, null);

      if (node.children_ids.length > 0) {
        s.expand(id);
        requestAnimationFrame(() => revealColumn(node.children_ids[0]));
      } else {
        // The board is infinitely recursive: there is always a more specific
        // question, so we never refuse to expand. If Grok truly has nothing
        // deeper it says so in a node, which is an answer rather than silence.
        requestExpand(id, "deeper", false);
      }
    },
    [revealColumn, requestExpand],
  );

  /**
   * Ask @grok, in the user's own words — of a card, or of the board.
   *
   * The question becomes a real node before the request goes out, so what the
   * user sees is: they type, the card they typed into becomes theirs, and the
   * evidence lands underneath it. requestExpand then treats that node like any
   * other — the agent is just the fork it happens to run.
   *
   * `parentId: null` is the board-level ask ("breaking news"), and the ONLY
   * thing that differs is what the question hangs off: a root instead of a
   * card, so no card's corpus to start from. Everything downstream — the node,
   * the fork, the route, the agent, the answer landing on the question card —
   * is the same path, which is the point.
   */
  const submitAsk = useCallback(
    (parentId: string | null, question: string) => {
      const s = useBoard.getState();
      const parent = parentId ? s.board?.nodes[parentId] : null;
      const q = s.addQuestion(parentId, question);
      if (!q) return;
      // the card's own evidence is the agent's starting corpus — it has no
      // citations of its own to derive one from, being a question. Asked of the
      // board there is no such card, and the agent's tools are all it gets.
      requestExpand(q.id, "ask", false, {
        question,
        corpus: parent?.source_post_ids ?? [],
        // the card they typed at, not just its title: its body is what makes
        // "this" resolvable, and its attribute labels are what an answer on a
        // decision board has to line up with
        askParent: parent ?? undefined,
        // what's already up there, so the answer isn't something the user has
        // read — the same novelty rule "more of your day" sends, and the reason
        // a board ask can't hand back a topic that's already a root
        covered: s.board ? coveredGround(s.board).titles : [],
      });
      requestAnimationFrame(() => revealColumn(q.id));
    },
    [requestExpand, revealColumn],
  );

  const askingId = useBoard((s) => s.asking);
  const cancelAsk = useBoard((s) => s.cancelAsk);
  const askingCard = askingId ? layout?.byId[askingId] : undefined;

  const hoveredCard =
    hoveredId && !expanded.has(hoveredId) ? layout?.byId[hoveredId] : undefined;
  // every card previews, because every card can be expanded — but not while
  // the composer already owns that slot
  const showGhost = Boolean(hoveredCard) && hoveredCard?.node.id !== askingId;

  /**
   * Asking a CARD works on both boards now. Asking the BOARD is still news-only.
   *
   * Not a category error any longer — the agent answers in options when the
   * board is one (see askAgent's `kind`), which is what the per-card composer
   * on a decision board now does. It's that the root column of a decision board
   * is already an answer to one question: three options on a named axis,
   * compared against each other. A question typed at the foot of it either asks
   * for more of them, which is the button directly underneath, or asks for
   * something off that axis, which lands beside three cards it can't be read
   * against. Neither one wants a second plot.
   */
  const canAskBoard = board?.kind !== "options";

  // the foot of the root column, where it carries on below the last root: the
  // board-level ask plot first, then "more of your day" under it — and on a
  // decision board, straight to "more directions" with no hole where the ask
  // plot would have been
  const rootColumnBottom = layout ? rootFootY(layout) : 0;
  const moreRootsY =
    rootColumnBottom + (canAskBoard ? ROOT_ASK_H + CARD_GAP : 0);

  /**
   * The lineage of whatever you're pointing at, root to leaf.
   *
   * At depth 3 a card gives you no clue how you got there — the columns to its
   * left hold several candidate parents and the layout alone won't say which.
   * Lighting the chain answers that without asking the user to trace bands.
   * Hover wins over selection so you can probe other branches without losing
   * your place.
   */
  const focusId = hoveredId ?? selectedId;
  const ancestry = useMemo(() => {
    const chain = new Set<string>();
    let cur = focusId ? board?.nodes[focusId] : undefined;
    while (cur) {
      chain.add(cur.id);
      cur = cur.parent_id ? board?.nodes[cur.parent_id] : undefined;
    }
    return chain;
  }, [focusId, board]);

  // NOTE: the container must mount on the very first render, even with no
  // board. It carries the ref that the wheel/drag/resize effects bind to, and
  // those effects only run once — early-returning a different element here
  // silently left the surface with no input handlers at all.
  return (
    <div
      ref={containerRef}
      className="gb-grid relative flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
    >
      <div
        ref={stageRef}
        className="gb-stage absolute left-0 top-0 origin-top-left will-change-transform"
        style={{ width: layout?.width ?? 0, height: layout?.height ?? 0 }}
      >
        {/* tracks first: they are the ground the cards sit on */}
        {layout?.tracks.map((t) => (
          <div
            key={t.key}
            className="gb-track"
            data-onpath={ancestry.has(t.nodeId) ? "true" : "false"}
            style={{
              transform: `translate3d(${t.x}px, ${t.y}px, 0)`,
              width: t.w,
              height: t.h,
            }}
          />
        ))}

        {showGhost && hoveredCard ? <GhostColumn card={hoveredCard} /> : null}

        {/* The composer takes the ghost's slot — you type where the answer lands.
            Keyed by node so asking a different card remounts it empty rather
            than carrying the last question over. */}
        {askingCard ? (
          <AskComposer
            key={askingCard.node.id}
            card={askingCard}
            onSubmit={(q: string) => submitAsk(askingCard.node.id, q)}
            onCancel={cancelAsk}
          />
        ) : null}

        {layout?.skeletons.map((box, i) => (
          <SkeletonCard key={box.key} box={box} index={i} />
        ))}

        {/* The root column carries on below the last root: ask the board, then
            more of what it already knows. The ask sits first because its plot
            is fixed-height and MoreRootsCard's isn't — stacking them the other
            way would make this one's position depend on that one's text. */}
        {layout && board && canAskBoard ? (
          <RootAskCard
            y={rootColumnBottom}
            onSubmit={(q: string) => submitAsk(null, q)}
          />
        ) : null}

        {layout && board ? <MoreRootsCard y={moreRootsY} /> : null}

        {board && layout ? layout.cards.map((card) => (
          <BranchCard
            key={card.node.id}
            card={card}
            board={board}
            pending={pending.has(card.node.id)}
            error={errors[card.node.id]}
            selected={selectedId === card.node.id}
            onPath={ancestry.has(card.node.id)}
            onToggle={onToggle}
            onHover={setHovered}
            onFork={onFork}
          />
        )) : null}
      </div>

      {/* Scale + controls readout. Written imperatively from the same subscribe
          tick as the transform, so the HUD never costs a React render. */}
      <div
        className="gb-label pointer-events-none absolute bottom-4 left-5 flex items-center gap-3 border px-2.5 py-[7px]"
        style={{
          color: "var(--gb-faint)",
          borderColor: "var(--gb-line)",
          background: "rgba(0,0,0,0.6)",
          borderRadius: 2,
          backdropFilter: "blur(8px)",
        }}
      >
        <span ref={hudRef} className="tabular-nums" style={{ color: "var(--gb-dim)" }}>
          62%
        </span>
        <span className="h-px w-6" style={{ background: "var(--gb-line)" }} />
        <span>Scroll pan · Shift zoom · 0 reset</span>
      </div>
    </div>
  );
}
