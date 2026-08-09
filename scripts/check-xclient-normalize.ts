/**
 * Exercises the X normalize path against a synthetic API response.
 *
 * The demo runs off `.snapshots`, whose posts were normalized by an older build
 * — so nothing in the app actually re-runs this code until someone reads live.
 * Everything below (t.co expansion, note_tweet, HTML unescaping, quote parents)
 * is invisible to a snapshot replay and needs its own check.
 *
 *   bun run scripts/check-xclient-normalize.ts
 */
import { getPostsByIds } from "../lib/xClient";

const PAYLOAD = {
  data: [
    {
      id: "100",
      // 🚀 before the link proves we don't rely on X's code-point offsets, and
      // R&amp;D proves the text arrives HTML-escaped
      text: "🚀 Our R&amp;D notes on 5 &lt; 10 are up: https://t.co/SHORT1 pic https://t.co/MEDIA1",
      author_id: "u1",
      created_at: "2026-08-08T10:00:00.000Z",
      entities: {
        urls: [
          { url: "https://t.co/SHORT1", expanded_url: "https://example.com/a/b", display_url: "example.com/a/b" },
          { url: "https://t.co/MEDIA1", media_key: "3_1" },
        ],
      },
      public_metrics: { like_count: 12, retweet_count: 3, reply_count: 1, quote_count: 0 },
      attachments: { media_keys: ["3_1"] },
      referenced_tweets: [{ type: "quoted", id: "200" }],
    },
    {
      id: "101",
      text: "This is the truncated 280-char form that X hands back and it stops mid-sen",
      author_id: "u1",
      created_at: "2026-08-08T09:00:00.000Z",
      note_tweet: {
        text: "This is the FULL long post, well past 280 characters, and it finishes its sentence. See https://t.co/SHORT2",
        entities: { urls: [{ url: "https://t.co/SHORT2", display_url: "nytimes.com/2026/08/08" }] },
      },
    },
  ],
  includes: {
    users: [
      { id: "u1", name: "Alice Example", username: "alice", profile_image_url: "https://pbs.twimg.com/x_normal.jpg", verified: true },
      { id: "u2", name: "Bob Quoted", username: "bob" },
    ],
    media: [{ media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/pic.jpg", width: 1200, height: 800 }],
    tweets: [
      {
        id: "200",
        text: "The original chart everyone is arguing about &amp; its caption https://t.co/SHORT3",
        author_id: "u2",
        entities: { urls: [{ url: "https://t.co/SHORT3", display_url: "fred.stlouisfed.org" }] },
      },
    ],
  },
};

globalThis.fetch = (async () =>
  new Response(JSON.stringify(PAYLOAD), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const posts = await getPostsByIds("fake-token", ["100", "101"]);
const a = posts.get("100")!;
const b = posts.get("101")!;

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? "  ok  " : "  FAIL", name);
  if (!ok) console.log("        got:  ", JSON.stringify(got), "\n        want: ", JSON.stringify(want));
};

console.log("post 100 text:", JSON.stringify(a.text));
check("t.co swapped for the display domain", a.text.includes("example.com/a/b"), true);
check("no t.co survives", /t\.co\//.test(a.text), false);
check("the media's own t.co is removed entirely", a.text.includes("MEDIA1"), false);
check("&amp; decoded", a.text.includes("R&D"), true);
check("&lt; decoded", a.text.includes("5 < 10"), true);
check("emoji did not shift the replacement", a.text.startsWith("🚀 Our R&D"), true);
check("avatar upscaled off _normal", a.author.avatar_url, "https://pbs.twimg.com/x_x96.jpg");
check("permalink built from the handle", a.url, "https://x.com/alice/status/100");
check("media attached", a.media?.[0]?.url, "https://pbs.twimg.com/pic.jpg");

console.log("\nquoted parent:", JSON.stringify(a.quoted, null, 1));
check("quote parent body kept", a.quoted?.text.includes("original chart"), true);
check("quote parent entities expanded", a.quoted?.text.includes("fred.stlouisfed.org"), true);
check("quote parent &amp; decoded", a.quoted?.text.includes("about & its"), true);
check("quote parent author resolved", a.quoted?.author.handle, "bob");
check("quote parent permalink", a.quoted?.url, "https://x.com/bob/status/200");

console.log("\npost 101 text:", JSON.stringify(b.text));
check("long post uses note_tweet, not the truncated text", b.text.includes("finishes its sentence"), true);
check("note_tweet entities expanded too", b.text.includes("nytimes.com/2026/08/08"), true);
check("no quoted key when nothing is quoted", b.quoted, undefined);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
