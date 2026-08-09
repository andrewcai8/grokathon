import {
  MAX_CHILDREN,
  agentTurn,
  outputTextOf,
  extractJson,
  readImagesRaw,
  CHILD_PROPS,
  systemFor,
} from "./grokClient";
import { rankEvidence, type BoardKind, type WebSource } from "./evidence";
import { searchWeb, hasExa } from "./exaClient";
import { getReplies, searchRecent } from "./xClient";
import { mediaFromPosts, reachableMedia, MEDIA_CAP } from "./media";
import { optionsSystemFor, type OptionChild } from "./optionsExpander";
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
function toolSpecs(hasX: boolean, decide = false) {
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
        decide
          ? "Search the web for real products and their specs. Every page it returns exists and can be cited by ref — and it is the ONLY way you are allowed to learn a price, a spec or that a product exists at all. Phrase queries the way a comparison article or buying guide is titled. Call it more than once when the first angle is thin."
          : "Search news and the open web. Better than X for anything that was reported rather than posted — numbers, official statements, background.",
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

/**
 * The same answer, in the other board's currency.
 *
 * A decision board's cards are not claims — they carry attributes and a picture
 * instead of an epistemic status and post chips (see BOARD_KINDS). So an ask
 * that answered here in the schema above would land a card with a "contested"
 * badge and X citations beside three cars being compared on price and range,
 * which is the exact category error /api/expand used to refuse the whole ask to
 * avoid. Same agent, same loop, same tool budget — one schema, and the rules in
 * the prompt that follow from it.
 *
 * The field is still called `children` so the loop's own checks — the JSON
 * validity predicate, the empty-answer retry — stay one code path rather than
 * two that have to agree.
 */
const DECIDE_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Your actual answer, talking to the person deciding. Normal sentences, as long as the question deserves and no longer. If you are giving a card below, this says what the card IS and what taking it costs them — not a restatement of its rows.",
    },
    answer_source_web_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "Refs (web1, web2...) of pages YOUR TOOLS RETURNED that the answer rests on. Fill this in whenever the answer draws on a source, even with no cards at all.",
    },
    /**
     * A picture the model asked for, rather than one it was told to produce.
     *
     * The whole point of an options board is that seeing the thing beats
     * reading about it, so the answer gets to be visual too — but only when the
     * picture IS part of the answer. Empty is the normal outcome for "is the
     * hybrid worth it", and a rule that always generated one would spend 7.6s
     * and $0.05 drawing an illustration of a sentence.
     */
    answer_image_prompt: {
      type: "string",
      description:
        "A prompt to generate a picture of the THING your answer is about, or an empty string for no picture. Give one only when seeing it is part of the answer and no card below already shows it. Describe the subject concretely and plainly, on a plain neutral background, no text or lettering or watermarks. Under 200 characters.",
    },
    children: {
      type: "array",
      minItems: 0,
      maxItems: MAX_CHILDREN,
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The option itself, under 60 characters. A thing a person could choose.",
          },
          body: {
            type: "string",
            description:
              "1-2 sentences. Lead with WHO this is the right choice for and what you give up by taking it.",
          },
          priority: {
            type: "number",
            description: "0-1. Drives vertical order — how strong a default this is here.",
          },
          attributes: {
            type: "array",
            description:
              "2-4 comparable facts, values taken verbatim from the pages your tools returned. Prefer measured facts with units. Never write 'Not listed', 'N/A' or a dash — omit the row instead.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short, e.g. 'Price', 'Range', 'Weight'." },
                value: { type: "string", description: "Short, e.g. '$27,400', '312 mi'." },
              },
              required: ["label", "value"],
              additionalProperties: false,
            },
          },
          source_web_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Refs (web1, web2...) of pages YOUR TOOLS RETURNED that this option and its attributes came from. Never invent a ref. A card with none of these is dropped.",
          },
          image_prompt: {
            type: "string",
            description:
              "A prompt to generate a clean, appealing image of THIS option for its card. Describe the subject concretely and plainly. Always specify a plain neutral background and no text, lettering or watermarks. Under 200 characters.",
          },
          has_children: {
            type: "boolean",
            description:
              "Honestly: can this be narrowed further, or is it already a single specific choice?",
          },
        },
        required: [
          "title",
          "body",
          "priority",
          "attributes",
          "source_web_ids",
          "image_prompt",
          "has_children",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "answer_source_web_ids", "answer_image_prompt", "children"],
  additionalProperties: false,
} as const;

interface AskAnswer {
  answer: string;
  answer_source_post_ids?: string[];
  answer_source_web_ids?: string[];
  answer_image_prompt?: string;
  children: (GrokChild & { source_web_ids?: string[] })[];
}

/** the same parse, when the schema above was DECIDE_SCHEMA */
interface DecideAnswer {
  answer: string;
  answer_source_web_ids?: string[];
  answer_image_prompt?: string;
  children: OptionChild[];
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
  /**
   * What the board is FOR, which decides what an answer IS.
   *
   * On "news" a card is a claim and the answer cites posts. On "options" a card
   * is a choice and the answer cites pages, carries attributes and may show a
   * picture. Everything between those two ends — the loop, the budget, the
   * citations-must-resolve invariant — is identical, which is the whole reason
   * this is a parameter rather than a second agent.
   */
  kind?: BoardKind;
  /**
   * Options boards: the decision the whole board is narrowing.
   *
   * "What's the Toyota equivalent to this" is unanswerable without it — the
   * card asked from is "Compact SUVs", the pronoun points at a car, and the
   * only thing that says this board is about cars under $30k at all is the
   * question the person typed to start it.
   */
  boardQuestion?: string;
  /**
   * Options boards: the attribute labels the card asked from compares on.
   *
   * A decision column is read DOWN — "Price" has to sit at the same height on
   * every card or the comparison isn't one. An answer card generated in
   * isolation picks its own labels, so an equivalent arrives measuring "Segment
   * / Drivetrain" beside the car it is supposedly equivalent to measuring
   * "Starting price / MPG", and the one comparison the user actually asked for
   * is the one they can't make.
   */
  compare?: string[];
}): Promise<{
  answer: string;
  /** the answer's OWN citations — what a zero-card ask shows under the reply */
  answerPostIds: string[];
  answerWeb: WebSource[];
  /** a picture for the question card itself, when the model asked for one */
  answerImagePrompt?: string;
  /** false when nothing at all stands behind the answer */
  grounded: boolean;
  children: GrokChild[];
  /** decide mode only: the answer as option cards, for optionsToNodes */
  options: OptionChild[];
  posts: Record<string, XPost>;
  web: WebSource[];
  trace: AskTrace[];
}> {
  const {
    question,
    parent,
    ancestors,
    corpus,
    covered,
    date,
    xToken,
    kind = "news",
    boardQuestion,
    compare = [],
  } = opts;
  const decide = kind === "options";

  /**
   * How many cards this ask may return, and why it depends on where it was asked.
   *
   * A card ask is capped at ASK_MAX_CHILDREN because its reply lands on the
   * question card itself — a card beside it is a bonus finding, not the answer.
   * A board ask has no such card to be the answer: "what's breaking" is only
   * useful AS the topics, so it gets the board's own branching factor. Same
   * agent, same schema, same everything else — one number.
   */
  /**
   * A decision ask is capped at the board's own branching factor instead.
   *
   * The one-card rule above is about a REPLY being the result: a claim card
   * beside it would say the same thing twice. That reasoning doesn't survive the
   * move to options, where the card is the thing itself — asked "what else
   * should I look at", a sentence naming three cars with no cards to open,
   * compare or narrow is the dead end this board exists to not be. The prompt
   * still says give as few as the question asks for, and one is the usual answer.
   */
  const maxCards = decide ? MAX_CHILDREN : parent ? ASK_MAX_CHILDREN : MAX_CHILDREN;
  const base = decide ? DECIDE_SCHEMA : ANSWER_SCHEMA;
  const schema = {
    ...base,
    properties: {
      ...base.properties,
      children: { ...base.properties.children, maxItems: maxCards },
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
        // No news category on a decision board, and no recency window: what we
        // want is the comparison and buying-guide pages optionCorpus goes after,
        // and filing a product round-up under "news" returns coverage of the
        // company instead of specs for the thing.
        const found = await searchWeb(
          query,
          decide
            ? { numResults: 6, maxCharacters: 1200 }
            : { numResults: 5, category: "news" },
        );
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

  const corpusBlock = decide
    ? // a decision board holds no posts at all: its cards were read out of web
      // pages, and those pages were spent by the expand that made them
      "NOTHING HAS BEEN RETRIEVED FOR THIS QUESTION. search_web is the only evidence you will have, and the only place a price, a spec or the existence of a product may come from."
    : corpus.length
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
  const placement = decide
    ? `THE DECISION THIS WHOLE BOARD IS NARROWING: ${boardQuestion ?? ancestors[0] ?? "(not stated)"}

${ancestors.length ? `HOW FAR THEY HAVE NARROWED IT: ${ancestors.join(" > ")}\n\n` : ""}THE OPTION THE USER ASKED FROM
title: ${parent?.title ?? "(the board itself)"}
body: ${parent?.body ?? "(none)"}${
        parent?.attributes?.length
          ? `\ncompared on: ${parent.attributes.map((a) => `${a.label} (${a.value})`).join(", ")}`
          : ""
      }

Their pronouns point at that option — "this", "it", "the same thing" all mean the card above, inside the decision above. Carry down every constraint the decision states: a budget, a use case or a timeframe from the question still rules out anything that breaks it, however good an answer it would otherwise be.`
    : parent
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
  /**
   * What a card is on a decision board: the thing itself, not a finding.
   *
   * "What's the Toyota equivalent to this" has an answer you can buy, and the
   * card is where it lives — with its price beside the price it's equivalent
   * to, its picture, and somewhere to narrow further. A sentence naming a car
   * with no card under it is the dead end this board exists to not be. But the
   * COUNT has to follow the question rather than a quota: asked for one
   * equivalent, three cards is two products the person never asked about,
   * dressed as an answer.
   */
  const decideCardsRule = `THE NUMBER OF CARDS IS DECIDED BY THE QUESTION, not by a quota. "What's the Toyota equivalent to this" is exactly ONE card. "What else should I look at" may be up to ${maxCards}. A question about the option they already have — "is the hybrid worth it", "what's the catch" — is ZERO cards: the answer is the whole result, and a card restating it is noise.

Every card is a CHOICE the person could actually make: a specific, real, buyable thing named in a page your tools returned, with its own picture and its own rows. Never a category, never a consideration, never "things to think about".

${
    compare.length
      ? `THE CARD THEY ASKED FROM COMPARES ON THESE, IN THIS ORDER:
${compare.map((l) => `- ${l}`).join("\n")}

Use the SAME labels, in the SAME order, wherever your sources give you those facts. That is the entire value of an equivalent — the person wants to read the new thing against the old one, row for row, and a card that brings its own labels ends the comparison instead of joining it. If the sources genuinely don't give you one, omit that row; never rename it and never substitute a different attribute for it.`
      : `Pick 2-4 attributes a person would genuinely compare these on, and give every card the same labels in the same order.`
  }

Identical values are fine here and often the point: if the equivalent costs the same and returns the same mpg, saying so IS the answer.

Your reply above the cards says what the thing is and what taking it costs them — not a reading of the rows, which they can see.`;

  const cardsRule = decide
    ? decideCardsRule
    : parent
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

${
    decide
      ? `SEARCH FIRST unless the question plainly doesn't need it. A product, a price, a spec, a comparison, "what else is there" — all of it MUST come out of search_web before you answer, because you are holding nothing else. Search from more than one angle before concluding something doesn't exist: what you know about this market is a year out of date and the person is deciding today. Only skip searching when the question is pure chat, or asks for your own read on the option already in front of you.

CITE THE ANSWER ITSELF in answer_source_web_ids. Those are the answer's own sources and they are shown right under it, so an answer resting on a page should carry it there — not only in cards.

DECIDE WHETHER A PICTURE HELPS. answer_image_prompt is yours to leave empty, and empty is the usual answer. Fill it only when the thing being asked about is something you'd want to LOOK at and no card below already shows it — and remember a card always comes with its own picture, so an equivalent you return as a card needs nothing here.`
      : `SEARCH FIRST unless the question plainly doesn't need it. You have the live X API and web search; anything about what happened, what people are saying or think, reactions, numbers, or anything recent MUST be searched before you answer — the corpus above is a handful of posts from one timeline, not the conversation. Search from more than one angle before concluding something isn't there. Only skip searching when the question is pure chat ("yo", "thanks") or asks for your own read on the card already in front of you.

CITE THE ANSWER ITSELF in answer_source_post_ids / answer_source_web_ids. Those are the answer's own sources and they are shown right under it, so an answer resting on evidence should carry it there — not in cards.`
  }

${cardsRule}

${
    decide
      ? `Every card must carry source_web_ids from pages your tools actually returned. A card with none is dropped before the user sees it, so a real option you found and forgot to cite is an option you didn't give them.

Answer the question that was ACTUALLY asked. If nothing you found is a genuine answer — no such equivalent exists, or nothing in that range clears their constraint — say that plainly and say what does exist instead. An invented product with a plausible price is the one failure this board cannot survive.`
      : `For any card you do give: cite BOTH kinds of evidence where you have them. A post is the better source for what someone said or how people reacted; an article is the better source for a number, an official statement, or what actually happened. Article refs go in source_web_ids.

Answer the question that was ACTUALLY asked. If the honest answer is "the evidence doesn't settle this", say that and show what it does say — a confident non-answer is the one thing that makes this board worthless.`
  }`;

  // web only on a decision board: X posts are the wrong currency there — a
  // decision card renders attributes and sources, and has nowhere to put a post
  // chip, so evidence gathered from X would be invisible on the card it backs
  const tools = toolSpecs(Boolean(xToken) && !decide, decide);
  let input: unknown[] = [
    {
      role: "system",
      content: decide ? optionsSystemFor("search", false) : systemFor("search"),
    },
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
          content: decide
            ? "If that question needs a real product, a price or a spec, search first with search_web and then answer — you are not allowed to name one you didn't retrieve. If it genuinely doesn't need a search, keep your answer as it is."
            : "If that question needs live evidence — anything about what happened, what people are saying, or numbers — search first with search_x or search_web and then answer. If it genuinely doesn't need a search, keep your answer as it is.",
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
    const children: GrokChild[] = decide
      ? []
      : parsed.children.slice(0, maxCards).map((c) => ({
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

    /**
     * The same cards, when the schema was DECIDE_SCHEMA.
     *
     * Handed back raw rather than resolved here: optionsToNodes already
     * resolves web refs against the corpus, drops the ones that don't, dedupes
     * by URL and strips non-discriminating attributes — the identical treatment
     * an option gets when the expander makes it. Doing any of that a second
     * time here is how the two paths start to disagree about what an option is.
     */
    const options: OptionChild[] = decide
      ? (parsed as unknown as DecideAnswer).children.slice(0, maxCards)
      : [];

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
        children.some((c) => c.source_post_ids.length > 0) ||
        // an option's grounding is the page its attributes were read out of,
        // and on a decision board it is the only kind there is
        options.some((o) => (o.source_web_ids ?? []).length > 0),
      children,
      options,
      // an empty string is the model declining a picture — carry it as absent
      // rather than as a prompt, or OptionImage draws a spinner for nothing
      answerImagePrompt: parsed.answer_image_prompt?.trim() || undefined,
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

