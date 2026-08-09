/**
 * Exercises the grounding path for trending roots.
 *
 * The failure this guards against shipped and sat on the board: X's #1
 * personalised trend rendered the red "no sources" marker under a body reading
 * "The supplied corpus does not contain any posts…", because a trend root
 * recorded no provenance and its grounding search returned nothing. Both halves
 * are invisible to a snapshot replay — the snapshot IS the wrong output — so
 * they need their own check.
 *
 *   bun run scripts/check-trend-grounding.ts
 */
import { buildBoardFromTrends, rollUpCitations } from "../lib/boardBuilder";
import { isGrounded } from "../lib/evidence";
import { relaxedQuery } from "../lib/grokClient";
import type { BranchNode } from "../lib/schema";
import type { XTrend } from "../lib/xClient";

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  ok   ${what}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${what}`, detail !== undefined ? `\n       got: ${JSON.stringify(detail)}` : "");
  }
}

// The real trend from the board that shipped the bug.
const TRENDS: XTrend[] = [
  {
    name: "OpenAI and Anthropic Staff Exchange Over Account Suspension Mix-Up",
    postCount: 18200,
    category: "Technology",
  },
  { name: "Fed holds rates", postCount: 5700 },
];

console.log("\ntrend roots carry their provenance");
const board = buildBoardFromTrends(TRENDS, { date: "2026-08-08", label: "Your day on X", limit: 2 });
const roots = board.root_ids.map((id) => board.nodes[id]);

check("every trend root is grounded on arrival", roots.every(isGrounded));
check("provenance names X's trend service", roots.every((r) => r.origin?.kind === "x_trend"));
check("X's own post volume survives", roots[0].origin?.postCount === 18200, roots[0].origin);
check(
  "the label is the trend verbatim, not a paraphrase",
  roots.every((r) => r.origin?.label === r.title),
);
check(
  "provenance is NOT smuggled in as a citation",
  roots.every((r) => r.source_post_ids.length === 0 && !r.source_urls_meta?.length),
);
check(
  "and NOT as a link we cannot stand behind",
  roots.every((r) => !("url" in (r.origin ?? {}))),
  roots[0].origin,
);

console.log("\nprovenance does not satisfy the grounding a claim needs");
// A trend root still has to go and find posts — origin grounds the headline
// only. rollUpCitations must still fire, or the whole retrieval path would
// quietly become optional the moment origin was added.
const child = { source_post_ids: ["p1", "p2", "p3", "p4"] } as BranchNode;
const rolled = rollUpCitations(roots[0], [child]);
check("a trend root still adopts its children's posts", rolled.source_post_ids.length === 3, rolled.source_post_ids);
check("and keeps its provenance alongside them", rolled.origin?.kind === "x_trend");

console.log("\nthe fallback query is blunt enough to actually return posts");
const relaxed = relaxedQuery(TRENDS[0].name);
check("ORs terms rather than ANDing a whole headline", relaxed.includes(" OR "), relaxed);
check("keeps the proper nouns that survive a rewording", /OpenAI/.test(relaxed) && /Anthropic/.test(relaxed), relaxed);
check("drops the stopwords that carry no signal", !/\bOver\b/.test(relaxed) && !/\band\b/.test(relaxed), relaxed);
check("drops lang: — the story is the story in any language", !relaxed.includes("lang:"), relaxed);
check("still excludes retweets", relaxed.includes("-is:retweet"), relaxed);
check("no wildcard — X 400s on '*' anywhere in a term", !relaxed.includes("*"), relaxed);

// A headline with no capitalised terms must still produce something searchable.
const lower = relaxedQuery("the markets are down again today after the news");
check("a headline with no proper nouns still yields terms", lower.includes(" OR "), lower);
// Degenerate input must not produce a query that means "everything".
const empty = relaxedQuery("a of the");
check("an unusable headline falls back rather than matching all of X", empty.length > "-is:retweet".length, empty);

console.log(
  failures ? `\n${failures} check(s) FAILED\n` : "\nall checks passed\n",
);
process.exit(failures ? 1 : 0);
