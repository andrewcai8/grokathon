import type { Board, BranchNode, Fork, GrokChild, GrokCluster, XPost } from "./schema";
import type { WebSource } from "./evidence";
import type { OptionChild } from "./optionsExpander";
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
 * Options -> nodes. Same split as childrenToNodes: the model invented the
 * meaning, we assign identity, wiring and depth.
 *
 * Three differences from a claim, all of them the point of the exercise:
 * no epistemic status (an option is not true or false), attributes instead of
 * citations as the thing you read, and a pending image request expressed as
 * media with a prompt but no url yet — the card asks for its own picture, so
 * the column lands instantly and fills in.
 */
/**
 * Drop attributes that don't discriminate.
 *
 * An attribute whose value reads the same on all three cards tells you nothing
 * — it's usually the constraint restated ("Price band: under $30,000" inside a
 * search for cars under $30,000), which costs a row and buys no decision.
 *
 * The prompt asks for this and the model still does it, which is the same
 * lesson novelty taught: if correctness depends on the model REMEMBERING a
 * rule, it will eventually forget. So it's enforced here instead — a
 * non-discriminating attribute cannot reach a card.
 */
/**
 * A placeholder is not a value.
 *
 * Told to keep labels identical across siblings, the model pads the gaps with
 * "Not listed" rather than dropping the row — so an option the sources are thin
 * on renders as a card of blanks and reads as broken rather than as sparse.
 * Omitting the row says the same thing and costs no space; a partial row is
 * itself information, which is why the check below tolerates one.
 */
const PLACEHOLDER = /^(n\/?a|not listed|not (?:yet )?(?:available|announced|specified)|unknown|tbd|varies|—|-)$/i;

function discriminating(raw: OptionChild[]) {
  const options = raw.map((o) => ({
    ...o,
    attributes: (o.attributes ?? []).filter((a) => !PLACEHOLDER.test(a.value.trim())),
  }));
  if (options.length < 2) return options;
  const norm = (v: string) => v.trim().toLowerCase();
  const dead = new Set<string>();

  for (const label of new Set(options.flatMap((o) => o.attributes?.map((a) => a.label) ?? []))) {
    const values = options.map((o) => o.attributes?.find((a) => a.label === label)?.value);
    // only judge a label every option carries; a partial row is already
    // information ("only this one has a tow rating")
    if (values.some((v) => v === undefined)) continue;
    if (new Set(values.map((v) => norm(v!))).size === 1) dead.add(label);
  }

  if (!dead.size) return options;
  console.log("[options] dropped non-discriminating attributes: %s", [...dead].join(", "));
  return options.map((o) => ({
    ...o,
    attributes: (o.attributes ?? []).filter((a) => !dead.has(a.label)),
  }));
}

export function optionsToNodes(
  parent: BranchNode,
  rawOptions: OptionChild[],
  web: WebSource[],
): BranchNode[] {
  const options = discriminating(rawOptions);
  const now = new Date().toISOString();
  return options.map((o) => {
    const id = newId("o");
    // refs come back as "web3"; resolve against the corpus we actually
    // retrieved, and drop anything that doesn't resolve rather than rendering
    // a source we can't stand behind
    const cited = (o.source_web_ids ?? [])
      .map((r) => web[Number(String(r).replace(/\D/g, "")) - 1])
      .filter(Boolean);

    return {
      id,
      type: "option" as const,
      title: o.title,
      body: o.body,
      parent_id: parent.id,
      children_ids: [],
      priority: o.priority ?? 0.5,
      generality: Math.max(0, parent.generality - 0.15),
      depth: parent.depth + 1,
      // options aren't grounded in X posts; their grounding is the pages the
      // attributes were read out of
      source_post_ids: [],
      source_urls_meta: cited.map((w) => ({
        url: w.url,
        title: w.title,
        siteName: w.siteName,
      })),
      attributes: o.attributes?.filter((a) => a.label && a.value) ?? [],
      // the board recurses indefinitely — see childrenToNodes. Grok's own
      // signal becomes the unread hint, not a locked door.
      has_children: true,
      unread_depth: o.has_children,
      media: o.image_prompt
        ? { kind: "generated_image" as const, alt: o.image_prompt }
        : undefined,
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
): { postIds: Set<string>; urls: Set<string>; titles: string[] } {
  const postIds = new Set<string>();
  // web sources get the same treatment as posts: an options board that keeps
  // re-reading the same buying guide produces the same three cars three levels
  // running, which is the exact failure the post rule was written to stop
  const urls = new Set<string>();
  const titles: string[] = [];
  for (const n of Object.values(board.nodes)) {
    if (n.id === excludeNodeId) continue;
    for (const id of n.source_post_ids) postIds.add(id);
    for (const w of n.source_urls_meta ?? []) urls.add(w.url);
    titles.push(n.title);
  }
  return { postIds, urls, titles };
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
