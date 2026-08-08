"use client";

import { memo, useEffect, useRef } from "react";
import type { PositionedCard } from "@/lib/layout";
import type { Board, Fork } from "@/lib/schema";
import { EPISTEMIC_LABEL, reportHeight } from "@/lib/store";
import { PostChip } from "./PostChip";

const EPISTEMIC_TONE: Record<string, string> = {
  widely_shared: "text-neutral-500",
  contested: "text-amber-700",
  note_flagged: "text-orange-700",
  thin_evidence: "text-neutral-400",
  projection: "text-violet-700",
};

interface Props {
  card: PositionedCard;
  board: Board;
  pending: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  onHover: (id: string | null) => void;
  onFork: (id: string, fork: Fork) => void;
}

/** Expand is not only "more detail" (doc §5.1). These are the beats worth demoing. */
const QUICK_FORKS: { fork: Fork; label: string }[] = [
  { fork: "counter", label: "Counters" },
  { fork: "primary_only", label: "Primary only" },
  { fork: "falsifiers", label: "Change my mind" },
];

function BranchCardInner({
  card,
  board,
  pending,
  selected,
  onToggle,
  onHover,
  onFork,
}: Props) {
  const n = card.node;
  const posts = n.source_post_ids.map((id) => board.posts[id]).filter(Boolean);
  const innerRef = useRef<HTMLDivElement>(null);

  // measure the content, not the card — the card's own height comes FROM this
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
      const measure = () => reportHeight(n.id, el.offsetHeight + 32);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n.id]);

  return (
    <div
      className="gb-card absolute left-0 top-0 cursor-pointer select-none rounded-[10px] bg-white px-4 py-4"
      style={{
        transform: `translate3d(${card.x}px, ${card.y}px, 0)`,
        width: card.w,
        height: card.h,
        // an open parent stretched over its subtree gets the reference's big
        // sweeping corner, so the surface reads as one branch containing its
        // children rather than a tall empty box
        borderBottomLeftRadius: card.expanded
          ? Math.max(10, Math.min(card.h * 0.5, 220))
          : 10,
        // the selected card gets a whisper of lift, nothing more — borders would
        // fight the reference's borderless look
        boxShadow: selected
          ? "0 1px 2px rgba(0,0,0,.05), 0 8px 26px rgba(0,0,0,.10)"
          : "0 1px 2px rgba(0,0,0,.035)",
      }}
      onMouseEnter={() => onHover(n.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onToggle(n.id)}
    >
      <div ref={innerRef}>
      <h3
        className="gb-title text-[17px] leading-[1.28] tracking-[-0.011em] text-neutral-900"
        style={{ fontWeight: "var(--title-weight, 700)" as unknown as number }}
      >
        {n.title}
        {n.unread_depth ? (
          <span className="ml-1.5 inline-block h-[6px] w-[6px] translate-y-[-1px] rounded-full bg-[#22c55e] align-middle" />
        ) : null}
      </h3>

      {n.body ? (
        <p className="gb-body mt-2 text-[13px] leading-[1.55] tracking-[-0.002em]">
          {n.body}
        </p>
      ) : null}

      <div className="gb-detail mt-3 flex flex-nowrap items-center gap-1.5 overflow-hidden">
        {n.epistemic ? (
          <span
            className={`text-[10px] font-medium uppercase tracking-[0.07em] ${
              EPISTEMIC_TONE[n.epistemic] ?? "text-neutral-400"
            }`}
          >
            {EPISTEMIC_LABEL[n.epistemic]}
          </span>
        ) : null}
        {n.epistemic && posts.length ? (
          <span className="text-neutral-300">·</span>
        ) : null}
        {posts.slice(0, 2).map((p) => (
          <PostChip key={p.id} post={p} />
        ))}
        {posts.length > 2 ? (
          <span className="shrink-0 text-[10.5px] text-neutral-400">
            +{posts.length - 2}
          </span>
        ) : null}
      </div>

      {pending ? (
        <div className="gb-detail mt-2.5 flex items-center gap-1.5 text-[11px] text-neutral-400">
          <span className="gb-pulse h-[5px] w-[5px] rounded-full bg-neutral-400" />
          Grok is expanding…
        </div>
      ) : null}

      {selected && !pending ? (
        <div className="gb-detail mt-2.5 flex flex-wrap gap-1">
          {QUICK_FORKS.map((f) => (
            <button
              key={f.fork}
              onClick={(e) => {
                e.stopPropagation();
                onFork(n.id, f.fork);
              }}
              className="rounded-full bg-black/[0.045] px-2 py-[3px] text-[10px] font-medium text-neutral-600 transition-colors hover:bg-neutral-900 hover:text-white"
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      </div>
    </div>
  );
}

export const BranchCard = memo(BranchCardInner);
