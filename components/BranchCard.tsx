"use client";

import { memo, useEffect, useRef } from "react";
import type { PositionedCard } from "@/lib/layout";
import type { Board, Fork, XPost } from "@/lib/schema";
import { isContestable, isGrounded } from "@/lib/evidence";
import { cardMedia, readMediaUrls } from "@/lib/media";
import { EPISTEMIC_LABEL, FORK_LABEL, reportHeight } from "@/lib/store";
import { postedAt, stamp } from "@/lib/time";
import { CardMedia } from "./CardMedia";
import { OptionImage } from "./OptionImage";
import { MoreCitations, PostChip } from "./PostChip";
import { compact } from "./PostPopover";
import { SourceChip } from "./SourceChip";

/**
 * Colour is the epistemic channel and nothing else. On a black board the only
 * saturated pixels mean "this is contested" or "this is flagged" — so status
 * reads from across the room without a legend.
 */
const EPISTEMIC_TONE: Record<string, string> = {
  widely_shared: "var(--gb-dim)",
  contested: "var(--gb-warn)",
  note_flagged: "var(--gb-flag)",
  thin_evidence: "var(--gb-faint)",
  projection: "var(--gb-proj)",
};

/**
 * One chip per ACCOUNT, not per post.
 *
 * "widely_shared" is a claim about corroboration ACROSS accounts, so ten posts
 * from one handle must never render like ten sources — that's the exact
 * inflation the epistemic layer exists to prevent. Ordered by reach so the cap
 * drops the long tail rather than whoever happened to be cited first.
 */
function distinctAccounts(posts: XPost[]) {
  const byAccount = new Map<string, XPost[]>();
  for (const p of posts) {
    const key = p.author.handle.toLowerCase();
    const hit = byAccount.get(key);
    if (hit) hit.push(p);
    else byAccount.set(key, [p]);
  }
  // Each group keeps ALL of the account's posts, best-performing first: that
  // one is the chip's link target, and the rest are what the panel opens onto.
  // Collapsing them to a count here is what made `×3` a dead end.
  return [...byAccount.values()]
    .map((ps) => [...ps].sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0)))
    .sort((a, b) => (b[0].metrics?.likes ?? 0) - (a[0].metrics?.likes ?? 0));
}

/** Enough to read corroboration at a glance; past this it's just wallpaper. */
const SOURCE_CAP = 6;
/**
 * Web sources share the citation row with the post chips, and a card carrying
 * five accounts AND six outlets is a card that's mostly footer. Three outlets
 * already says "this was reported, not just posted", which is the whole job.
 */
const WEB_CAP = 3;

interface Props {
  card: PositionedCard;
  board: Board;
  pending: boolean;
  error?: string;
  selected: boolean;
  /** an ancestor of (or is) the hovered/selected node */
  onPath: boolean;
  onToggle: (id: string) => void;
  onHover: (id: string | null) => void;
  onFork: (id: string, fork: Fork) => void;
}

/** Expand is not only "more detail" (doc §5.1). These are the beats worth demoing. */
const QUICK_FORKS: { fork: Fork; label: string }[] = [
  { fork: "replies", label: "Replies" },
  { fork: "counter", label: "Counters" },
  { fork: "primary_only", label: "Primary" },
  { fork: "falsifiers", label: "Falsify" },
];

function BranchCardInner({
  card,
  board,
  pending,
  error,
  selected,
  onPath,
  onToggle,
  onHover,
  onFork,
}: Props) {
  const n = card.node;
  const posts = n.source_post_ids.map((id) => board.posts[id]).filter(Boolean);
  const sources = distinctAccounts(posts);
  const shown = sources.slice(0, SOURCE_CAP);
  const innerRef = useRef<HTMLDivElement>(null);

  /**
   * What KIND of thing this card is — the one branch in the whole component.
   *
   * A claim is true or false, so it earns citations and an epistemic status. An
   * option is a choice: it has attributes and a price, "contested" is a
   * category error, and a post chip is the wrong rendering because you want to
   * see the thing rather than who said it.
   */
  const isOption = !isContestable(board.kind);
  /**
   * A card the user wrote the title of.
   *
   * Minted client-side when they ask (store.addQuestion), so its title is the
   * question verbatim and its body is Grok's direct answer. Everything about it
   * that differs from a claim follows from that: it asserts nothing itself, so
   * it carries no epistemic status and offers no forks of its own — the
   * evidence and the arguing live on its children.
   */
  const isQuestion = n.type === "fork" && n.fork === "ask";
  const webSources = n.source_urls_meta ?? [];
  /**
   * X's trend, when this card is one.
   *
   * Provenance, not a citation: it says where the headline came from, not that
   * anything under it has been evidenced. The two are shown in the same line
   * precisely because they're the same question — what is this card made of —
   * and a trending root that has since rolled up its children's posts honestly
   * reads as both ("trending on X · 4 accounts").
   */
  const trend = n.origin?.kind === "x_trend" ? n.origin : undefined;
  /**
   * When the evidence was posted. Null on an options board (a hatchback wasn't
   * posted at a time) and null when nothing under this card is a confirmed post.
   */
  const posted = isOption ? null : postedAt(posts);
  /**
   * What the card is made of, counted. Empty when it's made of nothing, which
   * is the case `unsourced` below exists to say out loud.
   */
  const provenance = [
    trend
      ? trend.postCount
        ? `trending on X · ${compact(trend.postCount)} posts`
        : "trending on X"
      : null,
    sources.length ? `${sources.length} ${sources.length === 1 ? "account" : "accounts"}` : null,
    webSources.length
      ? `${webSources.length} ${webSources.length === 1 ? "article" : "articles"}`
      : null,
  ].filter((s): s is string => s !== null);
  /**
   * A question is the one card that may honestly cite nothing: it asserts
   * nothing. Its answer and the arguing hang off its children, and those get
   * held to the normal standard.
   */
  const unsourced = !isQuestion && !isGrounded(n);
  /**
   * The pictures behind this card. We have been fetching these on every X call
   * and throwing them away — a quarter of a real timeline carries media, so
   * that was a quarter of what was said going unrendered.
   */
  const media = isOption ? [] : cardMedia(board, n);
  /** a media node IS its picture; every other card merely has one */
  const mediaLeads = n.type === "media";

  /**
   * "Read image" only appears where there is an UNREAD image.
   *
   * Not merely where there's an image: the server strips anything vision has
   * already read anywhere on the board, so a card whose only picture was read
   * from a sibling branch would offer a button that comes back 422 every time.
   * A button that reliably errors is worse than no button. Never on a media
   * node either — that would re-read the frame it was written from.
   */
  const unread = media.some((m) => !readMediaUrls(board).has(m.url));
  const forks =
    unread && !mediaLeads
      ? [{ fork: "media" as Fork, label: "Read image" }, ...QUICK_FORKS]
      : QUICK_FORKS;

  // measure the content, not the card — the card's own height comes FROM this
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => reportHeight(n.id, el.offsetHeight + 32);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n.id]);

  return (
    <div
      className="gb-card absolute left-0 top-0 cursor-pointer select-none px-4 py-4"
      data-expanded={card.expanded ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-onpath={onPath ? "true" : "false"}
      style={{
        transform: `translate3d(${card.x}px, ${card.y}px, 0)`,
        width: card.w,
        height: card.h,
      }}
      onMouseEnter={() => onHover(n.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onToggle(n.id)}
    >
      <div ref={innerRef}>
        {/* the node's own coordinates, stated plainly. depth · generality is the
            board's addressing scheme, so it belongs on the card like a part
            number rather than hidden in a tooltip. */}
        <div
          className="gb-detail gb-label mb-2.5 flex items-center gap-2"
          style={{ color: "var(--gb-faint)" }}
        >
          {/* "fork" is our word for the mechanism, not a kind of thing anyone
              is looking at. A card the user asked for is a question, and saying
              so costs nothing and needs no new node type — the type enum stays
              six entries wide for Grok to choose from, which is the point. */}
          <span>
            {String(card.col).padStart(2, "0")} / {isQuestion ? "question" : n.type}
          </span>
          {/* WHEN, next to WHERE. A date is as much this node's address as its
              column is — on a board seeded on a day, a claim whose newest
              citation is from Tuesday is a different claim from the same
              sentence posted an hour ago, and that was previously readable only
              by hovering the citations one at a time. */}
          {posted ? (
            <span className="tabular-nums" style={{ color: "var(--gb-dim)" }}>
              {stamp(posted)}
            </span>
          ) : null}
          {/* which fork produced this child. we record it, so we show it —
              otherwise a counter-branch is indistinguishable from a deeper one
              once it lands in the same column.

              A question node is the exception: it wasn't produced by a fork,
              it IS one, and the title below is the user's own words rather than
              anything Grok wrote. Saying "Asked" on it would credit the model
              with the question. */}
          {isQuestion ? (
            <span
              className="border px-1 py-[1px]"
              style={{
                borderColor: "var(--gb-live)",
                color: "var(--gb-live)",
                borderRadius: 2,
              }}
            >
              You asked @grok
            </span>
          ) : n.fork ? (
            <span
              className="border px-1 py-[1px]"
              style={{
                borderColor: "var(--gb-line-hi)",
                color: "var(--gb-dim)",
                borderRadius: 2,
              }}
            >
              {FORK_LABEL[n.fork]}
            </span>
          ) : null}
          <span className="h-px flex-1" style={{ background: "var(--gb-line)" }} />
          <span className="tabular-nums">{n.generality.toFixed(2)}</span>
        </div>

        {/* On an options board the picture IS the card — you're choosing
            between things, and seeing them beats reading about them. It sits
            above the title so the column reads as a row of choices. */}
        {isOption ? (
          <OptionImage nodeId={n.id} prompt={n.media?.alt} url={n.media?.url} />
        ) : null}

        {/* A vision node's whole subject is one frame, so the frame is the
            card — same reasoning as an option's picture, one row up from the
            title it explains. */}
        {mediaLeads && media.length ? (
          <div className="mb-3 [&>div]:mt-0">
            <CardMedia items={media} fit={mediaLeads ? "contain" : "cover"} />
          </div>
        ) : null}

        <h3
          className="gb-title text-[17px] leading-[1.3] tracking-[-0.014em]"
          style={{
            color: "var(--gb-text)",
            fontWeight: "var(--title-weight, 600)" as unknown as number,
          }}
        >
          {n.title}
          {n.unread_depth ? (
            <span
              className="ml-1.5 inline-block h-[5px] w-[5px] translate-y-[-2px] rounded-full align-middle"
              style={{
                background: "var(--gb-live)",
                boxShadow: "0 0 8px var(--gb-live)",
              }}
            />
          ) : null}
        </h3>

        {/* On a question card the title is what YOU said and the body is what
            Grok said back, so it gets attributed. Without this the answer reads
            as a description of the question rather than as a reply to it — the
            one card on the board with two voices on it. */}
        {isQuestion && (n.body || pending) ? (
          <div
            className="gb-attribution gb-label mt-3 flex items-center gap-1.5"
            style={{ color: "var(--gb-live)" }}
          >
            <span>@grok</span>
            {n.epistemic === "thin_evidence" ? (
              <span style={{ color: "var(--gb-faint)" }}>· answered without searching</span>
            ) : null}
          </div>
        ) : null}

        {/*
          The wait, drawn where the answer will be.

          This used to be three skeleton cards a column to the right — a preview
          of a column an ask never builds, since the reply IS this card's body.
          Same idea, right address: the lines sit in the paragraph they become,
          and because they're in the flow they reserve its height too, so the
          answer replaces them instead of shoving the band open.
        */}
        {isQuestion && pending && !n.body ? (
          // 8px bar + 13px gap is the 14px answer's own line box (leading 1.55),
          // so five lines of shimmer occupy what five lines of reply will — the
          // reserve the old skeleton column was for, at the address that needs it.
          <div className="mt-2 flex flex-col gap-[13px] pt-[6px]" aria-hidden>
            {[97, 92, 99, 88, 71].map((w, i) => (
              <div
                key={i}
                className="gb-skel-line h-[8px] rounded-[2px]"
                style={{ width: `${w}%`, animationDelay: `${i * 45}ms` }}
              />
            ))}
          </div>
        ) : null}

        {n.body ? (
          <p
            className={`gb-body mt-2 leading-[1.55] tracking-[-0.002em] ${isQuestion ? "text-[14px]" : "text-[13px]"}`}
            // an answer is prose the user asked for and will actually read, so
            // it keeps its paragraphs instead of collapsing into one block
            style={isQuestion ? { whiteSpace: "pre-wrap" } : undefined}
          >
            {n.body}
          </p>
        ) : null}

        {/* Below the body, because on a claim card the picture is evidence for
            what was just said. On a media node it's the other way round and the
            frame leads — see above the title. */}
        {!mediaLeads && media.length ? <CardMedia items={media} fit={mediaLeads ? "contain" : "cover"} /> : null}

        {/* The dimension the children divide this along. Naming it is what
            forces three different directions instead of three samples of one,
            so showing it is how you can tell whether the branching was any
            good — and it makes the next click legible before you make it. */}
        {isOption && n.axis ? (
          <div
            className="gb-attribution gb-label mt-2.5"
            style={{ color: "var(--gb-faint)", fontSize: "10.5px" }}
          >
            ↳ by {n.axis}
          </div>
        ) : null}

        {/* Status gets its own line so the citations get the card's full width.
            They used to share one clipped row, which meant a claim corroborated
            by six accounts displayed exactly like a claim from one — the single
            most important thing the epistemic layer has to distinguish. */}
        {/*
          Attributes are to an option what citations are to a claim: the thing
          that makes it decidable rather than a nice sentence. Laid out as
          aligned rows so three siblings can be read DOWN a column against each
          other — the comparison is the point, and it only works if "Price"
          sits at the same height on all three.
        */}
        {isOption && n.attributes?.length ? (
          <dl
            className="gb-attribution mt-3 border-t pt-2.5"
            style={{ borderColor: "var(--gb-line)" }}
          >
            {n.attributes.map((a) => (
              <div key={a.label} className="flex items-baseline gap-2 py-[3px]">
                <dt
                  className="gb-label shrink-0"
                  style={{ color: "var(--gb-faint)", fontSize: "10.5px" }}
                >
                  {a.label}
                </dt>
                <span
                  className="h-px min-w-2 flex-1 translate-y-[-2px]"
                  style={{ background: "var(--gb-line)" }}
                />
                <dd
                  className="gb-label tabular-nums"
                  style={{
                    color: "var(--gb-text)",
                    fontSize: "11.5px",
                    textTransform: "none",
                  }}
                >
                  {a.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="gb-attribution mt-3.5">
          {/* Where the attributes were read from. No epistemic status: an
              option isn't true or false, and labelling a hatchback "contested"
              is the category error this whole split exists to prevent. */}
          {isOption ? (
            webSources.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {webSources.slice(0, SOURCE_CAP).map((w) => (
                  <SourceChip
                    key={w.url}
                    url={w.url}
                    title={w.title}
                    siteName={w.siteName}
                  />
                ))}
              </div>
            ) : (
              /* An option with no sources is the more dangerous unsourced card,
                 not the less: a price and a range read as facts about a real
                 product, and nobody hovers a spec sheet to check where it came
                 from. Same marker, same reason. */
              <div
                className="gb-label"
                style={{ color: "var(--gb-warn)", fontSize: "10.5px" }}
              >
                no sources
              </div>
            )
          ) : (
            /* The provenance line: what this card is made of, and what the
               board thinks of it.

               It used to render only when Grok had stamped an epistemic status,
               which meant the cards carrying the LEAST information about
               themselves — no status, and often no sources either — were the
               ones that said nothing at all. Exactly backwards. The mix is
               stated whenever there is one, and its absence is stated too. */
            <div className="gb-label" style={{ fontSize: "10.5px" }}>
              {n.epistemic ? (
                <span style={{ color: EPISTEMIC_TONE[n.epistemic] ?? "var(--gb-faint)" }}>
                  {EPISTEMIC_LABEL[n.epistemic]}
                </span>
              ) : null}
              {/* Where it came from, in the counts themselves: "4 accounts" is a
                  card built out of X, "3 articles" is one built out of
                  reporting, and both together is the corroboration the web
                  retrieval was added for. A separate X / WEB tag would say the
                  same thing twice.

                  Account count only — the ×N badges already carry how many
                  posts each one contributed, and spelling both out here wrapped
                  the status line onto two rows. */}
              {provenance.length ? (
                <span style={{ color: "var(--gb-faint)" }}>
                  {n.epistemic ? "  ·  " : null}
                  {provenance.join("  ·  ")}
                </span>
              ) : null}
              {/* The 8% the HUD admits to, said on the card that owes it.
                  Same warn tone as an unverified citation chip because it is
                  the same failure: something on screen that nothing backs. */}
              {unsourced ? (
                <span style={{ color: "var(--gb-warn)" }}>
                  {n.epistemic ? "  ·  " : null}
                  no sources
                </span>
              ) : null}
            </div>
          )}

          {!isOption && (shown.length || webSources.length) ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {shown.map((s) => (
                <PostChip key={s[0].id} posts={s} />
              ))}
              {/* The web sources a news card was actually built from. We
                  retrieve these, hand them to Grok and record them on the node
                  — and until now rendered them only on options boards, so a
                  claim grounded in three articles displayed as if it were
                  grounded in nothing. Everything on a card is grounded in
                  something real we retrieved; that has to be visible or it
                  isn't a claim the board is making. */}
              {webSources.slice(0, WEB_CAP).map((w) => (
                <SourceChip
                  key={w.url}
                  url={w.url}
                  title={w.title}
                  siteName={w.siteName}
                />
              ))}
              {sources.length > shown.length ? (
                <MoreCitations posts={sources.slice(SOURCE_CAP).flat()} />
              ) : null}
            </div>
          ) : null}
        </div>

        {pending ? (
          <div
            className="gb-attribution gb-label mt-3 flex items-center gap-2"
            style={{ color: "var(--gb-dim)" }}
          >
            <span
              className="gb-pulse h-[4px] w-[4px] rounded-full"
              style={{ background: "var(--gb-live)" }}
            />
            {/* An ask doesn't expand, it goes and looks — and it takes longer
                than a fork does because it may search several times. Saying
                which is happening is the difference between waiting and
                wondering whether it broke. */}
            {isQuestion ? "Grok searching X and the web" : "Grok expanding"}
          </div>
        ) : null}

        {error && !pending ? (
          <div
            className="gb-attribution gb-label mt-3 flex items-start gap-2 leading-[1.5]"
            style={{ color: "var(--gb-warn)", letterSpacing: "0.06em" }}
          >
            <span>!</span>
            <span>{error} — click to retry</span>
          </div>
        ) : null}

        {/* The forks are all claim-shaped — replies, counters, primary sources,
            falsifiers. None of them mean anything about a choice, so an options
            board simply doesn't offer them rather than offering dead buttons. */}
        {selected && !pending && !isOption && !isQuestion ? (
          <div className="gb-attribution mt-3 flex flex-wrap gap-1.5">
            {forks.map((f) => (
              <button
                key={f.fork}
                onClick={(e) => {
                  e.stopPropagation();
                  onFork(n.id, f.fork);
                }}
                className="gb-label border px-2 py-[5px] transition-colors"
                style={{
                  borderColor: "var(--gb-line-hi)",
                  color: "var(--gb-dim)",
                  borderRadius: 2,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--gb-text)";
                  e.currentTarget.style.color = "#000";
                  e.currentTarget.style.borderColor = "var(--gb-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--gb-dim)";
                  e.currentTarget.style.borderColor = "var(--gb-line-hi)";
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const BranchCard = memo(BranchCardInner);
