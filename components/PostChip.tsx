"use client";

import type { XPost } from "@/lib/schema";

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function compact(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * The citation. This is the product's honesty surface — a claim without one of
 * these is a claim we shouldn't be making.
 *
 * Styled as a hairline tag rather than a filled pill: on black, a filled chip
 * competes with the card itself for attention, and the citation should be
 * available without being loud.
 */
export function PostChip({ post }: { post: XPost }) {
  return (
    <a
      href={post.url ?? `https://x.com/i/status/${post.id}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={
        post.unverified
          ? `UNVERIFIED — Grok reported this post but we could not confirm it exists on X.\n\n@${post.author.handle}: ${post.text}`
          : `${post.author.name} (@${post.author.handle})\n\n${post.text}`
      }
      className="group flex shrink-0 items-center gap-1.5 border px-1.5 py-[3px] transition-colors"
      style={{
        // dashed = we could not confirm this post exists. never let an
        // unconfirmed citation look identical to a verified one.
        borderColor: post.unverified ? "var(--gb-warn)" : "var(--gb-line)",
        borderStyle: post.unverified ? "dashed" : "solid",
        borderRadius: 2,
      }}
      onMouseEnter={(e) => {
        if (!post.unverified) e.currentTarget.style.borderColor = "var(--gb-line-max)";
      }}
      onMouseLeave={(e) => {
        if (!post.unverified) e.currentTarget.style.borderColor = "var(--gb-line)";
      }}
    >
      {post.author.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.author.avatar_url}
          alt=""
          className="h-[16px] w-[16px] shrink-0 object-cover"
          style={{ borderRadius: 1 }}
        />
      ) : (
        <span
          className="flex h-[16px] w-[16px] shrink-0 items-center justify-center text-[8px] font-semibold leading-none"
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
      {post.metrics ? (
        <span
          className="gb-label whitespace-nowrap tabular-nums"
          style={{ color: "var(--gb-faint)", fontSize: "10.5px" }}
        >
          {compact(post.metrics.likes)}
        </span>
      ) : null}
    </a>
  );
}
