import { NextResponse } from "next/server";
import { buildBoard } from "@/lib/boardBuilder";
import { clusterSeed, hasGrok, MAX_ROOTS } from "@/lib/grokClient";
import { setBoard } from "@/lib/serverBoard";
import { loadSnapshot, saveSnapshot } from "@/lib/snapshot";
import { activeToken } from "@/lib/xAuth";
import {
  getHomeTimeline,
  getPersonalizedTrends,
  searchRecent,
} from "@/lib/xClient";
import { FIXTURE_BOARD } from "@/lib/fixtures";
import type { XPost } from "@/lib/schema";

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
  const trending = url.searchParams.get("trending") === "1";
  const query = url.searchParams.get("q");

  if (wantSnapshot) {
    const snap = await loadSnapshot(wantSnapshot);
    if (snap) {
      setBoard(snap);
      return NextResponse.json({ board: snap, source: "snapshot" });
    }
  }

  // default to the rehearsed snapshot unless explicitly asked for a live read —
  // a demo should never gamble on the venue wifi
  if (!live && !query && !trending) {
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

  const token = await activeToken();
  if (token?.user_id) {
    try {
      if (trending) {
        /**
         * Trending, but personalised to this account — the x.com "for you"
         * trends rail, not a global top-10. Trends give us topic NAMES, so we
         * search recent posts for the top few and cluster those.
         *
         * Availability is unverified (documented as Premium-gated), so a
         * failure here is expected and falls through to the timeline seed
         * below rather than breaking the board.
         */
        const trends = await getPersonalizedTrends(token.access_token);
        const top = trends.slice(0, MAX_ROOTS);
        if (top.length) {
          const batches = await Promise.all(
            top.map((t) =>
              searchRecent(token.access_token, `${t.name} -is:retweet lang:en`, 25).catch(
                () => [],
              ),
            ),
          );
          const seen = new Set<string>();
          posts = batches.flat().filter((p) => !seen.has(p.id) && seen.add(p.id));
          label = "Trending for you";
          mode = "trending";
          source = "x_personalized_trends";
        }
      }

      if (!posts.length && query) {
        posts = await searchRecent(token.access_token, query, 60);
        label = query;
        mode = "search";
        source = "x_search_recent";
      } else if (!posts.length) {
        // trending unavailable or empty — the timeline seed always works
        posts = await getHomeTimeline(token.access_token, token.user_id, 100);
        label = token.handle ? `@${token.handle}'s day` : "Your day on X";
        source = "x_home_timeline";
      }
    } catch (err) {
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
    const cluster = await clusterSeed(posts);
    const board = buildBoard(cluster, posts, { date: today, label, mode });
    setBoard(board);
    // every successful live read becomes the next demo safety net
    if (source === "x_home_timeline") await saveSnapshot(board, "latest");
    return NextResponse.json({ board, source });
  } catch (err) {
    console.error("[seed] clustering failed:", err);
    setBoard(FIXTURE_BOARD);
    return NextResponse.json({ board: FIXTURE_BOARD, source: "fixtures_fallback" });
  }
}
