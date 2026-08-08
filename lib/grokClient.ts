import OpenAI from "openai";
import {
  GrokClusterSchema,
  GrokExpandSchema,
  type BranchNode,
  type Fork,
  type GrokChild,
  type XPost,
} from "./schema";

/**
 * xAI is OpenAI-SDK compatible. Verified against docs.x.ai:
 *   base URL       https://api.x.ai/v1
 *   latest model   grok-4.5 (500k context)
 *   structured out response_format: {type:"json_schema", json_schema:{...,strict:true}}
 *
 * Schemas below are hand-written rather than generated from zod: strict mode
 * requires every property listed in `required` and additionalProperties:false,
 * and hand-writing keeps that contract obvious at the call site. We still parse
 * the response through zod so a bad generation can never reach the graph.
 */

export const GROK_MODEL = process.env.GROK_MODEL ?? "grok-4.5";
export const REASONING_EFFORT = process.env.GROK_REASONING_EFFORT ?? "low";

/**
 * Hard cap on children per expand.
 *
 * Three is a product decision, not a token-saving one. With band layout a
 * six-child expand consumed ~1460px of canvas and pushed every sibling below
 * it off-screen. Three fits one viewport, keeps the board navigable, and
 * roughly halves expand latency. We ask for the most load-bearing three rather
 * than simply fewer, so capping costs coverage instead of nuance.
 */
export const MAX_CHILDREN = Number(process.env.GROK_MAX_CHILDREN ?? 3);

let client: OpenAI | null = null;
export function grok(): OpenAI {
  if (!process.env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set");
  }
  client ??= new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1",
    // a demo cannot afford the SDK's default retry ladder — fail fast and fall
    // back to the snapshot rather than hanging the surface
    maxRetries: 1,
    timeout: 60_000,
  });
  return client;
}

export function hasGrok() {
  return Boolean(process.env.XAI_API_KEY);
}

const EPISTEMIC_ENUM = [
  "widely_shared",
  "contested",
  "note_flagged",
  "thin_evidence",
  "projection",
];

const CHILD_PROPS = {
  type: {
    type: "string",
    enum: ["topic", "story", "claim", "post", "person", "media"],
    description: "Node type. Use 'claim' for atomic assertions.",
  },
  title: {
    type: "string",
    description: "Headline, under 70 characters. Must be legible standing alone.",
  },
  body: {
    type: "string",
    description: "2-3 sentences maximum. A card body, never an essay.",
  },
  priority: {
    type: "number",
    description: "0-1. Drives vertical order. Engagement x importance x recency.",
  },
  generality: {
    type: "number",
    description: "0-1, where 1 is most general. Children are less general than parents.",
  },
  source_post_ids: {
    type: "array",
    items: { type: "string" },
    description:
      "Post IDs from the supplied corpus that evidence this node. REQUIRED for claims when any evidence exists. Never invent an ID.",
  },
  has_children: {
    type: "boolean",
    description: "Honestly: is there more real depth beneath this, or is it a leaf?",
  },
  epistemic: {
    type: "string",
    enum: EPISTEMIC_ENUM,
    description:
      "widely_shared = corroborated across accounts; contested = real disagreement present; thin_evidence = single source or unsupported; projection = about the future.",
  },
} as const;

function childSchema() {
  return {
    type: "object",
    properties: CHILD_PROPS,
    required: Object.keys(CHILD_PROPS),
    additionalProperties: false,
  };
}

type Grounding = "corpus" | "search";

/**
 * One prompt, two groundings.
 *
 * These were previously two independent prompt pairs, and they drifted: the
 * corpus wording ("the posts you are given are the ONLY ground truth") leaked
 * into the x_search path and told the model to disregard the search tool it had
 * just been handed — it reported "no dissent found in corpus" without looking.
 * Everything shared now lives in one place; only the grounding clause differs.
 */
const SHARED_RULES = `- Label epistemic status honestly. One account's claim is thin_evidence, not widely_shared. If credible accounts disagree, it is contested. Say so plainly.
- Bodies are 2-3 sentences. This is a card on a canvas, not an article.
- Titles must make sense read alone at a glance, with no body text visible.
- Be specific. "Market reaction" is a bad title; "Rates repriced harder than equities" is a good one.
- Do not manufacture balance, and do not flatten real disagreement into consensus.`;

const GROUNDING_RULES: Record<Grounding, string> = {
  corpus: `The posts you are given are the ONLY ground truth. Never assert anything they do not support, and never cite an ID that is not in the supplied corpus.`,
  search: `Ground truth is the posts you find with the x_search tool. Search thoroughly before concluding anything.
- Cite only real posts you actually found. Every URL must be a permalink you saw in results, and every quote verbatim from that post. Never fabricate either.
- Search first, conclude second. Do not report an absence of evidence until you have looked from more than one angle.`,
};

function systemFor(grounding: Grounding) {
  return `You structure a person's X (Twitter) timeline into a nested knowledge tree.

Absolute rules:
- ${GROUNDING_RULES[grounding]}
${SHARED_RULES}`;
}

const SYSTEM = systemFor("corpus");

function postLine(p: XPost) {
  const m = p.metrics
    ? ` [${p.metrics.likes} likes, ${p.metrics.reposts} reposts, ${p.metrics.replies} replies]`
    : "";
  return `id:${p.id} @${p.author.handle} (${p.author.name})${m}\n${p.text}`;
}

async function structured<T>(
  name: string,
  schema: Record<string, unknown>,
  userContent: string,
  parse: (raw: unknown) => T,
): Promise<T> {
  const res = await grok().chat.completions.create({
    model: GROK_MODEL,
    // grok-4.5 reasons at high effort by default, which pushed a 17-post
    // clustering call past 25s. Measured: low effort does the same job in ~10s
    // with ~300 reasoning tokens. Structuring posts is not a hard reasoning
    // problem, and latency IS the product here.
    reasoning_effort: REASONING_EFFORT as "low" | "medium" | "high",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name, schema, strict: true },
    },
  });

  const text = res.choices[0]?.message?.content;
  if (!text) throw new Error("Grok returned no content");
  return parse(JSON.parse(text));
}

/** Seed corpus -> root topics for the day. */
export async function clusterSeed(posts: XPost[]) {
  const schema = {
    type: "object",
    properties: {
      topics: {
        type: "array",
        minItems: 3,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            title: CHILD_PROPS.title,
            body: CHILD_PROPS.body,
            priority: CHILD_PROPS.priority,
            generality: CHILD_PROPS.generality,
            source_post_ids: CHILD_PROPS.source_post_ids,
            epistemic: CHILD_PROPS.epistemic,
          },
          required: [
            "title",
            "body",
            "priority",
            "generality",
            "source_post_ids",
            "epistemic",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["topics"],
    additionalProperties: false,
  };

  const content = `Here are ${posts.length} posts from my X timeline today. Cluster them into 5-8 topics that describe what my day actually contains.

Cover the major clusters. Rank by how much they matter to me, using engagement and how much of the timeline they occupy. Put genuine noise in a single low-priority "Other" topic rather than dignifying it.

POSTS:
${posts.map(postLine).join("\n\n")}`;

  return structured("day_topics", schema, content, (raw) =>
    GrokClusterSchema.parse(raw),
  );
}

const FORK_INTENT: Record<Fork, string> = {
  deeper: "the most specific, load-bearing sub-claims of this",
  counter:
    "the strongest opposing frames, dissent and contradicting evidence — including from accounts a typical follower of this topic would never see",
  primary_only:
    "original sources only: the people directly involved, officials, first-hand accounts and documents. Exclude commentary and punditry",
  people: "who is actually driving and amplifying this — one node per significant actor, citing their own posts",
  media: "the images, video and memes in this story, and what each is arguing",
  falsifiers:
    "what would change my mind: the specific missing evidence, and the observations that would falsify the main claims",
};

function forkInstruction(fork: Fork, grounding: Grounding) {
  const verb = grounding === "search" ? "Search X for" : "From the corpus, surface";
  const nothing =
    grounding === "search"
      ? "Only after searching from several angles, if there genuinely is nothing, say so plainly in one node."
      : "If it genuinely is not present in the corpus, say so plainly in one node rather than inventing it.";
  return `${verb} ${FORK_INTENT[fork]}.\n${nothing}`;
}

export async function expandNode(
  node: BranchNode,
  fork: Fork,
  posts: XPost[],
  ancestors: string[] = [],
): Promise<GrokChild[]> {
  const schema = {
    type: "object",
    properties: {
      children: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CHILDREN,
        items: childSchema(),
      },
    },
    required: ["children"],
    additionalProperties: false,
  };

  const content = `Expand this node into AT MOST ${MAX_CHILDREN} children.

Return only the most load-bearing ones — the children that would change how I
understand this if I read them. Fewer, sharper children beat more shallow ones.
Do not pad to reach ${MAX_CHILDREN}.

${ancestors.length ? `CONTEXT (ancestors, most general first):\n${ancestors.join("\n  ↳ ")}\n\n` : ""}NODE TO EXPAND
type: ${node.type}
title: ${node.title}
body: ${node.body ?? "(none)"}

FORK: ${fork}
${forkInstruction(fork, "corpus")}

Children must be strictly more specific than the parent. Do not restate the parent. Every claim that has evidence in the corpus must cite its post IDs.

AVAILABLE POSTS:
${posts.map(postLine).join("\n\n")}`;

  const out = await structured("expand_children", schema, content, (raw) =>
    GrokExpandSchema.parse(raw),
  );
  // The json_schema already caps this, but parse stays deliberately tolerant so
  // an over-eager generation gets trimmed rather than throwing mid-demo. Keep
  // the highest-priority ones.
  return [...out.children]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_CHILDREN);
}

// ---------------------------------------------------------------------------
// x_search-backed expansion
//
// The corpus expand above can only cite posts that happened to cross the user's
// timeline, which makes "show me the counters" only as good as who they follow.
// Grok's x_search tool searches all of X — it fans out internally to keyword
// search, semantic search and thread fetch — so a fork can bring back dissent
// from accounts the user has never seen.
//
// Verified against the live API:
//   - Responses API only (/v1/responses), not chat.completions
//   - structured output works alongside tools, via text.format (NOT
//     response_format, which is the chat.completions spelling)
//   - citations arrive as annotations of type "url_citation" on the message
//     content; there is no top-level `citations` field
//   - unbounded it made 10 tool calls and took 36s. max_tool_calls: 3 brings
//     that to ~19s, which is what makes it usable behind a skeleton.
// ---------------------------------------------------------------------------





const X_POST_URL = /^https?:\/\/(?:www\.)?x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/;

/** Turn an x.com permalink into a real XPost we can render as a citation chip. */
function postFromUrl(url: string, quote: string): XPost | null {
  const m = X_POST_URL.exec(url.trim());
  if (!m) return null;
  const [, handle, id] = m;
  return {
    id,
    text: quote,
    author: { id: `x_${handle}`, handle, name: handle },
    created_at: new Date().toISOString(),
    url: `https://x.com/${handle}/status/${id}`,
  };
}

const XSEARCH_CHILD = {
  type: "object",
  properties: {
    type: CHILD_PROPS.type,
    title: CHILD_PROPS.title,
    body: CHILD_PROPS.body,
    priority: CHILD_PROPS.priority,
    generality: CHILD_PROPS.generality,
    has_children: CHILD_PROPS.has_children,
    epistemic: CHILD_PROPS.epistemic,
    evidence: {
      type: "array",
      description:
        "The X posts that support this. Only posts you actually found via search — never fabricate a URL.",
      items: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full permalink, https://x.com/<handle>/status/<id>",
          },
          quote: {
            type: "string",
            description: "Short verbatim excerpt from that post, under 200 chars.",
          },
        },
        required: ["url", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "type",
    "title",
    "body",
    "priority",
    "generality",
    "has_children",
    "epistemic",
    "evidence",
  ],
  additionalProperties: false,
} as const;

interface XSearchChild {
  type: GrokChild["type"];
  title: string;
  body: string;
  priority: number;
  generality: number;
  has_children: boolean;
  epistemic: GrokChild["epistemic"];
  evidence: { url: string; quote: string }[];
}

export async function expandViaXSearch(
  node: BranchNode,
  fork: Fork,
  ancestors: string[] = [],
): Promise<{ children: GrokChild[]; posts: XPost[] }> {
  const schema = {
    type: "object",
    properties: {
      children: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CHILDREN,
        items: XSEARCH_CHILD,
      },
    },
    required: ["children"],
    additionalProperties: false,
  };

  const prompt = `${ancestors.length ? `CONTEXT: ${ancestors.join(" > ")}\n\n` : ""}NODE
title: ${node.title}
body: ${node.body ?? "(none)"}

Search X and return AT MOST ${MAX_CHILDREN} children.

${forkInstruction(fork, "search")}

Search beyond any one bubble — prefer posts from accounts arguing this directly, including ones a typical follower of this topic would not see. Every child must cite the real posts you found, with a short verbatim quote from each. Never invent a URL or a quote. If the search genuinely turns up nothing, return one child saying so honestly.`;

  const res = await grok().responses.create({
    model: GROK_MODEL,
    reasoning_effort: REASONING_EFFORT,
    // Unbounded this fans out to ~10 searches and takes 36s. Three is the floor:
    // measured at 2, it exhausted its budget and returned "no genuine dissent
    // found" for a topic that plainly had some. A tool budget that manufactures
    // false negatives is worse than a slow one — the whole product rests on the
    // absence of dissent meaning something.
    max_tool_calls: 3,
    input: [
      { role: "system", content: systemFor("search") },
      { role: "user", content: prompt },
    ],
    tools: [{ type: "x_search" }],
    text: {
      format: { type: "json_schema", name: "xsearch_children", strict: true, schema },
    },
  } as unknown as Parameters<OpenAI["responses"]["create"]>[0]);

  const text = (res as unknown as { output_text?: string }).output_text;
  if (!text) throw new Error("x_search returned no content");

  const parsed = JSON.parse(text) as { children: XSearchChild[] };
  const posts: XPost[] = [];
  const children: GrokChild[] = [];

  for (const c of parsed.children.slice(0, MAX_CHILDREN)) {
    const ids: string[] = [];
    for (const ev of c.evidence ?? []) {
      const post = postFromUrl(ev.url, ev.quote);
      // a citation we can't resolve to a real permalink is dropped, not shown
      if (!post) continue;
      if (!posts.some((p) => p.id === post.id)) posts.push(post);
      ids.push(post.id);
    }
    children.push({
      type: c.type,
      title: c.title,
      body: c.body,
      priority: c.priority,
      generality: c.generality,
      has_children: c.has_children,
      epistemic: c.epistemic,
      source_post_ids: ids,
    });
  }

  return { children, posts };
}

/** Which forks reach outside the user's timeline. */
export const XSEARCH_FORKS: ReadonlySet<Fork> = new Set<Fork>([
  "counter",
  "primary_only",
  "falsifiers",
  "people",
]);
