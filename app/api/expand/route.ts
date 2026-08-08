import { NextResponse } from "next/server";
import {
  expandNode,
  expandViaXSearch,
  hasGrok,
  searchQueryFor,
  XSEARCH_FORKS,
} from "@/lib/grokClient";
import {
  ancestorTitles,
  childrenToNodes,
  citedPosts,
  relevantPosts,
  rollUpCitations,
} from "@/lib/boardBuilder";
import { getBoard, patchBoard } from "@/lib/serverBoard";
import { activeToken } from "@/lib/xAuth";
import { getPostsByIds, searchRecent } from "@/lib/xClient";
import {
  ForkSchema,
  type Board,
  type BranchNode,
  type Fork,
  type XPost,
} from "@/lib/schema";

/**
 * Check every post Grok says it found against the real X API.
 *
 * x_search returns a URL and a quote that the MODEL wrote. Rendering that as
 * "@someone said X" without checking means we can put invented words in a real
 * person's mouth, under their name, with a permalink that makes it look
 * sourced. For a product whose entire claim is epistemic honesty that is the
 * one unacceptable failure.
 *
 * Verified posts get the REAL text and metrics substituted for Grok's quote.
 * Posts that don't resolve are dropped entirely. If we have no X token we
 * can't check, so they survive but are flagged unverified and rendered as
 * such — never silently passed off as confirmed.
 */
async function verifyCitations(posts: XPost[]): Promise<Record<string, XPost>> {
  if (!posts.length) return {};

  const token = await activeToken();
  if (!token?.access_token) {
    console.warn("[expand] no X token — %d citations unverified", posts.length);
    return Object.fromEntries(posts.map((p) => [p.id, { ...p, unverified: true }]));
  }

  try {
    const real = await getPostsByIds(
      token.access_token,
      posts.map((p) => p.id),
    );
    const kept: Record<string, XPost> = {};
    for (const p of posts) {
      const confirmed = real.get(p.id);
      if (confirmed) kept[p.id] = confirmed;
    }
    const dropped = posts.length - Object.keys(kept).length;
    if (dropped > 0) {
      console.warn(
        "[expand] dropped %d/%d citations that do not exist on X",
        dropped,
        posts.length,
      );
    }
    return kept;
  } catch (err) {
    // verification itself failed (rate limit, network) — flag, don't fabricate
    console.error("[expand] citation verification failed:", err);
    return Object.fromEntries(posts.map((p) => [p.id, { ...p, unverified: true }]));
  }
}

/**
 * The expand contract (doc §3.4): structured children, never a chat dump.
 * Capped, cited, honestly labelled.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    nodeId?: string;
    fork?: string;
    /**
     * The client's own copy of the node it clicked, plus context.
     *
     * The server keeps a board in module memory, but the client can legitimately
     * hold one the server doesn't: the fixture board painted on the first frame,
     * a second tab, or anything after a reseed. That mismatch produced
     * "404 unknown node" on real clicks. Trusting the client's node for the
     * prompt costs nothing — Grok only ever writes meaning, and identity and
     * wiring are still assigned server-side — and it makes expand independent
     * of server memory.
     */
    node?: BranchNode;
    ancestors?: string[];
    posts?: Record<string, XPost>;
  };
  const nodeId = body.nodeId;
  if (!nodeId) {
    return NextResponse.json({ error: "nodeId required" }, { status: 400 });
  }

  const fork: Fork = ForkSchema.safeParse(body.fork).success
    ? (body.fork as Fork)
    : "deeper";

  const serverBoard = getBoard();
  const node = serverBoard?.nodes[nodeId] ?? body.node;
  if (!node) {
    return NextResponse.json(
      { error: "unknown node and none supplied" },
      { status: 404 },
    );
  }

  // Prefer the server's graph; fall back to whatever the client sent.
  const board: Board = serverBoard?.nodes[nodeId]
    ? serverBoard
    : {
        date: new Date().toISOString().slice(0, 10),
        seed: { mode: "my_day", label: "client" },
        nodes: { [nodeId]: node },
        root_ids: [nodeId],
        // deliberately NOT merging serverBoard.posts: this node isn't from
        // that board, and borrowing its corpus made ungrounded nodes look
        // grounded, which routed bare headlines away from x_search
        posts: body.posts ?? {},
      };

  // Already expanded on this fork — serve from the graph, instantly.
  //
  // This is what makes rehearsal work: walking the demo path once warms every
  // node, so on stage a counter fork that costs ~38s cold returns in ~0ms. It
  // also stops a second click on the same fork from appending duplicates.
  const alreadyFetched = node.children_ids
    .map((id) => board.nodes[id])
    .filter(Boolean)
    .filter((c) => (fork === "deeper" ? !c.fork : c.fork === fork));

  if (alreadyFetched.length > 0) {
    return NextResponse.json({
      children: alreadyFetched,
      posts: Object.fromEntries(
        alreadyFetched
          .flatMap((c) => c.source_post_ids)
          .map((id) => [id, board.posts[id]])
          .filter(([, p]) => Boolean(p)),
      ),
      fork,
      cached: true,
    });
  }

  if (!hasGrok()) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 503 });
  }

  try {
    const ancestors = serverBoard?.nodes[nodeId]
      ? ancestorTitles(board, nodeId)
      : (body.ancestors ?? []);

    // Forks that are about what OTHER people think go to x_search, so they can
    // cite accounts the user doesn't follow. "deeper" stays on the timeline
    // corpus: it's about this story as it reached you, and it's ~7s faster.
    //
    // But a trending board's roots are headlines with no posts behind them at
    // all, so there is no corpus to reason from. Anything with an empty corpus
    // must search, or we'd be asking Grok to expand on nothing.
    let raw;
    let summary: string | undefined;
    let newPosts: Record<string, XPost> = {};

    /**
     * Retrieval strategy.
     *
     * A node with no citations behind it (a bare trending headline) needs
     * grounding before it can be expanded. We do that with the X API rather
     * than x_search: Grok writes the query, X returns the posts. Real posts by
     * construction — a fabricated citation isn't possible — and it's ~3s
     * instead of ~20s.
     *
     * x_search is kept for the forks that are open-ended discovery ("find the
     * strongest opposing argument"), which no keyword query can express.
     */
    const grounded = citedPosts(board, nodeId).length > 0;
    let corpus = grounded ? relevantPosts(board, nodeId) : [];
    let groundedNow = false;

    if (!grounded && !XSEARCH_FORKS.has(fork)) {
      const tok = await activeToken();
      if (tok?.access_token) {
        try {
          const q = await searchQueryFor(node.title);
          const found = await searchRecent(tok.access_token, q, 40);
          if (found.length) {
            corpus = found;
            newPosts = Object.fromEntries(found.map((p) => [p.id, p]));
            groundedNow = true;
            console.log("[expand] grounded %s via X search: %s -> %d posts",
              nodeId, q, found.length);
          }
        } catch (err) {
          console.warn("[expand] X grounding failed, falling back:", err);
        }
      }
    }

    // fall back to x_search when the X API couldn't ground it, or for the
    // discovery forks
    const useXSearch =
      hasGrok() && (XSEARCH_FORKS.has(fork) || (!grounded && !groundedNow));

    if (useXSearch) {
      const out = await expandViaXSearch(node, fork, ancestors);
      raw = out.children;
      newPosts = { ...newPosts, ...(await verifyCitations(out.posts)) };
      summary = out.summary;
    } else {
      raw = await expandNode(node, fork, corpus, ancestors);
    }

    const postsForCitations = { ...board.posts, ...newPosts };
    const children = childrenToNodes(node, raw, postsForCitations, fork);

    // only patch the server graph when it actually owns this node
    if (serverBoard?.nodes[nodeId]) patchBoard((b) => {
      const nodes = { ...b.nodes };
      for (const c of children) nodes[c.id] = c;
      nodes[nodeId] = rollUpCitations(
        {
          ...nodes[nodeId],
          children_ids:
            fork === "deeper"
              ? children.map((c) => c.id)
              : [...nodes[nodeId].children_ids, ...children.map((c) => c.id)],
          // a bare trending headline gets its story once we've actually
          // searched — grounded now, so writing it is no longer an invention
          body: nodes[nodeId].body || summary,
          has_children: true,
          updated_at: new Date().toISOString(),
        },
        children,
      );
      return { ...b, nodes, posts: { ...b.posts, ...newPosts } };
    });

    // ship the posts back so the client can render their citation chips
    return NextResponse.json({
      children,
      posts: newPosts,
      fork,
      summary,
      source: useXSearch ? "x_search" : "timeline",
    });
  } catch (err) {
    console.error("[expand]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "expand failed" },
      { status: 500 },
    );
  }
}
