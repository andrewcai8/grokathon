"use client";

import { memo, useEffect, useRef } from "react";
import type { PositionedCard } from "@/lib/layout";
import type { Board, Fork, XPost } from "@/lib/schema";
import { EPISTEMIC_LABEL, FORK_LABEL, reportHeight } from "@/lib/store";
import { PostChip } from "./PostChip";

/**
 * Colour is the epistemic channel and nothing else. On a black board the only
 * saturated pixels mean "this is contested" or "this is flagged" — so status
 * reads from across the room without a legend.
 */
const EPISTEMIC_TONE: Record<string, string> = {
  widely_shared: "var(--gb-dim)",
  contested: "var(--gb-warn)",
  note_flagged: "var(--gb-flag)",
  thin_evidence: "var(--gb-faint)",
  projection: "var(--gb-proj)",
};

/**
 * One chip per ACCOUNT, not per post.
 *
 * "widely_shared" is a claim about corroboration ACROSS accounts, so ten posts
 * from one handle must never render like ten sources — that's the exact
 * inflation the epistemic layer exists to prevent. Ordered by reach so the cap
 * drops the long tail rather than whoever happened to be cited first.
 */
function distinctAccounts(posts: XPost[]) {
  const byAccount = new Map<string, { post: XPost; count: number }>();
  for (const p of posts) {
    const key = p.author.handle.toLowerCase();
    const hit = byAccount.get(key);
    if (hit) {
      hit.count += 1;
      // keep the account's best-performing post as the chip's link target
      if ((p.metrics?.likes ?? 0) > (hit.post.metrics?.likes ?? 0)) hit.post = p;
    } else {
      byAccount.set(key, { post: p, count: 1 });
    }
  }
  return [...byAccount.values()].sort(
    (a, b) => (b.post.metrics?.likes ?? 0) - (a.post.metrics?.likes ?? 0),
  );
}

/** Enough to read corroboration at a glance; past this it's just wallpaper. */
const SOURCE_CAP = 6;

interface Props {
  card: PositionedCard;
  board: Board;
  pending: boolean;
  error?: string;
  selected: boolean;
  /** an ancestor of (or is) the hovered/selected node */
  onPath: boolean;
  onToggle: (id: string) => void;
  onHover: (id: string | null) => void;
  onFork: (id: string, fork: Fork) => void;
}

/** Expand is not only "more detail" (doc §5.1). These are the beats worth demoing. */
const QUICK_FORKS: { fork: Fork; label: string }[] = [
  { fork: "replies", label: "Replies" },
  { fork: "counter", label: "Counters" },
  { fork: "primary_only", label: "Primary" },
  { fork: "falsifiers", label: "Falsify" },
];

function BranchCardInner({
  card,
  board,
  pending,
  error,
  selected,
  onPath,
  onToggle,
  onHover,
  onFork,
}: Props) {
  const n = card.node;
  const posts = n.source_post_ids.map((id) => board.posts[id]).filter(Boolean);
  const sources = distinctAccounts(posts);
  const shown = sources.slice(0, SOURCE_CAP);
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
      className="gb-card absolute left-0 top-0 cursor-pointer select-none px-4 py-4"
      data-expanded={card.expanded ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-onpath={onPath ? "true" : "false"}
      style={{
        transform: `translate3d(${card.x}px, ${card.y}px, 0)`,
        width: card.w,
        height: card.h,
      }}
      onMouseEnter={() => onHover(n.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onToggle(n.id)}
    >
      <div ref={innerRef}>
        {/* the node's own coordinates, stated plainly. depth · generality is the
            board's addressing scheme, so it belongs on the card like a part
            number rather than hidden in a tooltip. */}
        <div
          className="gb-detail gb-label mb-2.5 flex items-center gap-2"
          style={{ color: "var(--gb-faint)" }}
        >
          <span>
            {String(card.col).padStart(2, "0")} / {n.type}
          </span>
          {/* which fork produced this child. we record it, so we show it —
              otherwise a counter-branch is indistinguishable from a deeper one
              once it lands in the same column. */}
          {n.fork ? (
            <span
              className="border px-1 py-[1px]"
              style={{
                borderColor: "var(--gb-line-hi)",
                color: "var(--gb-dim)",
                borderRadius: 2,
              }}
            >
              {FORK_LABEL[n.fork]}
            </span>
          ) : null}
          <span className="h-px flex-1" style={{ background: "var(--gb-line)" }} />
          <span className="tabular-nums">{n.generality.toFixed(2)}</span>
        </div>

        <h3
          className="gb-title text-[17px] leading-[1.3] tracking-[-0.014em]"
          style={{
            color: "var(--gb-text)",
            fontWeight: "var(--title-weight, 600)" as unknown as number,
          }}
        >
          {n.title}
          {n.unread_depth ? (
            <span
              className="ml-1.5 inline-block h-[5px] w-[5px] translate-y-[-2px] rounded-full align-middle"
              style={{
                background: "var(--gb-live)",
                boxShadow: "0 0 8px var(--gb-live)",
              }}
            />
          ) : null}
        </h3>

        {n.body ? (
          <p className="gb-body mt-2 text-[13px] leading-[1.55] tracking-[-0.002em]">
            {n.body}
          </p>
        ) : null}

        {/* Status gets its own line so the citations get the card's full width.
            They used to share one clipped row, which meant a claim corroborated
            by six accounts displayed exactly like a claim from one — the single
            most important thing the epistemic layer has to distinguish. */}
        <div className="gb-attribution mt-3.5">
          {n.epistemic ? (
            <div
              className="gb-label"
              style={{
                color: EPISTEMIC_TONE[n.epistemic] ?? "var(--gb-faint)",
                fontSize: "10.5px",
              }}
            >
              {EPISTEMIC_LABEL[n.epistemic]}
              {sources.length ? (
                <span style={{ color: "var(--gb-faint)" }}>
                  {"  ·  "}
                  {/* account count only — the ×N badges already carry how many
                      posts each one contributed, and spelling both out here
                      wrapped the status line onto two rows */}
                  {sources.length} {sources.length === 1 ? "account" : "accounts"}
                </span>
              ) : null}
            </div>
          ) : null}

          {shown.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {shown.map((s) => (
                <PostChip key={s.post.id} post={s.post} count={s.count} />
              ))}
              {sources.length > shown.length ? (
                <span
                  className="gb-label tabular-nums"
                  style={{ color: "var(--gb-faint)", fontSize: "10.5px" }}
                >
                  +{sources.length - shown.length}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {pending ? (
          <div
            className="gb-attribution gb-label mt-3 flex items-center gap-2"
            style={{ color: "var(--gb-dim)" }}
          >
            <span
              className="gb-pulse h-[4px] w-[4px] rounded-full"
              style={{ background: "var(--gb-live)" }}
            />
            Grok expanding
          </div>
        ) : null}

        {error && !pending ? (
          <div
            className="gb-attribution gb-label mt-3 flex items-start gap-2 leading-[1.5]"
            style={{ color: "var(--gb-warn)", letterSpacing: "0.06em" }}
          >
            <span>!</span>
            <span>{error} — click to retry</span>
          </div>
        ) : null}

        {selected && !pending ? (
          <div className="gb-attribution mt-3 flex flex-wrap gap-1.5">
            {QUICK_FORKS.map((f) => (
              <button
                key={f.fork}
                onClick={(e) => {
                  e.stopPropagation();
                  onFork(n.id, f.fork);
                }}
                className="gb-label border px-2 py-[5px] transition-colors"
                style={{
                  borderColor: "var(--gb-line-hi)",
                  color: "var(--gb-dim)",
                  borderRadius: 2,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--gb-text)";
                  e.currentTarget.style.color = "#000";
                  e.currentTarget.style.borderColor = "var(--gb-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--gb-dim)";
                  e.currentTarget.style.borderColor = "var(--gb-line-hi)";
                }}
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
