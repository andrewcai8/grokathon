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

const SYSTEM = `You structure a person's X (Twitter) timeline into a nested knowledge tree.

Absolute rules:
- The posts you are given are the ONLY ground truth. Never assert anything not supported by them.
- Never invent a post ID. Only cite IDs present in the supplied corpus.
- Label epistemic status honestly. If something is one account's claim, it is thin_evidence, not widely_shared. If accounts disagree, it is contested. Say so plainly.
- Bodies are 2-3 sentences. This is a card on a canvas, not an article.
- Titles must make sense read alone at a glance, with no body text visible.
- Be specific. "Market reaction" is a bad title; "Rates repriced harder than equities" is a good one.
- Do not flatten disagreement into false consensus. Surfacing dissent is the point.`;

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

const FORK_INSTRUCTION: Record<Fork, string> = {
  deeper: "Break this into its most specific, load-bearing sub-claims.",
  counter:
    "Surface ONLY the opposing frames, dissent, and contradicting evidence. If genuine dissent does not exist in the corpus, return a single node saying so honestly rather than manufacturing balance.",
  primary_only:
    "Strip commentary and punditry. Prefer original posts, officials, first-hand accounts and documents.",
  people: "Who is driving and amplifying this? One node per significant actor.",
  media: "The images, video and memes in this story, and what each is arguing.",
  falsifiers:
    "What would change my mind? Name the specific missing evidence and the observations that would falsify the main claims.",
};

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
${FORK_INSTRUCTION[fork]}

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

/**
 * Grok's x_search agent tool: searches X posts, profiles and threads natively
 * and returns citations. Lets us ground a claim in posts from OUTSIDE the
 * user's following graph — which is what makes the Counter fork actually work.
 * Responses API only. $5 per 1k calls.
 */
export async function xSearch(
  query: string,
  opts: { fromDate?: string; toDate?: string; handles?: string[] } = {},
): Promise<{ text: string; citations: string[] }> {
  const res = await grok().responses.create({
    model: GROK_MODEL,
    input: [{ role: "user", content: query }],
    tools: [
      {
        type: "x_search",
        ...(opts.handles?.length ? { allowed_x_handles: opts.handles.slice(0, 20) } : {}),
        ...(opts.fromDate ? { from_date: opts.fromDate } : {}),
        ...(opts.toDate ? { to_date: opts.toDate } : {}),
      } as unknown as never,
    ],
  });

  const r = res as unknown as { output_text?: string; citations?: string[] };
  return { text: r.output_text ?? "", citations: r.citations ?? [] };
}
