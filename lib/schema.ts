import { z } from "zod";

/**
 * Ground truth. Everything Grok writes must point back to one of these.
 * Shape mirrors what we can get from X API v2 in a single call with expansions.
 */
export const XAuthorSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  avatar_url: z.string().optional(),
  verified: z.boolean().optional(),
});
export type XAuthor = z.infer<typeof XAuthorSchema>;

export const XPostSchema = z.object({
  id: z.string(),
  text: z.string(),
  author: XAuthorSchema,
  created_at: z.string(),
  url: z.string().optional(),
  metrics: z
    .object({
      likes: z.number(),
      reposts: z.number(),
      replies: z.number(),
      quotes: z.number().optional(),
    })
    .optional(),
  media: z
    .array(
      z.object({
        kind: z.enum(["photo", "video", "animated_gif"]),
        url: z.string(),
        alt: z.string().optional(),
        /** intrinsic pixels — the card sizes its frame from these, see lib/media */
        width: z.number().optional(),
        height: z.number().optional(),
        duration_ms: z.number().optional(),
      }),
    )
    .optional(),
  conversation_id: z.string().optional(),
  /** quote / reply / retweet parents, for thread expansion */
  referenced_post_ids: z.array(z.string()).optional(),
  /**
   * The post this one quotes, when there is one.
   *
   * We already pay for the `referenced_tweets.id` expansion on every X call and
   * used to drop the bodies on the floor — so a quote-tweet reached the board as
   * bare commentary with the thing being commented on missing. "Exactly this"
   * over a screenshot of a chart is not a claim until you can see the chart.
   * One level only: the quote of a quote is someone else's argument.
   */
  quoted: z
    .object({
      id: z.string(),
      text: z.string(),
      author: XAuthorSchema,
      url: z.string().optional(),
    })
    .optional(),
  /**
   * True when this post came from Grok's x_search and we could NOT confirm it
   * exists via the X API. The text is then Grok's account of the post, not the
   * post. Rendered differently, never silently passed off as verified.
   */
  unverified: z.boolean().optional(),
});
export type XPost = z.infer<typeof XPostSchema>;

export const NODE_TYPES = [
  "topic",
  "story",
  "claim",
  "post",
  "person",
  "media",
  "fork",
  "generated",
  /** a choice on an options board — not true or false, so never an assertion */
  "option",
] as const;
export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EPISTEMIC_STATUSES = [
  "widely_shared",
  "contested",
  "note_flagged",
  "thin_evidence",
  "projection",
] as const;
export const EpistemicStatusSchema = z.enum(EPISTEMIC_STATUSES);
export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;

/** Expand is not only "more detail" — see design doc §5.1 */
export const FORKS = [
  "deeper",
  "replies",
  "counter",
  "primary_only",
  "people",
  "media",
  "falsifiers",
  /**
   * The user wrote the fork themselves.
   *
   * Every other entry here is a question we decided to offer. "ask" is the open
   * slot in the same table — §5.1 already lists "what would change my mind?" as
   * a fork, so a freeform question is the same shape with the intent supplied
   * at runtime rather than baked in.
   *
   * The question is NOT carried on this enum's children as a field. It is the
   * TITLE of the node they hang off: asking mints a real question node, so the
   * question gets a card, a TOC row, a collapse state and its own citations for
   * free, and two different questions can never collide in the expand cache the
   * way two runs of one fork would.
   */
  "ask",
] as const;
export const ForkSchema = z.enum(FORKS);
export type Fork = z.infer<typeof ForkSchema>;

export const BranchNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  title: z.string(),
  /** short — a card body, never an essay */
  body: z.string().optional(),
  parent_id: z.string().nullable(),
  children_ids: z.array(z.string()),

  // layout hints — these ARE the two screen axes (doc §3.3)
  /** 0–1, vertical order within a column */
  priority: z.number(),
  /** 0–1, 1 = most general. Correlates with column index but Grok sets it independently */
  generality: z.number(),
  depth: z.number(),

  // grounding
  source_post_ids: z.array(z.string()),
  source_urls: z.array(z.string()).optional(),
  account_ids: z.array(z.string()).optional(),
  /**
   * Where this node came from, when what produced it was not a post we hold.
   *
   * A trending root is the case this exists for. X's trends API tells us a name
   * and a post volume and gives us no post IDs at all, so the node was built
   * with `source_post_ids: []` — and then rendered the red "no sources" marker,
   * on the single most prominent card on the board, for something X itself
   * handed us. That marker means "nothing backs this", which was false: X's
   * trend service backs it, and said how loudly.
   *
   * This is provenance, not a citation, and the distinction is load-bearing.
   * It grounds the HEADLINE — "X says this is trending, with N posts" — and
   * nothing more. It is deliberately not enough to support a body making a
   * claim; that still needs posts or reporting, which is why `rollUpCitations`
   * still runs and why the grounding search still fires on expand.
   */
  origin: z
    .object({
      kind: z.literal("x_trend"),
      /** the trend name exactly as X gave it */
      label: z.string(),
      /** X's own volume for the trend, already parsed from "5.7K posts" */
      postCount: z.number().optional(),
      category: z.string().optional(),
      /**
       * Deliberately no URL.
       *
       * The obvious move is to link the chip at x.com/search?q=<the trend>, and
       * it's wrong: trend names are synthesised summaries that never appear
       * verbatim in posts (see searchQueryFor), so that link lands on an empty
       * X page dressed as a source. A provenance marker you can't check beats
       * one that pretends to be checkable. The checkable version arrives on its
       * own a moment later — the grounding search rolls real post chips onto
       * this node, and those are better evidence than any search link.
       */
    })
    .optional(),

  // state
  has_children: z.boolean(),
  unread_depth: z.boolean().optional(),
  /** velocity / engagement, drives heat styling */
  heat: z.number().optional(),
  epistemic: EpistemicStatusSchema.optional(),
  /** which fork produced this node, if not the default "deeper" */
  fork: ForkSchema.optional(),

  /**
   * For option nodes: the attributes that make this a real choice (price,
   * size, range). Options aren't true or false, so they carry these instead
   * of citations and an epistemic status.
   */
  attributes: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  /**
   * For option nodes: the dimension this node's CHILDREN were divided along
   * ("body style", "trip length"). Naming the axis is what forces three
   * different directions instead of three samples of one, so showing it is
   * also how the user can tell whether the branching was any good.
   */
  axis: z.string().optional(),
  /** web sources behind this node, for boards not grounded in X posts */
  source_urls_meta: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        siteName: z.string().optional(),
      }),
    )
    .optional(),

  media: z
    .object({
      kind: z.enum(["image", "video", "generated_image", "generated_video"]),
      url: z.string().optional(),
      alt: z.string().optional(),
      vision_summary: z.string().optional(),
      /**
       * The post this image was attached to. A vision claim is a claim about
       * something a real account published, so it has to say which one —
       * otherwise it's an assertion about a picture nobody can go and check.
       */
      post_id: z.string().optional(),
      /** carried so a snapshotted vision card reframes identically on replay */
      width: z.number().optional(),
      height: z.number().optional(),
    })
    .optional(),

  created_at: z.string(),
  updated_at: z.string(),
});
export type BranchNode = z.infer<typeof BranchNodeSchema>;

export interface Board {
  /** boards are rooted on a date, not a topic (doc §3.3) */
  date: string;
  /**
   * What this board is for. "news" asserts things that can be false and needs
   * citations; "options" presents choices, which carry attributes instead.
   * Everything else — layout, zoom, bands, novelty, recursion — is identical.
   */
  kind?: "news" | "options";
  /**
   * For options boards: the dimension the ROOT column was divided along.
   *
   * A node stores the axis its own children were split by, but the roots have
   * no node above them — the question does, and the question isn't a card. So
   * the board holds it. Without this, "more directions" is asked to continue a
   * division nobody told it about, and it re-divides the space along whatever
   * axis it infers from three titles, which is how you get synonyms.
   */
  axis?: string;
  seed: {
    mode: "my_day" | "trending" | "search" | "post" | "handle";
    label: string;
    /** set when this board came off disk rather than a live read */
    snapshot?: boolean;
    /** which snapshot file this board came from, so warming writes back to it */
    name?: string;
    /** synthetic demo data — never allowed to overwrite a real snapshot */
    fixture?: boolean;
  };
  nodes: Record<string, BranchNode>;
  root_ids: string[];
  posts: Record<string, XPost>;
}

// ---------------------------------------------------------------------------
// Grok structured-output contracts
//
// These are what we hand the model as a JSON schema. They are deliberately
// NARROWER than BranchNode: the model only invents meaning, never identity,
// wiring, or timestamps. We assign ids, parent_id, children_ids, depth and
// created_at/updated_at ourselves so the graph can't be corrupted by a bad
// generation.
// ---------------------------------------------------------------------------

export const GrokChildSchema = z.object({
  type: NodeTypeSchema,
  title: z.string(),
  body: z.string(),
  priority: z.number(),
  generality: z.number(),
  source_post_ids: z.array(z.string()),
  source_web_ids: z.array(z.string()).optional(),
  has_children: z.boolean(),
  epistemic: EpistemicStatusSchema,
});
export type GrokChild = z.infer<typeof GrokChildSchema>;

export const GrokExpandSchema = z.object({
  children: z.array(GrokChildSchema).min(1).max(8),
});
export type GrokExpand = z.infer<typeof GrokExpandSchema>;

export const GrokTopicSchema = z.object({
  title: z.string(),
  body: z.string(),
  priority: z.number(),
  generality: z.number(),
  source_post_ids: z.array(z.string()),
  epistemic: EpistemicStatusSchema,
});

export const GrokClusterSchema = z.object({
  topics: z.array(GrokTopicSchema).min(1).max(12),
});
export type GrokCluster = z.infer<typeof GrokClusterSchema>;
