import { after, NextResponse } from "next/server";
import { persistWarmedBoard } from "@/lib/snapshot";
import {
  expandNode,
  expandViaXSearch,
  hasGrok,
  MAX_CHILDREN,
  readMedia,
  searchQueryFor,
  XSEARCH_FORKS,
} from "@/lib/grokClient";
import {
  MEDIA_CAP,
  mediaFromPosts,
  reachableMedia,
  resolveRef,
  type CardMediaItem,
} from "@/lib/media";
import {
  ancestorTitles,
  childrenToNodes,
  citedPosts,
  coveredGround,
  optionsToNodes,
  relevantPosts,
  rollUpCitations,
} from "@/lib/boardBuilder";
import { expandOptions, optionCorpus } from "@/lib/optionsExpander";
import { rankEvidence, type BoardKind } from "@/lib/evidence";
import { getBoard, patchBoard } from "@/lib/serverBoard";
import { activeToken } from "@/lib/xAuth";
import { getPostsByIds, getReplies, searchRecent } from "@/lib/xClient";
import { hasExa, searchWeb } from "@/lib/exaClient";
import type { WebSource } from "@/lib/evidence";
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
    /** what the client's board is FOR, for the same reason it sends the node */
    kind?: BoardKind;
    /**
     * Image URLs the client's board has already had read. Same reason it sends
     * the node: when the server doesn't own this board, its own notion of what
     * has been covered is a graph of one node, and vision would happily read
     * the same screenshot twice.
     */
    readMedia?: string[];
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
        kind: body.kind,
      };

  // The server's board wins when it owns the node, for the same reason it wins
  // on the graph; otherwise trust what the client says its board is for.
  const kind: BoardKind = board.kind ?? body.kind ?? "news";

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

  /**
   * An options board narrows instead of evidencing.
   *
   * Same seam as replies: a node in, at most N more specific children out, one
   * grounding type. Everything the board does around this call — layout, zoom,
   * bands, the novelty rule, infinite recursion — is untouched and shared. Only
   * retrieval and what a child MEANS differ, which is the whole claim of the
   * paradigm.
   */
  if (kind === "options") {
    if (!hasGrok()) {
      return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 503 });
    }
    if (!hasExa()) {
      return NextResponse.json({ error: "EXA_API_KEY not set" }, { status: 503 });
    }
    try {
      const covered = coveredGround(board, nodeId);
      const ancestors = serverBoard?.nodes[nodeId]
        ? ancestorTitles(board, nodeId)
        : (body.ancestors ?? []);

      // sources already used on this board are removed before the model sees
      // them — structural novelty, exactly as posts are for news
      const { web, query } = await optionCorpus(node.title, ancestors, covered.urls);
      if (!web.length) {
        return NextResponse.json(
          { error: `nothing new found for "${query}"` },
          { status: 404 },
        );
      }

      const { options, summary, axis } = await expandOptions(
        node,
        ancestors,
        covered.titles,
        web,
      );
      if (!options.length) {
        return NextResponse.json({ error: "no options returned" }, { status: 502 });
      }

      const children = optionsToNodes(node, options, web);

      if (serverBoard?.nodes[nodeId]) patchBoard((b) => {
        const prev = b.nodes[nodeId];
        if (!prev) return b;
        const nodes = { ...b.nodes };
        for (const c of children) nodes[c.id] = c;
        nodes[nodeId] = {
          ...prev,
          children_ids: children.map((c) => c.id),
          body: prev.body || summary,
          axis: axis ?? prev.axis,
          has_children: true,
          updated_at: new Date().toISOString(),
        };
        return { ...b, nodes };
      });

      after(() => persistWarmedBoard(getBoard()));
      console.log(
        "[expand/options] %s -> %s -> %d options (axis: %s)",
        node.title, query, children.length, axis ?? "none",
      );
      return NextResponse.json({
        children,
        posts: {},
        fork: "deeper",
        summary,
        axis,
        source: "web",
      });
    } catch (err) {
      console.error("[expand/options]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "options expand failed" },
        { status: 500 },
      );
    }
  }

  /**
   * Vision — what the pictures on this card are arguing.
   *
   * Every other fork reads text. This one reads the part of a post nobody has
   * read: on a real timeline a quarter of posts carry media and none of it
   * carries alt text, so the image is simply missing from the board's account
   * of what was said.
   *
   * The invariant survives intact because the model never chooses a source. We
   * pick the images off posts we already retrieved, hand them over under
   * opaque refs (m1, m2…), and map the ref it answers with back to the post on
   * this side. A claim about an image we didn't show it has nowhere to land.
   */
  if (fork === "media") {
    if (!hasGrok()) {
      return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 503 });
    }
    // the node's own pictures first; a rolled-up root falls back to the posts
    // its children cited, which are still posts behind this card
    const behind = node.source_post_ids.length
      ? node.source_post_ids.map((id) => board.posts[id]).filter(Boolean)
      : citedPosts(board, nodeId);
    const covered = coveredGround(board, nodeId);
    const alreadyRead = new Set([...covered.mediaUrls, ...(body.readMedia ?? [])]);
    const all = mediaFromPosts(behind);
    // Images the board has already read are stripped before the model sees
    // them, exactly as posts are. Novelty is structural, not remembered.
    const found = mediaFromPosts(behind, MEDIA_CAP, alreadyRead);
    if (!found.length) {
      return NextResponse.json(
        {
          error: all.length
            ? `already read every image behind this card (${all.length})`
            : "no image on any post behind this card",
        },
        { status: 422 },
      );
    }

    try {
      // one dead URL 400s the whole call — see reachableMedia
      const media = await reachableMedia(found);
      if (!media.length) {
        return NextResponse.json(
          { error: `${found.length} image(s) behind this card, none still reachable` },
          { status: 404 },
        );
      }

      const ancestors = serverBoard?.nodes[nodeId]
        ? ancestorTitles(board, nodeId)
        : (body.ancestors ?? []);

      const read = await readMedia(node, media, ancestors, covered.titles);

      /**
       * A vision claim must cite the post whose media it read.
       *
       * The ref is the only handle the model has on an image, so a ref that
       * doesn't resolve means it described something it was not shown. Those
       * are dropped, exactly as a fabricated permalink is.
       */
      const usedRefs = new Set<string>();
      const paired = read
        .map((c) => ({ child: c, m: resolveRef(media, c.media_ref) }))
        .filter((p): p is { child: (typeof read)[number]; m: CardMediaItem } =>
          Boolean(p.m),
        )
        // one card per image. Two readings of one picture render as two cards
        // showing the same picture, which reads as a duplicate however
        // different the words are.
        .filter((p) => !usedRefs.has(p.m.ref) && usedRefs.add(p.m.ref));

      if (paired.length < read.length) {
        console.warn(
          "[expand/media] dropped %d/%d vision claims citing an image we never sent",
          read.length - paired.length,
          read.length,
        );
      }
      if (!paired.length) {
        return NextResponse.json(
          { error: "vision cited no image we sent" },
          { status: 502 },
        );
      }

      const posts = Object.fromEntries(
        paired.map((p) => [p.m.postId, board.posts[p.m.postId]]).filter(([, v]) => v),
      ) as Record<string, XPost>;

      // Ordered here, once, before it reaches either the client or the server
      // graph. The client sorts an arriving batch by priority; if the server
      // stored the model's order instead, the snapshot would replay this column
      // in a different vertical order than the person rehearsing it saw.
      paired.sort((a, b) => b.child.priority - a.child.priority);

      const children = childrenToNodes(
        node,
        paired.map((p) => ({
          type: "media" as const,
          title: p.child.title,
          body: p.child.body,
          priority: p.child.priority,
          generality: 0,
          source_post_ids: [p.m.postId],
          has_children: true,
          epistemic: p.child.epistemic,
        })),
        // childrenToNodes drops citations it can't resolve; the post is behind
        // this card by construction, so make sure it's resolvable
        { ...board.posts, ...posts },
        fork,
      ).map((c, i) => ({

        ...c,
        // the child carries the exact frame it was written from, so the card
        // shows you the thing being described rather than describing it twice
        media: {
          kind: (paired[i].m.kind === "video" ? "video" : "image") as "video" | "image",
          url: paired[i].m.url,
          alt: paired[i].m.alt,
          vision_summary: paired[i].child.body,
          post_id: paired[i].m.postId,
          // carried so a snapshotted vision card frames identically on replay,
          // when the post it came from may no longer be in the corpus
          width: paired[i].m.width,
          height: paired[i].m.height,
        },
      }))
        /**
         * A vision claim MUST cite the post whose media it read.
         *
         * Today it always can — `behind` is drawn from `board.posts`, so
         * childrenToNodes can always resolve the id. But that makes the
         * invariant true by accident of plumbing rather than by rule, and if
         * `behind` ever gains a source outside the corpus the id would be
         * silently stripped and the card would ship with a picture, a
         * confident reading of it, and no citation — rendering as merely
         * uncited, which is indistinguishable from a properly sourced sibling.
         * That is the exact failure mode the x_search verification pass exists
         * to prevent, so it gets the same treatment: no citation, no card.
         */
        .filter((c) => {
          if (c.source_post_ids.length) return true;
          console.warn("[expand/media] dropped a vision claim with no citation");
          return false;
        });

      if (!children.length) {
        return NextResponse.json(
          { error: "vision produced nothing citable" },
          { status: 502 },
        );
      }

      if (serverBoard?.nodes[nodeId]) patchBoard((b) =>
        b.nodes[nodeId]
          ? {
              ...b,
              nodes: {
                ...b.nodes,
                ...Object.fromEntries(children.map((c) => [c.id, c])),
                [nodeId]: {
                  ...b.nodes[nodeId],
                  children_ids: [
                    ...b.nodes[nodeId].children_ids,
                    ...children.map((c) => c.id),
                  ],
                  updated_at: new Date().toISOString(),
                },
              },
              posts: { ...b.posts, ...posts },
            }
          : b,
      );
      after(() => persistWarmedBoard(getBoard()));
      console.log(
        "[expand/media] %s: %d images sent (%d dead), %d claims",
        node.title, media.length, found.length - media.length, children.length,
      );
      return NextResponse.json({ children, posts, fork, source: "x_vision" });
    } catch (err) {
      console.error("[expand/media]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "vision failed" },
        { status: 500 },
      );
    }
  }

  /**
   * Replies need no model at all.
   *
   * Every other expansion asks Grok to say something about posts. This one
   * returns the posts themselves — what people actually said back — so there
   * is nothing to invent, nothing to verify, and no latency beyond one X call.
   * It's also a different KIND of information than "a narrower claim", which
   * is what makes going deeper feel like learning rather than rewording.
   */
  if (fork === "replies") {
    const tok = await activeToken();
    if (!tok?.access_token) {
      return NextResponse.json({ error: "not connected to X" }, { status: 401 });
    }
    const covered = coveredGround(board, nodeId);
    // Pull replies from EVERY post this card cites, not just one.
    // A node often cites a single low-traffic post, so opening only that
    // conversation surfaced 1-like noise while a busier thread sat beside it.
    // Gather across all of them, then rank once.
    const seeds = citedPosts(board, nodeId)
      .sort((a, b) => (b.metrics?.replies ?? 0) - (a.metrics?.replies ?? 0))
      .slice(0, 3);
    if (!seeds.length) {
      return NextResponse.json(
        { error: "no post behind this card to read replies from" },
        { status: 422 },
      );
    }
    try {
      const gathered = (
        await Promise.all(
          seeds.map((sp) =>
            getReplies(tok.access_token, sp.conversation_id ?? sp.id).catch(
              () => [] as XPost[],
            ),
          ),
        )
      ).flat();

      /**
       * Only replies that earned attention.
       *
       * "What people said back" has to mean something. A 0-like reply is one
       * stranger talking, and showing it as a finding is the same mistake as
       * an uncited claim — noise presented as signal. Two gates: an absolute
       * floor so nothing trivial gets through, and a relative one so a huge
       * thread doesn't let its long tail in on the floor alone.
       *
       * When nothing clears the bar we say so. "No notable replies" is a real
       * answer about the conversation; three quiet replies pretending to be a
       * finding is not.
       */
      const candidates = [...new Map(gathered.map((p) => [p.id, p])).values()]
        .filter((p) => !covered.postIds.has(p.id))
        .sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0));

      // Relative, not absolute. Measured on real boards: 79 replies under a
      // trending story and not one cleared 3 likes — reply engagement runs an
      // order of magnitude below post engagement, so a fixed floor makes this
      // permanently empty. "Popular" only means anything relative to the
      // conversation it's in. We still require at least one like, so a thread
      // where nobody engaged reports honestly instead of promoting silence.
      const best = candidates[0]?.metrics?.likes ?? 0;
      const bar = Math.max(1, Math.round(best * 0.25));
      const replies = candidates
        .filter((p) => (p.metrics?.likes ?? 0) >= bar)
        .slice(0, MAX_CHILDREN);

      if (!replies.length) {
        console.log(
          "[expand/replies] %d replies, best %d likes, bar %d — none notable",
          candidates.length, best, bar,
        );
        return NextResponse.json(
          {
            error: `No notable replies — ${candidates.length} found, none with engagement`,
          },
          { status: 404 },
        );
      }
      const posts = Object.fromEntries(replies.map((p) => [p.id, p]));
      const children = childrenToNodes(
        node,
        replies.map((p, i) => ({
          type: "post" as const,
          title: `@${p.author.handle}`,
          body: p.text.slice(0, 280),
          priority: 1 - i * 0.1,
          generality: 0,
          source_post_ids: [p.id],
          has_children: true,
          epistemic: "widely_shared" as const,
        })),
        posts,
        fork,
      );
      patchBoard((b) =>
        b.nodes[nodeId]
          ? {
              ...b,
              nodes: {
                ...b.nodes,
                ...Object.fromEntries(children.map((c) => [c.id, c])),
                [nodeId]: {
                  ...b.nodes[nodeId],
                  children_ids: [
                    ...b.nodes[nodeId].children_ids,
                    ...children.map((c) => c.id),
                  ],
                },
              },
              posts: { ...b.posts, ...posts },
            }
          : b,
      );
      // rehearsing the demo path is what warms the snapshot — see persistWarmedBoard
      after(() => persistWarmedBoard(getBoard()));
      return NextResponse.json({ children, posts, fork, source: "x_replies" });
    } catch (err) {
      console.error("[expand/replies]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "replies failed" },
        { status: 500 },
      );
    }
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
    // What the board has already said. Posts already cited anywhere are
    // removed from the corpus outright, so a deeper card cannot be built from
    // evidence the user has already read.
    const covered = coveredGround(board, nodeId);
    const isNew = (p: XPost) => !covered.postIds.has(p.id);

    const grounded = citedPosts(board, nodeId).length > 0;
    let corpus = grounded ? relevantPosts(board, nodeId).filter(isNew) : [];
    let groundedNow = false;
    let web: WebSource[] = [];

    /**
     * Fetch fresh evidence when the novel corpus runs dry.
     *
     * Novelty plus a finite timeline corpus hits exhaustion within about two
     * levels — depth 2 was already answering "no detail in remaining corpus".
     * But the board is meant to recurse indefinitely, and the reason someone
     * is three levels down is that they want MORE, not a note saying we ran
     * out. So when there's little unseen evidence left we go and search X for
     * this specific node, which is naturally a narrower query the deeper you
     * are, and returns posts the board has never shown.
     */
    /**
     * Depth always fetches fresh evidence.
     *
     * relevantPosts() pads the corpus with the rest of the timeline, so a deep
     * node LOOKS well supplied while none of those posts are about it — Grok
     * then correctly answers "no corpus evidence for <specific sub-claim>",
     * which reads as a dead end. Sizing the corpus was the wrong test.
     *
     * The honest rule matches what the levels mean: a ROOT is your day, and
     * the timeline is the right evidence for it. Anything DEEPER is the user
     * saying "I want to know more about this specific thing", and the answer
     * to that lives on X, not in the hundred posts that happened to cross
     * their feed. So depth >= 1 always goes and gets new posts.
     */
    const MIN_NOVEL_CORPUS = 5;
    const wantsFresh = node.depth >= 1 || corpus.length < MIN_NOVEL_CORPUS;
    if (wantsFresh && !XSEARCH_FORKS.has(fork)) {
      const tok = await activeToken();
      if (tok?.access_token) {
        try {
          const q = await searchQueryFor(node.title);
          // X and the web in parallel: what people are saying, and what was
          // reported. For a factual claim the reporting is usually the better
          // evidence, and it's real by construction either way.
          const [found, webFound] = await Promise.all([
            searchRecent(tok.access_token, q, 40)
              // rank before the corpus is capped: a search returns forty hits
              // and the model reads them in the order we hand them over
              .then((r) => rankEvidence(r.filter(isNew)))
              .catch(() => [] as XPost[]),
            hasExa()
              ? searchWeb(node.title, {
                  numResults: 5,
                  // headline-derived query: journalism is what we want, and
                  // recency keeps a fast-moving story off last year's coverage
                  category: "news",
                  startPublishedDate: new Date(
                    Date.now() - 14 * 24 * 3600 * 1000,
                  ).toISOString(),
                }).catch(() => [])
              : Promise.resolve([]),
          ]);
          web = webFound;
          if (found.length || web.length) {
            // for a deep node the fresh posts ARE the evidence; padding with
            // unrelated timeline posts is what produced the dead ends
            corpus = node.depth >= 1 ? found : [...corpus, ...found];
            newPosts = Object.fromEntries(found.map((p) => [p.id, p]));
            groundedNow = true;
            console.log(
              "[expand] refreshed %s via X search: %s -> %d new posts (corpus %d)",
              nodeId, q, found.length, corpus.length,
            );
          }
        } catch (err) {
          console.warn("[expand] X grounding failed, falling back:", err);
        }
      }
    }

    // fall back to x_search when the X API couldn't ground it, or for the
    // discovery forks
    // Fall back to x_search whenever we're left with too little NEW evidence
    // to say anything worth reading — not only when there's literally none.
    // Expanding on two leftover posts produces "no corpus evidence for X",
    // which is a dead end dressed as an answer.
    const useXSearch =
      hasGrok() &&
      (XSEARCH_FORKS.has(fork) || (wantsFresh && !groundedNow));

    if (useXSearch) {
      const out = await expandViaXSearch(node, fork, ancestors, covered.titles);
      raw = out.children;
      const verified = await verifyCitations(out.posts.filter(isNew));
      newPosts = { ...newPosts, ...verified };
      summary = out.summary;
    } else {
      const out = await expandNode(node, fork, corpus, ancestors, covered.titles, web);
      raw = out.children;
      summary = out.summary;
    }

    const postsForCitations = { ...board.posts, ...newPosts };
    let children = childrenToNodes(node, raw, postsForCitations, fork).map((c, i) => {
      const refs = raw[i]?.source_web_ids ?? [];
      // the model cites "web2" twice more often than you'd hope; dedupe by URL
      // or the card renders the same outlet twice and React sees two nodes
      // under one key
      const cited = [
        ...new Map(
          refs
            .map((r) => web[Number(String(r).replace(/\D/g, "")) - 1])
            .filter(Boolean)
            .map((w) => [w.url, w] as const),
        ).values(),
      ];
      return cited.length
        ? {
            ...c,
            source_web_ids: undefined,
            source_urls_meta: cited.map((w) => ({
              url: w.url,
              title: w.title,
              siteName: w.siteName,
            })),
          }
        : c;
    });

    /**
     * Drop claims left with no evidence.
     *
     * verifyCitations deletes fabricated posts, but the claim they "supported"
     * survived with an empty citation list — rendering as merely uncited,
     * indistinguishable from a properly grounded sibling. We watched Grok
     * fabricate 6/6 URLs in one call, so this is the difference between the
     * check working and the check looking like it worked.
     *
     * If EVERY child is uncited we keep one: that's the honest "nothing found
     * here" answer, which is a real result rather than a fabrication.
     */
    const cited = children.filter((c) => c.source_post_ids.length > 0);
    if (cited.length > 0 && cited.length < children.length) {
      console.warn(
        "[expand] dropped %d/%d claims left with no surviving evidence",
        children.length - cited.length,
        children.length,
      );
      children = cited;
    } else if (cited.length === 0) {
      children = children.slice(0, 1).map((c) => ({
        ...c,
        epistemic: "thin_evidence" as const,
      }));
    }

    // only patch the server graph when it actually owns this node
    if (serverBoard?.nodes[nodeId]) patchBoard((b) => {
      const prev = b.nodes[nodeId];
      // the board can be reseeded while a 10s expand is in flight — if this
      // node's board is gone, drop the patch rather than crashing the request
      if (!prev) return b;
      const nodes = { ...b.nodes };
      for (const c of children) nodes[c.id] = c;
      nodes[nodeId] = rollUpCitations(
        {
          ...prev,
          children_ids:
            fork === "deeper"
              ? children.map((c) => c.id)
              : [...prev.children_ids, ...children.map((c) => c.id)],
          // a bare trending headline gets its story once we've actually
          // searched — grounded now, so writing it is no longer an invention
          body: prev.body || summary,
          has_children: true,
          updated_at: new Date().toISOString(),
        },
        children,
      );
      return { ...b, nodes, posts: { ...b.posts, ...newPosts } };
    });

    // Persist AFTER the response flushes: the disk write must never sit in the
    // latency path of an expand the user is watching.
    after(() => persistWarmedBoard(getBoard()));

    // ship the posts back so the client can render their citation chips
    return NextResponse.json({
      children,
      posts: newPosts,
      fork,
      summary,
      // distinguish posts we just fetched from X for this node from ones that
      // were already in the board's corpus
      source: useXSearch ? "x_search" : groundedNow ? "x_grounded" : "timeline",
    });
  } catch (err) {
    console.error("[expand]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "expand failed" },
      { status: 500 },
    );
  }
}
