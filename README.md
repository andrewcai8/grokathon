# Grok Branches

A zoomable common-knowledge surface over your day on X. Grok structures, X grounds, you navigate in space.

Product doc: [`GROK-BRANCHES.md`](./GROK-BRANCHES.md).

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

## How it fits together

```
X home timeline ──┐
                  ├─> Grok cluster ──> roots ──> expand(fork) ──> children
Grok x_search ────┘        │                          │
                           └──── every claim carries source_post_ids ────> PostChip
```

- `lib/layout.ts` — column index = generality, vertical order = priority. The
  "priority × specificity plane" is not a second view; it's this layout zoomed out.
- `lib/lod.ts` — semantic zoom. Titles legible at every scale, body text ramps
  between `#c9c9c9` texture and `#3d3d3d` prose.
- `lib/grokClient.ts` — structured outputs via `response_format.json_schema`.
  Grok invents meaning; `lib/boardBuilder.ts` assigns identity and wiring, and
  drops any citation that isn't a real post in the corpus.
- `lib/snapshot.ts` — every successful live read is written to `.snapshots/latest.json`
  and replayed through the identical code path if the network dies mid-demo.

## Seeding

| URL | Source |
|---|---|
| `/api/seed` | snapshot if one exists, else live |
| `/api/seed?live=1` | force a fresh X home-timeline read |
| `/api/seed?q=<query>` | reseed from X recent search |
| `/api/seed?snapshot=<name>` | replay a specific snapshot |

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
