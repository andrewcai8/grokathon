import type { XPost } from "./schema";

/**
 * Evidence — what a card is grounded in.
 *
 * Until now "evidence" meant "an X post", baked in everywhere: the citation
 * chip renders a handle, the epistemic badge assumes a contestable assertion,
 * the corpus is a post map. That was correct while X was the only source, and
 * it's wrong the moment a board is about cars or holidays.
 *
 * The distinction that matters isn't where a source came from, it's what KIND
 * of thing the card is:
 *
 *   - a CLAIM is true or false. It needs citations, and "contested" means
 *     something about it.
 *   - an OPTION is a choice. It has attributes and a price. Calling it
 *     "contested" is a category error, and a citation chip is the wrong
 *     rendering — you want to see the thing, not who said it.
 *
 * Keeping both under one type is what would quietly undo the grounding work:
 * an option with no citation would look like a claim that failed verification.
 * So the kind travels with the evidence, and the card renders accordingly.
 */

export type EvidenceKind = "x_post" | "web" | "generated";

/** A web page retrieved by us — real by construction, same as an X post. */
export interface WebSource {
  id: string;
  url: string;
  title: string;
  /** clean extracted text, already truncated for prompting */
  text?: string;
  author?: string;
  publishedAt?: string;
  siteName?: string;
  imageUrl?: string;
}

/** Something a model made: a map, an illustration of an option. */
export interface GeneratedSource {
  id: string;
  kind: "image";
  url: string;
  prompt: string;
}

export type Source =
  | ({ kind: "x_post" } & XPost)
  | ({ kind: "web" } & WebSource)
  | ({ kind: "generated" } & GeneratedSource);

/**
 * What a board is FOR. This is what makes the paradigm reusable: the layout,
 * zoom, bands, novelty rules and recursion are identical, and only the
 * retrieval and the rendering of evidence change.
 */
export type BoardKind = "news" | "options";

export interface BoardKindSpec {
  /** shown in the rail */
  label: string;
  /** does a card assert something that could be false? */
  contestable: boolean;
  /** which retrieval sources this kind may draw on, in preference order */
  sources: EvidenceKind[];
  /** what "going deeper" means here, for the prompt */
  deeper: string;
}

export const BOARD_KINDS: Record<BoardKind, BoardKindSpec> = {
  news: {
    label: "What's happening",
    contestable: true,
    sources: ["x_post", "web"],
    deeper:
      "the most specific, load-bearing sub-claims — what is actually being asserted, and by whom",
  },
  options: {
    /**
     * Progressive refinement. Three options, pick one, three narrower options,
     * repeat until you've converged on a single thing. Cars, laptops, trips,
     * anything with a decision at the end.
     *
     * Not contestable: an option isn't true or false, so it carries no
     * epistemic status and no citation chip. It carries attributes.
     */
    label: "Narrow it down",
    contestable: false,
    sources: ["web", "generated"],
    deeper:
      "three genuinely distinct options one level more specific than the parent, each a real choice a person could make, covering meaningfully different directions rather than variations of one",
  },
};

export function isContestable(kind: BoardKind | undefined) {
  return BOARD_KINDS[kind ?? "news"].contestable;
}

/**
 * Which posts get to be the evidence.
 *
 * Every retrieval returns more than a card can carry — 40 search hits, 100
 * timeline posts — and something has to choose. Until now that was insertion
 * order, i.e. nothing.
 *
 * Reach, log-scaled so a viral post doesn't erase forty ordinary ones, plus a
 * deliberate thumb on the scale for posts carrying media. Two reasons, and the
 * second is the one that matters:
 *
 *   1. A post people bothered to attach a chart, a screenshot or a video to is
 *      usually a post making an argument rather than reacting to one.
 *   2. It is the only evidence on the board we can go and read a second way.
 *      A text post is fully spent the moment it's quoted; a post with an image
 *      still has something in it the board hasn't shown, which is exactly what
 *      the media fork is for. Preferring them means depth has somewhere to go.
 *
 * A thumb, not a rule: the multiplier is small enough that a text post with
 * real traction still outranks a picture nobody looked at.
 */
export function evidenceScore(post: {
  metrics?: { likes: number; reposts: number };
  media?: unknown[];
}): number {
  const reach = (post.metrics?.likes ?? 0) + 2 * (post.metrics?.reposts ?? 0);
  return Math.log10(1 + reach) * (post.media?.length ? 1.35 : 1);
}

export function rankEvidence<T extends { metrics?: { likes: number; reposts: number }; media?: unknown[] }>(
  posts: T[],
): T[] {
  return [...posts].sort((a, b) => evidenceScore(b) - evidenceScore(a));
}
