"use client";

import { useState } from "react";
import { formatDuration, frameAspect, type CardMediaItem } from "@/lib/media";

/**
 * The pictures on a card.
 *
 * Three constraints shaped this, in order of how much they cost to get wrong:
 *
 * 1. DETERMINISTIC HEIGHT. Card heights are DOM-measured and fed back into the
 *    band layout, so a box that grows when its bytes arrive would reflow the
 *    whole column mid-flight. The X API gives us intrinsic width and height,
 *    so the frame takes the image's OWN shape and is still final on first
 *    paint — laid out to its true proportions without ever waiting on the
 *    network. See frameAspect for why it's clamped.
 *
 * 2. IT PARTICIPATES IN THE ZOOM. A photograph at full strength on a zoomed-out
 *    board would be the loudest thing on a surface whose entire rule is that
 *    the only saturated pixels mean "contested". So it rides --body-reveal:
 *    near-monochrome texture in the overview, full colour once you're reading.
 *    See .gb-media in globals.css.
 *
 * 3. ONE FRAME, NOT A CONTACT SHEET. At one card wide, three thumbnails are three
 *    unreadable squares. Show the picture from the post with the most reach and
 *    count the rest — the media fork is how you read them all.
 *
 * Video is the preview frame. Never autoplay: a card that starts moving while
 * you're reading its neighbour is a bug, and on stage it's a disaster.
 */
export function CardMedia({
  items,
  /**
   * On a vision card the image IS the claim, so nothing may be cropped out of
   * it — you have to be able to check the reading against the whole frame.
   * Everywhere else the picture is supporting evidence at card width, where a
   * filled frame reads better than a letterboxed one, and the full image is
   * one click away on the post.
   */
  fit = "cover",
}: {
  items: CardMediaItem[];
  fit?: "cover" | "contain";
}) {
  const [dead, setDead] = useState(false);
  const hero = items[0];
  if (!hero || dead) return null;

  const more = items.length - 1;
  const postUrl = hero.postId
    ? `https://x.com/${hero.handle || "i"}/status/${hero.postId}`
    : undefined;
  const duration = formatDuration(hero.durationMs);

  return (
    <div
      className="gb-media relative mt-3 overflow-hidden"
      style={{
        borderRadius: 2,
        border: "1px solid var(--gb-line)",
        background: "rgba(255,255,255,0.03)",
        // the height is known before the bytes are — see (1) above
        aspectRatio: String(frameAspect(hero)),
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={hero.url}
        // a real timeline read returned 30 media objects and zero alt text, so
        // this is almost always the fallback. Name the source rather than
        // shipping an empty alt.
        alt={hero.alt ?? (hero.handle ? `Image posted by @${hero.handle}` : "Post image")}
        loading="lazy"
        // a rotted twimg URL should cost the picture, not the card
        onError={() => setDead(true)}
        className="h-full w-full"
        // centre, not top. Timeline media is a mix of near-square screenshots,
        // portrait promo cards and 16:9 video frames; measured across a real
        // read, top-anchoring only helped the screenshots and beheaded
        // everything else.
        style={{ objectFit: fit, objectPosition: "center" }}
      />

      {/* Which post this came off, and the way out to the real thing.
          The image is a citation too, and an unattributed photograph on a card
          about a contested claim is exactly the kind of authority-by-
          association the epistemic layer exists to stop.

          Only the badge is clickable, deliberately. The frame is a third of the
          card's surface, and the card's own click is expand — the interaction
          the whole product is built on. Handing that area to a link would trade
          the primary gesture for a secondary one. The badge is enough of a
          target to open the post at full size, and it rides the attribution
          ramp, so it can't be clicked while it's invisible. */}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-[6px]">
        {hero.handle ? (
          <a
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="gb-attribution gb-label truncate transition-colors"
            style={{
              background: "rgba(0,0,0,0.62)",
              color: "var(--gb-dim)",
              padding: "2px 5px",
              borderRadius: 2,
              letterSpacing: "0.08em",
              backdropFilter: "blur(4px)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gb-text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gb-dim)")}
          >
            @{hero.handle} ↗
          </a>
        ) : (
          <span />
        )}
        {more > 0 ? (
          <span
            className="gb-label pointer-events-none shrink-0 tabular-nums"
            style={{
              background: "rgba(0,0,0,0.62)",
              color: "var(--gb-faint)",
              padding: "2px 5px",
              borderRadius: 2,
              backdropFilter: "blur(4px)",
            }}
          >
            +{more}
          </span>
        ) : null}
      </div>

      {/* A still frame that says nothing is a still frame you assume is a
          photo. Mark it, and don't pretend it plays here. */}
      {hero.kind !== "photo" ? (
        <span
          className="gb-label pointer-events-none absolute right-[6px] top-[6px]"
          style={{
            background: "rgba(0,0,0,0.62)",
            color: "var(--gb-dim)",
            padding: "2px 5px",
            borderRadius: 2,
            letterSpacing: "0.1em",
            backdropFilter: "blur(4px)",
          }}
        >
          {hero.kind === "video"
            ? // the length matters: a 30s clip and a five-minute talk are
              // different asks, and the still frame can't tell you which
              duration
              ? `Video ${duration}`
              : "Video"
            : "GIF"}
        </span>
      ) : null}
    </div>
  );
}
