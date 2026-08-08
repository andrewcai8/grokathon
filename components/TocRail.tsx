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
    <aside className="flex h-full w-[228px] shrink-0 flex-col border-r border-black/[0.055] bg-[#f4f4f2]">
      <div className="px-5 pb-3 pt-5">
        <div className="text-[13px] font-bold tracking-[-0.008em] text-neutral-900">
          {seedLabel}
        </div>
        <div className="mt-0.5 text-[11px] text-neutral-400">
          {new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
          })}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-5">
        {rows.map((row) => (
          <button
            key={row.id}
            onClick={() => onJump(row.id)}
            style={{ paddingLeft: 12 + row.depth * 13 }}
            className={`block w-full rounded-md py-[5px] pr-2 text-left text-[11.5px] leading-[1.35] transition-colors ${
              selectedId === row.id
                ? "bg-black/[0.06] text-neutral-900"
                : row.depth === 0
                  ? "text-neutral-700 hover:bg-black/[0.035]"
                  : "text-neutral-500 hover:bg-black/[0.035]"
            }`}
          >
            {row.title}
          </button>
        ))}
      </nav>

      {footer}
    </aside>
  );
}
