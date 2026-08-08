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
 */
export function PostChip({ post }: { post: XPost }) {
  return (
    <a
      href={post.url ?? `https://x.com/i/status/${post.id}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`${post.author.name} (@${post.author.handle})\n\n${post.text}`}
      className="group flex items-center gap-1.5 rounded-full bg-black/[0.045] px-1.5 py-1 pr-2.5 transition-colors hover:bg-black/[0.09]"
    >
      {post.author.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.author.avatar_url}
          alt=""
          className="h-4 w-4 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-[7px] font-semibold leading-none text-white">
          {initials(post.author.name)}
        </span>
      )}
      <span className="whitespace-nowrap text-[10.5px] font-medium leading-none text-neutral-600 group-hover:text-neutral-900">
        @{post.author.handle}
      </span>
      {post.metrics ? (
        <span className="whitespace-nowrap text-[10.5px] leading-none text-neutral-400 tabular-nums">
          {compact(post.metrics.likes)}
        </span>
      ) : null}
    </a>
  );
}
