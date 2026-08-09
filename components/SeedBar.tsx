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
 *
 * Reads as a status block — source, link state, actions — because that framing
 * makes the honesty structural rather than a disclaimer.
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
  const [question, setQuestion] = useState("");

  /**
   * The other kind of board.
   *
   * Same surface, same zoom, same recursion — it just narrows instead of
   * evidencing. Starting one is a sentence rather than a mode switch, because
   * the decision the user has in mind IS the seed, and asking them to pick
   * "options mode" first would make them describe it twice.
   */
  const narrow = async () => {
    const prompt = question.trim();
    if (!prompt) return;
    setBusy("narrow");
    setError(null);
    try {
      const res = await fetch("/api/board/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.board?.root_ids?.length) {
        setError(data?.error ?? "could not build that board");
      } else {
        onBoard(data.board);
      }
    } catch {
      setError("request failed");
    } finally {
      setBusy(null);
    }
  };

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

  const action =
    "gb-label w-full border px-2.5 py-[9px] text-left transition-colors disabled:opacity-40";
  const actionStyle = {
    borderColor: "var(--gb-line)",
    color: "var(--gb-dim)",
    borderRadius: 2,
  };
  const hoverOn = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.currentTarget.disabled) return;
    e.currentTarget.style.borderColor = "var(--gb-line-max)";
    e.currentTarget.style.color = "var(--gb-text)";
  };
  const hoverOff = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.borderColor = "var(--gb-line)";
    e.currentTarget.style.color = "var(--gb-dim)";
  };

  return (
    <div className="px-5 py-4" style={{ borderTop: "1px solid var(--gb-line)" }}>
      {me?.connected ? (
        <div className="gb-label mb-3 flex items-center gap-2">
          <span
            className="h-[5px] w-[5px] rounded-full"
            style={{
              background: live ? "var(--gb-live)" : "var(--gb-faint)",
              boxShadow: live ? "0 0 8px var(--gb-live)" : "none",
            }}
          />
          <span style={{ color: "var(--gb-text)" }}>{me.handle}</span>
          <span className="h-px flex-1" style={{ background: "var(--gb-line)" }} />
          <span style={{ color: live ? "var(--gb-live)" : "var(--gb-faint)" }}>
            {live ? "Live" : "Snapshot"}
          </span>
        </div>
      ) : me?.canConnect ? (
        <a
          href="/api/auth/login"
          className="gb-label mb-3 block px-3 py-[10px] text-center transition-opacity hover:opacity-80"
          style={{ background: "var(--gb-text)", color: "#000", borderRadius: 2 }}
        >
          Connect X
        </a>
      ) : (
        <div className="gb-label mb-3" style={{ color: "var(--gb-faint)" }}>
          X credentials not configured
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {me?.connected ? (
          <button
            onClick={() => reseed("/api/seed?live=1", "live")}
            disabled={Boolean(busy)}
            className={action}
            style={actionStyle}
            onMouseEnter={hoverOn}
            onMouseLeave={hoverOff}
          >
            {busy === "live" ? "Reading X…" : "↻ Reseed my day"}
          </button>
        ) : null}
        <button
          onClick={() => reseed("/api/seed?snapshot=latest", "snap")}
          disabled={Boolean(busy)}
          className={action}
          style={actionStyle}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
        >
          {busy === "snap" ? "Loading…" : "◧ Load snapshot"}
        </button>
      </div>

      <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--gb-line)" }}>
        <div className="gb-label mb-2" style={{ color: "var(--gb-faint)" }}>
          Narrow it down
        </div>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void narrow();
          }}
          disabled={Boolean(busy)}
          placeholder="help me pick a car under $30k"
          className="gb-label w-full border px-2.5 py-[9px] outline-none transition-colors disabled:opacity-40"
          style={{
            borderColor: "var(--gb-line)",
            color: "var(--gb-text)",
            background: "transparent",
            borderRadius: 2,
            textTransform: "none",
            letterSpacing: "0.01em",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--gb-line-max)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--gb-line)";
          }}
        />
        <button
          onClick={() => void narrow()}
          disabled={Boolean(busy) || !question.trim()}
          className={`${action} mt-1.5`}
          style={actionStyle}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
        >
          {busy === "narrow" ? "Searching the web…" : "→ Give me three options"}
        </button>
      </div>

      {error ? (
        <div
          className="gb-label mt-3 leading-[1.5]"
          style={{ color: "var(--gb-warn)", letterSpacing: "0.06em" }}
        >
          {error}
        </div>
      ) : null}
      {me && !me.grok ? (
        <div
          className="gb-label mt-3 leading-[1.5]"
          style={{ color: "var(--gb-warn)", letterSpacing: "0.06em" }}
        >
          XAI_API_KEY not set — fixtures only
        </div>
      ) : null}
    </div>
  );
}
