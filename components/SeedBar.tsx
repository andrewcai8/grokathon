"use client";

import { useEffect, useState } from "react";
import type { Board } from "@/lib/schema";

interface Me {
  connected: boolean;
  handle: string | null;
  canConnect: boolean;
  grok: boolean;
}

/**
 * "That's my real feed" is the second-biggest beat in the demo (doc §0), so the
 * provenance of the board has to be visible and honest: connected or not,
 * live or snapshot. Never let the audience wonder which they're looking at.
 */
export function SeedBar({
  board,
  onBoard,
}: {
  board: Board | null;
  onBoard: (b: Board) => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => {});
  }, []);

  const reseed = async (url: string, what: string) => {
    setBusy(what);
    setError(null);
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data?.board?.root_ids?.length) {
        onBoard(data.board);
        if (data.source === "fixtures" || data.source === "fixtures_fallback") {
          setError("fell back to fixtures — check the server log");
        }
      } else {
        setError("no board returned");
      }
    } catch {
      setError("request failed");
    } finally {
      setBusy(null);
    }
  };

  const live = board && !board.seed.snapshot;

  return (
    <div className="border-t border-black/[0.055] px-5 py-4">
      {me?.connected ? (
        <div className="mb-2.5 flex items-center gap-1.5">
          <span className="h-[6px] w-[6px] rounded-full bg-[#22c55e]" />
          <span className="text-[11px] font-medium text-neutral-700">
            @{me.handle}
          </span>
          <span className="text-[11px] text-neutral-400">
            {live ? "· live" : "· snapshot"}
          </span>
        </div>
      ) : me?.canConnect ? (
        <a
          href="/api/auth/login"
          className="mb-2.5 block rounded-md bg-neutral-900 px-3 py-2 text-center text-[11.5px] font-medium text-white transition-opacity hover:opacity-85"
        >
          Connect X
        </a>
      ) : (
        <div className="mb-2.5 text-[11px] text-neutral-400">
          X credentials not configured
        </div>
      )}

      <div className="flex flex-col gap-1">
        {me?.connected ? (
          <button
            onClick={() => reseed("/api/seed?live=1", "live")}
            disabled={Boolean(busy)}
            className="rounded-md px-2 py-1.5 text-left text-[11.5px] text-neutral-600 transition-colors hover:bg-black/[0.045] disabled:opacity-45"
          >
            {busy === "live" ? "Reading your timeline…" : "🔄 Reseed from my timeline"}
          </button>
        ) : null}
        <button
          onClick={() => reseed("/api/seed?snapshot=latest", "snap")}
          disabled={Boolean(busy)}
          className="rounded-md px-2 py-1.5 text-left text-[11.5px] text-neutral-600 transition-colors hover:bg-black/[0.045] disabled:opacity-45"
        >
          {busy === "snap" ? "Loading…" : "💾 Load snapshot"}
        </button>
      </div>

      {error ? (
        <div className="mt-2 text-[10.5px] leading-tight text-amber-700">{error}</div>
      ) : null}
      {me && !me.grok ? (
        <div className="mt-2 text-[10.5px] leading-tight text-amber-700">
          XAI_API_KEY not set — structure is fixtures only
        </div>
      ) : null}
    </div>
  );
}
