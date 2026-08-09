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
   * Which kind of board you're steering.
   *
   * Held separately from the board's own kind because you need to be able to
   * stand in the options pane while a news board is still on screen — that's
   * the whole moment of typing a question. It follows the board whenever the
   * board changes underneath you, so the rail never claims you're somewhere
   * you aren't.
   */
  const [pane, setPane] = useState<"news" | "options">(board?.kind ?? "news");
  useEffect(() => {
    if (board?.kind) setPane(board.kind);
  }, [board?.kind]);

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

  const reseed = async (url: string, what: string, quiet = false) => {
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
        return true;
      }
      if (!quiet) setError(data?.error ?? "no board returned");
      return false;
    } catch {
      if (!quiet) setError("request failed");
      return false;
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

  /**
   * The two things this surface can be pointed at.
   *
   * Both are the same board — same layout, same zoom, same recursion — so this
   * is a switch of subject, not of mode: what's happening on X, or a decision
   * you're trying to make. Naming them as a pair is also the clearest statement
   * that the paradigm generalises, which is otherwise invisible until you type
   * something into it.
   */
  const tab = (id: "news" | "options", label: string) => (
    <button
      key={id}
      onClick={() => {
        setError(null);
        setPane(id);
        // A toggle that changes the sidebar but not the canvas reads as broken,
        // so both directions actually move the board. Each kind keeps its own
        // warm snapshot, so this is a disk read either way — instant.
        if (id === "news" && board?.kind === "options") {
          void reseed("/api/seed?snapshot=latest", "snap");
        }
        if (id === "options" && board?.kind !== "options") {
          /**
           * The preset first, your last board second.
           *
           * Building one costs two Grok calls, a web search and three images,
           * so landing on a cold prompt makes the whole second half of the
           * product look like it hasn't started. The preset is a real board
           * built through the real pipeline, with its pictures already on disk
           * — so this is a disk read, and Decide cuts instantly.
           *
           * Quietly, in both cases: if neither exists there is nothing to
           * restore, and the prompt below is the answer rather than an error.
           */
          void reseed("/api/seed?snapshot=options-preset", "lastopts", true).then(
            (ok) =>
              ok || reseed("/api/seed?snapshot=options-latest", "lastopts", true),
          );
        }
      }}
      className="gb-label flex-1 border px-2 py-[7px] transition-colors"
      style={{
        borderColor: pane === id ? "var(--gb-text)" : "var(--gb-line)",
        color: pane === id ? "var(--gb-text)" : "var(--gb-dim)",
        background: pane === id ? "rgba(255,255,255,0.06)" : "transparent",
        borderRadius: 2,
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="px-5 py-4" style={{ borderTop: "1px solid var(--gb-line)" }}>
      <div className="mb-3 flex gap-1.5">
        {tab("news", "Your day")}
        {tab("options", "Decide")}
      </div>

      {/* The X status block belongs to the X board. Gating only its first
          branch dropped through to the "Connect X" call-to-action while you
          were already connected — the rail telling you to link an account you
          had linked, on a board that doesn't use it. */}
      {pane !== "news" ? null : me?.connected ? (
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

      <div className={`flex flex-col gap-1.5 ${pane === "news" ? "" : "hidden"}`}>
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

      <div className={pane === "options" ? "" : "hidden"}>
        <div className="gb-label mb-2" style={{ color: "var(--gb-faint)" }}>
          What are you trying to decide?
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
        {/* A fresh options board costs two Grok calls and a web search, so the
            last one is kept warm on disk exactly like the X board is. On stage
            this is the difference between a 25s wait and an instant cut. */}
        <button
          onClick={() => reseed("/api/seed?snapshot=options-latest", "lastopts")}
          disabled={Boolean(busy)}
          className={`${action} mt-1.5`}
          style={actionStyle}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
        >
          {busy === "lastopts" ? "Loading…" : "◧ Last decision board"}
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
