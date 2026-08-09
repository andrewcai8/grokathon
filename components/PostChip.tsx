"use client";

import type { XPost } from "@/lib/schema";
import { compact, initials, useCitationPopover } from "./PostPopover";

/**
 * The citation. This is the product's honesty surface — a claim without one of
 * these is a claim we shouldn't be making.
 *
 * Styled as a hairline tag rather than a filled pill: on black, a filled chip
 * competes with the card itself for attention, and the citation should be
 * available without being loud.
 *
 * The chip is the handle; hovering or clicking it opens the posts themselves.
 * It takes every post this account contributed rather than just the best one —
 * the `×3` badge used to be the end of the road for the other two, which made
 * the corroboration count something you had to take on faith.
 */
export function PostChip({ posts }: { posts: XPost[] }) {
  const post = posts[0];
  const count = posts.length;
  const { trigger, panel } = useCitationPopover<HTMLAnchorElement>(posts);

  return (
    <>
      <a
        {...trigger}
        href={post.url ?? `https://x.com/i/status/${post.id}`}
        target="_blank"
        rel="noreferrer"
        className="group flex shrink-0 items-center gap-1 border px-[5px] py-[3px] transition-colors"
        style={{
          // dashed = we could not confirm this post exists. never let an
          // unconfirmed citation look identical to a verified one.
          borderColor: post.unverified ? "var(--gb-warn)" : "var(--gb-line)",
          borderStyle: post.unverified ? "dashed" : "solid",
          borderRadius: 2,
        }}
        onMouseEnter={(e) => {
          trigger.onMouseEnter();
          if (!post.unverified) e.currentTarget.style.borderColor = "var(--gb-line-max)";
        }}
        onMouseLeave={(e) => {
          trigger.onMouseLeave();
          if (!post.unverified) e.currentTarget.style.borderColor = "var(--gb-line)";
        }}
      >
        {post.author.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.author.avatar_url}
            alt=""
            className="h-[15px] w-[15px] shrink-0 object-cover"
            style={{ borderRadius: 1 }}
          />
        ) : (
          <span
            className="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-[8px] font-semibold leading-none"
            style={{
              background: "rgba(255,255,255,0.1)",
              color: "var(--gb-dim)",
              borderRadius: 1,
            }}
          >
            {initials(post.author.name)}
          </span>
        )}
        {/* deliberately NOT uppercased like the rest of the mono labels: a handle
            is an identity, and @lowercase is how it's recognised as a real X
            account. Uppercasing it turned citations into callsigns. */}
        <span
          className="gb-label whitespace-nowrap transition-colors group-hover:!text-[var(--gb-text)]"
          style={{
            color: "var(--gb-dim)",
            letterSpacing: "0.02em",
            // sized for the RESTING zoom, not for 100%. At the default 0.62 a
            // 10px handle rendered at ~6px — present but not actually readable,
            // which is the same failure as hiding it.
            fontSize: "11.5px",
            // inline, not a `normal-case` class: .gb-label is unlayered CSS and
            // outranks Tailwind's layered utilities
            textTransform: "none",
          }}
        >
          @{post.author.handle}
        </span>
        {/* this account cited more than once on the same node */}
        {count > 1 ? (
          <span
            className="gb-label whitespace-nowrap tabular-nums"
            style={{ color: "var(--gb-dim)", fontSize: "10.5px" }}
          >
            ×{count}
          </span>
        ) : post.metrics ? (
          <span
            className="gb-label whitespace-nowrap tabular-nums"
            style={{ color: "var(--gb-faint)", fontSize: "10.5px" }}
          >
            {compact(post.metrics.likes)}
          </span>
        ) : null}
      </a>
      {panel}
    </>
  );
}

/**
 * The tail of the citation row, past the cap.
 *
 * `+4` used to be inert text — the four accounts a card ranked lowest were
 * cited on screen and unreadable by any gesture, which is a worse failure than
 * not listing them at all. Same panel, opened from the overflow instead of a
 * handle.
 */
export function MoreCitations({ posts }: { posts: XPost[] }) {
  const { trigger, panel } = useCitationPopover<HTMLButtonElement>(posts);
  const accounts = new Set(posts.map((p) => p.author.handle.toLowerCase())).size;

  return (
    <>
      <button
        {...trigger}
        type="button"
        className="gb-label shrink-0 tabular-nums transition-colors"
        style={{ color: "var(--gb-faint)", fontSize: "10.5px" }}
        onMouseEnter={(e) => {
          trigger.onMouseEnter();
          e.currentTarget.style.color = "var(--gb-text)";
        }}
        onMouseLeave={(e) => {
          trigger.onMouseLeave();
          e.currentTarget.style.color = "var(--gb-faint)";
        }}
      >
        +{accounts}
      </button>
      {panel}
    </>
  );
}
