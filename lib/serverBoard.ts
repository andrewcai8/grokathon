import type { BoardKind } from "./evidence";
import type { Board } from "./schema";

/**
 * The server's copy of the current board — one per KIND.
 *
 * A module-level singleton is the right call for a hackathon single-user demo:
 * it survives across requests in one dev/prod process, needs no database, and
 * gives /api/expand the node context it needs without the client shipping the
 * whole graph back on every call. Swap for a real store if this ever grows up.
 *
 * One slot per kind, though, because a news board and a decision board are not
 * competing versions of the same thing — they are two boards, and the user
 * moves between them. With a single slot they overwrote each other: every page
 * load calls GET /api/seed, which seeds your day, so a refresh or a second tab
 * silently replaced the decision board still on screen. /api/roots/more then
 * read `kind` off the wrong board and answered a question about trucks with
 * three trend headlines.
 *
 * That was patched twice at the call site — expand and roots/more both learned
 * to distrust this module and take the board from the client instead — which is
 * the signal the storage was wrong, not the callers. lib/snapshot.ts had
 * already reached the same conclusion on disk ("latest" vs "options-latest",
 * and a mismatched write refused outright); this is that rule in memory.
 *
 * The client payloads stay as the fallback: they cover the cases a per-kind
 * slot still can't, like a board this process never built.
 */

const slots: Record<BoardKind, Board | null> = { news: null, options: null };

/** A board with no kind is a news board — that's how they've always been built. */
export function kindOf(board: Board): BoardKind {
  return board.kind ?? "news";
}

export function getBoard(kind: BoardKind = "news") {
  return slots[kind];
}

export function setBoard(b: Board) {
  slots[kindOf(b)] = b;
  return b;
}

export function patchBoard(kind: BoardKind, fn: (b: Board) => Board) {
  const current = slots[kind];
  if (!current) return null;
  // a patch must not move a board between slots — the kind is its identity here
  const next = fn(current);
  slots[kind] = { ...next, kind: current.kind };
  return slots[kind];
}
