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
      }),
    )
    .optional(),
  conversation_id: z.string().optional(),
  /** quote / reply / retweet parents, for thread expansion */
  referenced_post_ids: z.array(z.string()).optional(),
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
  "counter",
  "primary_only",
  "people",
  "media",
  "falsifiers",
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

  // state
  has_children: z.boolean(),
  unread_depth: z.boolean().optional(),
  /** velocity / engagement, drives heat styling */
  heat: z.number().optional(),
  epistemic: EpistemicStatusSchema.optional(),
  /** which fork produced this node, if not the default "deeper" */
  fork: ForkSchema.optional(),

  media: z
    .object({
      kind: z.enum(["image", "video", "generated_image", "generated_video"]),
      url: z.string().optional(),
      alt: z.string().optional(),
      vision_summary: z.string().optional(),
    })
    .optional(),

  created_at: z.string(),
  updated_at: z.string(),
});
export type BranchNode = z.infer<typeof BranchNodeSchema>;

export interface Board {
  /** boards are rooted on a date, not a topic (doc §3.3) */
  date: string;
  seed: {
    mode: "my_day" | "trending" | "search" | "post" | "handle";
    label: string;
    /** set when this board came off disk rather than a live read */
    snapshot?: boolean;
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
