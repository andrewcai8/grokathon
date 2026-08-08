import type { Board } from "./schema";

/**
 * The server's copy of the current board.
 *
 * A module-level singleton is the right call for a hackathon single-user demo:
 * it survives across requests in one dev/prod process, needs no database, and
 * gives /api/expand the node context it needs without the client shipping the
 * whole graph back on every call. Swap for a real store if this ever grows up.
 */

let current: Board | null = null;

export function getBoard() {
  return current;
}

export function setBoard(b: Board) {
  current = b;
  return b;
}

export function patchBoard(fn: (b: Board) => Board) {
  if (!current) return null;
  current = fn(current);
  return current;
}
