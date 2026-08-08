import type { Board, BranchNode, Fork, GrokChild, GrokCluster, XPost } from "./schema";

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
