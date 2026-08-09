import { NextResponse } from "next/server";
import { buildBoard, buildBoardFromTrends } from "@/lib/boardBuilder";
import { clusterSeed, hasGrok, MAX_ROOTS } from "@/lib/grokClient";
import { setBoard } from "@/lib/serverBoard";
import { loadSnapshot, saveSnapshot } from "@/lib/snapshot";
import { activeToken } from "@/lib/xAuth";
import {
  getHomeTimeline,
  getPersonalizedTrends,
  searchRecent,
  type XTrend,
} from "@/lib/xClient";
import { FIXTURE_BOARD } from "@/lib/fixtures";
import type { Board, XPost } from "@/lib/schema";

export const dynamic = "force-dynamic";

/**
 * Seed order of preference:
 *   1. ?snapshot=<name>  — the rehearsed demo path, always instant
 *   2. live X home timeline + Grok clustering  — the real product
 *   3. Grok clustering over fixture posts       — no X creds yet
 *   4. the fixture board                        — no creds at all
 *
 * Never returns empty. Opening on an empty state is death (doc §0).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wantSnapshot = url.searchParams.get("snapshot");
  const live = url.searchParams.get("live") === "1";
  const query = url.searchParams.get("q");

  if (wantSnapshot) {
    const snap = await loadSnapshot(wantSnapshot);
    if (snap) {
      setBoard(snap);
      return NextResponse.json({ board: snap, source: "snapshot" });
    }
    // Asking for a NAMED snapshot is asking for that board, not for whatever
    // else is on disk. Falling through handed back "your day on X" when the
    // caller asked for the last decision board — a different board answering
    // to the wrong name, which is worse than an empty-handed no.
    return NextResponse.json(
      { error: `no snapshot named "${wantSnapshot}"` },
      { status: 404 },
    );
  }

  // default to the rehearsed snapshot unless explicitly asked for a live read —
  // a demo should never gamble on the venue wifi
  if (!live && !query) {
    const snap = await loadSnapshot("latest");
    if (snap) {
      setBoard(snap);
      return NextResponse.json({ board: snap, source: "snapshot" });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  let posts: XPost[] = [];
  let label = "Your day on X";
  let mode: "my_day" | "search" | "trending" = "my_day";
  let source = "fixtures";
  /** trending roots, merged in front of the clustered timeline topics */
  let trendBoard: Board | null = null;
  /**
   * Set only when an X read THREW. Never when it simply came back empty — the
   * whole point of keeping these is that "X is down" and "your day was quiet"
   * are different facts, and only one of them is about you.
   */
  let trendsError: string | undefined;
  let xError: string | undefined;

  const token = await activeToken();
  if (token?.user_id) {
    try {
      if (query) {
        posts = await searchRecent(token.access_token, query, 60);
        label = query;
        mode = "search";
        source = "x_search_recent";
      } else {
        /**
         * One seed, not two.
         *
         * Trending and timeline were separate buttons, which made the user
         * choose between "what the world is talking about" and "what my feed
         * is talking about" before seeing either. Your day is both. Trends
         * come first because they're free and instant and they're legible
         * news; the timeline fills any remaining slots with what your own
         * follow graph is actually discussing.
         */
        /**
         * A failed trends call is not an empty trending rail.
         *
         * Swallowed to [], a rate limit or an expired scope renders exactly
         * like "nothing is trending for you today" — the board quietly drops
         * to timeline-only roots and nobody ever learns the personalised half
         * of the seed stopped working. Same failure the web search was
         * hardened against; it just hadn't been applied here yet.
         */
        const trends = await getPersonalizedTrends(token.access_token).catch(
          (err) => {
            trendsError = err instanceof Error ? err.message : "trends failed";
            console.error("[seed] trends FAILED (not empty):", err);
            return [] as XTrend[];
          },
        );
        const trendRoots = Math.min(trends.length, MAX_ROOTS - 1);
        if (trendRoots > 0) {
          trendBoard = buildBoardFromTrends(trends, {
            date: today,
            label: "Your day on X",
            limit: trendRoots,
          });
        }
        posts = await getHomeTimeline(token.access_token, token.user_id, 100);
        label = token.handle ? `@${token.handle}'s day` : "Your day on X";
        source = trendRoots > 0 ? "trends+timeline" : "x_home_timeline";
      }
    } catch (err) {
      xError = err instanceof Error ? err.message : "X read failed";
      console.error("[seed] X read failed:", err);
    }
  }

  if (!posts.length) {
    posts = Object.values(FIXTURE_BOARD.posts);
    source = hasGrok() ? "grok_over_fixtures" : "fixtures";
  }

  if (!hasGrok()) {
    setBoard(FIXTURE_BOARD);
    return NextResponse.json({ board: FIXTURE_BOARD, source: "fixtures" });
  }

  try {
    // leave room for the trending roots so the board still holds MAX_ROOTS
    const slots = MAX_ROOTS - (trendBoard?.root_ids.length ?? 0);
    const cluster = await clusterSeed(posts, Math.max(1, slots));
    let board = buildBoard(cluster, posts, { date: today, label, mode });

    if (trendBoard) {
      board = {
        ...board,
        seed: { ...board.seed, label: "Your day on X" },
        nodes: { ...trendBoard.nodes, ...board.nodes },
        // trends first: they're the legible headline news
        root_ids: [...trendBoard.root_ids, ...board.root_ids].slice(0, MAX_ROOTS),
      };
    }
    setBoard(board);
    /**
     * Every successful live read becomes the next demo safety net.
     *
     * This was gated on `x_home_timeline`, which is precisely the case where
     * trends came back EMPTY — so on the normal path, the one everybody
     * actually runs, the snapshot was never refreshed by the seed at all and
     * the safety net quietly aged. A `?q=` board stays excluded on purpose:
     * "latest" means your day, and a topic search answering to that name is
     * the same mismatch snapshot.ts already refuses across kinds.
     */
    if (mode === "my_day" && !source.includes("fixtures")) {
      await saveSnapshot(board, "latest");
    }
    return NextResponse.json({ board, source, trendsError, xError });
  } catch (err) {
    console.error("[seed] clustering failed:", err);
    setBoard(FIXTURE_BOARD);
    return NextResponse.json({ board: FIXTURE_BOARD, source: "fixtures_fallback" });
  }
}
