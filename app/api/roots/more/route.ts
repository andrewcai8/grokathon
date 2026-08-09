import { NextResponse } from "next/server";
import {
  buildBoard,
  buildBoardFromTrends,
  coveredGround,
  rootOptions,
} from "@/lib/boardBuilder";
import { clusterSeed, hasGrok, MAX_ROOTS } from "@/lib/grokClient";
import { expandOptions, optionCorpus } from "@/lib/optionsExpander";
import { hasExa } from "@/lib/exaClient";
import { getBoard, patchBoard } from "@/lib/serverBoard";
import { activeToken } from "@/lib/xAuth";
import { getHomeTimeline, getPersonalizedTrends, type XTrend } from "@/lib/xClient";
import type { BoardKind } from "@/lib/evidence";
import type { BranchNode, XPost } from "@/lib/schema";

export const dynamic = "force-dynamic";

type Attribute = NonNullable<BranchNode["attributes"]>[number];

/**
 * What the client's board is, when the server's memory isn't it.
 *
 * Same contract, and the same reason, as /api/expand's `node` + `kind`: the
 * server keeps one board in module memory and the client can legitimately hold
 * another. Every page load calls GET /api/seed, which setBoard()s a NEWS board
 * — so opening a second tab, refreshing, or a dev reload silently replaced the
 * decide board the user was still looking at. This route then read
 * `board.kind`, saw "news", and answered a question about trucks with three
 * trend headlines: text cards, no attributes, no images, nothing to do with
 * what was on screen. That is the bug this payload exists to close.
 *
 * The client is authoritative about what it is showing. The server's board is
 * used only to widen what counts as already-covered, never to decide what the
 * board IS.
 */
interface MoreRootsBody {
  count?: number;
  kind?: BoardKind;
  /** the question an options board is narrowing — its seed label */
  question?: string;
  /** the dimension the root column is divided along, so more roots continue it */
  axis?: string;
  /**
   * The roots already on offer.
   *
   * Titles, so the new batch extends that division rather than avoiding those
   * words; attributes, so it joins their comparison rather than starting its
   * own beside it.
   */
  roots?: { title?: string; attributes?: Attribute[] }[];
  /** everything the client's board has already said — the novelty rule, travelling */
  covered?: { titles?: string[]; urls?: string[]; postIds?: string[] };
}

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
  const body = (await req.json().catch(() => ({}))) as MoreRootsBody;
  // MAX_ROOTS, not 6: three is the board's one branching factor, and a caller
  // asking for more than that (count:99 returned six) got a root column that
  // no longer matched the shape of everything under it.
  const want = Math.min(MAX_ROOTS, Math.max(1, body.count ?? MAX_ROOTS));

  // the client is the thing displaying the board, so it says what kind it is —
  // and the kind picks the slot, so this has to come first
  const kind: BoardKind = body.kind ?? "news";
  const serverBoard = getBoard(kind);

  /**
   * ...and the server owns it only if it's the SAME board of that kind.
   *
   * The slot rules out the cross-kind mixup by construction now. What it can't
   * rule out is two decisions: the label is what tells "pick a truck" from
   * "pick a laptop", and answering one with the other's covered ground would
   * withhold all the wrong sources.
   */
  const board =
    serverBoard && (!body.question || serverBoard.seed.label === body.question)
      ? serverBoard
      : null;

  /**
   * Union, not preference.
   *
   * Novelty is structural — the corpus the model sees simply cannot contain
   * what has already been read — so the two halves of what's been covered are
   * added together rather than one chosen over the other. Missing a source
   * here doesn't error, it repeats a card, which is the failure that made the
   * rule in the first place.
   */
  const seen = {
    titles: [...new Set(body.covered?.titles ?? [])],
    urls: new Set(body.covered?.urls ?? []),
    postIds: new Set(body.covered?.postIds ?? []),
  };
  if (board) {
    const mine = coveredGround(board);
    seen.titles = [...new Set([...seen.titles, ...mine.titles])];
    for (const u of mine.urls) seen.urls.add(u);
    for (const p of mine.postIds) seen.postIds.add(p);
  }

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
  if (kind === "options") {
    if (!hasGrok() || !hasExa()) {
      return NextResponse.json({ error: "Grok and Exa required" }, { status: 503 });
    }
    const question = body.question ?? board?.seed.label;
    if (!question) {
      return NextResponse.json({ error: "no question to extend" }, { status: 409 });
    }
    try {
      // the existing ROOTS specifically — extending the top-level division is a
      // different job from avoiding every title anywhere on the board
      const siblings: { title?: string; attributes?: Attribute[] }[] =
        body.roots?.length
          ? body.roots
          : (board?.root_ids ?? [])
              .map((id) => board?.nodes[id])
              .filter((n): n is BranchNode => Boolean(n));
      const offered = siblings
        .map((r) => r.title)
        .filter((t): t is string => Boolean(t));
      const axis = body.axis ?? board?.axis;
      // the labels the column is already compared on, in the order they read;
      // first card wins, since that is the order the reader's eye learned
      const labels = [
        ...new Set(siblings.flatMap((r) => r?.attributes?.map((a) => a.label) ?? [])),
      ];

      const { web, query } = await optionCorpus(question, [], seen.urls, offered);
      if (!web.length) {
        return NextResponse.json({ roots: [], posts: {}, exhausted: true });
      }
      const { options, exhausted } = await expandOptions(
        { title: question },
        [],
        seen.titles,
        web,
        { extend: offered, axis, labels },
      );
      // "that's all of them", said in the field built for it rather than
      // rendered as a card nobody can choose
      if (exhausted || !options.length) {
        console.log("[roots/more/options] %s -> exhausted", query);
        return NextResponse.json({ roots: [], posts: {}, exhausted: true });
      }

      const fresh = rootOptions(question, options, web, siblings);

      // only when the server is actually holding this board — patching someone
      // else's graph with these roots is how the two drift apart to begin with
      if (board) {
        patchBoard(kind, (b) => ({
          ...b,
          nodes: { ...b.nodes, ...Object.fromEntries(fresh.map((n) => [n.id, n])) },
          root_ids: [...b.root_ids, ...fresh.map((n) => n.id)],
        }));
      }
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

  const seenTitles = new Set(seen.titles.map((t) => t.toLowerCase()));
  // a news board is still rooted on a date and a label; if the server isn't
  // holding this one, today and the client's own label are the honest answers
  const date = board?.date ?? new Date().toISOString().slice(0, 10);
  const label = board?.seed.label ?? body.question ?? "my day";

  const nodes: Record<string, BranchNode> = {};
  const rootIds: string[] = [];
  const posts: Record<string, XPost> = {};

  /** set only when the trends call THREW — an empty rail is a different fact */
  let trendsError: string | undefined;

  try {
    // 1. trends we haven't shown yet
    const trends = (
      await getPersonalizedTrends(token.access_token).catch((err) => {
        trendsError = err instanceof Error ? err.message : "trends failed";
        console.error("[roots/more] trends FAILED (not empty):", err);
        return [] as XTrend[];
      })
    ).filter((t) => !seenTitles.has(t.name.toLowerCase()));

    if (trends.length) {
      const fresh = buildBoardFromTrends(trends, {
        date,
        label,
        limit: Math.min(trends.length, want),
      });
      Object.assign(nodes, fresh.nodes);
      rootIds.push(...fresh.root_ids);
    }

    // 2. cluster timeline posts the board hasn't cited, for whatever's left
    const remaining = want - rootIds.length;
    if (remaining > 0 && hasGrok()) {
      const timeline = await getHomeTimeline(token.access_token, token.user_id, 100);
      const unseen = timeline.filter((p) => !seen.postIds.has(p.id));
      if (unseen.length >= 5) {
        const cluster = await clusterSeed(unseen, remaining);
        const fresh = buildBoard(
          {
            topics: cluster.topics.filter(
              (t) => !seenTitles.has(t.title.toLowerCase()),
            ),
          },
          unseen,
          { date, label, mode: "my_day" },
        );
        Object.assign(nodes, fresh.nodes);
        Object.assign(posts, fresh.posts);
        rootIds.push(...fresh.root_ids);
      }
    }

    if (!rootIds.length) {
      /**
       * "Exhausted" is a claim about your day, so it must not be how a broken
       * X call renders. If trends threw, we don't know that there's nothing
       * more — we know we couldn't look.
       */
      if (trendsError) {
        return NextResponse.json(
          { error: `Couldn't reach X for more — ${trendsError}`, trendsError },
          { status: 502 },
        );
      }
      return NextResponse.json({ roots: [], posts: {}, exhausted: true });
    }

    // same rule as the options half: only patch a board the server is holding
    if (board) {
      patchBoard(kind, (b) => ({
        ...b,
        nodes: { ...b.nodes, ...nodes },
        posts: { ...b.posts, ...posts },
        root_ids: [...b.root_ids, ...rootIds],
      }));
    }

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
