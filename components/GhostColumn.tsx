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
        {/*
          The second thing this slot can become.

          Expanding asks the question we chose; asking asks yours, and both land
          right here — so the plot advertises both rather than hiding one behind
          a menu. It teaches the key rather than offering a button because the
          ghost is pointer-events-none by design: reaching for a target inside it
          means leaving the card, which un-hovers it and takes the target away.
        */}
        <div
          className="gb-label mt-3 flex items-center gap-1.5"
          style={{ color: "var(--gb-dim)" }}
        >
          <span
            style={{
              border: "1px solid var(--gb-line-hi)",
              borderRadius: 2,
              padding: "1px 4px",
            }}
          >
            @
          </span>
          <span>to ask @grok anything</span>
        </div>
      </div>
    </div>
  );
}
