import type { Board, BranchNode, XPost } from "./schema";

/**
 * SYNTHETIC demo data.
 *
 * Handles here are fictional on purpose — we do not put invented words in real
 * people's mouths, even in a fixture. The moment X OAuth is wired, this file
 * stops being used for anything but offline development.
 *
 * Shapes match XPost/BranchNode exactly, so swapping in a live board is a
 * data-source change and nothing else.
 */

const now = "2026-08-08T13:00:00Z";

function post(
  id: string,
  handle: string,
  name: string,
  text: string,
  likes: number,
  reposts: number,
  replies: number,
): XPost {
  return {
    id,
    text,
    author: {
      id: `u_${handle}`,
      handle,
      name,
      avatar_url: undefined,
    },
    created_at: now,
    url: `https://x.com/${handle}/status/${id}`,
    metrics: { likes, reposts, replies },
  };
}

const POSTS: XPost[] = [
  post("1901", "marketpulse_daily", "Market Pulse", "BREAKING: new 25% tariff on imported steel confirmed for Sept 1. Domestic mills up 8% pre-market, autos down 3%.", 12400, 3800, 940),
  post("1902", "tradepolicywire", "Trade Policy Wire", "Full text of the steel tariff order is out. Note the carve-out for existing contracts signed before July — that's most of Q3 volume, so near-term impact is smaller than headlines suggest.", 5200, 1900, 410),
  post("1903", "steelworkers_now", "Steelworkers Now", "Twelve thousand jobs in Ohio and Pennsylvania depend on this. Been waiting years for it.", 8900, 2100, 1600),
  post("1904", "econ_skeptic", "Ana R. — econ", "Every steel tariff study from 2018-2024 found the same thing: ~$900k in consumer cost per job saved. This is not a close empirical question.", 15600, 6200, 2800),
  post("1905", "autoparts_supply", "Auto Supply Chain", "Our input costs go up 11% at 25%. We employ 400 people. Nobody asked us.", 3100, 890, 220),
  post("1906", "canadatradedesk", "Canada Trade Desk", "Ottawa signalling retaliatory measures on aluminum within 48h. This escalates.", 6700, 2400, 530),

  post("1910", "fedwatcher", "Fed Watcher", "September cut odds just fell from 78% to 41% on the tariff news. Inflation path repriced hard.", 9800, 3100, 620),
  post("1911", "bondmarketdaily", "Bond Market Daily", "10y up 14bp. The market is telling you it thinks this is inflationary and durable.", 4400, 1200, 180),
  post("1912", "quietquant", "quiet quant", "Careful reading too much into a one-day move on thin August volume.", 2200, 410, 95),

  post("1920", "aiinfradaily", "AI Infra Daily", "Three separate labs shipped sub-100ms inference this week. The latency wall everyone talked about in 2024 is just gone.", 18200, 5600, 1100),
  post("1921", "gpu_economics", "GPU Economics", "Cost per million tokens is down 40x in 24 months. The interesting question is no longer capability, it's what you build when it's free.", 22100, 8900, 1900),
  post("1922", "ml_grumpy", "grumpy ML", "\"Sub-100ms\" is doing a lot of work here. That's first token, not full response, on a cached prefix, on their best hardware.", 11400, 4200, 830),
  post("1923", "devtools_watch", "Devtools Watch", "Every dev tool company is quietly rewriting their roadmap around agents that run for hours instead of seconds.", 7600, 2300, 490),

  post("1930", "citywatch_transit", "City Watch: Transit", "The new line opens Monday. Six years late, 2.4x over budget, and genuinely good.", 5400, 1100, 380),
  post("1931", "urbanistmag", "Urbanist", "Ridership projections were revised down twice during construction. Worth watching whether they hit even the lowered number.", 1900, 520, 140),

  post("1940", "sportsdesk_live", "Sports Desk", "Unbelievable finish. Down 17 at the half.", 34000, 9200, 4100),
  post("1941", "statsnerd_hoops", "Stats Nerd", "That was a 0.4% win probability at halftime. Fourth time it's happened in the last decade.", 12800, 5100, 620),
];

export const FIXTURE_POSTS: Record<string, XPost> = Object.fromEntries(
  POSTS.map((p) => [p.id, p]),
);

function node(n: Partial<BranchNode> & Pick<BranchNode, "id" | "type" | "title">): BranchNode {
  return {
    body: "",
    parent_id: null,
    children_ids: [],
    priority: 0.5,
    generality: 0.5,
    depth: 0,
    source_post_ids: [],
    has_children: false,
    created_at: now,
    updated_at: now,
    ...n,
  };
}

const NODES: BranchNode[] = [
  // ---- depth 0: the day's topics, ordered by priority ----
  node({
    id: "t_tariffs",
    type: "topic",
    title: "Steel tariffs land, markets reprice",
    body: "A confirmed 25% tariff on imported steel effective September 1 dominated the morning. Domestic producers rallied, downstream manufacturers sold off, and Canada signalled retaliation within 48 hours. The economics are contested along familiar lines.",
    priority: 0.95,
    generality: 1.0,
    depth: 0,
    source_post_ids: ["1901", "1902", "1906"],
    has_children: true,
    children_ids: ["s_whatchanged", "s_marketreaction", "s_whobenefits"],
    unread_depth: true,
    heat: 0.9,
    epistemic: "widely_shared",
  }),
  node({
    id: "t_inference",
    type: "topic",
    title: "The latency wall quietly fell",
    body: "Three labs shipped sub-100ms inference in a week, and cost per million tokens is down roughly 40x in two years. The conversation on your timeline shifted from whether models can do a thing to what you build once doing it is nearly free.",
    priority: 0.82,
    generality: 1.0,
    depth: 0,
    source_post_ids: ["1920", "1921", "1923"],
    has_children: true,
    children_ids: ["s_latency", "s_agents"],
    unread_depth: true,
    heat: 0.75,
    epistemic: "contested",
  }),
  node({
    id: "t_transit",
    type: "topic",
    title: "Transit line opens, six years late",
    body: "Opening Monday at 2.4x the original budget. Local reaction is warm; the open question is ridership against projections that were revised down twice during construction.",
    priority: 0.44,
    generality: 1.0,
    depth: 0,
    source_post_ids: ["1930", "1931"],
    has_children: true,
    children_ids: ["s_ridership"],
    heat: 0.3,
    epistemic: "widely_shared",
  }),
  node({
    id: "t_sports",
    type: "topic",
    title: "17-point comeback",
    body: "A 0.4% win-probability halftime turned into the fourth such comeback in a decade. Highest raw engagement on your timeline today by a wide margin.",
    priority: 0.31,
    generality: 1.0,
    depth: 0,
    source_post_ids: ["1940", "1941"],
    has_children: false,
    heat: 0.95,
    epistemic: "widely_shared",
  }),

  // ---- depth 1: stories under tariffs ----
  node({
    id: "s_whatchanged",
    type: "story",
    title: "What actually changed",
    body: "A 25% duty on imported steel takes effect September 1. Contracts signed before July are carved out, which covers most of Q3 volume — so the near-term trade impact is materially smaller than the headline rate implies.",
    parent_id: "t_tariffs",
    priority: 0.9,
    generality: 0.7,
    depth: 1,
    source_post_ids: ["1901", "1902"],
    has_children: true,
    children_ids: ["c_25pct", "c_carveout"],
    epistemic: "widely_shared",
  }),
  node({
    id: "s_marketreaction",
    type: "story",
    title: "Rates repriced harder than equities",
    body: "September rate-cut odds fell from 78% to 41% and the 10-year moved 14bp. The bond move is the more informative one: it reads as a bet that this is inflationary and durable rather than a one-quarter shock.",
    parent_id: "t_tariffs",
    priority: 0.71,
    generality: 0.7,
    depth: 1,
    source_post_ids: ["1910", "1911", "1912"],
    has_children: true,
    children_ids: ["c_cutodds", "c_thinvolume"],
    epistemic: "contested",
  }),
  node({
    id: "s_whobenefits",
    type: "story",
    title: "Who gains, who pays",
    body: "Domestic mills and their workforce gain directly. Downstream manufacturers — auto parts in particular — absorb an 11% input cost increase. This split is the entire argument.",
    parent_id: "t_tariffs",
    priority: 0.58,
    generality: 0.7,
    depth: 1,
    source_post_ids: ["1903", "1905"],
    has_children: true,
    children_ids: ["c_jobscost", "c_downstream"],
    epistemic: "contested",
  }),

  // ---- depth 2: claims ----
  node({
    id: "c_25pct",
    type: "claim",
    title: "25% duty, effective September 1",
    body: "The rate and date are confirmed in the published order and consistent across independent accounts on the timeline.",
    parent_id: "s_whatchanged",
    priority: 0.94,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1901", "1902"],
    has_children: false,
    epistemic: "widely_shared",
  }),
  node({
    id: "c_carveout",
    type: "claim",
    title: "Pre-July contracts are exempt",
    body: "One account reports the carve-out covers most Q3 volume. That volume estimate is a single-source read, not a published figure.",
    parent_id: "s_whatchanged",
    priority: 0.66,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1902"],
    has_children: false,
    epistemic: "thin_evidence",
  }),
  node({
    id: "c_cutodds",
    type: "claim",
    title: "September cut odds fell 78% → 41%",
    body: "A large single-day repricing attributed directly to the tariff news.",
    parent_id: "s_marketreaction",
    priority: 0.8,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1910", "1911"],
    has_children: false,
    epistemic: "widely_shared",
  }),
  node({
    id: "c_thinvolume",
    type: "claim",
    title: "The move may be an August volume artifact",
    body: "Direct pushback on reading signal into a one-day move on thin summer volume. Minority position on the timeline but from a quantitatively careful account.",
    parent_id: "s_marketreaction",
    priority: 0.42,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1912"],
    has_children: false,
    epistemic: "contested",
    fork: "counter",
  }),
  node({
    id: "c_jobscost",
    type: "claim",
    title: "~$900k consumer cost per job saved",
    body: "Cited as the consistent finding of 2018–2024 tariff studies. Presented as settled empirics; no counter-citation appeared on the timeline today.",
    parent_id: "s_whobenefits",
    priority: 0.77,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1904"],
    has_children: false,
    epistemic: "contested",
  }),
  node({
    id: "c_downstream",
    type: "claim",
    title: "11% input cost increase downstream",
    body: "First-hand from a supplier with 400 employees. One firm's number, not a sector estimate.",
    parent_id: "s_whobenefits",
    priority: 0.55,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1905"],
    has_children: false,
    epistemic: "thin_evidence",
  }),

  // ---- depth 1: stories under inference ----
  node({
    id: "s_latency",
    type: "story",
    title: "Sub-100ms, with caveats",
    body: "Three labs shipped it in a week. The pushback is that the number describes first-token latency on a cached prefix on best-case hardware — real end-to-end response is a different measurement.",
    parent_id: "t_inference",
    priority: 0.85,
    generality: 0.7,
    depth: 1,
    source_post_ids: ["1920", "1922"],
    has_children: true,
    children_ids: ["c_firsttoken"],
    epistemic: "contested",
  }),
  node({
    id: "s_agents",
    type: "story",
    title: "Roadmaps are being rewritten around long-running agents",
    body: "With cost per million tokens down ~40x, the design constraint moves from per-call economics to what an agent can do given hours instead of seconds.",
    parent_id: "t_inference",
    priority: 0.63,
    generality: 0.7,
    depth: 1,
    source_post_ids: ["1921", "1923"],
    has_children: false,
    epistemic: "projection",
  }),
  node({
    id: "c_firsttoken",
    type: "claim",
    title: "The benchmark measures first token, not full response",
    body: "Specific methodological objection: cached prefix, best hardware, time-to-first-token. If correct it substantially narrows the claim.",
    parent_id: "s_latency",
    priority: 0.72,
    generality: 0.3,
    depth: 2,
    source_post_ids: ["1922"],
    has_children: false,
    epistemic: "contested",
    fork: "counter",
  }),

  // ---- depth 1: transit ----
  node({
    id: "s_ridership",
    type: "story",
    title: "Projections were revised down twice",
    body: "The relevant test is whether opening ridership clears even the twice-lowered projection. No data until the line actually runs.",
    parent_id: "t_transit",
    priority: 0.4,
    generality: 0.7,
    depth: 1,
    source_post_ids: ["1931"],
    has_children: false,
    epistemic: "thin_evidence",
  }),
];

export const FIXTURE_BOARD: Board = {
  date: "2026-08-08",
  seed: { mode: "my_day", label: "Your day on X", snapshot: true },
  nodes: Object.fromEntries(NODES.map((n) => [n.id, n])),
  root_ids: ["t_tariffs", "t_inference", "t_transit", "t_sports"],
  posts: FIXTURE_POSTS,
};
