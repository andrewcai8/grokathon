import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  await writeFile(file, JSON.stringify({ ...board, seed: { ...board.seed, snapshot: true } }, null, 2));
  return file;
}

export async function loadSnapshot(name = "latest"): Promise<Board | null> {
  try {
    const raw = await readFile(path.join(DIR, `${name}.json`), "utf8");
    const board = JSON.parse(raw) as Board;
    if (!board?.root_ids?.length) return null;
    return { ...board, seed: { ...board.seed, snapshot: true } };
  } catch {
    return null;
  }
}

export async function listSnapshots(): Promise<string[]> {
  try {
    const files = await readdir(DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
