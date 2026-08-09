"use client";

import { useEffect, useRef, useState } from "react";
import type { PositionedCard } from "@/lib/layout";
import { ghostSlot } from "@/lib/layout";

/**
 * Asking, in the slot the answer will land in.
 *
 * This is the ghost column with a cursor in it. Hovering a card already draws a
 * surveyed-but-unbuilt plot one column to the right (GhostColumn); typing into
 * that same plot is the whole affordance, and it means you write the question
 * where the answer is about to appear rather than in a panel somewhere else.
 *
 * It deliberately does not look like a chat box. The board's claim is that an
 * answer is structure, not a message — so the composer is a card-shaped hole,
 * and what fills it is a card.
 */
export function AskComposer({
  card,
  onSubmit,
  onCancel,
}: {
  card: PositionedCard;
  onSubmit: (question: string) => void;
  onCancel: () => void;
}) {
  const slot = ghostSlot(card);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    // focus after the transform lands, or the browser scrolls the canvas to
    // chase an element that is still animating into place
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const submit = () => {
    const q = value.trim();
    if (q) onSubmit(q);
  };

  return (
    <div
      className="gb-ask absolute left-0 top-0"
      style={{
        transform: `translate3d(${slot.x}px, ${slot.y}px, 0)`,
        width: slot.w,
        border: "1px solid var(--gb-live)",
        borderRadius: 3,
        background: "var(--gb-card, rgba(0,0,0,0.6))",
      }}
      // the canvas pans on pointer-drag from anywhere; without this, selecting
      // your own text with the mouse drags the board out from under you
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-4 py-4">
        <div
          className="gb-label flex items-center gap-2"
          style={{ color: "var(--gb-live)" }}
        >
          <span
            className="gb-pulse h-[4px] w-[4px] rounded-full"
            style={{ background: "var(--gb-live)" }}
          />
          Ask @grok
        </div>

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // the canvas listens on window for @, =, -, 0 and Escape; every one
            // of those is a character somebody might type into a question
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            // an empty box that lost focus is abandoned; one with words in it
            // is not, and silently discarding them is unforgivable
            if (!value.trim()) onCancel();
          }}
          rows={2}
          placeholder={`Ask anything about "${card.node.title.slice(0, 40)}${card.node.title.length > 40 ? "…" : ""}"`}
          className="mt-3 w-full resize-none bg-transparent text-[17px] leading-[1.3] tracking-[-0.014em] outline-none"
          style={{ color: "var(--gb-text)", fontWeight: 600 }}
        />

        <div
          className="gb-label mt-3 flex items-center gap-3"
          style={{ color: "var(--gb-faint)" }}
        >
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="gb-label border px-2 py-[5px] transition-colors disabled:opacity-40"
            style={{
              borderColor: value.trim() ? "var(--gb-live)" : "var(--gb-line-hi)",
              color: value.trim() ? "var(--gb-live)" : "var(--gb-faint)",
              borderRadius: 2,
            }}
          >
            Ask ⏎
          </button>
          <span>Grok will search X and the web</span>
        </div>
      </div>
    </div>
  );
}
