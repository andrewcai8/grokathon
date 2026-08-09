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

/**
 * Root topics per board. Three, for the same reason children are three: the
 * whole board then has one branching factor, and the zoomed-out orientation
 * view stays a glanceable map instead of a scroll. Both Branches captures we
 * worked from show exactly three roots.
 */
export const MAX_ROOTS = Number(process.env.GROK_MAX_ROOTS ?? 3);

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
- Search first, conclude second. Do not report an absence of evidence until you have looked from more than one angle.
- NEVER return text describing your intent ("Searching X for...", "Looking into..."). The structured output is the finished answer, produced after the tool has run — not a status update. If you have not called the tool yet, call it.`,
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
export async function clusterSeed(posts: XPost[], slots = MAX_ROOTS) {
  const schema = {
    type: "object",
    properties: {
      topics: {
        type: "array",
        minItems: 1,
        maxItems: Math.max(1, slots),
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

  const content = `Here are ${posts.length} posts from my X timeline today. Give me THE ${slots} stories that actually define my day.

This is a hard cap, not a target — pick the ${slots} that matter most and let the rest go. Rank by how much they matter to me, using engagement and how much of the timeline they occupy. Do not add an "Other" bucket; with only ${slots} slots, spending one on noise wastes it.

POSTS:
${posts.map(postLine).join("\n\n")}`;

  const out = await structured("day_topics", schema, content, (raw) =>
    GrokClusterSchema.parse(raw),
  );
  // schema caps it, but parsing stays tolerant — trim rather than throw
  return {
    topics: [...out.topics].sort((a, b) => b.priority - a.priority).slice(0, slots),
  };
}

const FORK_INTENT: Record<Fork, string> = {
  deeper: "the most specific, load-bearing sub-claims of this",
  replies: "what people said back to this — handled without a model, see getReplies",
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
  /** titles already on the board — children must not restate any of them */
  covered: string[] = [],
): Promise<{ children: GrokChild[]; summary?: string }> {
  const schema = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "2-3 sentences on what this story actually is, strictly from the posts supplied. Becomes this card's body. Say only what the posts support.",
      },
      children: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CHILDREN,
        items: childSchema(),
      },
    },
    required: ["summary", "children"],
    additionalProperties: false,
  };

  const content = `Expand this node into AT MOST ${MAX_CHILDREN} children, and write a short summary of what this story is.

Return only the most load-bearing ones — the children that would change how I
understand this if I read them. Fewer, sharper children beat more shallow ones.
Do not pad to reach ${MAX_CHILDREN}.

${ancestors.length ? `CONTEXT (ancestors, most general first):\n${ancestors.join("\n  ↳ ")}\n\n` : ""}NODE TO EXPAND
type: ${node.type}
title: ${node.title}
body: ${node.body ?? "(none)"}

FORK: ${fork}
${forkInstruction(fork, "corpus")}

Children must be strictly more specific than the parent, and every one must carry information that is NOT already on the board. The person expanding this is curious and wants to learn something they don't already know — a child that rephrases the parent, or repeats a card they can already see, wastes the click.

${covered.length ? `ALREADY ON THE BOARD — do not restate any of these, and do not make a child that is merely a narrower wording of one:\n${covered.slice(0, 40).map((t) => `- ${t}`).join("\n")}\n` : ""}
Every claim that has evidence in the corpus must cite its post IDs. The posts below have been filtered to ones not yet cited anywhere on this board, so prefer them — that is where the new information is.

AVAILABLE POSTS:
${posts.map(postLine).join("\n\n")}`;

  const out = await structured("expand_children", schema, content, (raw) => ({
    ...GrokExpandSchema.parse(raw),
    summary: (raw as { summary?: string })?.summary,
  }));
  // The json_schema already caps this, but parse stays deliberately tolerant so
  // an over-eager generation gets trimmed rather than throwing mid-demo. Keep
  // the highest-priority ones.
  return {
    children: [...out.children]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_CHILDREN),
    summary: out.summary,
  };
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

/** Pull the last top-level JSON object out of a possibly chatty response. */
function extractJson<T>(text: string, isValid?: (o: unknown) => boolean): T {
  const ok = (o: unknown) => (isValid ? isValid(o) : true);
  try {
    const direct = JSON.parse(text);
    if (ok(direct)) return direct as T;
  } catch {
    /* fall through to scanning */
  }
  {
    // Scan for a balanced object. first-brace-to-last-brace breaks when the
    // response contains more than one object, which tool-enabled replies do.
    for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          try {
            const candidate = JSON.parse(text.slice(i, j + 1));
            // A tool-enabled reply can emit a status object BEFORE the real
            // answer, so take the first object that actually carries the
            // payload rather than the first one that parses.
            if (ok(candidate)) return candidate as T;
          } catch {
            /* not this one */
          }
          break; // this opening brace is closed; try the next
        }
      }
    }
    throw new Error("no parseable JSON in response");
  }
}

/**
 * Turn a trend headline into an X search query.
 *
 * Trend headlines are synthesised summaries — they never appear verbatim in
 * posts, so a literal search matches nothing. This is a language problem, and
 * one cheap Grok call solves it. The RETRIEVAL then happens against the X API,
 * which means the posts are real by construction rather than model-reported:
 * a fabricated citation isn't possible, so no verification pass is needed.
 */
export async function searchQueryFor(headline: string): Promise<string> {
  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "An X (Twitter) search query. Use the distinctive proper nouns and 2-3 salient terms, OR-ing synonyms. Do NOT include the whole headline. NO wildcards (*) — X rejects them; write the variants out instead. Keep it under 120 characters.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  };

  const out = await structured<{ query: string }>(
    "x_query",
    schema,
    `Write an X search query that will find posts about this story.

HEADLINE: ${headline}

The headline is a synthesised summary and will not appear verbatim in any post. Use the identifying entities (people, products, companies, numbers) and OR together likely phrasings. Do not add lang: or -is: filters; those are added for you.`,
    (raw) => raw as { query: string },
  );

  // belt and braces: X returns 400 for a '*' anywhere in a term, and one bad
  // query shouldn't cost us the whole expand
  const q = (out.query || headline).replace(/\*/g, "").slice(0, 120).trim();
  return `${q} -is:retweet lang:en`;
}

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
  /** titles already on the board — this path repeated facts without it */
  covered: string[] = [],
): Promise<{ children: GrokChild[]; posts: XPost[]; summary?: string }> {
  const schema = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "2-3 sentences on what this story actually is, strictly from the posts you found. This becomes the parent card's body. Say only what the posts support.",
      },
      children: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CHILDREN,
        items: XSEARCH_CHILD,
      },
    },
    required: ["summary", "children"],
    additionalProperties: false,
  };

  const prompt = `${ancestors.length ? `CONTEXT: ${ancestors.join(" > ")}\n\n` : ""}NODE
title: ${node.title}
body: ${node.body ?? "(none)"}

${node.body ? "" : "This node is a trending headline with no posts attached to it yet. The search IS how it becomes grounded.\n\n"}SEARCH FIRST. Call x_search before you answer — do not describe what you are about to do, and do not write your answer from prior knowledge. Everything below must come from posts the search actually returned.

Then return AT MOST ${MAX_CHILDREN} children, plus a summary of what this story is.

${covered.length ? `ALREADY ON THE BOARD — the user has read all of these. Do NOT restate any of them, and do not return a narrower rewording of one. Every child must teach something none of these say:\n${covered.slice(0, 40).map((t) => `- ${t}`).join("\n")}\n` : ""}

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

  // With tools enabled the model sometimes prefixes prose before the JSON, so
  // take the last balanced object rather than trusting the whole string.
  const parsed = extractJson<{ summary?: string; children: XSearchChild[] }>(
    text,
    (o) => Array.isArray((o as { children?: unknown })?.children),
  );
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

  return { children, posts, summary: parsed.summary };
}

/** Which forks reach outside the user's timeline. */
export const XSEARCH_FORKS: ReadonlySet<Fork> = new Set<Fork>([
  "counter",
  "primary_only",
  "falsifiers",
  "people",
]);
