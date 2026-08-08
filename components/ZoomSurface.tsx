"use client";

import { useCallback, useEffect, useRef } from "react";
import { useBoard } from "@/lib/store";
import { lodFor, clamp, frameRect } from "@/lib/lod";
import { CARD_W, COL_GAP, LEFT_PAD } from "@/lib/layout";
import { BranchCard } from "./BranchCard";
import { GhostColumn } from "./GhostColumn";
import { SkeletonCard } from "./SkeletonCard";

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
  const rafRef = useRef<number | null>(null);

  const board = useBoard((s) => s.board);
  const layout = useBoard((s) => s.layout);
  const expanded = useBoard((s) => s.expanded);
  const pending = useBoard((s) => s.pending);
  const hoveredId = useBoard((s) => s.hoveredId);
  const selectedId = useBoard((s) => s.selectedId);
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
      stage.style.setProperty("--detail-opacity", String(lod.detailOpacity));
      stage.style.setProperty("--body-reveal", String(lod.bodyReveal));
      stage.style.setProperty("--title-weight", String(lod.titleWeight));
      stage.style.setProperty("--ghost-opacity", String(0.55 + 0.45 * lod.bodyReveal));
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
      const s = useBoard.getState();
      const c = { x: s.viewport.w / 2, y: s.viewport.h / 2 };
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
    (id: string, fork: string, append: boolean) => {
      const s = useBoard.getState();
      s.setPending(id, true);
      // skeletons are laid out on this same frame — show them straight away
      requestAnimationFrame(() => revealChildColumnOf(id));
      void fetch("/api/expand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: id, fork }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data?.children?.length) return;
          useBoard.getState().mergeChildren(id, data.children, data.posts, append);
          useBoard.getState().expand(id);
          requestAnimationFrame(() => revealColumn(data.children[0].id));
        })
        .catch(() => {})
        .finally(() => useBoard.getState().setPending(id, false));
    },
    [revealColumn, revealChildColumnOf],
  );

  const onFork = useCallback(
    (id: string, fork: string) => requestExpand(id, fork, true),
    [requestExpand],
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

      if (node.children_ids.length > 0) {
        s.expand(id);
        requestAnimationFrame(() => revealColumn(node.children_ids[0]));
      } else if (node.has_children) {
        // children not fetched yet — ask Grok
        requestExpand(id, "deeper", false);
      }
    },
    [revealColumn, requestExpand],
  );

  const hoveredCard =
    hoveredId && !expanded.has(hoveredId) ? layout?.byId[hoveredId] : undefined;
  const showGhost = hoveredCard?.node.has_children;

  // NOTE: the container must mount on the very first render, even with no
  // board. It carries the ref that the wheel/drag/resize effects bind to, and
  // those effects only run once — early-returning a different element here
  // silently left the surface with no input handlers at all.
  return (
    <div
      ref={containerRef}
      className="relative flex-1 cursor-grab touch-none overflow-hidden bg-[#efefed] active:cursor-grabbing"
    >
      <div
        ref={stageRef}
        className="gb-stage absolute left-0 top-0 origin-top-left will-change-transform"
        style={{ width: layout?.width ?? 0, height: layout?.height ?? 0 }}
      >
        {showGhost && hoveredCard ? <GhostColumn card={hoveredCard} /> : null}

        {layout?.skeletons.map((box, i) => (
          <SkeletonCard key={box.key} box={box} index={i} />
        ))}

        {board && layout ? layout.cards.map((card) => (
          <BranchCard
            key={card.node.id}
            card={card}
            board={board}
            pending={pending.has(card.node.id)}
            selected={selectedId === card.node.id}
            onToggle={onToggle}
            onHover={setHovered}
            onFork={onFork}
          />
        )) : null}
      </div>
    </div>
  );
}
