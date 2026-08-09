"use client";

import { coveredGround } from "@/lib/boardBuilder";
import { CARD_W, LEFT_PAD } from "@/lib/layout";
import { useBoard } from "@/lib/store";

/**
 * "More of your day" — the root column, continued.
 *
 * Three roots is what's legible on open, not what exists. In briefing.gif the
 * roots are just a vertical list under the date, so extending it should read as
 * the list carrying on rather than as a new control. It borrows the ghost
 * column's dashed hairline: the same "there is something here you haven't
 * opened yet" language, pointing down instead of right.
 */
export function MoreRootsCard({ y }: { y: number }) {
  const loading = useBoard((s) => s.loadingRoots);
  const exhausted = useBoard((s) => s.rootsExhausted);
  // the affordance is the same on both kinds of board; only what it fetches,
  // and therefore what it should promise, differs
  const isOption = useBoard((s) => s.board?.kind) === "options";

  if (exhausted) return null;

  const load = async () => {
    const s = useBoard.getState();
    if (s.loadingRoots) return;
    const b = s.board;
    if (!b) return;
    s.setLoadingRoots(true);
    try {
      /**
       * Send the board, for the same reason expand sends its node.
       *
       * This used to post `{ count: 3 }` and let the route read its own module
       * memory — but that memory is one slot, and every page load overwrites it
       * with a news board. So a refresh, or a second tab, left the server
       * answering "more directions" on a decision board with three trend
       * headlines: text cards, no attributes, no images. The board on screen is
       * the only thing that knows what this button means, so it travels with
       * the click.
       */
      const covered = coveredGround(b);
      const res = await fetch("/api/roots/more", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          count: 3,
          kind: b.kind,
          question: b.seed.label,
          // the division the roots are points on, so more of them continue it
          // rather than starting a second division on top of the first
          axis: b.axis,
          // titles so the new batch extends this division, attributes so it
          // joins the comparison instead of starting a second one beside it
          roots: b.root_ids
            .map((id) => b.nodes[id])
            .filter(Boolean)
            .map((n) => ({ title: n.title, attributes: n.attributes })),
          covered: {
            titles: covered.titles,
            urls: [...covered.urls],
            postIds: [...covered.postIds],
          },
        }),
      });
      const data = await res.json();
      if (data?.roots?.length) {
        useBoard.getState().appendRoots(data.roots, data.posts);
      } else {
        useBoard.setState({ rootsExhausted: Boolean(data?.exhausted) });
      }
    } catch {
      /* leave the affordance in place so it can be retried */
    } finally {
      useBoard.getState().setLoadingRoots(false);
    }
  };

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        void load();
      }}
      className="gb-more absolute left-0 top-0 cursor-pointer select-none px-4 py-4"
      style={{
        transform: `translate3d(${LEFT_PAD}px, ${y}px, 0)`,
        width: CARD_W,
        border: "1px dashed var(--gb-line-hi)",
        borderRadius: 3,
      }}
    >
      <div className="gb-label flex items-center gap-2" style={{ color: "var(--gb-dim)" }}>
        {loading ? (
          <>
            <span
              className="gb-pulse h-[4px] w-[4px] rounded-full"
              style={{ background: "var(--gb-live)" }}
            />
            {isOption ? "Finding more directions" : "Reading more of your day"}
          </>
        ) : (
          <>
            <span>+</span>
            {isOption ? "More directions" : "More of your day"}
          </>
        )}
      </div>
      {!loading ? (
        <div
          className="gb-detail mt-2 text-[11.5px] leading-[1.45]"
          style={{ color: "var(--gb-faint)" }}
        >
          {/* Three roots is what's legible on open, not what exists — on a
              decision that means directions you haven't been offered yet, on
              the same question and the same axis. */}
          {isOption
            ? "Other directions on this question that aren’t here yet"
            : "Next trends, then what your timeline is saying that isn’t here yet"}
        </div>
      ) : null}
    </div>
  );
}
