import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Board } from "./schema";

/**
 * The demo safety net (doc §16).
 *
 * A snapshot is a REAL authed board written to disk and replayed through the
 * identical code path — not a fabricated corpus. If the venue wifi dies or we
 * hit a rate limit mid-demo, we show real posts we really fetched, and we say
 * out loud that it's a snapshot. That distinction is the whole point.
 */

const DIR = path.join(process.cwd(), ".snapshots");

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

export async function saveSnapshot(board: Board, name = "latest"): Promise<string> {
  await ensureDir();
  const file = path.join(DIR, `${name}.json`);
  await writeFile(
    file,
    JSON.stringify({ ...board, seed: { ...board.seed, snapshot: true, name } }, null, 2),
  );
  return file;
}

export async function loadSnapshot(name = "latest"): Promise<Board | null> {
  try {
    const raw = await readFile(path.join(DIR, `${name}.json`), "utf8");
    const board = JSON.parse(raw) as Board;
    if (!board?.root_ids?.length) return null;
    // remember which file this came from, so warming writes back to the same one
    return { ...board, seed: { ...board.seed, snapshot: true, name } };
  } catch {
    return null;
  }
}

/**
 * Write the CURRENT, warmed board back to disk.
 *
 * The seed snapshot only ever held roots: it was written the instant the board
 * was built, before anything had been expanded. So rehearsing the demo warmed
 * `serverBoard`'s in-memory singleton and nothing else, and a single server
 * restart put every expand back on a cold ~19s Grok call — with the only
 * defence being "don't restart the server". Persisting after each expand makes
 * the rehearsal itself durable, which is what everyone assumed it already did.
 *
 * Never overwrites a real capture with fixtures: synthetic data must not be
 * able to masquerade as posts we actually fetched.
 */
export async function persistWarmedBoard(board: Board | null): Promise<void> {
  if (!board?.root_ids?.length || board.seed.fixture) return;
  try {
    await saveSnapshot(board, board.seed.name ?? "latest");
  } catch (err) {
    // warming is a convenience; never let it take down an expand that worked
    console.error("[snapshot] persist failed:", err);
  }
}
