"use client";

import { useEffect, useState } from "react";
import { useBoard } from "@/lib/store";

/**
 * A card fetches its own picture.
 *
 * Generation measures ~7.6s, which cannot sit inside an expand — the column has
 * to land on the click. So the expander returns a prompt and no image, and this
 * asks for the bytes once the card is on screen: three cards generate in
 * parallel, and a failure belongs to the card that failed instead of taking the
 * whole branch with it.
 *
 * The result is cached on disk by prompt hash, so a re-open, a reload or a
 * replayed snapshot costs nothing and returns instantly.
 */

/** in flight or already done, keyed by prompt — React 19 double-invokes effects */
const inflight = new Map<string, Promise<string>>();

function requestImage(prompt: string): Promise<string> {
  const hit = inflight.get(prompt);
  if (hit) return hit;
  const p = fetch("/api/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
    .then(async (r) => {
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.url) throw new Error(data?.error ?? `image failed (${r.status})`);
      return data.url as string;
    })
    .catch((err) => {
      // let a later mount retry rather than caching the failure forever
      inflight.delete(prompt);
      throw err;
    });
  inflight.set(prompt, p);
  return p;
}

export function OptionImage({
  nodeId,
  prompt,
  url,
}: {
  nodeId: string;
  prompt?: string;
  url?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  /**
   * Dedupe on the request, never on the mount.
   *
   * The obvious guard — a ref saying "already asked" — is wrong under React's
   * double-invoked dev effects: the first pass sets the ref and its cleanup
   * marks itself stale, the second pass sees the ref and returns, and the image
   * that WAS generated gets discarded by the first pass's own staleness check.
   * The picture is paid for and then thrown away, silently, every time.
   *
   * So `inflight` does the deduping by prompt, and the result is written to the
   * store unconditionally — a store write is idempotent and safe after unmount,
   * and the card is keyed by node id, so nothing can land on the wrong one.
   */
  useEffect(() => {
    if (url || !prompt) return;
    let live = true;
    requestImage(prompt)
      .then((got) => useBoard.getState().setMedia(nodeId, got))
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "image failed");
      });
    return () => {
      live = false;
    };
  }, [nodeId, prompt, url]);

  if (!prompt && !url) return null;

  if (error) {
    // a silent failure is indistinguishable from a card that never wanted an
    // image — say it, quietly, in the space the image would have taken
    return (
      <div
        className="gb-attribution gb-label mb-3 flex items-center gap-2 border px-2 py-[7px]"
        style={{
          borderColor: "var(--gb-line)",
          color: "var(--gb-faint)",
          borderRadius: 2,
          letterSpacing: "0.06em",
        }}
      >
        <span>!</span>
        <span>no image — {error}</span>
      </div>
    );
  }

  return (
    <div
      className="relative mb-3 overflow-hidden"
      style={{
        borderRadius: 2,
        background: "rgba(255,255,255,0.03)",
        // hold the space before the bytes land so the card doesn't jump when
        // the image resolves — measured height feeds the layout
        aspectRatio: "4 / 3",
      }}
    >
      {url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={prompt ?? ""}
            onLoad={() => setLoaded(true)}
            className="h-full w-full object-cover transition-opacity duration-500"
            style={{ opacity: loaded ? 1 : 0 }}
          />
          {/*
            This is the one thing on the board we did not retrieve from the
            world. An unverified post renders differently for the same reason:
            nobody should have to guess which pixels we fetched and which we
            made.
          */}
          <span
            className="gb-label absolute bottom-[6px] right-[6px] px-[5px] py-[2px]"
            style={{
              background: "rgba(0,0,0,0.62)",
              color: "var(--gb-faint)",
              fontSize: "9.5px",
              letterSpacing: "0.1em",
              borderRadius: 2,
              backdropFilter: "blur(4px)",
            }}
          >
            GENERATED
          </span>
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className="gb-pulse h-[4px] w-[4px] rounded-full"
            style={{ background: "var(--gb-live)" }}
          />
        </div>
      )}
    </div>
  );
}
