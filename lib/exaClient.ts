import type { WebSource } from "./evidence";

/**
 * Exa web search.
 *
 * Same contract as the X API path and for the same reason: WE retrieve, Grok
 * only interprets. Results are real by construction, so there is nothing to
 * verify after the fact and no way to fabricate a source.
 *
 * It complements X rather than replacing it. X tells you what people are
 * saying; Exa tells you what was reported. On the OpenAI/Astra story X gave us
 * reaction posts while Exa returned Bloomberg, TechCrunch and The Verge with
 * datelines and bylines — different evidence, and for a factual claim the
 * better kind.
 *
 * Verified against the live API: POST https://api.exa.ai/search, x-api-key
 * header, ~1.0s, ~$0.007 per search (listed at $7/1k, plus $1/1k per content
 * type). Category strings are from the OpenAPI enum — note there is no
 * shopping/product category, which matters for the options board kind.
 */

const API = "https://api.exa.ai";

export function hasExa() {
  return Boolean(process.env.EXA_API_KEY);
}

interface ExaResult {
  id: string;
  url: string;
  title?: string;
  text?: string;
  author?: string;
  publishedDate?: string;
  image?: string;
  highlights?: string[];
}

export interface ExaOptions {
  numResults?: number;
  /** ISO date; keeps a fast-moving story from citing last year's coverage */
  startPublishedDate?: string;
  /** exact strings from the OpenAPI enum; there is no shopping/product category */
  category?:
    | "news"
    | "company"
    | "research paper"
    | "pdf"
    | "github"
    | "personal site"
    | "people"
    | "financial report";
  maxCharacters?: number;
}

function siteOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export async function searchWeb(
  query: string,
  opts: ExaOptions = {},
): Promise<WebSource[]> {
  if (!process.env.EXA_API_KEY) return [];

  const res = await fetch(`${API}/search`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.EXA_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: opts.numResults ?? 6,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.startPublishedDate
        ? { startPublishedDate: opts.startPublishedDate }
        : {}),
      contents: {
        text: { maxCharacters: opts.maxCharacters ?? 900 },
        // numSentences is deprecated in the current spec; maxCharacters is the
        // supported control
        highlights: { maxCharacters: 400 },
      },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as { results?: ExaResult[] };
  return (json.results ?? [])
    .filter((r) => r.url && r.title)
    .map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title!,
      // prefer highlights: they're the relevant sentences, not the page chrome
      text: (r.highlights?.join(" ") || r.text || "").slice(0, 900).trim(),
      author: r.author || undefined,
      publishedAt: r.publishedDate || undefined,
      siteName: siteOf(r.url),
      imageUrl: r.image || undefined,
    }));
}

/** How web sources are shown to Grok, mirroring postLine for X. */
export function webLine(w: WebSource, ref: string) {
  const meta = [w.siteName, w.publishedAt?.slice(0, 10), w.author]
    .filter(Boolean)
    .join(" · ");
  return `ref:${ref} ${w.title}${meta ? `\n[${meta}]` : ""}\n${w.text ?? ""}`;
}
