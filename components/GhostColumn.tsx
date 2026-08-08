"use client";

import type { PositionedCard } from "@/lib/layout";
import { ghostSlot } from "@/lib/layout";

/**
 * The entire expand affordance, straight from briefing.gif: hover a card and a
 * faded preview of where its children will land appears one column to the
 * right, labelled "Click to expand". No buttons, no chevrons.
 */
export function GhostColumn({ card }: { card: PositionedCard }) {
  const slot = ghostSlot(card);
  return (
    <div
      className="gb-ghost pointer-events-none absolute left-0 top-0"
      style={{
        transform: `translate3d(${slot.x}px, ${slot.y}px, 0)`,
        width: slot.w,
      }}
    >
      <div className="px-4 py-4">
        <div className="text-[13px] leading-none tracking-[-0.005em] text-neutral-400">
          Click to expand
        </div>
        <div className="mt-3 text-[17px] font-bold leading-[1.28] tracking-[-0.011em] text-neutral-300">
          {card.node.title}
        </div>
      </div>
    </div>
  );
}
