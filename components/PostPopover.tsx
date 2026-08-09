"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { XPost } from "@/lib/schema";
import { useBoard } from "@/lib/store";
import { ago, stamp } from "@/lib/time";

/** Long enough that sweeping the cursor across a citation row opens nothing. */
const OPEN_DELAY = 110;
/** Short enough to feel closed, long enough to cross the gap into the panel. */
const CLOSE_GRACE = 180;
/**
 * Screen pixels, not board pixels. The panel is the one thing on this surface
 * that does NOT scale — a citation you opened in order to read has to be
 * readable at the zoom you happened to be at.
 */
const PANEL_W = 384;
const MARGIN = 12;
const GAP = 10;

export function compact(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function Avatar({ post, size }: { post: XPost; size: number }) {
  return post.author.avatar_url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={post.author.avatar_url}
      alt=""
      className="shrink-0 object-cover"
      style={{ width: size, height: size, borderRadius: 2 }}
    />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center font-semibold leading-none"
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        background: "rgba(255,255,255,0.1)",
        color: "var(--gb-dim)",
        fontSize: size * 0.4,
      }}
    >
      {initials(post.author.name)}
    </span>
  );
}

/**
 * One cited post, rendered as the post.
 *
 * Everything here was already on the client — the board ships `board.posts`
 * whole — and was reachable only through a native `title` tooltip: OS-styled,
 * ~1s late, invisible to touch and to the keyboard, silently truncated on
 * anything long. A citation you cannot read is a claim about grounding rather
 * than grounding, which is the one thing this board is not allowed to be.
 */
function PostBody({ post }: { post: XPost }) {
  const href = post.url ?? `https://x.com/i/status/${post.id}`;
  const photo = post.media?.[0];

  return (
    <article className="px-3.5 py-3">
      <header className="flex items-center gap-2">
        <Avatar post={post} size={30} />
        <div className="min-w-0 flex-1">
          <div
            className="flex items-baseline gap-1.5 truncate text-[13px] leading-tight"
            style={{ color: "var(--gb-text)" }}
          >
            <span className="truncate font-medium">{post.author.name}</span>
            {post.author.verified ? (
              <span style={{ color: "var(--gb-dim)", fontSize: 10 }}>✓</span>
            ) : null}
          </div>
          <div
            className="gb-label truncate"
            style={{ color: "var(--gb-dim)", textTransform: "none", fontSize: 11 }}
          >
            @{post.author.handle}
          </div>
        </div>
        {/* Relative over absolute: "2H" is what you read the panel for, the
            stamp under it is what you'd quote. Both are suppressed on an
            unverified post — its `created_at` is the moment WE minted the
            record, not the moment anyone posted, and printing that as "NOW"
            would dress up the one citation we could not confirm as the freshest
            thing on the board. */}
        {post.unverified ? null : (
          <span className="shrink-0 text-right">
            <span className="gb-label block" style={{ color: "var(--gb-dim)" }}>
              {ago(post.created_at)}
            </span>
            <span
              className="gb-label mt-1 block tabular-nums"
              style={{ color: "var(--gb-faint)" }}
            >
              {stamp(post.created_at)}
            </span>
          </span>
        )}
      </header>

      {/* The post's own words, at full length. `pre-wrap` because line breaks
          are authored content in a post — a list that arrives as one paragraph
          is a different post from the one that was written. */}
      <p
        className="mt-2.5 whitespace-pre-wrap break-words text-[13px] leading-[1.5]"
        style={{ color: "var(--gb-text)" }}
      >
        {post.text}
      </p>

      {/* What this post was quoting. Commentary without it is half a claim. */}
      {post.quoted ? (
        <div
          className="mt-2.5 border-l pl-2.5"
          style={{ borderColor: "var(--gb-line-hi)" }}
        >
          <div
            className="gb-label"
            style={{ color: "var(--gb-dim)", textTransform: "none", fontSize: 11 }}
          >
            @{post.quoted.author.handle}
          </div>
          <p
            className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-[1.45]"
            style={{ color: "var(--gb-dim)" }}
          >
            {post.quoted.text}
          </p>
        </div>
      ) : null}

      {photo ? (
        <div
          className="mt-2.5 overflow-hidden border"
          style={{ borderColor: "var(--gb-line)", borderRadius: 2 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={photo.alt ?? `Image posted by @${post.author.handle}`}
            className="block max-h-[200px] w-full object-cover"
          />
        </div>
      ) : null}

      {post.unverified ? (
        <div
          className="gb-label mt-2.5 border px-2 py-1.5 leading-[1.4]"
          style={{
            color: "var(--gb-warn)",
            borderColor: "var(--gb-warn)",
            borderStyle: "dashed",
            borderRadius: 2,
          }}
        >
          Unverified — Grok reported this post, X could not confirm it
        </div>
      ) : null}

      {/* Metrics get their own row rather than sharing one with the link.
          Sharing it, a post with four-figure counts wrapped "210 REPLIES" down
          on top of "OPEN ON X" — and the mono label is wide enough that this is
          the common case, not the long tail. */}
      <footer className="mt-3 border-t pt-2" style={{ borderColor: "var(--gb-line)" }}>
        {post.metrics ? (
          <div
            className="gb-label tabular-nums"
            style={{ color: "var(--gb-faint)", lineHeight: 1.5 }}
          >
            {compact(post.metrics.likes)} likes · {compact(post.metrics.reposts)}{" "}
            reposts · {compact(post.metrics.replies)} replies
          </div>
        ) : null}
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="gb-label mt-1 inline-block transition-colors"
          style={{ color: "var(--gb-dim)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gb-text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gb-dim)")}
        >
          Open on X ↗
        </a>
      </footer>
    </article>
  );
}

function Panel({
  posts,
  anchorRef,
  onEnter,
  onLeave,
}: {
  posts: XPost[];
  anchorRef: { current: HTMLElement | null };
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  /**
   * Placement is written straight to the node, never through state.
   *
   * The board re-lays-out on every wheel tick and this panel is glued to a chip
   * that is moving with it — routed through React that would be a full re-render
   * per frame, which is the exact cost `ZoomSurface` restructured itself to
   * avoid. Same discipline here.
   */
  const place = useCallback(() => {
    const a = anchorRef.current;
    const p = ref.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    const w = p.offsetWidth;
    const h = p.offsetHeight;

    const left = Math.max(
      MARGIN,
      Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - MARGIN),
    );
    // above by preference — a citation row sits low on a card, and opening
    // downward covers the fork buttons you might be reaching for next
    const above = r.top - h - GAP;
    const top =
      above >= MARGIN
        ? above
        : Math.max(MARGIN, Math.min(r.bottom + GAP, window.innerHeight - h - MARGIN));

    p.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    p.style.opacity = "1";
  }, [anchorRef]);

  useLayoutEffect(() => {
    place();
    // pan and zoom both move the anchor; the store tick is the same signal the
    // surface itself repaints from
    const unsub = useBoard.subscribe(place);
    window.addEventListener("resize", place);
    return () => {
      unsub();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      className="fixed left-0 top-0 z-50 overflow-y-auto overscroll-contain shadow-2xl"
      style={{
        width: PANEL_W,
        maxHeight: "62vh",
        // starts invisible: the first paint happens before `place` has measured
        // it, and a panel that flashes at 0,0 reads as a bug
        opacity: 0,
        background: "var(--gb-panel)",
        border: "1px solid var(--gb-line-max)",
        borderRadius: 3,
        transition: "opacity 120ms linear",
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // the surface pans on pointerdown anywhere; inside the panel a drag is
      // someone selecting the quote they came here to read
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {posts.map((p, i) => (
        <div
          key={p.id}
          style={
            i > 0 ? { borderTop: "1px solid var(--gb-line)" } : undefined
          }
        >
          <PostBody post={p} />
        </div>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Hover-or-click to read the cited posts, anchored to any trigger element.
 *
 * Click pins so the panel survives the trip to a link inside it; modified and
 * middle clicks are left alone so a chip that looks like a link still behaves
 * like one in a new tab.
 */
export function useCitationPopover<T extends HTMLElement>(posts: XPost[]) {
  const anchorRef = useRef<T | null>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const close = useCallback(() => {
    cancel();
    pinned.current = false;
    setOpen(false);
  }, [cancel]);

  const enter = useCallback(() => {
    cancel();
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  }, [cancel]);

  const leave = useCallback(() => {
    cancel();
    if (pinned.current) return;
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_GRACE);
  }, [cancel]);

  const click = useCallback(
    (e: React.MouseEvent) => {
      // let the browser do its own thing for cmd/ctrl/middle-click
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
      pinned.current = true;
      setOpen(true);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if ((e.target as HTMLElement).closest?.("[role='dialog']")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);

  const trigger = {
    ref: anchorRef,
    onMouseEnter: enter,
    onMouseLeave: leave,
    onFocus: enter,
    onBlur: leave,
    onClick: click,
  };

  const panel = open ? (
    <Panel posts={posts} anchorRef={anchorRef} onEnter={cancel} onLeave={leave} />
  ) : null;

  return { trigger, panel, open };
}
