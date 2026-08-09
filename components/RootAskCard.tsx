"use client";

import { useEffect, useRef, useState } from "react";
import { CARD_W, LEFT_PAD, ROOT_ASK_H } from "@/lib/layout";
import { useBoard } from "@/lib/store";

/**
 * Asking the BOARD, at the foot of the root column.
 *
 * AskComposer is the same idea one column over: you type the question in the
 * plot the answer is about to occupy. The difference is only which plot that
 * is — a question asked of a card grows a child to its right, a question asked
 * of the board grows a root beneath the roots. A subject you name yourself is a
 * topic, not a detail of some other topic, so it has to be able to land in
 * column 0. ("Breaking news" is one such subject, not the point of the box.)
 *
 * Unlike AskComposer this one is always here rather than summoned by hover.
 * There is no card to hover: an empty-handed question has no anchor, so the
 * anchor has to be a standing plot. It borrows MoreRootsCard's dashed hairline
 * for the same reason that does — "there is something here you haven't opened
 * yet", pointing down instead of right.
 *
 * Its height is fixed at ROOT_ASK_H and set explicitly, because MoreRootsCard
 * is stacked directly beneath it: a box that grew as you typed would shove that
 * button out from under the cursor mid-click.
 */
export function RootAskCard({
  y,
  onSubmit,
}: {
  y: number;
  onSubmit: (question: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const focusNonce = useBoard((s) => s.rootAskFocus);

  // @ with nothing under the cursor lands here. A nonce rather than a flag, so
  // pressing it twice focuses twice — see store.focusRootAsk.
  useEffect(() => {
    if (!focusNonce) return;
    ref.current?.focus();
  }, [focusNonce]);

  const submit = () => {
    const q = value.trim();
    if (!q) return;
    // cleared here, not on the response: the question card is minted
    // synchronously and is on screen this frame, so leaving the words in the
    // box would show the same question twice
    setValue("");
    onSubmit(q);
  };

  const live = Boolean(value.trim());

  return (
    <div
      className="gb-ask absolute left-0 top-0"
      style={{
        transform: `translate3d(${LEFT_PAD}px, ${y}px, 0)`,
        width: CARD_W,
        height: ROOT_ASK_H,
        border: `1px ${focused || live ? "solid" : "dashed"} ${
          focused || live ? "var(--gb-live)" : "var(--gb-line-hi)"
        }`,
        borderRadius: 3,
        transition: "border-color 140ms ease",
      }}
      // the canvas pans on pointer-drag from anywhere; without this, selecting
      // your own text with the mouse drags the board out from under you
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        ref.current?.focus();
      }}
    >
      <div className="px-4 py-4">
        <div
          className="gb-label flex items-center gap-2"
          style={{ color: focused || live ? "var(--gb-live)" : "var(--gb-dim)" }}
        >
          <span
            className={focused || live ? "gb-pulse h-[4px] w-[4px] rounded-full" : "h-[4px] w-[4px] rounded-full"}
            style={{ background: focused || live ? "var(--gb-live)" : "var(--gb-line-max)" }}
          />
          Ask @grok
          {/* What makes this one different from the composer on a card: the
              answer arrives as a root, not as a child. Said here, once, rather
              than baked into a placeholder that would read as the only thing
              you're allowed to type. */}
          <span className="ml-auto" style={{ color: "var(--gb-faint)" }}>
            New topic
          </span>
        </div>

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
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
              ref.current?.blur();
            }
          }}
          rows={2}
          placeholder="Ask anything"
          className="mt-3 w-full resize-none bg-transparent text-[17px] leading-[1.3] tracking-[-0.014em] outline-none"
          style={{ color: "var(--gb-text)", fontWeight: 600 }}
        />

        <div
          className="gb-label mt-1 flex items-center gap-3"
          style={{ color: "var(--gb-faint)" }}
        >
          {live ? (
            <button
              onClick={submit}
              className="gb-label border px-2 py-[5px] transition-colors"
              style={{
                borderColor: "var(--gb-live)",
                color: "var(--gb-live)",
                borderRadius: 2,
              }}
            >
              Ask ⏎
            </button>
          ) : (
            // The affordance, only while the box is empty — once there are
            // words in it the button is the thing to say, and both at once
            // overflows the fixed plot.
            <span>Grok will search X and the web</span>
          )}
        </div>
      </div>
    </div>
  );
}
