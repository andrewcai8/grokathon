"use client";

import type { PositionedCard } from "@/lib/layout";
import { ghostSlot } from "@/lib/layout";

/**
 * The entire expand affordance, straight from briefing.gif: hover a card and a
 * faded preview of where its children will land appears one column to the
 * right. No buttons, no chevrons.
 *
 * On black it reads as a surveyed but unbuilt plot — dashed hairline outline,
 * the parent's title greyed inside it — rather than as ghosted content.
 */
export function GhostColumn({ card }: { card: PositionedCard }) {
  const slot = ghostSlot(card);
  return (
    <div
      className="gb-ghost pointer-events-none absolute left-0 top-0"
      style={{
        transform: `translate3d(${slot.x}px, ${slot.y}px, 0)`,
        width: slot.w,
        minHeight: 132,
        border: "1px dashed var(--gb-line-hi)",
        borderRadius: 3,
      }}
    >
      <div className="px-4 py-4">
        <div className="gb-label" style={{ color: "var(--gb-dim)" }}>
          Click to expand
        </div>
        <div
          className="mt-3 text-[17px] leading-[1.3] tracking-[-0.014em]"
          style={{ color: "var(--gb-faint)", fontWeight: 600 }}
        >
          {card.node.title}
        </div>
      </div>
    </div>
  );
}
