import { after, NextResponse } from "next/server";
import { persistWarmedBoard } from "@/lib/snapshot";
import {
  expandNode,
  expandViaXSearch,
  hasGrok,
  MAX_CHILDREN,
  readMedia,
  relaxedQuery,
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
import { askAgent } from "@/lib/askAgent";
import { isGrounded, rankEvidence, type BoardKind } from "@/lib/evidence";
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
 * Enough posts to say something, rather than enough to prove we searched.
 *
 * One number, two callers, because it is one judgement: below this an expand
 * produces a shrug rather than a reading. It decides both when to go and fetch
 * fresh evidence (the novel corpus has run dry) and when a search that returned
 * *something* still hasn't returned enough (see groundNode). Those were briefly
 * two constants holding the same 5 for the same reason, which is the kind of
 * pair that silently stops agreeing.
 */
const MIN_CORPUS = 5;

/**
 * Go and find posts for a node, and don't take silence for an answer.
 *
 * The failure this exists for, observed on a live board: the user's #1
 * personalised trend produced no usable posts, because `searchQueryFor` writes
 * a precise query and precision is what fails against a synthesised headline.
 * It ANDs several terms of a summary nobody phrased that way against posts that
 * phrase it differently. The empty result then travelled onward
 * indistinguishable from "nothing was posted about this" — so the board wrote
 * that down as a finding, on the loudest card on screen, about the story X had
 * just told us everyone was discussing.
 *
 * Measured against that exact trend while it was still live, the precise query
 * returned ONE post. So "did we get anything" is the wrong bar — one post is a
 * corpus you can't write from, and it was already known to produce "no corpus
 * evidence for X" (see the x_search note below). We top up from a blunter query
 * instead of replacing: the precise hits are the most on-topic ones we'll get,
 * they just aren't enough on their own.
 *
 * And the two silences stay apart — no posts because nobody posted, and no
 * posts because the search failed, are different facts, and only one of them is
 * about the world.
 */
async function groundNode(
  token: string,
  title: string,
): Promise<{ posts: XPost[]; query?: string; error?: string }> {
  const queries: string[] = [];
  try {
    queries.push(await searchQueryFor(title));
  } catch (err) {
    // one flaky model call must not cost us the retrieval it was only phrasing
    console.warn("[expand] query generation failed, falling back to terms:", err);
  }
  queries.push(relaxedQuery(title));

  // insertion order is preference order: whatever the precise query found stays
  // in front of the top-up, and dedupe keeps the overlap from counting twice
  const byId = new Map<string, XPost>();
  const used: string[] = [];
  let error: string | undefined;

  for (const query of queries) {
    try {
      const posts = await searchRecent(token, query, 40);
      for (const p of posts) if (!byId.has(p.id)) byId.set(p.id, p);
      if (posts.length) used.push(query);
      // the second query costs ~300ms and only runs when the first left us
      // without enough to write from
      if (byId.size >= MIN_CORPUS) break;
      console.warn(
        "[expand] X search returned %d post(s) — below the floor — for: %s",
        posts.length, query,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : "X search failed";
      console.error("[expand] X search FAILED (not empty) for %s: %s", query, error);
    }
  }

  return {
    posts: [...byId.values()],
    query: used.join("  |  ") || undefined,
    // a search that ultimately found posts is not a failed one
    error: byId.size ? undefined : error,
  };
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
    /** fork "ask" only: the user's question, verbatim */
    question?: string;
    /**
     * Options boards only: the decision the whole board is narrowing, i.e. the
     * seed label. Travels with the request for the same reason `node` and
     * `kind` do — the server's one board slot is routinely something else.
     */
    boardQuestion?: string;
    /**
     * fork "ask" only: ids of the posts the agent should start from.
     *
     * A question node is minted by the client and cites nothing of its own —
     * it's a question, not a claim — so there is no citedPosts() to derive the
     * starting corpus from. The card it was asked FROM has one, and the client
     * is the only side guaranteed to know which card that was.
     */
    corpus?: string[];
  };
  const nodeId = body.nodeId;
  if (!nodeId) {
    return NextResponse.json({ error: "nodeId required" }, { status: 400 });
  }

  const fork: Fork = ForkSchema.safeParse(body.fork).success
    ? (body.fork as Fork)
    : "deeper";

  /**
   * What the board is FOR is settled first, because it picks the slot.
   *
   * The server keeps one board per kind, so the kind has to be known before
   * there is a board to read it off — and the client is the one that knows:
   * it's the thing displaying it. This used to read `board.kind ?? body.kind`
   * against a single shared slot, which meant the answer depended on whichever
   * board that slot happened to be holding.
   */
  const kind: BoardKind = body.kind ?? "news";

  const serverBoard = getBoard(kind);
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
        kind,
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

  /**
   * @grok — the user wrote the fork themselves.
   *
   * Same seam as every other fork: a node in, at most N cited children out.
   * What differs is that we don't know what the question needs, so this is the
   * one path where the model chooses its own retrieval — see askAgent.
   *
   * The question is the node's TITLE, not a parameter, because the client mints
   * a real question node before calling. That's what makes two different
   * questions on one card two different branches instead of a cache collision,
   * and it's why nothing above this line needed a special case for "ask".
   */
  if (fork === "ask") {
    if (!hasGrok()) {
      return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 503 });
    }
    /**
     * Ask is a CLAIM-shaped fork, so it belongs to claim-shaped boards.
     *
     * It runs before the kind check because a question node is minted by the
     * client and needs handling before anything reads the board — but that
     * ordering meant asking a question on a decision board answered with claim
     * cards carrying epistemic badges and X post citations. Options aren't true
     * or false, so that is the one category error the evidence split exists to
     * prevent, and it was the only cross-kind leak anywhere in the API.
     *
     * Refused rather than silently answered in the wrong currency. Delete this
     * the moment ask learns to answer in attributes.
     */
    if (kind === "options") {
      return NextResponse.json(
        { error: "asking isn't supported on a decision board yet" },
        { status: 422 },
      );
    }
    const question = (body.question ?? node.title).trim();
    if (!question) {
      return NextResponse.json({ error: "question required" }, { status: 400 });
    }

    try {
      const tok = await activeToken();
      const ancestors = serverBoard?.nodes[nodeId]
        ? ancestorTitles(board, nodeId)
        : (body.ancestors ?? []);
      // the card's own evidence is where the agent starts; it decides whether
      // that is enough and goes and gets more if not
      const corpus = (body.corpus ?? [])
        .map((id) => board.posts[id])
        .filter(Boolean) as XPost[];

      const out = await askAgent({
        question,
        parent: node,
        ancestors,
        corpus,
        covered: coveredGround(board, nodeId).titles,
        xToken: tok?.access_token,
      });

      // Only the posts actually cited reach the board. The agent's pool can
      // hold sixty posts after four searches and the other fifty-odd are
      // working memory, not evidence — shipping them would bloat every
      // snapshot and make coveredGround think the user had read them.
      const citedIds = new Set([
        ...out.children.flatMap((c) => c.source_post_ids),
        // the answer's own sources travel too, or a zero-card ask would ship
        // citation ids with no posts for the chips to render from
        ...out.answerPostIds,
      ]);
      const posts = Object.fromEntries(
        [...citedIds].map((id) => [id, out.posts[id]]).filter(([, p]) => Boolean(p)),
      ) as Record<string, XPost>;

      let children = childrenToNodes(node, out.children, posts, "ask").map((c, i) => {
        const refs = out.children[i]?.source_web_ids ?? [];
        const cited = [
          ...new Map(
            refs
              .map((r) => out.web[Number(String(r).replace(/\D/g, "")) - 1])
              .filter(Boolean)
              .map((w) => [w.url, w] as const),
          ).values(),
        ];
        return cited.length
          ? {
              ...c,
              source_urls_meta: cited.map((w) => ({
                url: w.url,
                title: w.title,
                siteName: w.siteName,
              })),
            }
          : c;
      });

      /**
       * Uncited CARDS are dropped. The ANSWER is never dropped.
       *
       * Every other fork now REPORTS a total grounding failure rather than
       * showing anything for it, because a card nothing backs is worse than an
       * error. An ask is the one fork that can lose all its cards and still
       * have something to show: the answer sits on the question card either
       * way. So this drops silently all the way to zero instead of erroring —
       * a question with a straight answer and no evidence cards is a normal,
       * good outcome. (It's also what stopped a degenerate generation titled
       * "placeholder" from being promoted into a lone thin_evidence finding.)
       */
      const before = children.length;
      children = children.filter(isGrounded);
      if (children.length < before) {
        console.warn(
          "[expand/ask] dropped %d/%d cards with no surviving evidence",
          before - children.length,
          before,
        );
      }

      /**
       * An ask is NOT written into the server board, and deliberately so.
       *
       * This used to graft the question node and its answers into the shared
       * graph, keyed off the parent, so a rehearsed question would be warm on
       * stage. That was a mistake with a much bigger blast radius than the
       * benefit: the server board is one process-wide object that every client
       * seeds from, and persistWarmedBoard writes it to .snapshots/latest.json.
       * So every question anyone ever asked came back on every future load,
       * hanging off the card it was asked from — four test questions were
       * enough to make a fresh board look like it had duplicated itself.
       *
       * A question belongs to the person who typed it and to the session they
       * typed it in. The client already owns the question node outright (it
       * mints it, and sends it back as body.node), so keeping it client-side
       * costs nothing except that a rehearsed ask is no longer pre-warmed.
       */

      console.log(
        '[expand/ask] "%s" -> %d tool calls (%s) -> %d children',
        question,
        out.trace.length,
        out.trace.map((t) => `${t.tool}:${t.got}`).join(" ") || "none",
        children.length,
      );

      return NextResponse.json({
        children,
        posts,
        fork: "ask",
        // becomes the question node's body — mergeChildren already does
        // `body ||= summary`, so the card you typed into fills itself in with
        // the direct answer while the evidence lands underneath it
        summary: out.answer,
        source: "x_agent",
        trace: out.trace,
        // the card renders an unsourced answer differently — it's Grok
        // talking, not evidence, and the two must not look alike here
        grounded: out.grounded,
        // the answer's own citations, rendered under the reply itself so an
        // ask that returns no cards is still visibly grounded
        answerPostIds: out.answerPostIds.filter((id) => posts[id]),
        answerWeb: out.answerWeb.map((w) => ({
          url: w.url,
          title: w.title,
          siteName: w.siteName,
        })),
      });
    } catch (err) {
      console.error("[expand/ask]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "ask failed" },
        { status: 500 },
      );
    }
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
      const lineage = serverBoard?.nodes[nodeId]
        ? ancestorTitles(board, nodeId)
        : (body.ancestors ?? []);

      /**
       * The question is the first ancestor of every option on the board.
       *
       * A root's ancestors are [] — its parent is the question, and the question
       * has no card. So the entire retrieval context for a root expand was its
       * own title, and option titles are written as points on an axis rather
       * than as things: "Budget frames under $250", "Short-haul (under 6 hours)",
       * "Solid setups $300-$500". None of those contain the subject. Searching
       * the web for them returns whatever that phrase means to the open
       * internet, so a standing-desk board expanded into digital photo frames,
       * a winter-sun board into airlines, and a headphones board into
       * smartphones — every card beautifully sourced and about the wrong
       * product entirely. Nothing on the card could tell you it had happened,
       * which makes it the exact failure the grounding invariant exists to
       * prevent: confident, cited, and not about what you asked.
       *
       * The board's seed label IS the question, so it leads the lineage. The
       * client sends it for the same reason it sends the node and the kind:
       * the server's single board slot may be showing something else entirely.
       */
      const question = (
        board.kind === "options" && board.seed.label !== "client"
          ? board.seed.label
          : body.boardQuestion
      )?.trim();
      const ancestors =
        question && !lineage.includes(question) ? [question, ...lineage] : lineage;

      // sources already used on this board are removed before the model sees
      // them — structural novelty, exactly as posts are for news
      const { web, query } = await optionCorpus(node.title, ancestors, covered.urls);
      if (!web.length) {
        return NextResponse.json(
          { error: `nothing new found for "${query}"` },
          { status: 404 },
        );
      }

      const { options, summary, axis, exhausted } = await expandOptions(
        node,
        ancestors,
        covered.titles,
        web,
      );

      /**
       * "That's all of them" is an answer, not a failure.
       *
       * The expander can now say a category divides no further and hand back an
       * empty set deliberately. This route didn't know that and turned it into a
       * 502, so the honest end of a refinement — the point where you've actually
       * converged on a choice, which is what the whole board is FOR — rendered
       * as "no options returned" in warning colour with an invitation to retry.
       * A dead end you can't tell from a crash is the worst of both.
       *
       * Empty WITHOUT that flag is still a real failure and still says so.
       */
      /**
       * Exhaustion has to be earned.
       *
       * "That's all of them" is a real answer at the bottom of a funnel, where
       * the node already names one specific purchasable thing. Near the TOP it
       * is almost always a retrieval miss wearing the answer's clothes: the
       * corpus came back about the wrong subject, the model correctly found it
       * could not divide the parent along its axis, and said so — one observed
       * summary read "these are adjustable bed frames, not sit-stand desks"
       * while the route forwarded it as a successful, terminal expansion.
       *
       * Measured: a category whose own summary named its split ("body style and
       * the step up to Sport Touring") still claimed exhaustion on 6 of 7
       * identical calls. So a shallow claim of exhaustion is not trusted — it
       * is reported as the failure it is, which is the whole of I4.
       */
      const MIN_EXHAUSTIBLE_DEPTH = 2;
      if (!options.length && exhausted && node.depth < MIN_EXHAUSTIBLE_DEPTH) {
        console.warn(
          "[expand/options] rejected exhausted at depth %d for %s (query: %s)",
          node.depth, node.title, query,
        );
        return NextResponse.json(
          {
            error: `no options found for "${node.title}" — the sources came back off-subject`,
          },
          { status: 422 },
        );
      }

      if (!options.length) {
        return exhausted
          ? NextResponse.json({
              children: [],
              posts: {},
              fork: "deeper",
              exhausted: true,
              summary,
              source: "web",
            })
          : NextResponse.json({ error: "no options returned" }, { status: 502 });
      }

      const children = optionsToNodes(node, options, web);

      if (serverBoard?.nodes[nodeId]) patchBoard(kind, (b) => {
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

      after(() => persistWarmedBoard(getBoard(kind)));
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

      if (serverBoard?.nodes[nodeId]) patchBoard(kind, (b) =>
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
      after(() => persistWarmedBoard(getBoard(kind)));
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
      patchBoard(kind, (b) =>
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
      after(() => persistWarmedBoard(getBoard(kind)));
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
    /** set only when the web search THREW — never when it simply found nothing */
    let webError: string | undefined;
    /** the same distinction for X: a failed search is not an empty timeline */
    let xError: string | undefined;

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
    const wantsFresh = node.depth >= 1 || corpus.length < MIN_CORPUS;

    /**
     * The web is fetched for every model-written expand.
     *
     * It used to hang off two conditions it has nothing to do with. It only ran
     * when the POST corpus needed refreshing, so a root with a healthy timeline
     * corpus — which is most roots on a warm board, and the cards people
     * actually look at — never saw a single article. And it sat inside the X
     * token check, so no X token meant no web either, though Exa needs nothing
     * from X. Measured on a live board: five children across two root expands,
     * zero web sources; the same story one level down cited Digg immediately.
     *
     * It is one parallel second and $0.007, so the honest default is to always
     * ask and let the model use it or not.
     */
    const webPromise: Promise<WebSource[]> =
      !XSEARCH_FORKS.has(fork) && hasExa()
        ? searchWeb(node.title, {
            numResults: 5,
            // headline-derived query: journalism is what we want, and
            // recency keeps a fast-moving story off last year's coverage
            category: "news",
            startPublishedDate: new Date(
              Date.now() - 14 * 24 * 3600 * 1000,
            ).toISOString(),
          })
            /**
             * Novelty applies to articles too.
             *
             * Posts already cited are stripped from the corpus before the model
             * sees them, and the options board does the same for its web
             * sources — but the news path computed covered.urls and never used
             * it. Measured on a live subtree: 15 distinct urls across 26
             * citations, 9 reused, one article cited on four cards including a
             * parent and its own child. That is exactly how a level-4 card ends
             * up a rewording of level 3: same evidence in, same words out. The
             * rule is meant to be structural, not remembered, so the reused
             * article never reaches the prompt at all.
             */
            .then((found) => {
              /**
               * Including this node's OWN articles.
               *
               * coveredGround deliberately excludes the node being expanded, so
               * that its own evidence stays available as context for reasoning
               * about it. Correct for posts, wrong for this: the article behind
               * the card you just clicked is the one thing you have certainly
               * already read, and re-serving it is how a child ends up a
               * rewording of its parent. Measured: one url cited on four cards,
               * a parent and its own child among them.
               */
              const read = new Set([
                ...covered.urls,
                ...(node.source_urls_meta ?? []).map((w) => w.url),
              ]);
              return found.filter((w) => !read.has(w.url));
            })
            .catch((err) => {
            /**
             * A failed search is not an empty one.
             *
             * Swallowing this to [] made an Exa outage, a rate limit or a bad
             * key render exactly like "there is no reporting on this" — and the
             * model, handed nothing, then writes a card saying the evidence
             * doesn't exist. That is a silent failure wearing the costume of a
             * finding, which is the one failure mode this board is not allowed
             * to have. We still don't fail the expand over it: the posts are
             * real evidence on their own. We just refuse to let the absence
             * pass as a result.
             */
            webError = err instanceof Error ? err.message : "web search failed";
            console.error("[expand] web search FAILED (not empty):", err);
            return [] as WebSource[];
          })
        : Promise.resolve([] as WebSource[]);

    if (wantsFresh && !XSEARCH_FORKS.has(fork)) {
      const tok = await activeToken();
      if (tok?.access_token) {
        try {
          // X and the web in parallel: what people are saying, and what was
          // reported. For a factual claim the reporting is usually the better
          // evidence, and it's real by construction either way.
          const [hits, webFound] = await Promise.all([
            groundNode(tok.access_token, node.title),
            webPromise,
          ]);
          web = webFound;
          xError = hits.error;

          /**
           * Novelty is a preference, not a precondition.
           *
           * `isNew` strips every post the board has already cited, which is
           * right for a node that HAS evidence — depth should teach you
           * something. For a node with none it is backwards: it can strip the
           * search down to nothing and leave the card ungrounded, and a post
           * you've seen elsewhere is still infinitely better grounding than the
           * board admitting it found nothing. So the filter applies, and then
           * gets out of the way if it emptied the only evidence we have.
           */
          // rank before the corpus is capped: a search returns forty hits and
          // the model reads them in the order we hand them over
          const fresh = rankEvidence(hits.posts.filter(isNew));
          const found =
            fresh.length || grounded ? fresh : rankEvidence(hits.posts);
          if (found.length && !fresh.length) {
            console.log(
              "[expand] %s: novelty left 0 of %d hits; grounding on them anyway",
              nodeId, hits.posts.length,
            );
          }

          if (found.length || web.length) {
            // for a deep node the fresh posts ARE the evidence; padding with
            // unrelated timeline posts is what produced the dead ends
            corpus = node.depth >= 1 ? found : [...corpus, ...found];
            newPosts = Object.fromEntries(found.map((p) => [p.id, p]));
            groundedNow = true;
            console.log(
              "[expand] refreshed %s via X search: %s -> %d new posts (corpus %d)",
              nodeId, hits.query ?? "(no query succeeded)", found.length, corpus.length,
            );
          }
        } catch (err) {
          console.warn("[expand] X grounding failed, falling back:", err);
        }
      }
    }

    // whatever the X path did or didn't do, the articles stand on their own
    if (!web.length) web = await webPromise;

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
     *
     * A WEB source counts as evidence here, and the omission was quietly
     * undoing the point of retrieving the web at all: a claim carrying three
     * Bloomberg articles and no posts was deleted as unsupported, while the
     * reporting is usually the better evidence for a factual claim. Web sources
     * are also the safer half of the check — they are real by construction,
     * resolved against the corpus we fetched, with unresolvable refs already
     * dropped, so nothing here can be fabricated the way an x_search permalink
     * can.
     *
     * Shares isGrounded with the card and the HUD deliberately — three places
     * deciding "does anything back this" must not be able to disagree.
     */
    const cited = children.filter(isGrounded);
    if (cited.length > 0 && cited.length < children.length) {
      console.warn(
        "[expand] dropped %d/%d claims left with no surviving evidence",
        children.length - cited.length,
        children.length,
      );
      children = cited;
    } else if (cited.length === 0) {
      /**
       * Nothing survived. Report it; do not plant it.
       *
       * This used to keep one uncited child as the honest "nothing found here"
       * answer, and the honesty didn't survive contact with the board. What
       * shipped was a permanent card reading "No corpus evidence for <story>"
       * with the red no-sources marker, wired under X's #1 trend — and because
       * `body: prev.body ?? summary` runs below, the parent adopted the
       * apology as its own text. The failure then became load-bearing: its
       * title entered `coveredGround`, so every later attempt at that story was
       * told it had already been covered.
       *
       * A transient error is what this actually is. The replies fork has
       * reported exactly this way for a while (404 "No notable replies") and
       * the card stays expandable, which is the behaviour you want from a
       * search that came back thin — retryable, and gone by the next attempt.
       */
      console.warn("[expand] %s: no child survived grounding — reporting, not planting", nodeId);
      return NextResponse.json(
        {
          error: xError
            ? `Couldn't reach X for this one — ${xError}`
            : webError
              ? `Found nothing on X, and the web search failed — ${webError}`
              : "Nothing solid enough to cite yet — try again in a moment",
          fork,
          xError,
          webError,
        },
        { status: 422 },
      );
    }

    // only patch the server graph when it actually owns this node
    if (serverBoard?.nodes[nodeId]) patchBoard(kind, (b) => {
      const prev = b.nodes[nodeId];
      // the board can be reseeded while a 10s expand is in flight — if this
      // node's board is gone, drop the patch rather than crashing the request
      if (!prev) return b;
      const nodes = { ...b.nodes };
      for (const c of children) nodes[c.id] = c;
      nodes[nodeId] = rollUpCitations(
        {
          ...prev,
          /**
           * Replace this fork's branch, never anyone else's.
           *
           * A re-run of "deeper" used to overwrite children_ids outright, which
           * silently deleted the Counters, Replies and Primary branches hanging
           * off the same card. The nodes themselves survive in the graph with
           * nothing pointing at them, so they persist into the snapshot as
           * orphans — 27 of 147 nodes at one point — and the cache that makes a
           * rehearsed demo instant stops finding them, so the next click pays
           * full price to regenerate work that was already done.
           *
           * Keep every child that belongs to a DIFFERENT fork, drop the ones
           * this call is replacing, append the new batch.
           */
          children_ids: [
            ...prev.children_ids.filter((id) => {
              const kid = b.nodes[id];
              if (!kid) return false;
              return fork === "deeper" ? Boolean(kid.fork) : kid.fork !== fork;
            }),
            ...children.map((c) => c.id),
          ],
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
    after(() => persistWarmedBoard(getBoard(kind)));

    // ship the posts back so the client can render their citation chips
    return NextResponse.json({
      children,
      posts: newPosts,
      fork,
      summary,
      // distinguish posts we just fetched from X for this node from ones that
      // were already in the board's corpus
      source: useXSearch ? "x_search" : groundedNow ? "x_grounded" : "timeline",
      // the expand succeeded on posts alone, but the reporting half of the
      // evidence is missing and the card must not imply we looked and found
      // nothing
      webError,
      // and the mirror image: the web carried this one while X was unreachable
      xError,
    });
  } catch (err) {
    console.error("[expand]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "expand failed" },
      { status: 500 },
    );
  }
}
