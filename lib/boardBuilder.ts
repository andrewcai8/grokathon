import type { Board, BranchNode, Fork, GrokChild, GrokCluster, XPost } from "./schema";
import type { XTrend } from "./xClient";

/**
 * Grok invents meaning. We assign identity, wiring and timestamps.
 *
 * This split is deliberate: a bad generation can produce a weird title, but it
 * can never corrupt the graph structure, orphan a node, or fabricate an ID that
 * collides with a real one.
 */

let counter = 0;
function newId(prefix: string) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Drop any citation that isn't a real post in our corpus. Non-negotiable. */
function keepRealPosts(ids: string[], posts: Record<string, XPost>) {
  return ids.filter((id) => Boolean(posts[id]));
}

export function buildBoard(
  cluster: GrokCluster,
  posts: XPost[],
  opts: { date: string; label: string; mode: Board["seed"]["mode"]; snapshot?: boolean },
): Board {
  const postMap = Object.fromEntries(posts.map((p) => [p.id, p]));
  const now = new Date().toISOString();
  const nodes: Record<string, BranchNode> = {};
  const rootIds: string[] = [];

  for (const t of cluster.topics) {
    const id = newId("t");
    rootIds.push(id);
    nodes[id] = {
      id,
      type: "topic",
      title: t.title,
      body: t.body,
      parent_id: null,
      children_ids: [],
      priority: t.priority,
      generality: 1,
      depth: 0,
      source_post_ids: keepRealPosts(t.source_post_ids, postMap),
      has_children: true,
      unread_depth: t.priority > 0.6,
      epistemic: t.epistemic,
      created_at: now,
      updated_at: now,
    };
  }

  return {
    date: opts.date,
    seed: { mode: opts.mode, label: opts.label, snapshot: opts.snapshot },
    nodes,
    root_ids: rootIds,
    posts: postMap,
  };
}

/**
 * Trends ARE the roots.
 *
 * X's personalised trends already come back as topics — headline, category,
 * volume. Clustering exists to recover structure from unstructured posts; here
 * there's nothing to recover, so we skip the search-and-recluster round trip
 * entirely. The board opens in about a second instead of eighteen, with no
 * Grok call at all, and the citations arrive when you expand.
 */
export function buildBoardFromTrends(
  trends: XTrend[],
  opts: { date: string; label: string; limit: number },
): Board {
  const now = new Date().toISOString();
  const nodes: Record<string, BranchNode> = {};
  const rootIds: string[] = [];
  const top = trends.slice(0, opts.limit);
  const busiest = Math.max(1, ...top.map((t) => t.postCount));

  for (const trend of top) {
    const id = newId("t");
    rootIds.push(id);
    nodes[id] = {
      id,
      type: "topic",
      title: trend.name,
      // no body: the trend headline IS the content. Inventing a summary here
      // would be the one thing this product must never do — assert something
      // no post supports.
      body: undefined,
      parent_id: null,
      children_ids: [],
      priority: trend.postCount / busiest,
      generality: 1,
      depth: 0,
      source_post_ids: [],
      has_children: true,
      unread_depth: true,
      heat: trend.postCount / busiest,
      created_at: now,
      updated_at: now,
    };
  }

  return {
    date: opts.date,
    seed: { mode: "trending", label: opts.label },
    nodes,
    root_ids: rootIds,
    posts: {},
  };
}

/**
 * Roll a parent's citations up from its children.
 *
 * A trending root starts with no posts — X's trends API is confirmed to carry
 * no trend ID, no query and no post IDs, so a headline is genuinely all we get.
 * That left root cards with no citation chips, which breaks the board's one
 * invariant: everything shown is grounded in real posts.
 *
 * Once the children come back from x_search with VERIFIED posts, those posts
 * evidence the parent topic just as much as they evidence the child claim, so
 * the parent adopts a few. Costs nothing — no extra call — and the chips are
 * the same verified posts, not a second-hand claim about them.
 */
export function rollUpCitations(
  parent: BranchNode,
  children: BranchNode[],
  limit = 3,
): BranchNode {
  if (parent.source_post_ids.length > 0) return parent;
  const ids = [...new Set(children.flatMap((c) => c.source_post_ids))].slice(0, limit);
  if (!ids.length) return parent;
  return { ...parent, source_post_ids: ids };
}

export function childrenToNodes(
  parent: BranchNode,
  children: GrokChild[],
  posts: Record<string, XPost>,
  fork: Fork,
): BranchNode[] {
  const now = new Date().toISOString();
  return children.map((c) => {
    const id = newId(c.type[0] ?? "n");
    return {
      id,
      type: c.type,
      title: c.title,
      body: c.body,
      parent_id: parent.id,
      children_ids: [],
      priority: c.priority,
      // never let a child claim to be more general than its parent
      generality: Math.min(c.generality, Math.max(0, parent.generality - 0.05)),
      depth: parent.depth + 1,
      source_post_ids: keepRealPosts(c.source_post_ids, posts),
      /**
       * Always true. The board is infinitely recursive by design — there is
       * always a more specific question to ask, so no card is ever a dead end.
       *
       * Grok's own has_children signal is kept as a HINT (below) about whether
       * it knows of real depth here, which drives the unread dot. That's the
       * honest reading: "I don't know of more" is guidance, not a locked door.
       * If you expand anyway and there genuinely is nothing, Grok says so in a
       * node — which is a real answer, unlike an inert card.
       */
      has_children: true,
      unread_depth: c.has_children,
      epistemic: c.epistemic,
      fork: fork === "deeper" ? undefined : fork,
      created_at: now,
      updated_at: now,
    };
  });
}

/**
 * Everything the board has ALREADY said.
 *
 * Depth has to pay for itself. Someone expands a node because they're curious
 * and want to learn more — if the children re-cite the same posts and restate
 * the same ideas in narrower words, curiosity gets punished and the tree is
 * just a thesaurus. So we tell Grok what's already on the board and, more
 * importantly, remove those posts from the corpus it can draw on. Novelty then
 * isn't something the model has to remember to do; it's the only thing it can
 * do.
 */
export function coveredGround(
  board: Board,
  excludeNodeId?: string,
): { postIds: Set<string>; titles: string[] } {
  const postIds = new Set<string>();
  const titles: string[] = [];
  for (const n of Object.values(board.nodes)) {
    if (n.id === excludeNodeId) continue;
    for (const id of n.source_post_ids) postIds.add(id);
    titles.push(n.title);
  }
  return { postIds, titles };
}

/**
 * ONLY what this node and its ancestors actually cite — no top-up.
 *
 * This is the grounding test: does this node have evidence behind it, or is it
 * a bare headline? relevantPosts() deliberately pads with the rest of the
 * corpus so Grok can find new evidence, which makes it useless for that
 * question — an ungrounded trend root looked grounded purely because some
 * other board's posts were still in memory.
 */
export function citedPosts(board: Board, nodeId: string): XPost[] {
  const ids = new Set<string>();
  let cur: BranchNode | undefined = board.nodes[nodeId];
  while (cur) {
    for (const id of cur.source_post_ids) ids.add(id);
    cur = cur.parent_id ? board.nodes[cur.parent_id] : undefined;
  }
  return [...ids].map((id) => board.posts[id]).filter(Boolean);
}

/** Posts relevant to a node: its own citations plus its ancestors'. */
export function relevantPosts(board: Board, nodeId: string, limit = 40): XPost[] {
  const ids = new Set<string>();
  let cur: BranchNode | undefined = board.nodes[nodeId];
  while (cur) {
    for (const id of cur.source_post_ids) ids.add(id);
    cur = cur.parent_id ? board.nodes[cur.parent_id] : undefined;
  }
  // top up with the rest of the corpus so Grok can find genuinely new evidence
  const picked = [...ids].map((id) => board.posts[id]).filter(Boolean);
  if (picked.length < limit) {
    for (const p of Object.values(board.posts)) {
      if (picked.length >= limit) break;
      if (!ids.has(p.id)) picked.push(p);
    }
  }
  return picked.slice(0, limit);
}

export function ancestorTitles(board: Board, nodeId: string): string[] {
  const out: string[] = [];
  let cur = board.nodes[nodeId]?.parent_id
    ? board.nodes[board.nodes[nodeId].parent_id!]
    : undefined;
  while (cur) {
    out.unshift(cur.title);
    cur = cur.parent_id ? board.nodes[cur.parent_id] : undefined;
  }
  return out;
}
