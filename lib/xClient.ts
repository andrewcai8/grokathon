import type { XPost } from "./schema";

/**
 * X API v2 reads. Field/expansion combo below is the single call that returns
 * everything a card needs: text, author identity, metrics, media and the
 * quote/reply parents. All three media params are required together or media
 * silently doesn't come back.
 *
 * reverse_chronological is an "Owned Read" — ~$0.001/post, 180 req/15min per
 * user. No tier gating since X moved to pay-per-usage in Feb 2026.
 */

const API = "https://api.x.com/2";

const TWEET_FIELDS =
  "created_at,text,public_metrics,conversation_id,referenced_tweets,attachments,author_id,lang";
const USER_FIELDS = "name,username,profile_image_url,verified";
const MEDIA_FIELDS = "media_key,type,url,preview_image_url,alt_text";
const EXPANSIONS =
  "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys";

interface RawUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
}
interface RawMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
}
interface RawTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    quote_count?: number;
  };
  attachments?: { media_keys?: string[] };
  referenced_tweets?: { type: string; id: string }[];
}
interface RawResponse {
  data?: RawTweet[];
  includes?: { users?: RawUser[]; media?: RawMedia[]; tweets?: RawTweet[] };
  meta?: { next_token?: string; result_count?: number };
  title?: string;
  detail?: string;
}

async function xGet<T>(path: string, token: string, params: Record<string, string>) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function getMe(token: string) {
  const json = await xGet<{ data: RawUser }>("/users/me", token, {
    "user.fields": USER_FIELDS,
  });
  return json.data;
}

function normalize(json: RawResponse): XPost[] {
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
  const media = new Map((json.includes?.media ?? []).map((m) => [m.media_key, m]));

  return (json.data ?? []).map((t) => {
    const u = t.author_id ? users.get(t.author_id) : undefined;
    const attached = (t.attachments?.media_keys ?? [])
      .map((k) => media.get(k))
      .filter((m): m is RawMedia => Boolean(m))
      .map((m) => ({
        kind: (m.type === "video"
          ? "video"
          : m.type === "animated_gif"
            ? "animated_gif"
            : "photo") as "photo" | "video" | "animated_gif",
        url: m.url ?? m.preview_image_url ?? "",
        alt: m.alt_text,
      }))
      .filter((m) => m.url);

    return {
      id: t.id,
      text: t.text,
      author: {
        id: t.author_id ?? "unknown",
        handle: u?.username ?? "unknown",
        name: u?.name ?? "Unknown",
        avatar_url: u?.profile_image_url?.replace("_normal", "_x96"),
        verified: u?.verified,
      },
      created_at: t.created_at ?? new Date().toISOString(),
      url: u ? `https://x.com/${u.username}/status/${t.id}` : undefined,
      metrics: t.public_metrics
        ? {
            likes: t.public_metrics.like_count,
            reposts: t.public_metrics.retweet_count,
            replies: t.public_metrics.reply_count,
            quotes: t.public_metrics.quote_count,
          }
        : undefined,
      media: attached.length ? attached : undefined,
      conversation_id: t.conversation_id,
      referenced_post_ids: t.referenced_tweets?.map((r) => r.id),
    } satisfies XPost;
  });
}

/** The personal seed: the authed user's own reverse-chronological home timeline. */
export async function getHomeTimeline(
  token: string,
  userId: string,
  maxResults = 100,
): Promise<XPost[]> {
  const json = await xGet<RawResponse>(
    `/users/${userId}/timelines/reverse_chronological`,
    token,
    {
      max_results: String(Math.min(100, Math.max(5, maxResults))),
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
      "media.fields": MEDIA_FIELDS,
      expansions: EXPANSIONS,
      exclude: "replies",
    },
  );
  return normalize(json);
}

/**
 * Resolve post IDs against X. This is the integrity check for anything Grok
 * claims to have found: x_search hands back a URL and a quote it authored, and
 * without this we would render invented words attributed to a real, named
 * account with a permalink that lends them authority. Anything that doesn't
 * come back here did not exist.
 *
 * Up to 100 ids per call.
 */
export async function getPostsByIds(
  token: string,
  ids: string[],
): Promise<Map<string, XPost>> {
  const wanted = [...new Set(ids)].slice(0, 100);
  if (!wanted.length) return new Map();

  const json = await xGet<RawResponse>("/tweets", token, {
    ids: wanted.join(","),
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    "media.fields": MEDIA_FIELDS,
    expansions: EXPANSIONS,
  });
  return new Map(normalize(json).map((p) => [p.id, p]));
}

/**
 * Trends personalised to the authed account — the "what's trending for you"
 * rail on x.com, rather than a global top-10. Confirmed working on this
 * account: returns headline-style trend names with a category and post count.
 *
 * These ARE the board's root topics. X has already done the clustering, so we
 * use them directly rather than searching for posts and re-deriving topics.
 */
export interface XTrend {
  name: string;
  category?: string;
  /** parsed from the API's display string, e.g. "5.7K posts" -> 5700 */
  postCount: number;
  since?: string;
}

/** "5.7K posts" -> 5700, "542 posts" -> 542 */
function parsePostCount(display?: string): number {
  if (!display) return 0;
  const m = /([\d.]+)\s*([KMB])?/i.exec(display);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() ?? ""] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}

export async function getPersonalizedTrends(token: string): Promise<XTrend[]> {
  const json = await xGet<{
    data?: {
      trend_name?: string;
      post_count?: string;
      category?: string;
      trending_since?: string;
    }[];
  }>("/users/personalized_trends", token, {});

  return (json.data ?? [])
    .map((t) => ({
      name: t.trend_name ?? "",
      category: t.category,
      postCount: parsePostCount(t.post_count),
      since: t.trending_since,
    }))
    .filter((t) => t.name)
    .sort((a, b) => b.postCount - a.postCount);
}


/**
 * Trends personalised to the authed account — the "what's trending for you"
 * rail on x.com, rather than a global top-10. Confirmed working on this
 * account: returns headline-style trend names with a category and post count.
 *
 * These ARE the board's root topics. X has already done the clustering, so we
 * use them directly rather than searching for posts and re-deriving topics.
 */
/**
 * The replies to a conversation, most-engaged first.
 *
 * Depth usually means "a narrower claim". This is a different KIND of
 * information: what people said back. X exposes it through the
 * `conversation_id:` search operator, so it needs no model at all — the
 * replies are the content, already grounded, with nothing to hallucinate.
 */
export async function getReplies(
  token: string,
  conversationId: string,
  limit = 40,
): Promise<XPost[]> {
  const json = await xGet<RawResponse>("/tweets/search/recent", token, {
    query: `conversation_id:${conversationId} -is:retweet`,
    max_results: String(Math.min(100, Math.max(10, limit))),
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    "media.fields": MEDIA_FIELDS,
    expansions: EXPANSIONS,
  });
  return normalize(json)
    .filter((p) => p.id !== conversationId)
    .sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0));
}

/** Fallback seed and topic reseed. Not an Owned Read — costs more per post. */
export async function searchRecent(
  token: string,
  query: string,
  maxResults = 50,
): Promise<XPost[]> {
  const json = await xGet<RawResponse>("/tweets/search/recent", token, {
    query,
    max_results: String(Math.min(100, Math.max(10, maxResults))),
    sort_order: "relevancy",
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    "media.fields": MEDIA_FIELDS,
    expansions: EXPANSIONS,
  });
  return normalize(json);
}
