import { NextResponse } from "next/server";
import {
  buildBoard,
  buildBoardFromTrends,
  coveredGround,
  optionsToNodes,
} from "@/lib/boardBuilder";
import { clusterSeed, hasGrok, MAX_ROOTS } from "@/lib/grokClient";
import { expandOptions, optionCorpus } from "@/lib/optionsExpander";
import { hasExa } from "@/lib/exaClient";
import { getBoard, patchBoard } from "@/lib/serverBoard";
import { activeToken } from "@/lib/xAuth";
import { getHomeTimeline, getPersonalizedTrends } from "@/lib/xClient";
import type { BranchNode, XPost } from "@/lib/schema";

export const dynamic = "force-dynamic";

/**
 * More of your day.
 *
 * The board opens with three roots because three is legible, not because three
 * is all there is. This extends the root column downward — the same list, just
 * longer — pulling the next trends and then clustering timeline posts the board
 * hasn't used yet.
 *
 * Same novelty rule as depth: nothing already on the board comes back.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { count?: number };
  const want = Math.min(6, Math.max(1, body.count ?? MAX_ROOTS));

  const board = getBoard();
  if (!board) return NextResponse.json({ error: "no board" }, { status: 409 });

  /**
   * More of the same question.
   *
   * Three roots is what's legible on open, not what exists — and that's as true
   * of a decision as of a day. Here it means more directions on the question you
   * asked, along the axis already established, rather than more of anything from
   * X. The novelty rule does the work: every title and every source already on
   * the board is withheld, so this can only come back with directions you have
   * not been offered.
   */
  if (board.kind === "options") {
    if (!hasGrok() || !hasExa()) {
      return NextResponse.json({ error: "Grok and Exa required" }, { status: 503 });
    }
    try {
      const seen = coveredGround(board);
      const question = board.seed.label;
      const { web, query } = await optionCorpus(question, [], seen.urls);
      if (!web.length) {
        return NextResponse.json({ roots: [], posts: {}, exhausted: true });
      }
      const { options } = await expandOptions(
        { title: question },
        [],
        seen.titles,
        web,
        // the existing ROOTS specifically — extending the top-level division is
        // a different job from avoiding every title anywhere on the board
        board.root_ids.map((id) => board.nodes[id]?.title).filter(Boolean),
      );
      if (!options.length) {
        return NextResponse.json({ roots: [], posts: {}, exhausted: true });
      }

      // roots sit at depth 0 / generality 1, like every other root on the board
      const anchor = board.nodes[board.root_ids[0]];
      const fresh = optionsToNodes(
        { ...anchor, id: "__more", generality: 1.15, depth: -1 },
        options,
        web,
      ).map((n) => ({ ...n, parent_id: null, depth: 0, generality: 1, axis: undefined }));

      patchBoard((b) => ({
        ...b,
        nodes: { ...b.nodes, ...Object.fromEntries(fresh.map((n) => [n.id, n])) },
        root_ids: [...b.root_ids, ...fresh.map((n) => n.id)],
      }));
      console.log("[roots/more/options] %s -> %d more", query, fresh.length);
      return NextResponse.json({ roots: fresh, posts: {} });
    } catch (err) {
      console.error("[roots/more/options]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "failed" },
        { status: 500 },
      );
    }
  }

  const token = await activeToken();
  if (!token?.user_id) {
    return NextResponse.json({ error: "not connected to X" }, { status: 401 });
  }

  const covered = coveredGround(board);
  const seenTitles = new Set(covered.titles.map((t) => t.toLowerCase()));

  const nodes: Record<string, BranchNode> = {};
  const rootIds: string[] = [];
  const posts: Record<string, XPost> = {};

  try {
    // 1. trends we haven't shown yet
    const trends = (await getPersonalizedTrends(token.access_token).catch(() => []))
      .filter((t) => !seenTitles.has(t.name.toLowerCase()));

    if (trends.length) {
      const fresh = buildBoardFromTrends(trends, {
        date: board.date,
        label: board.seed.label,
        limit: Math.min(trends.length, want),
      });
      Object.assign(nodes, fresh.nodes);
      rootIds.push(...fresh.root_ids);
    }

    // 2. cluster timeline posts the board hasn't cited, for whatever's left
    const remaining = want - rootIds.length;
    if (remaining > 0 && hasGrok()) {
      const timeline = await getHomeTimeline(token.access_token, token.user_id, 100);
      const unseen = timeline.filter((p) => !covered.postIds.has(p.id));
      if (unseen.length >= 5) {
        const cluster = await clusterSeed(unseen, remaining);
        const fresh = buildBoard(
          {
            topics: cluster.topics.filter(
              (t) => !seenTitles.has(t.title.toLowerCase()),
            ),
          },
          unseen,
          { date: board.date, label: board.seed.label, mode: "my_day" },
        );
        Object.assign(nodes, fresh.nodes);
        Object.assign(posts, fresh.posts);
        rootIds.push(...fresh.root_ids);
      }
    }

    if (!rootIds.length) {
      return NextResponse.json({ roots: [], posts: {}, exhausted: true });
    }

    patchBoard((b) => ({
      ...b,
      nodes: { ...b.nodes, ...nodes },
      posts: { ...b.posts, ...posts },
      root_ids: [...b.root_ids, ...rootIds],
    }));

    return NextResponse.json({
      roots: rootIds.map((id) => nodes[id]),
      posts,
    });
  } catch (err) {
    console.error("[roots/more]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}
