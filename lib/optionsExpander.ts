import { searchWeb, webLine } from "./exaClient";
import { MAX_CHILDREN, structured } from "./grokClient";
import type { WebSource } from "./evidence";

/**
 * Progressive refinement: three options, pick one, three narrower options,
 * until you've converged on a single thing.
 *
 * The shape is identical to the news expander — a node, N more specific
 * children, a grounding type — and that is the whole point of the paradigm.
 * What differs is what grounding MEANS. For a claim, grounding proves the
 * assertion is true. For an option, there is nothing to prove: an option isn't
 * true or false. Grounding here means the option actually exists and its
 * attributes are real, so the corpus is retrieved the same way and the model
 * still only interprets.
 *
 * Two things are deliberately NOT hardcoded to a domain:
 *
 *   - The web query is written by Grok, exactly as searchQueryFor does for X.
 *     Exa has no shopping/product category, so the obvious move was steering by
 *     includeDomains — but that means a car list, a laptop list, a hotel list,
 *     and a board that only generalises to domains someone remembered to
 *     enumerate. Verified across cars, laptops and travel: a well-formed query
 *     alone returns comparison and buying-guide pages, 12/12 with usable
 *     images. So the steering is language, not configuration.
 *
 *   - The image prompt is written per option by the same call, because the
 *     model that invented the option is the only thing that knows what it looks
 *     like. A template here would be a car template.
 */

export interface OptionChild {
  title: string;
  body: string;
  priority: number;
  attributes: { label: string; value: string }[];
  source_web_ids: string[];
  image_prompt: string;
  has_children: boolean;
}

const OPTIONS_SYSTEM = `You help a person narrow a decision down to one choice, three options at a time.

Absolute rules:
- The web pages you are given are the ONLY ground truth. Every option must be something those pages actually describe, and every attribute value must come from them. Never invent a product, a price or a spec that is not in the sources.
- An option is a CHOICE, not a claim. It is not true or false. Do not hedge, do not weigh evidence, do not label anything contested. Say what the thing is and what it costs you.
- The three options must be genuinely DIFFERENT DIRECTIONS, not variations of one thing. If two of them would suit the same person for the same reason, replace one. Divide the space; do not sample it.
- All three must be points on the SAME named axis — mutually exclusive, and together covering the space. Three options taken from three different dimensions (a size, then a body style, then a fuel type) is a grab bag, not a division: the person can no longer tell which question they are answering, and the options overlap so picking one doesn't rule the others out. Where the space has a simple ordered axis — small / medium / large, cheap / mid / premium, short / medium / long — prefer it: it is instantly legible and obviously complete.
- Every option must be strictly one level more specific than the parent, and must be a real choice a person could actually make.
- Attributes are what make a choice decidable: the 2-4 facts a person would genuinely compare. Their labels must be IDENTICAL across all three options, in the same order, so the three can be read down a column against each other. A fact only one option has is not a comparison — leave it out.
- Every attribute must DISCRIMINATE. If a value would read the same on all three cards it is telling the reader nothing: drop it and find one that differs. Never restate the constraint they already gave — "under $30,000" on a card inside a $30,000 search is a wasted row.
- Prefer concrete measured facts with units — price, range, mpg, weight, capacity, duration — over editorial verdicts like "editor's choice" or "also recommended". A ranking is someone's opinion of an option; a number is a property of it.
- Never write "Not listed", "N/A", "Unknown" or a dash as a value. If the sources don't give you the fact, omit that attribute for that option entirely. A missing row is fine; a row full of nothing makes the card look broken.
- Titles must be legible alone at a glance.`;

/**
 * Turn a node into a web query that finds comparisons.
 *
 * A node title is a destination ("Compact hatchbacks"), not a question. Pages
 * that actually enumerate options are phrased as comparisons and buying
 * guides, so the query has to be rewritten into that register or Exa returns
 * encyclopedia entries and manufacturer homepages.
 */
export async function optionQueryFor(
  title: string,
  ancestors: string[],
): Promise<string> {
  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A web search query that will find pages COMPARING the concrete options within this category. Phrase it the way a buying guide or comparison article is titled. Include the constraints that matter (budget, year, use case) if they are known. Under 140 characters.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  };

  const out = await structured<{ query: string }>(
    "option_query",
    schema,
    `Write a web search query that will find pages listing and comparing the real options inside this category.

${ancestors.length ? `THE PERSON IS NARROWING DOWN: ${ancestors.join(" > ")}\n` : ""}CATEGORY: ${title}
CURRENT YEAR: ${new Date().getFullYear()}

Carry down every constraint stated above — a budget or a use case from further up still applies here.

Add NOTHING they did not say. Do not decide new or used, a brand, a body style, or a model year on their behalf: each invented word narrows the search before they have chosen anything, and they will never see what it ruled out. If they did not say "used", the query must not say "used". Use the current year, not a past one.

Aim at comparison articles, buying guides and "best X for Y" round-ups — those are the pages that actually enumerate choices. Prefer wording that will match several independent publications rather than one aggregator.`,
    (raw) => raw as { query: string },
    OPTIONS_SYSTEM,
  );

  return (out.query || title).slice(0, 140).trim();
}

/**
 * Retrieve the corpus for an options node.
 *
 * Sources already used elsewhere on the board are removed before the model
 * ever sees them — the same structural novelty rule the news board uses, for
 * the same reason: if the corpus still contains what the user has read, the
 * model has to REMEMBER not to repeat it, and it won't.
 */
export async function optionCorpus(
  title: string,
  ancestors: string[],
  usedUrls: Set<string>,
): Promise<{ web: WebSource[]; query: string }> {
  const query = await optionQueryFor(title, ancestors);
  // 6 x 1000 rather than 8 x 1200: the larger corpus pushed one expand past the
  // SDK's 60s ceiling and returned "Request timed out", and the extra pages were
  // adding length rather than distinct options. Latency IS the product here.
  const found = await searchWeb(query, { numResults: 6, maxCharacters: 1000 });
  return { web: found.filter((w) => !usedUrls.has(w.url)), query };
}

export async function expandOptions(
  node: { title: string; body?: string },
  ancestors: string[],
  /** titles already on the board — options must not restate any of them */
  covered: string[],
  web: WebSource[],
  /**
   * Directions already offered at this level, when this call is EXTENDING a set
   * rather than creating one. Without it the model re-divides a space it has
   * already divided and hands back synonyms — "Small cars" for "Compact cars" —
   * which pass the novelty check on exact titles while adding nothing.
   */
  extend?: string[],
): Promise<{ summary?: string; axis?: string; options: OptionChild[] }> {
  const schema = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "1-2 sentences on what this category is and what actually separates the choices inside it. Strictly from the sources.",
      },
      axis: {
        type: "string",
        description:
          "The single dimension you divided this category along, as a short noun phrase (e.g. 'body style', 'trip length', 'screen size'). Naming it is what forces the three to be different directions rather than three samples of the same one.",
      },
      options: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CHILDREN,
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "The option itself, under 60 characters. A thing a person could choose.",
            },
            body: {
              type: "string",
              description:
                "1-2 sentences. Lead with WHO this is the right choice for and what you give up by taking it. Not a description of the category.",
            },
            priority: {
              type: "number",
              description:
                "0-1. Drives vertical order — how strong a default this is for a typical person in this situation.",
            },
            attributes: {
              type: "array",
              description:
                "2-4 comparable facts, values taken verbatim from the sources. Labels MUST be identical across all three options — same words, same order — so the cards read down a column. Every one must DISCRIMINATE: if the value would be the same on all three, drop it and pick one that differs. Prefer measured facts with units (price, range, mpg, weight, duration) over editorial verdicts.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Short, e.g. 'Price', 'Range', 'Weight'.",
                  },
                  value: {
                    type: "string",
                    description: "Short, e.g. '$27,400', '312 mi', '2.7 lb'.",
                  },
                },
                required: ["label", "value"],
                additionalProperties: false,
              },
            },
            source_web_ids: {
              type: "array",
              items: { type: "string" },
              description:
                "refs (web1, web2...) of the sources this option and its attributes came from. Never invent a ref.",
            },
            image_prompt: {
              type: "string",
              description:
                "A prompt to generate a clean, appealing image of THIS option for its card. Describe the subject concretely and plainly. Always specify a plain neutral background and no text, lettering or watermarks. Keep it under 200 characters.",
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
    required: ["summary", "axis", "options"],
    additionalProperties: false,
  };

  const content = `Give me AT MOST ${MAX_CHILDREN} options one level more specific than this, and say what separates them.

${ancestors.length ? `NARROWING DOWN SO FAR (most general first):\n${ancestors.join("\n  ↳ ")}\n\n` : ""}NARROW THIS
${node.title}${node.body ? `\n${node.body}` : ""}

Pick ONE dimension to divide this category along, name it in "axis", then give the ${MAX_CHILDREN} options that divide it best. Different directions, not variations: someone choosing between them should face a real trade-off, not a preference between near-identical things.

${
  extend?.length
    ? `These directions are ALREADY on offer at this level:
${extend.map((t) => `- ${t}`).join("\n")}

CONTINUE that same division — do not start a new one, and do not rename one of the above. Give the directions that set leaves out. If it genuinely covers the space with nothing meaningful left over, return fewer options, or none at all: "that's all of them" is a real answer and a far better one than three synonyms.

`
    : ancestors.length
      ? ""
      : `This is the FIRST split, so divide the space at its BROADEST useful level: the kinds of thing a person could choose between, not individual products. Naming three specific products now silently discards every alternative they haven't considered yet — and they will never know what was thrown away. The specific ones are earned later, once a direction has been picked.

`
}

Constraints stated further up (budget, use case, timing) still apply — never offer an option that violates one.

${covered.length ? `ALREADY ON THE BOARD — do not offer any of these again, and do not offer a narrower rewording of one:\n${covered.slice(0, 40).map((t) => `- ${t}`).join("\n")}\n` : ""}
Every option and every attribute value must come from the sources below. If the sources do not support an attribute, leave it out rather than estimating it.

SOURCES:
${web.length ? web.map((w, i) => webLine(w, `web${i + 1}`)).join("\n\n") : "(none)"}`;

  const out = await structured<{
    summary?: string;
    axis?: string;
    options: OptionChild[];
  }>(
    "narrow_options",
    schema,
    content,
    (raw) => raw as { summary?: string; axis?: string; options: OptionChild[] },
    OPTIONS_SYSTEM,
  );

  // the json_schema caps this, but parse stays tolerant so an over-eager
  // generation is trimmed rather than throwing mid-demo
  return {
    summary: out.summary,
    axis: out.axis,
    options: [...(out.options ?? [])]
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, MAX_CHILDREN),
  };
}
