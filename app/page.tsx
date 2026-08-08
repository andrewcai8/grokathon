"use client";

import { useEffect } from "react";
import { FIXTURE_BOARD } from "@/lib/fixtures";
import { useBoard } from "@/lib/store";
import { TocRail } from "@/components/TocRail";
import { ZoomSurface } from "@/components/ZoomSurface";
import { SeedBar } from "@/components/SeedBar";
import type { Board } from "@/lib/schema";

/**
 * Warm the first expand before anyone clicks it.
 *
 * A cold Grok expand measures ~19s. Nobody stands in front of judges waiting
 * for that. We quietly fetch children for the highest-priority roots in the
 * background, so the click that matters resolves from the graph instantly.
 */
function prefetchTopLevel(board: Board, count = 3) {
  const roots = [...board.root_ids]
    .map((id) => board.nodes[id])
    .filter((n) => n && n.has_children && n.children_ids.length === 0)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, count);

  for (const root of roots) {
    void fetch("/api/expand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: root.id, fork: "deeper" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        // graft the children in WITHOUT expanding — the column stays closed
        // until the user asks for it, it's just ready when they do
        if (data?.children?.length) {
          useBoard.getState().mergeChildren(root.id, data.children, data.posts);
        }
      })
      .catch(() => {});
  }
}

export default function Home() {
  const board = useBoard((s) => s.board);
  const expanded = useBoard((s) => s.expanded);
  const selectedId = useBoard((s) => s.selectedId);
  const setBoard = useBoard((s) => s.setBoard);

  // Never open empty, never open on a spinner (doc §0).
  //
  // Paint a built board on the FIRST frame, then swap in the live one if and
  // when it arrives. A cold Grok clustering call can take 30s; nobody — least
  // of all a judge — should ever watch that happen.
  useEffect(() => {
    let cancelled = false;
    setBoard(FIXTURE_BOARD);

    const ctrl = new AbortController();
    const bail = setTimeout(() => ctrl.abort(), 20_000);

    fetch("/api/seed", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("seed failed"))))
      .then((data) => {
        // only replace if it's genuinely better than what's already on screen
        if (!cancelled && data?.source !== "fixtures" && data?.board?.root_ids?.length) {
          setBoard(data.board);
          prefetchTopLevel(data.board);
        }
      })
      .catch(() => {})
      .finally(() => clearTimeout(bail));

    return () => {
      cancelled = true;
      clearTimeout(bail);
      ctrl.abort();
    };
  }, [setBoard]);

  return (
    <main className="flex h-screen w-screen overflow-hidden">
      {board ? (
        <TocRail
          board={board}
          expanded={expanded}
          selectedId={selectedId}
          seedLabel={board.seed.label}
          date={board.date}
          footer={
            <SeedBar
              board={board}
              onBoard={(b) => {
                setBoard(b);
                prefetchTopLevel(b);
              }}
            />
          }
          onJump={(id) => {
            const fly = (window as unknown as { __gbFlyTo?: (id: string) => void })
              .__gbFlyTo;
            useBoard.getState().select(id);
            fly?.(id);
          }}
        />
      ) : (
        <div
          className="w-[248px] shrink-0"
          style={{
            background: "var(--gb-panel)",
            borderRight: "1px solid var(--gb-line)",
          }}
        />
      )}
      <ZoomSurface />
      {board?.seed.snapshot ? (
        <div
          className="gb-label pointer-events-none absolute right-5 top-5 flex items-center gap-2 border px-2.5 py-[7px]"
          style={{
            borderColor: "var(--gb-line)",
            color: "var(--gb-dim)",
            background: "rgba(0,0,0,0.6)",
            borderRadius: 2,
            backdropFilter: "blur(8px)",
          }}
        >
          <span
            className="h-[5px] w-[5px] rounded-full"
            style={{ background: "var(--gb-faint)" }}
          />
          Snapshot
        </div>
      ) : null}
    </main>
  );
}
