# Grok Branches

**A multimodal, zoomable common-knowledge surface over your day on X**

| | |
|---|---|
| **Status** | Concept / Grokathon pitch |
| **Inspired by** | [Common Knowledge — Branches](https://www.commonknowled.ge/experiments/branches) (nested briefings, semantic zoom, priority × specificity layout) |
| **Platform** | xAI Grok + X APIs — **you connect your own X account** |
| **One-liner** | Your X firehose, reorganized as a nested knowledge tree you can zoom, expand, argue with, and export — grounded in real posts, not anonymous “sources.” |

---

## 0. North star: the demo

**This is a hackathon. The deliverable is 75 seconds of screen that makes a room lean forward.** Not architecture, not coverage, not a roadmap. Every decision below is subordinate to that.

The three things that actually land, in order:

1. **The zoom.** Zoomed out it's a map of bold headlines over gray text-texture; you push in and prose *resolves* out of the noise. It's continuous, it's fast, it's unlike anything else on stage. This is the whole demo. If only one thing is polished, it's this.
2. **"That's my real feed, from this morning."** Personal beats impressive. A judge recognizing an account they follow does more than any feature.
3. **Expand blooming a new column** with real post chips underneath. Structure appearing on demand, grounded in real posts.

Everything else is scaffolding for those three.

**Rules that follow from this:**

- **Motion quality > feature count.** A janky sixth feature loses to a buttery third one. Budget real hours for easing curves and transition timing — that's product work here, not polish.
- **Never open empty.** Board is pre-warmed and cached before the demo starts. Cold start is invisible.
- **Never open on a spinner.** Any load over ~400ms happens behind a card that's already on screen.
- **Rehearse the exact path.** Pre-expand and cache every node the demo touches. The demo path is a *route*, not an exploration.
- **One wow modality, fully working.** Three half-wired ones read as broken.
- **If it doesn't appear on screen in 75 seconds, it does not get built.**

## 1. Problem

### What’s broken today

| Surface | Failure mode |
|---|---|
| **X feed** | Chronological / algorithmic noise. No structure. Hard to see *how a story branches*. |
| **Chat with an LLM** | Linear. Loses the map. “Explain the tariffs fight” becomes a wall of prose with weak grounding. |
| **News apps / digests** | Editorial, static, not *your* graph. Citations are opaque. |
| **Mind maps / whiteboards** | Manual. Don’t live-update from the town square. |

People don’t lack information. They lack **orientation**: what’s the story, what’s contested, what’s primary, and how deep should I go?

### Opportunity

X is already a **branching graph** (post → replies → quotes → RTs → Notes). Feeds hide that. Grok can *read* that graph and *write* middle layers (summaries, claims, clusters) while **posts remain the ground truth**.

Common Knowledge’s Branches experiment showed the right UI primitive:

- Nested briefing cards (not infinite sticky chaos)
- Expand-to-the-right for depth
- **Semantic zoom** — zoom means *deeper meaning*, parent fades into peripheral context
- Optional **2D layout**: general ↔ specific, high priority ↔ low priority

This project ports that primitive onto **X + Grok multimodality**.

---

## 2. Product thesis

> **Grok Branches is a sentient surface for common knowledge on X.**
>
> Seed from the user’s trending / following / firehose. Cluster into a nested tree. Navigate with semantic zoom. Expand one level at a time. Ground every claim in real posts. Use multimodality as *node types and actions*, not side features. Export structure back to X.

### Non-goals (v0)

- Full freeform infinite whiteboard with arbitrary sticky notes
- Perfect global knowledge graph of all of X
- Multiplayer realtime collaboration (nice later)
- Replacing X’s feed entirely
- Unlabeled speculative “facts” without post citations

---

## 3. Core experience

### 3.1 Seed (cold start)

The product should almost never open empty.

| Mode | Source | When |
|---|---|---|
| **My day (default)** | User’s home / following firehose, recent posts | Open app |
| **Trending** | Global or in-network trending topics | Explicit toggle |
| **Topic / search** | Keyword, hashtag, semantic query | Reseed |
| **Single post** | URL or post ID becomes temporary root | Deep dive |
| **Handle** | `@user` as root; their posts + quote ecosystem | Profile-as-story |

**Recommendation:** default = **my day**, every card can **“Focus as root”** (recenter zoom on that subtree).

**You connect your own X account.** The first screen is *sign in with X* → we read your actual home timeline. This is decided, not a hedge (see §18). A canned demo corpus makes the whole thing collapse into “generic RSS with a nice canvas” — the personal seed is the product. Fallback for API flakiness is a **cached snapshot of a real authed board**, replayed through the identical code path (§16), not a fabricated corpus.

### 3.2 Structure

```
X posts (seed corpus)
        ↓
Grok: cluster + rank + short cards
        ↓
Root topics  ←→  TOC / left rail
        ↓ expand / semantic zoom (one level)
Story cards (summary + key posts)
        ↓ expand
Claims / people / media / counters
        ↓ expand
Primary posts, threads, Notes, generated maps
```

### 3.3 Interaction model (observed from Branches references)

Taken frame-by-frame from `briefing.gif`, `SemanticZoom.mov`, and `branches-diagram.png` (§19). These are mechanics to copy exactly, not a vibe to approximate.

**One layout, not two**

Expanding a card opens a **new column to the right**. The parent column keeps all its siblings in place; children appear as a fresh column, vertically anchored near the parent card. Nothing is replaced and nothing drills down in place.

Consequence: the nested view **already is** the priority × specificity plane.

| Screen axis | Encodes | Field |
|---|---|---|
| **X — column index, left → right** | more general → more specific | `generality` / `depth` |
| **Y — order within a column, top → bottom** | higher → lower priority | `priority` |

`branches-diagram.png` is literally this same column stack with axis labels drawn over it. So **no Tree/Plane toggle in v0** — the “priority plane” is just a zoomed-out camera on the one canvas. (P2 can add a free re-layout that drops column snapping.)

**Connections are containers, not edges**

Columns sit inside nested rounded-rectangle tracks; a child track branches off its parent with a large corner radius. No arrows, no drawn edges, no lines — the shape of the gray track *is* the parent link.

**Click to expand (ghost column)**

Hovering a card renders a faded preview one column to its right: the card’s title in gray, plus the literal label “Click to expand.” That is the entire affordance — no buttons, no chevrons, no hover chrome.

**Semantic zoom = text level-of-detail**

The important correction to earlier drafts: the parent does **not** fade. Zoom is an opacity/legibility ramp on card **body text**, keyed to scale.

- Titles stay legible at **every** zoom level
- Body text fades in as you zoom in, and back to gray texture as you zoom out
- Fully zoomed out → a map of bold headlines over gray “text texture”: orientation at a glance
- Fully zoomed in → one card’s body fully readable
- Ancestors don’t fade; they’re simply clipped by the left viewport edge as you pan right
- Preload the next level so expand feels instant

This is both truer to the reference and far cheaper to build than a fade-the-ancestor system — and it’s the beat that produces the “whoa.”

**Live table of contents**

The left rail is not a static list of roots. It **grows and indents as you expand**, mirroring the currently open subtree. It is orientation, back-button, and jump target in one.

**Small things that matter**

- Green indicator dot sits **inline, immediately after the headline** — unread depth / new posts landed
- The root of a board is a **date** (“February 10”), not a topic
- Cards have no borders: white surfaces floating on light gray
- Reference uses numeric `[1][3]` footnotes; **we use post chips / author avatars instead** — X-native, and the citation is the product

### 3.4 Expand contract (critical)

Expand must return **structured children**, never a chat dump.

```json
{
  "parent_id": "topic_tariffs",
  "children": [
    {
      "id": "claim_25pct",
      "type": "claim",
      "title": "25% tariff on steel imports",
      "body": "Trump stated steel entering the U.S. would face a 25% tariff…",
      "priority": 0.92,
      "generality": 0.4,
      "source_post_ids": ["1842…", "1843…"],
      "has_children": true,
      "epistemic": "contested"
    }
  ]
}
```

**Hard rules**

- Cap children per expand (e.g. 3–7)
- Every claim/story links to **post IDs** when evidence exists
- Label thin evidence and projections explicitly
- Collapse is first-class; spaghetti is a product bug

---

## 4. Node model

### 4.1 Node types

| Type | Role | Expand produces |
|---|---|---|
| **Topic** | Cluster root (“Tariffs”, “DOGE legal fights”) | Stories, key people |
| **Story** | Coherent narrative unit + short Grok brief | Claims, angles, media |
| **Claim** | Atomic assertion | Evidence posts, counters |
| **Post** | Real X post (embed / quote / link) | Thread tree, quotes, related |
| **Person** | Account / public figure node | Their posts, alliances, attacks |
| **Media** | Image / video from X | Vision interpretation, similar media |
| **Fork** | Intentional branch type (see §5) | Filtered children |
| **Generated** | Map, chart, briefing image, video export | (usually leaf) |
| **Voice region** | Not a permanent node; action on a selection | Spoken brief / nav commands |

### 4.2 Node schema (v0)

```ts
type NodeType =
  | "topic"
  | "story"
  | "claim"
  | "post"
  | "person"
  | "media"
  | "fork"
  | "generated";

type EpistemicStatus =
  | "widely_shared"
  | "contested"
  | "note_flagged"
  | "thin_evidence"
  | "projection"; // clearly labeled future/sim

interface BranchNode {
  id: string;
  type: NodeType;
  title: string;
  body?: string;              // short; not an essay
  parent_id: string | null;
  children_ids: string[];

  // layout hints
  priority: number;           // 0–1, for Y-axis / ranking
  generality: number;         // 0–1, for X-axis (1 = general)
  depth: number;

  // grounding
  source_post_ids: string[];
  source_urls?: string[];
  account_ids?: string[];

  // state
  has_children: boolean;
  unread_depth?: boolean;     // green dots
  heat?: number;              // velocity / engagement
  epistemic?: EpistemicStatus;

  // multimodal
  media?: {
    kind: "image" | "video" | "generated_image" | "generated_video";
    url?: string;
    alt?: string;
    vision_summary?: string;
  };

  created_at: string;
  updated_at: string;
}
```

### 4.3 Graph, not only tree

UI presents a tree/zoom, but storage can allow **multi-parent** later (same claim under two topics). v0 can be a strict tree for simplicity.

---

## 5. Forks and epistemic layer

### 5.1 Expand is not only “more detail”

| Fork | Intent |
|---|---|
| **Deeper** | More specific claims / details |
| **Counter** | Opposing frames and dissent posts |
| **Primary only** | Strip pundits; prefer OP, officials, docs |
| **People** | Who is driving / amplifying |
| **Media** | Images, video, memes in this story |
| **Markets / policy / culture** | Lens filters |
| **Satire** | Only jokes *or* downrank jokes |
| **What would change my mind?** | Falsifiers / missing evidence |

### 5.2 Epistemic honesty (Grok brand)

Per claim node, prefer visible status:

- **Evidence** — supporting posts
- **Counter** — dissenting posts
- **Notes** — Community Notes as edges when available
- **Status** — widely shared / contested / thin / projection

This is a core differentiator vs “AI news that sounds sure.”

---

## 6. Multimodality (first-class, not bolted on)

### 6.1 Principle

| Modality | Role |
|---|---|
| **Text / reasoning** | Structure the tree; write middle layers |
| **X posts** | Ground truth leaves |
| **Vision** | Interpret images/memes/charts on the canvas |
| **Image generation** | Explainer maps, one-pagers, argument diagrams |
| **Voice** | Navigate and brief a *region* of the canvas |
| **Video** | Export evolution of a topic; demo polish |

**Same story, multiple skins:** one node ID can render as text card, visual map, voice brief, or post strip without losing place.

### 6.2 Multimodal actions

| Action | Trigger | Output |
|---|---|---|
| **Brief this** | Voice or button on card/region | Spoken summary of subtree |
| **What’s this claiming?** | Select media node | Vision → claim children |
| **Map this fight** | Story or claim cluster | Generated argument map image |
| **Show counters** | Voice / fork | Counter branch |
| **Animate the day** | Topic root | Short video of tree growth (stretch) |
| **Post this branch** | Export | Compose back to X (text + image) |

### 6.3 Multimodal demo beats (60–90s)

1. Open → **my day clustered** (no empty state)
2. Semantic zoom into a hot topic
3. Expand claim → **real posts** as leaves
4. Select a meme → vision: “this is arguing X”
5. Voice: “show counters only”
6. Generate **argument map** → export-ready image
7. (Bonus) Live pulse: new post attaches under a branch

---

## 7. Live graph behavior

Not a once-a-day PDF.

| Behavior | Description |
|---|---|
| **Attach** | New matching posts land under existing topics |
| **Heat** | Edge/node size or color by velocity |
| **Unread depth** | Green dots on ancestors |
| **Time scrub** (P2) | Tree as of 10:00 vs now |
| **Propose branches** | Grok suggests “3 new children under Tariffs”; user accepts/rejects |

Canvas is slightly **agentic**: Grok helps keep the board tidy; user steers with focus, forks, mute, pin.

---

## 8. Personalization and memory

| Signal | Effect |
|---|---|
| Follow graph + engagement | Seed ranking, priority Y-axis |
| Mute / prune patterns | “No sports,” “primary only default” |
| Pins | Sticky roots across sessions |
| Past boards | Clustering context for “my day” |

v0 can ignore durable memory; P2 makes day-2 feel smart.

---

## 9. Export and closed loop with X

The product should **consume and produce**:

| Export | Format |
|---|---|
| Single card | Text ready to post |
| Subtree | Thread outline or long post |
| Argument map | Generated image |
| Voice brief | Audio clip (stretch) |
| Board | Shareable read-only URL (stretch) |

Closed loop pitch: **X → structure with Grok → back to X.**

---

## 10. UI layout (v0)

Columns, not a freeform canvas. Rail is fixed; the surface pans and zooms.

```
┌───────────────┬──────────────────────────────────────────────────────────┐
│ Table of      │   February 10                    ← board root is a date  │
│ Contents      │                                                          │
│               │   ┌ col 0 ────────┐ ┌ col 1 ──────┐ ┌ ghost ─────────┐  │
│ Tariffs       │   │ ▍Tariffs    ● │ │ ▍25% steel  │ │                │  │
│   25% steel   │   │  body text…   │ │  body text… │ │ Click to expand│  │
│   Canada hit  │   │  ▣▣ post chips│ │  ▣▣▣        │ │ Canada hit     │  │
│ Super Bowl    │   ├───────────────┤ ├─────────────┤ └────────────────┘  │
│   Final score │   │ ▍Super Bowl ● │ │ ▍Canada hit │      ↑ hover        │
│ DOGE          │   │  body text…   │ │  body text… │        preview      │
│               │   ├───────────────┤ └─────────────┘                     │
│ (grows as you │   │ ▍DOGE         │                                     │
│  expand)      │   └───────────────┘                                     │
│               │                                                          │
│ ──────────    │   ← general ────────────────────────── specific →        │
│ 🔥 Trending   │   ↑ high priority   ↓ low priority                       │
│ 🔍 Reseed     │                                                          │
│ 🎤 Voice      │   Zoom: body text fades in/out · titles always legible   │
│               │   Actions: Expand · Counter · Map · Brief                │
└───────────────┴──────────────────────────────────────────────────────────┘
```

### Visual language (from references)

- Clean editorial typography; bold title + regular body, generous line height
- Cards have **no borders** — white surfaces floating on light gray
- Nested rounded-rect tracks with a large corner radius carry the parent→child link; no arrows, no edges
- Expand affordance is the ghost column: card title in gray + “Click to expand”
- Semantic zoom is a continuous body-text legibility ramp, not hard page cuts
- Citations as compact post chips / author avatars, never academic footnotes
- Green dot inline right after the headline
- Zoomed out, the board should read as a **headline map over gray text texture**

---

## 11. System architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Sign in     │────▶│  Ingest / normalize│────▶│  Seed corpus    │
│ with X      │     │  posts, users,    │     │  (session)      │
│  ↓ token    │     │  media metadata   │     │  + snapshot ⇄   │
│  X APIs     │     └──────────────────┘     └────────┬────────┘
│  home,      │                                       │
│  search,    │                                       │
│  threads    │                                       │
└─────────────┘                                       ▼
                                          ┌───────────────────────┐
                                          │  Grok API             │
                                          │  · cluster roots      │
                                          │  · expand (JSON)      │
                                          │  · epistemic labels   │
                                          │  · vision on media    │
                                          │  · image gen maps     │
                                          │  · voice brief (opt)  │
                                          └───────────┬───────────┘
                                                      ▼
                                          ┌───────────────────────┐
                                          │  Canvas state         │
                                          │  nodes + layout + UI  │
                                          │  (React / etc.)       │
                                          └───────────────────────┘
```

### 11.1 Suggested API responsibilities

| Component | Responsibility |
|---|---|
| **X: OAuth 2.0 (PKCE)** | Sign in with X; token for the user’s own reads |
| **X: search / recent** | Seed posts for keywords, trends |
| **X: user timeline / home** | Personalized “my day” — the default seed |
| **X: thread fetch** | Expand post nodes into conversation trees |
| **X: user lookup** | Person nodes |
| **Grok: chat + tools** | Cluster, expand JSON, forks, briefs |
| **Grok: vision** | Media interpretation |
| **Grok: image gen** | Argument maps, one-pagers |
| **Grok: voice** | Optional nav + spoken brief |
| **Client** | Semantic zoom, layout, caching, offline of last board |

### 11.2 Expand pipeline

1. User expands node `N`
2. Client sends: node context + relevant seed posts + fork type
3. Grok returns: `children[]` matching schema
4. Client merges into graph, lays out, animates
5. Optionally prefetch children of high-priority kids

### 11.3 Caching

- Cache expand results by `(node_id, fork, corpus_version)`
- Re-open is instant; live attach invalidates softly
- Never re-generate the whole board on every pan

---

## 12. Grok prompt contracts (sketch)

### 12.1 Cluster seed → roots

**Input:** list of posts (id, text, author, metrics, media flags)  
**Output:** 5–12 topic nodes with titles, one-line gists, priority, member post ids  

**Constraints:** no invented facts beyond posts; topics must cover major clusters; leftovers in “Other / Noise” with low priority.

### 12.2 Expand node

**Input:** parent node, fork type, supporting posts, optional user prefs  
**Output:** 3–7 children JSON per schema  

**Constraints:** short bodies; source_post_ids required for claims when evidence exists; set `epistemic`; set `has_children` honestly.

### 12.3 Vision on media

**Input:** image + parent story context  
**Output:** what it depicts, claim if any, suggested child nodes  

### 12.4 Map export

**Input:** subtree nodes + key post excerpts  
**Output:** image-gen prompt or direct generation of a clean argument map (claims left/right, sources as labels)

---

## 13. Build plan (12-hour Grokathon)

Ordered by **what appears on screen in the demo**, not by architectural tidiness (§0).

### Rough clock

| Hours | Focus |
|---|---|
| 0–2 | OAuth working → **snapshot a real board immediately** → build against the snapshot |
| 2–5 | Column surface + expand + live TOC. Ugly is fine; structure must be right |
| 5–8 | **The zoom.** Easing, LOD ramp, transition timing. Budget real hours here |
| 8–10 | One wow modality, fully wired |
| 10–11 | Typography and motion pass — this is where it starts looking expensive |
| 11–12 | Pre-warm the demo board, cache the exact path, rehearse it 5× |

Do not let hours 5–8 get eaten. The zoom *is* the demo.

### P0 — Product exists

| # | Deliverable |
|---|---|
| 1 | **Sign in with X** → seed from real home timeline (+ search fallback) |
| 2 | Grok cluster → 5–8 root topics + summaries |
| 3 | Column surface + **live TOC** (grows/indents on expand) |
| 4 | Expand one level → new column right (structured JSON children) |
| 5 | Semantic zoom = body-text legibility ramp; titles always legible |
| 6 | Post citations as chips on claims |
| 7 | Snapshot the authed board to disk — the demo safety net |

Note: because column index = generality and vertical order = priority, **the priority × specificity plane ships free with #4** — it’s what you see when you zoom out. It is not separate work.

### P1 — Multimodal + Grok personality

| # | Deliverable |
|---|---|
| 8 | **One** wow modality: vision *or* voice *or* map export |
| 9 | Counter / contested fork |
| 10 | Epistemic badges on claims |
| 11 | Ghost “Click to expand” column on hover |

### P2 — Living board

| # | Deliverable |
|---|---|
| 12 | Live attach + inline green unread dots |
| 13 | Heat / velocity styling |
| 14 | Free re-layout of the plane (drop column snapping) |

### P3 — Stretch

| # | Deliverable |
|---|---|
| 15 | Export map image to clipboard / X compose |
| 16 | Time scrub |
| 17 | Durable memory / prefs |
| 18 | Multiplayer board |
| 19 | Video “day in a topic” |

### Ruthless cuts

- Perfect clustering
- Full freeform canvas tools
- Multi-user accounts (OAuth for *you*, not a user system)
- Every modality on every node
- A Tree/Plane toggle — it’s one layout

**Ship spine:** connect X → cluster → column expand + zoom → post citations → one wow modality.

---

## 14. Demo script (judges)

**Time:** ~75 seconds  

1. **It’s yours** — “this is my actual X account, this morning.” Open on an already-built board.  
2. **Orientation** — zoomed out: headline map over gray text texture. 6 topics, ranked. Point at the live TOC.  
3. **Zoom** — zoom in; body text resolves into readable prose. Titles never blurred.  
4. **Expand** — click a card; a new column blooms to the right. Ghost preview showed it coming.  
5. **Grounding** — expand a claim; real post chips, real authors.  
6. **Multimodal beat** — vision on a meme *or* voice “show counters” *or* generate map.  
7. **Close** — “Common knowledge as a surface: Grok structures, X grounds, you navigate in space.”  

Backup if APIs flake: snapshotted authed board + live expand on one topic only. Say out loud that it’s a snapshot — don’t pretend it’s live.

---

## 15. Positioning

### Pitch lines

- **Short:** Semantic zoom over your X.  
- **Medium:** Grok turns the firehose into a nested knowledge tree — posts and media ground it, voice navigates it, maps explain it, the graph updates as the story moves.  
- **Contrast:** Not another chat. Not another feed. A **zoomable common-knowledge surface** for the town square.

### Why this is on-theme for xAI / Grokathon

- Uses **X + Grok** in a load-bearing way (not ChatGPT with a pretty shell)
- Multimodal is structural
- Matches Grok’s personality: maximally truth-seeking, show dissent, cite primary
- Echoes Common Knowledge’s “sentient surface” without being a clone of news wire UX

### Competitive frame

| Alternative | Grok Branches |
|---|---|
| Grok chat | Spatial memory + progressive disclosure |
| X feed | Structure + depth control |
| Grokipedia | Live discourse + personal seed |
| Generic mind map | Live corpus + multimodal + citations |

---

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Canvas spaghetti | Max children, collapse rules, column snapping |
| Hallucinated facts | Post IDs required; epistemic labels; no silent invention |
| Scope explosion | P0 spine only; one modality wow |
| Clustering quality | Allow reseed + manual “focus as root”; show “Other” |
| Rate limits / API flakiness | **Snapshot of a real authed board**, replayed through the identical code path — not a fabricated corpus |
| OAuth burns the clock | Do it first, snapshot immediately, then build UI against the snapshot |
| Timeline API access gated | Degrade to authed search + following list; still personal, still your account |
| Looks like “mind map + LLM” | Live X + citations + semantic zoom + export loop |

---

## 17. Success metrics (hackathon + product)

### Hackathon (the ones that count)

- Judges understand the product in &lt; 30s of demo
- **Audible reaction on the zoom** — this is the real metric
- Nothing stutters, nothing spins, nothing 404s on stage
- Clear X-native story: obviously could not be generic RSS
- A judge sees an account they recognize in the citations

### Product (later)

- Time-to-first-orientation after open
- Expand depth per session (not just bounce)
- % of claims with ≥1 post citation
- Return rate for “my day” habit
- Export → post conversion (closed loop)

---

## 18. Open decisions

| Decision | Options | Status |
|---|---|---|
| **Auth** | Demo corpus vs real X OAuth | **DECIDED: real X OAuth.** You connect your own account; snapshot the authed board as demo fallback |
| **Tree / plane toggle** | Two views vs one layout | **DECIDED: one layout.** Column = generality, vertical = priority; plane is the zoomed-out camera |
| **Zoom semantics** | Parent fade vs text LOD | **DECIDED: body-text legibility ramp**, titles always legible (matches reference) |
| Default seed | Home vs trending vs hybrid | Hybrid: home timeline + trending rail |
| Layout engine | Custom CSS, React Flow, tldraw-like | Custom columns + CSS transform zoom first |
| Primary wow modality | Vision / voice / map | Map export *or* vision (most visual for judges) |
| Strict tree vs graph | Tree v0 | Tree v0 |
| Branding name | Grok Branches / Common X / ZoomFeed / … | **Grok Branches** for pitch |

### Open risk on the auth decision

Home-timeline read is the gated part of the X API and OAuth eats hackathon hours. Mitigation is sequencing, not hedging: **get OAuth working first**, snapshot a real board the moment it works, then build the surface against the snapshot. If timeline access is unavailable at the event, degrade to authed **search + following list** — still your account, still personal.

---

## 19. References

### Product / UX

- [Common Knowledge — Branches](https://www.commonknowled.ge/experiments/branches) — nested news briefing, expand, infinite canvas of nested items
- Common Knowledge mission — “Sentient Surface”: generative GUI that adapts

**Local captures** (from the Branches page — source of the mechanics in §3.3):

| File | Shows |
|---|---|
| `~/Downloads/briefing.gif` | Expand → new column right; live TOC growing and indenting; ghost “Click to expand”; zoomed-out headline map |
| `~/Downloads/SemanticZoom.mov` | Zoom as **body-text legibility ramp**; titles legible at all scales; ancestors clipped, not faded; inline green dot |
| `~/Downloads/branches-diagram.png` | The same column stack with axes drawn on: general→specific (X), high→low priority (Y); nested rounded-rect tracks |

### Platform

- [xAI / Grok](https://x.ai/) — reasoning, vision, image, voice, video
- [Grokathon](https://x.ai/grokathon) — frontier Grok models + X APIs
- X developer surfaces — search, posts, users, threads (as available to event)

### Adjacent ideas (not copy)

- Canvas browsers / Wikipedia rabbit-hole maps
- GraphRAG / knowledge graphs for grounding
- Grokipedia as static spine + X as live branches (optional stretch narrative)

---

## 20. Appendix A — Example board (illustrative)

**Seed:** User’s morning firehose  

| Priority | Topic | Sample children on expand |
|---|---|---|
| High | Steel & aluminum tariffs | 25% claim → posts; Canada impact; market reaction fork |
| High | Super Bowl LIX | Final score story; presidential attendance claim → posts |
| Med | DOGE legal challenges | Access to payment systems claim; counter filings |
| Low | Misc / noise | Collapsed by default |

**Expand path:** Tariffs → “25% on steel” (claim, contested) → evidence posts + counter posts → “Map this fight” generated image.

---

## 21. Appendix B — Minimal file / module split (implementation)

```
apps/web/
  components/
    TocRail.tsx            # live outline; grows + indents on expand
    ZoomSurface.tsx        # pan/zoom viewport, CSS transform
    ColumnStack.tsx        # depth columns + nested rounded tracks
    BranchCard.tsx         # title always legible, body opacity ~ zoom
    GhostColumn.tsx        # hover "Click to expand" preview
    PostChip.tsx           # citation chip: avatar + handle + link
  state/
    boardStore.ts          # nodes, focus, expanded set, zoom level
  lib/
    xAuth.ts               # OAuth 2.0 PKCE, token storage
    xClient.ts             # home timeline, search, thread fetch
    grokClient.ts          # cluster, expand, vision, image
    layout.ts              # column index (generality) + y order (priority)
    lod.ts                 # zoom → body-text opacity ramp
    snapshot.ts            # save/load a real authed board (demo path)
    schema.ts              # BranchNode types + zod
server/ (optional)
  routes/
    auth.ts                # OAuth callback
    seed.ts
    expand.ts
    vision.ts
    map.ts
```

No `PriorityPlane.tsx` — the plane is `ColumnStack` at low zoom.

---

## 22. Summary

**Grok Branches** combines:

1. **Branches UX** — nested briefing, expand-to-a-new-column, semantic zoom as text LOD  
2. **One layout** — column = generality, vertical = priority; the “2D plane” is just zoomed out  
3. **Your own X account** — OAuth in, your real home timeline as roots and leaves  
4. **Grok as structure engine** — cluster, expand, epistemic labels  
5. **Multimodality** — vision, voice, generated maps/video as node types and actions  
6. **Live + personal + export** — attach, memory, closed loop back to X  

Build the spine first. Win the demo with orientation + grounding + one multimodal punch. Everything else is depth you earn after the tree works.

---

*Document for Grokathon ideation and implementation. Inspired by Common Knowledge Branches; product direction is X-native and Grok-multimodal.*
