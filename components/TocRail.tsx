"use client";

import type { Board } from "@/lib/schema";

interface Props {
  board: Board;
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  onJump: (id: string) => void;
  seedLabel: string;
  date: string;
  footer?: React.ReactNode;
}

/**
 * Not a static list of roots. It grows and indents as you expand, mirroring the
 * open subtree — orientation, back-button and jump target in one.
 *
 * Reads as an index/manifest: mono masthead, hairline rules, indent guides for
 * depth. It is the one place on screen that stays still while the board moves.
 */
export function TocRail({
  board,
  expanded,
  selectedId,
  onJump,
  seedLabel,
  date,
  footer,
}: Props) {
  const rows: { id: string; title: string; depth: number }[] = [];

  const walk = (id: string, depth: number) => {
    const node = board.nodes[id];
    if (!node) return;
    rows.push({ id, title: node.title, depth });
    if (!expanded.has(id)) return;
    for (const kid of [...node.children_ids].sort(
      (a, b) => (board.nodes[b]?.priority ?? 0) - (board.nodes[a]?.priority ?? 0),
    )) {
      walk(kid, depth + 1);
    }
  };

  for (const rootId of [...board.root_ids].sort(
    (a, b) => (board.nodes[b]?.priority ?? 0) - (board.nodes[a]?.priority ?? 0),
  )) {
    walk(rootId, 0);
  }

  return (
    <aside
      className="flex h-full w-[248px] shrink-0 flex-col"
      style={{
        background: "var(--gb-panel)",
        borderRight: "1px solid var(--gb-line)",
      }}
    >
      <div
        className="px-5 pb-4 pt-5"
        style={{ borderBottom: "1px solid var(--gb-line)" }}
      >
        <div
          className="gb-label mb-3.5"
          style={{ color: "var(--gb-faint)", letterSpacing: "0.22em" }}
        >
          Grok Branches
        </div>
        <div
          className="text-[13px] leading-[1.3] tracking-[-0.01em]"
          style={{ color: "var(--gb-text)", fontWeight: 600 }}
        >
          {seedLabel}
        </div>
        <div className="gb-label mt-2 flex items-center gap-2" style={{ color: "var(--gb-faint)" }}>
          <span>
            {new Date(`${date}T12:00:00Z`)
              .toLocaleDateString("en-US", {
                month: "short",
                day: "2-digit",
                year: "numeric",
              })
              .toUpperCase()}
          </span>
          <span className="h-px flex-1" style={{ background: "var(--gb-line)" }} />
          <span className="tabular-nums">{rows.length} NODES</span>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-3 pr-2">
        {rows.map((row) => {
          const active = selectedId === row.id;
          return (
            <button
              key={row.id}
              onClick={() => onJump(row.id)}
              className="group relative block w-full py-[6px] pr-2 text-left text-[11.5px] leading-[1.4] transition-colors"
              style={{
                paddingLeft: 20 + row.depth * 14,
                color: active
                  ? "var(--gb-text)"
                  : row.depth === 0
                    ? "var(--gb-dim)"
                    : "var(--gb-faint)",
                background: active ? "rgba(255,255,255,0.05)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = "var(--gb-text)";
              }}
              onMouseLeave={(e) => {
                if (!active)
                  e.currentTarget.style.color =
                    row.depth === 0 ? "var(--gb-dim)" : "var(--gb-faint)";
              }}
            >
              {/* indent guide — one hairline per level of depth */}
              {Array.from({ length: row.depth }).map((_, i) => (
                <span
                  key={i}
                  className="absolute top-0 h-full w-px"
                  style={{ left: 20 + i * 14 - 7, background: "var(--gb-line)" }}
                />
              ))}
              {/* selection spine */}
              <span
                className="absolute left-0 top-0 h-full w-[2px]"
                style={{ background: active ? "var(--gb-text)" : "transparent" }}
              />
              {row.title}
            </button>
          );
        })}
      </nav>

      {footer}
    </aside>
  );
}
