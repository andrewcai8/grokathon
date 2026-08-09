import {
  MAX_CHILDREN,
  agentTurn,
  outputTextOf,
  extractJson,
  readImagesRaw,
  CHILD_PROPS,
  systemFor,
} from "./grokClient";
import { rankEvidence, type WebSource } from "./evidence";
import { searchWeb, hasExa } from "./exaClient";
import { getReplies, searchRecent } from "./xClient";
import { mediaFromPosts, reachableMedia, MEDIA_CAP } from "./media";
import type { BranchNode, GrokChild, XPost } from "./schema";

/**
 * @grok as an agent.
 *
 * Every other fork is a single call with the evidence gathered for it in
 * advance, because we knew what the fork wanted before we asked. A freeform
 * question doesn't work like that: "who is actually paying for this?" needs a
 * search, "what did people say back?" needs the replies, "what is that chart
 * showing?" needs the picture read. Which of those it needs is the question's
 * business, not ours, so the model chooses — it gets tools and a loop.
 *
 * WHY OUR OWN X TOOLS AND NOT THE SERVER-SIDE x_search
 * ----------------------------------------------------
 * x_search returns a URL and a quote that the MODEL wrote, which is why
 * expandViaXSearch has to run every citation back through the X API afterwards
 * to find out which ones were invented (route.ts verifyCitations — we watched
 * it fabricate 6/6 URLs in one call).
 *
 * An agent can hold the real API instead. Every tool here returns posts fetched
 * from X by us, so the model can only cite ids that came out of a real
 * response. Fabrication isn't caught after the fact, it's unrepresentable: an
 * id the tools never returned has nothing to resolve against and is dropped.
 * That's the same invariant as vision's opaque media refs, for the same reason.
 */

/** How many round trips before we stop and answer with what we have. */
const MAX_TURNS = 5;

/**
 * An ask is ONE node.
 *
 * Every other fork hands back a column of siblings, which is why MAX_CHILDREN
 * is 3 — three plots is what the layout reserves. An ask isn't that shape: the
 * reply lands on the question card itself, so a card beside it is an extra
 * finding, not a share of the answer. Letting it return three made the loading
 * preview promise a column and the reply deliver a paragraph, and the cards it
 * did produce were usually the answer restated (see the CARDS DEFAULT TO ZERO
 * instruction below, which was fighting the schema rather than agreeing with
 * it). One is the ceiling now, so the plot we reserve is a plot we can fill.
 */
const ASK_MAX_CHILDREN = 1;

/**
 * How many tool calls one question may spend.
 *
 * Unbudgeted, the agent is genuinely thorough and genuinely too slow: measured
 * on a live board it spent 15 calls and 41s on one question, and the last eight
 * searches were rephrasings that returned the same posts as the first four. The
 * answer did not improve after roughly the eighth call; only the wait did.
 *
 * The budget withdraws the TOOLS rather than cutting the loop off, so the model
 * always gets a turn to answer from what it found. Truncating instead would
 * throw away every search it had already paid for — and an ask that returns
 * nothing after 40s is worse than one that answers from eight sources.
 */
const TOOL_BUDGET = 8;

/** Post fields the model needs to reason and cite; the rest is noise. */
function toolPost(p: XPost) {
  return {
    id: p.id,
    handle: p.author.handle,
    name: p.author.name,
    text: p.text,
    likes: p.metrics?.likes ?? 0,
    replies: p.metrics?.replies ?? 0,
    // it can't see the picture from here, but it can decide to go and read it
    images: p.media?.length ?? 0,
  };
}

/**
 * Everything the agent retrieved, accumulated across the whole loop.
 *
 * This is the citable universe. A claim can only cite what is in here, so the
 * pool is built from tool RESULTS rather than from anything the model said.
 */
interface EvidencePool {
  posts: Record<string, XPost>;
  web: WebSource[];
}

export interface AskTrace {
  tool: string;
  arg: string;
  got: number;
  ms: number;
}

/** The tools, described for the model. Kept next to their implementations. */
function toolSpecs(hasX: boolean) {
  const specs: Record<string, unknown>[] = [];
  const fn = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
  ) => ({
    type: "function",
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    strict: true,
  });

  if (hasX) {
    specs.push(
      fn(
        "search_x",
        "Search X for real recent posts. This is the live X API, not a summary — every post it returns exists and can be cited by id. Call it more than once with different phrasings when the first angle is thin.",
        {
          query: {
            type: "string",
            description:
              "X search syntax. Keywords, no hashtag spam. You may use from:, -is:retweet, lang:en.",
          },
        },
        ["query"],
      ),
      fn(
        "get_replies",
        "Read what people actually said back to a specific post. Use when the question is about reaction, dissent or consensus rather than facts.",
        {
          post_id: {
            type: "string",
            description: "Id of a post you have already seen in the corpus or a tool result.",
          },
        },
        ["post_id"],
      ),
      fn(
        "read_image",
        "Look at the pictures attached to posts. Returns a description of what each image actually shows. Use when the question is about a chart, screenshot, photo or meme.",
        {
          post_ids: {
            type: "array",
            items: { type: "string" },
            description: "Ids of posts that carry images (the corpus marks these).",
          },
        },
        ["post_ids"],
      ),
    );
  }
  if (hasExa()) {
    specs.push(
      fn(
        "search_web",
        "Search news and the open web. Better than X for anything that was reported rather than posted — numbers, official statements, background.",
        { query: { type: "string", description: "A natural-language search query." } },
        ["query"],
      ),
    );
  }
  return specs;
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Your actual answer, talking to the user. Write it like a reply, not like a card: normal sentences, as long as the question deserves and no longer. Answer whatever they asked — if it's a question about the story, answer from what you found and say what the evidence does and doesn't settle; if it's conversational, just talk back. This is the main thing they read, and it must stand on its own.",
    },
    answer_source_post_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "Ids of posts YOUR TOOLS RETURNED that your answer rests on. These are the answer's own sources — fill this in whenever the answer draws on evidence, even if you give no cards at all.",
    },
    answer_source_web_ids: {
      type: "array",
      items: { type: "string" },
      description: "Refs (web1, web2...) of articles the answer rests on.",
    },
    children: {
      type: "array",
      // Zero is a real answer. "yo" deserves a reply and no evidence cards, and
      // a forced minimum of 1 is what makes a model invent a card titled
      // "placeholder" — the schema was manufacturing the junk downstream then
      // had to filter out.
      minItems: 0,
      maxItems: ASK_MAX_CHILDREN,
      items: {
        type: "object",
        properties: {
          type: CHILD_PROPS.type,
          title: CHILD_PROPS.title,
          body: CHILD_PROPS.body,
          priority: CHILD_PROPS.priority,
          generality: CHILD_PROPS.generality,
          has_children: CHILD_PROPS.has_children,
          epistemic: CHILD_PROPS.epistemic,
          source_post_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Ids of posts YOUR TOOLS RETURNED that support this. Never an id you did not see in a tool result.",
          },
          source_web_ids: {
            type: "array",
            items: { type: "string" },
            description: "Refs (web1, web2...) of articles your tools returned.",
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
          "source_post_ids",
          "source_web_ids",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "answer_source_post_ids", "answer_source_web_ids", "children"],
  additionalProperties: false,
} as const;

interface AskAnswer {
  answer: string;
  answer_source_post_ids?: string[];
  answer_source_web_ids?: string[];
  children: (GrokChild & { source_web_ids?: string[] })[];
}

/**
 * Run the tool loop and return structured, cited children.
 *
 * `question` is the user's words. `parent` is the card they asked from — its
 * title and body are the context that makes a pronoun in the question ("who
 * pays for THIS") resolvable.
 */
export async function askAgent(opts: {
  question: string;
  /**
   * The card the question was asked from, or null for a question asked of the
   * BOARD — "breaking news", typed with nothing under the cursor.
   *
   * Null is not a degenerate case of a card, it inverts what a good answer
   * looks like. Asked of a card, the reply is the result and cards are the
   * exception (see the prompt below). Asked of the board, there is no reply
   * worth reading on its own — "here is what's breaking" is only useful as the
   * topics themselves, which is what makes this the one ask that must return
   * children. Everything else about the run is identical.
   */
  parent: BranchNode | null;
  ancestors: string[];
  /** posts already behind the card — the agent starts from these, not from zero */
  corpus: XPost[];
  /** titles already on the board; an answer that restates one teaches nothing */
  covered: string[];
  /** the board's own date, so "breaking" means today rather than whenever */
  date?: string;
  xToken?: string;
}): Promise<{
  answer: string;
  /** the answer's OWN citations — what a zero-card ask shows under the reply */
  answerPostIds: string[];
  answerWeb: WebSource[];
  /** false when nothing at all stands behind the answer */
  grounded: boolean;
  children: GrokChild[];
  posts: Record<string, XPost>;
  web: WebSource[];
  trace: AskTrace[];
}> {
  const { question, parent, ancestors, corpus, covered, date, xToken } = opts;

  /**
   * How many cards this ask may return, and why it depends on where it was asked.
   *
   * A card ask is capped at ASK_MAX_CHILDREN because its reply lands on the
   * question card itself — a card beside it is a bonus finding, not the answer.
   * A board ask has no such card to be the answer: "what's breaking" is only
   * useful AS the topics, so it gets the board's own branching factor. Same
   * agent, same schema, same everything else — one number.
   */
  const maxCards = parent ? ASK_MAX_CHILDREN : MAX_CHILDREN;
  const schema = {
    ...ANSWER_SCHEMA,
    properties: {
      ...ANSWER_SCHEMA.properties,
      children: { ...ANSWER_SCHEMA.properties.children, maxItems: maxCards },
    },
  };

  const pool: EvidencePool = {
    posts: Object.fromEntries(corpus.map((p) => [p.id, p])),
    web: [],
  };
  const trace: AskTrace[] = [];

  /** Run one tool call and fold whatever it found into the citable pool. */
  async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const started = Date.now();
    const done = (got: number, arg: string) => {
      trace.push({ tool: name, arg, got, ms: Date.now() - started });
    };

    try {
      if (name === "search_x" && xToken) {
        const query = String(args.query ?? "");
        const found = rankEvidence(await searchRecent(xToken, query, 30));
        for (const p of found) pool.posts[p.id] = p;
        done(found.length, query);
        return found.slice(0, 15).map(toolPost);
      }

      if (name === "get_replies" && xToken) {
        const id = String(args.post_id ?? "");
        // the conversation id is what threads a reply search; fall back to the
        // post id itself, which is the conversation id for an original post
        const seed = pool.posts[id];
        const found = await getReplies(xToken, seed?.conversation_id ?? id, 30);
        for (const p of found) pool.posts[p.id] = p;
        // most-liked first: an agent reading a 40-reply thread should see the
        // ones that landed, not the chronological tail
        const top = [...found]
          .sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0))
          .slice(0, 12);
        done(found.length, id);
        return top.map(toolPost);
      }

      if (name === "read_image" && xToken) {
        const ids = (Array.isArray(args.post_ids) ? args.post_ids : []).map(String);
        // only posts we actually hold — the model cannot point vision at a URL
        // it invented, for the same reason it cannot cite one
        const posts = ids.map((id) => pool.posts[id]).filter(Boolean);
        const found = mediaFromPosts(posts, MEDIA_CAP);
        if (!found.length) {
          done(0, ids.join(","));
          return { error: "no image on those posts" };
        }
        // one unreachable URL 400s the whole vision request — see reachableMedia
        const media = await reachableMedia(found);
        if (!media.length) {
          done(0, ids.join(","));
          return { error: "those images are no longer reachable" };
        }
        // prose about each image, against the same opaque refs the media fork
        // uses — the agent reasons over the reading, it doesn't render it
        const read = await readImagesRaw(media);
        done(read.length, ids.join(","));
        return read;
      }

      if (name === "search_web") {
        const query = String(args.query ?? "");
        const found = await searchWeb(query, { numResults: 5, category: "news" });
        const base = pool.web.length;
        pool.web.push(...found);
        done(found.length, query);
        return found.map((w, i) => ({
          ref: `web${base + i + 1}`,
          title: w.title,
          site: w.siteName,
          url: w.url,
          text: w.text?.slice(0, 1200),
        }));
      }

      done(0, "");
      return { error: `no such tool: ${name}` };
    } catch (err) {
      // A dead tool must not kill the answer. The model is told what failed and
      // can route around it — that is the whole advantage of a loop over a
      // fixed pipeline, and a thrown error here would throw away the turns
      // that already succeeded.
      const message = err instanceof Error ? err.message : "tool failed";
      done(0, message);
      console.warn("[ask] tool %s failed: %s", name, message);
      return { error: message };
    }
  }

  const corpusBlock = corpus.length
    ? `POSTS ALREADY BEHIND THIS CARD (cite by id; ${corpus.filter((p) => p.media?.length).length} carry images you can read):\n${corpus
        .slice(0, 20)
        .map((p) => JSON.stringify(toolPost(p)))
        .join("\n")}`
    : parent
      ? "There are no posts behind this card yet. Your tools are the only evidence you will have."
      : "Nothing has been retrieved yet. Your tools are the only evidence you will have.";

  /**
   * What the question was asked OF.
   *
   * A card ask resolves its pronouns against that card ("who pays for THIS").
   * A board ask has no card and no lineage — it is the user turning to the
   * board itself and naming a subject, so the honest context is the board's
   * date and the fact that whatever comes back opens a topic of its own.
   */
  const placement = parent
    ? `${ancestors.length ? `WHERE THIS SITS: ${ancestors.join(" > ")}\n\n` : ""}THE CARD THE USER ASKED FROM
title: ${parent.title}
body: ${parent.body ?? "(none)"}`
    : `ASKED OF THE BOARD ITSELF${date ? `, today being ${date}` : ""}. There is no card above this question and no story it belongs to — the user typed it at the top of an open board and what you return opens a NEW TOPIC there, alongside the topics already on it. Treat "recent", "now" and "breaking" as meaning today.`;

  /**
   * What cards are FOR, which is the one thing the two kinds of ask disagree on.
   *
   * Asked of a card, a card beside the reply is a second thing to read and
   * almost always the reply restated — hence zero, hard. Asked of the board,
   * the reply has nowhere to be the answer: "here's what's breaking" is a
   * sentence, and the topics are what the user can actually open, argue with
   * and expand. So the same instruction inverts rather than relaxes.
   */
  const cardsRule = parent
    ? `CARDS DEFAULT TO ZERO, and that is the normal outcome. ONE is the most you may ever give. A card is not a summary of part of your answer; it is a SEPARATE finding the reader would want to open, argue with and expand on its own. Give it only when there is a distinct thread — a specific dissent, a named actor, a concrete number — that the answer doesn't already make. If a card would restate a sentence you just wrote, it is noise: the user would read the same thing twice, once as your reply and once as a card pretending to be a finding.

Ask yourself before that card: does this say something my answer doesn't? If no, drop it. A card that paraphrases the answer is the single worst thing you can return here.`
    : `THE CARDS ARE THE ANSWER HERE. Give ${maxCards} unless there genuinely aren't that many, because there is no card above this question for your reply to land on — the topics you return ARE what the user asked for, and a paragraph with nothing under it is a dead end on a board whose whole point is opening things.

Each card is a TOPIC, the way "Steel tariffs" or "Super Bowl LIX" is a topic: one story, named as a person would say it, with a body that says what actually happened and why it matters. Not a claim, not a quote, not a category — something with more underneath it, because the user's next move is to expand it. Set type to "story" or "topic".

Make them genuinely different stories rather than three angles on the biggest one, and rank them: priority is how much this matters to someone catching up right now.

Your reply above them is the orientation — a couple of sentences on what the picture looks like — not a list of the cards. Don't restate them.`;

  const prompt = `${placement}

THE QUESTION, in the user's own words:
"${question}"

${corpusBlock}

${covered.length ? `ALREADY ON THE BOARD — the user has read all of these. An answer that restates one teaches nothing:\n${covered.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n\n` : ""}ANSWER THEM. Whatever they said, they get a reply — that is the whole job. Talk to them normally, the way you would in a thread.

SEARCH FIRST unless the question plainly doesn't need it. You have the live X API and web search; anything about what happened, what people are saying or think, reactions, numbers, or anything recent MUST be searched before you answer — the corpus above is a handful of posts from one timeline, not the conversation. Search from more than one angle before concluding something isn't there. Only skip searching when the question is pure chat ("yo", "thanks") or asks for your own read on the card already in front of you.

CITE THE ANSWER ITSELF in answer_source_post_ids / answer_source_web_ids. Those are the answer's own sources and they are shown right under it, so an answer resting on evidence should carry it there — not in cards.

${cardsRule}

For any card you do give: cite BOTH kinds of evidence where you have them. A post is the better source for what someone said or how people reacted; an article is the better source for a number, an official statement, or what actually happened. Article refs go in source_web_ids.

Answer the question that was ACTUALLY asked. If the honest answer is "the evidence doesn't settle this", say that and show what it does say — a confident non-answer is the one thing that makes this board worthless.`;

  const tools = toolSpecs(Boolean(xToken));
  let input: unknown[] = [
    { role: "system", content: systemFor("search") },
    { role: "user", content: prompt },
  ];
  let previousId: string | undefined;
  /** whether we've already told it off for answering without searching */
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Out of budget: hand back the same conversation with no tools, which is
    // the only way to say "answer now" to a model that would otherwise keep
    // rephrasing the same search.
    const spent = trace.length >= TOOL_BUDGET;
    const res = await agentTurn({
      input: spent
        ? [
            ...input,
            {
              role: "user",
              content: `You have used your search budget (${trace.length} calls). Answer the question now, from what you already found. Do not ask for more tools.`,
            },
          ]
        : input,
      tools: spent ? [] : tools,
      previousResponseId: previousId,
      // the per-ask schema, not the template: `maxCards` above is what makes a
      // card ask return one card and a board ask return a column
      schema,
      schemaName: "ask_answer",
    });

    const output = (res.output ?? []) as {
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }[];
    const calls = output.filter((o) => o.type === "function_call");

    if (calls.length) {
      // Verified against the live API: grok issues SEVERAL function calls in a
      // single turn, so this is an array, not a single call. Run them together
      // — they're independent reads and doing them in series doubled the
      // wall clock for nothing.
      const results = await Promise.all(
        calls.map(async (c) => ({
          type: "function_call_output",
          call_id: c.call_id,
          output: JSON.stringify(
            await runTool(c.name ?? "", safeArgs(c.arguments)),
          ),
        })),
      );
      previousId = (res as { id?: string }).id;
      input = results;
      continue;
    }

    const text = outputTextOf(res);
    if (!text) throw new Error("ask agent returned no content");
    const parsed = extractJson<AskAnswer>(text, (o) =>
      Array.isArray((o as { children?: unknown })?.children),
    );

    /**
     * An unsearched answer gets LABELLED, never refused.
     *
     * This used to throw, on the reasoning that an answer with no retrieval is
     * prior knowledge and prior knowledge is what the board doesn't render.
     * That was wrong about what asking is for. @grok on X answers you whatever
     * you say to it, and a person who types "yo" or "what do you think?" has
     * asked a real question that no search would improve — refusing it with an
     * error is just a broken assistant.
     *
     * The board's actual rule isn't "never say anything unsourced", it's "never
     * pass unsourced off as sourced" — thin evidence and projections are shown,
     * labelled. So we nudge once, because a factual question genuinely is
     * better after a search, and then answer regardless and mark it as coming
     * from Grok rather than from evidence.
     */
    /**
     * An empty answer with no cards is nothing at all.
     *
     * Now that the reply IS the result, a blank one renders as a question card
     * with a title and no body — silently, looking like it worked. Seen live
     * once. Retry within the loop rather than failing the request: we already
     * hold the conversation, so it costs one turn instead of the whole ask.
     */
    if (!parsed.answer?.trim() && !parsed.children?.length) {
      if (turn < MAX_TURNS - 1) {
        previousId = (res as { id?: string }).id;
        input = [
          {
            role: "user",
            content:
              "You returned an empty answer. Write the reply out properly — answer the question in your own words.",
          },
        ];
        continue;
      }
      throw new Error("Grok returned an empty answer — ask again");
    }

    if (!trace.length && !nudged) {
      nudged = true;
      previousId = (res as { id?: string }).id;
      input = [
        {
          role: "user",
          content:
            "If that question needs live evidence — anything about what happened, what people are saying, or numbers — search first with search_x or search_web and then answer. If it genuinely doesn't need a search, keep your answer as it is.",
        },
      ];
      continue;
    }

    /**
     * Resolve citations against the pool, and drop what doesn't resolve.
     *
     * An id the tools never returned is either a hallucination or a post we
     * failed to keep — either way we cannot show the user the thing it claims
     * to cite, so it is not evidence.
     */
    const children: GrokChild[] = parsed.children.slice(0, maxCards).map((c) => ({
      type: c.type,
      title: c.title,
      body: c.body,
      priority: c.priority,
      generality: c.generality,
      has_children: c.has_children,
      epistemic: c.epistemic,
      source_post_ids: (c.source_post_ids ?? []).filter((id) => pool.posts[id]),
      source_web_ids: c.source_web_ids ?? [],
    }));

    // The answer's own sources, resolved against the same pool the cards are.
    // These are what make a zero-card ask still grounded: the reply carries its
    // citations directly, the way an @grok reply on X does.
    const answerPostIds = (parsed.answer_source_post_ids ?? []).filter(
      (id) => pool.posts[id],
    );
    const answerWeb = [
      ...new Map(
        (parsed.answer_source_web_ids ?? [])
          .map((r) => pool.web[Number(String(r).replace(/\D/g, "")) - 1])
          .filter(Boolean)
          .map((w) => [w.url, w] as const),
      ).values(),
    ];

    return {
      answer: parsed.answer,
      answerPostIds,
      answerWeb,
      /**
       * Does anything at all stand behind this answer?
       *
       * Not "did it search" — the card's own corpus is handed over in the
       * prompt, so Grok can answer a question about what's already on screen
       * from real posts without making a single tool call. Calling that
       * unsourced would have libelled a perfectly grounded answer. What
       * actually matters is whether a citation exists anywhere.
       */
      grounded:
        answerPostIds.length > 0 ||
        answerWeb.length > 0 ||
        children.some((c) => c.source_post_ids.length > 0),
      children,
      // only the posts actually cited travel back — the pool can hold 60 posts
      // after four searches and the board has no use for the other 55
      posts: pool.posts,
      web: pool.web,
      trace,
    };
  }

  throw new Error(`ask agent did not finish within ${MAX_TURNS} turns`);
}

function safeArgs(raw?: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

