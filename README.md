# Grok Branches

A zoomable common-knowledge surface. Grok structures, the world grounds, you
navigate in space.

## The mission

**Make understanding something feel like moving through it.**

People don't lack information. They lack orientation: what's the story, what's
contested, what's primary, and how deep should I go. Every surface we have gets
that wrong in the same way — a feed is chronological noise with no structure, a
chat is linear and loses the map, a news app is someone else's editorial. All of
them hand you a wall of text and leave the shape of the thing in your head.

But the shape is real, and it's already there. X is a branching graph — post,
replies, quotes, notes. A decision is a tree — a space, divided, then divided
again. Feeds and chat windows flatten both into a scroll. This puts the structure
on the screen and lets you *walk* it.

## The vision

Three commitments, in the order they matter:

**Depth is a place you go, not a wall you read.** Expanding a card blooms a new
column to the right; the parent and its siblings stay put. Column index is
generality, vertical order is priority — so the "priority × specificity plane"
isn't a second view to toggle, it's this one layout zoomed out. Zoom is semantic:
titles stay legible at every scale while body text ramps between grey texture and
readable prose. Zoomed out you get a headline map; zoomed in, one card's argument.

**Nothing on the board is unbacked, and you can always see what backs it.**
Grok writes the middle layers — clusters, claims, options — but never chooses its
own sources. We retrieve; it interprets. A citation that doesn't resolve to
something we actually fetched is dropped, not flagged, so a fabricated source is
unrepresentable rather than caught after the fact. Claims carry an epistemic
status and the posts behind them; when the evidence doesn't settle something, the
board says so instead of sounding sure.

**The paradigm is bigger than news.** A node, N more specific children, a
grounding type — that's the whole primitive, and it doesn't care what the nodes
are about. Point it at your timeline and it's a briefing you can argue with.
Point it at "help me pick a car under $30k" and the same canvas, layout, zoom and
novelty rules become a decision funnel where cards are choices with prices and
pictures. Two board kinds share one engine; the second is the proof the first
wasn't a one-off.

Product doc, pitch and build order: [`GROK-BRANCHES.md`](./GROK-BRANCHES.md).

## Run it

```bash
bun install
cp .env.example .env.local   # fill in your keys
bun run dev
```

Open http://localhost:3000. It works with no keys at all — you get the fixture board so the surface is never empty.

## What to do with the mouse

| Input | Effect |
|---|---|
| Click a card | Expand — children bloom in a new column to the right |
| Click again | Collapse (and everything beneath it) |
| Hover | Ghost preview of where the children will land |
| Scroll / drag | Pan |
| Pinch, or shift+scroll | Zoom — body text fades between texture and prose |
| `-` `=` `0` | Zoom out / in / reset |
| TOC row | Fly to that node |
| Counters / Primary only / Change my mind | Fork — adds a branch alongside what's open |
| `@` while pointing at a card | Ask Grok about it, in the plot the answer lands in |
| `@` pointing at nothing | Ask the board itself (news boards only) |
| "Ask @grok" on a decision card | The same thing, as a button — decision cards have no forks |

## Two kinds of board

One canvas, one layout, one zoom. What differs is what a card MEANS, and
everything follows from that.

| | **What's happening** (`news`) | **Decide** (`options`) |
|---|---|---|
| A card is | a claim — it can be false | a choice — it can't |
| Grounded in | X posts, plus reporting | web pages the attributes were read from |
| Card shows | epistemic status, post chips | attributes, a generated picture |
| Expanding gives you | narrower claims | three options one level more specific |
| Seeded by | your timeline, or a trend | a sentence: "help me pick a car under $30k" |

Asking works on both and answers in the board's own currency. On a news board
the reply cites posts and may hang a claim off the question; on a decision board
it cites pages and may hand back a real, buyable option — attributes lined up
with the card you asked from, so you can read the new thing against the old one
row for row, plus its own picture.

`lib/askAgent.ts` is one agent with a `kind`. It chooses its own retrieval,
because a question's needs aren't knowable in advance: "who's actually paying for
this" wants a search, "what did people say back" wants the replies, "what's the
Toyota equivalent" wants three comparison pages. It can only cite what its own
tools returned, so a fabricated source has nothing to resolve against and is
dropped rather than caught.

## How it fits together

```
X home timeline ──┐
Grok x_search ────┼─> Grok cluster ──> roots ──> expand(fork) ──> children
Exa web search ───┘        │                          │
                           └──── every card carries what it was built from ──┐
                                                                             │
a sentence ──────> Exa ──> Grok divides ──> options ──> expand ──> narrower ─┘
                                                (attributes + generated image)
```

- `lib/layout.ts` — column index = generality, vertical order = priority. The
  "priority × specificity plane" is not a second view; it's this layout zoomed out.
- `lib/lod.ts` — semantic zoom. Titles legible at every scale, body text ramps
  between `#c9c9c9` texture and `#3d3d3d` prose.
- `lib/grokClient.ts` — structured outputs via `response_format.json_schema`.
  Grok invents meaning; `lib/boardBuilder.ts` assigns identity and wiring, and
  drops any citation that isn't a real post in the corpus.
- `lib/optionsExpander.ts` — the decision half. Grok writes the web query and the
  per-option image prompt, so the board generalises to laptops and holidays
  without a list of domains someone remembered to enumerate.
- `lib/askAgent.ts` — the one place Grok picks its own retrieval, in a tool loop
  bounded by a search budget. Every tool hands back things we fetched, so it can
  only cite what really exists.
- `lib/snapshot.ts` — every successful live read is written to `.snapshots/latest.json`
  and replayed through the identical code path if the network dies mid-demo.

## Seeding

| URL | Source |
|---|---|
| `/api/seed` | snapshot if one exists, else live |
| `/api/seed?live=1` | force a fresh X home-timeline read |
| `/api/seed?q=<query>` | reseed from X recent search |
| `/api/seed?snapshot=<name>` | replay a specific snapshot |
| `POST /api/board/options` | start a decision from a sentence — the Decide tab posts here |

Connect your account at `/api/auth/login`.

## Credentials

The first two are Grokathon-provided:

- `XAI_API_KEY` — from console.x.ai. Not the Grok CLI token in `~/.grok/auth.json`.
- `X_CLIENT_ID` / `X_CLIENT_SECRET` — developer.x.com, with
  `http://localhost:3000/api/auth/callback` registered as a callback, and
  prepaid credits on the account.
- `EXA_API_KEY` — exa.ai. The web half of the evidence split: X for what people
  are saying, Exa for what actually happened. A decision board is a 503 without
  it, and a news board loses its article citations.

## Before demoing

1. `bun run dev`, connect X, hit `/api/seed?live=1` once — this writes the snapshot.
2. Walk the exact demo path so every node the demo touches is cached.
3. Leave the browser open on the built board. Never open cold.
