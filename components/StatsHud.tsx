"use client";

import { useMemo } from "react";
import { useBoard } from "@/lib/store";

/**
 * Telemetry.
 *
 * The claim this product makes is "everything here is grounded in something
 * real". Saying that is weak; showing it is not. Every number here is measured
 * from actual retrievals — which source answered, how long it took, how many
 * real posts and articles are behind what's on screen — so a judge can watch
 * the grounding happen instead of taking it on faith.
 *
 * Deliberately reads as instrumentation, not a dashboard: mono, uppercase,
 * hairline rules, no chrome. It belongs to the same voice as the rest of the
 * board.
 */

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span style={{ color: "var(--gb-faint)" }}>{label}</span>
      <span className="h-px flex-1" style={{ background: "var(--gb-line)" }} />
      <span className="tabular-nums" style={{ color: tone ?? "var(--gb-dim)" }}>
        {value}
      </span>
    </div>
  );
}

export function StatsHud() {
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const expandedCount = useBoard((s) => s.expanded.size);

  const stats = useMemo(() => {
    const nodes = Object.values(board?.nodes ?? {});
    const retrievals = events.filter((e) => !e.error && !e.cached);
    const live = retrievals.filter((e) => e.ms > 0);
    const median = (() => {
      if (!live.length) return 0;
      const xs = live.map((e) => e.ms).sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)];
    })();

    // where the evidence on this board actually came from
    const bySource = new Map<string, number>();
    for (const e of retrievals) {
      if (!e.source) continue;
      bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    }

    const citedPosts = new Set(nodes.flatMap((n) => n.source_post_ids));
    const webCites = nodes.reduce(
      (n, node) => n + (node.source_urls_meta?.length ?? 0),
      0,
    );
    const unverified = Object.values(board?.posts ?? {}).filter(
      (p) => p.unverified,
    ).length;
    const deepest = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    const grounded = nodes.filter(
      (n) => n.source_post_ids.length > 0 || (n.source_urls_meta?.length ?? 0) > 0,
    ).length;

    return {
      nodes: nodes.length,
      grounded,
      deepest,
      citedPosts: citedPosts.size,
      webCites,
      unverified,
      median,
      cached: events.filter((e) => e.cached).length,
      failed: events.filter((e) => e.error).length,
      bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [board, events]);

  if (!board) return null;

  const pct = stats.nodes ? Math.round((stats.grounded / stats.nodes) * 100) : 0;

  return (
    <div
      className="gb-label pointer-events-none absolute right-4 top-4 w-[212px] px-3 py-3"
      style={{
        background: "rgba(5,5,6,0.82)",
        border: "1px solid var(--gb-line)",
        borderRadius: 3,
        backdropFilter: "blur(8px)",
        lineHeight: 1.9,
      }}
    >
      <div className="mb-2 flex items-center gap-2" style={{ color: "var(--gb-text)" }}>
        <span
          className="h-[5px] w-[5px] rounded-full"
          style={{
            background: board.seed.snapshot ? "var(--gb-faint)" : "var(--gb-live)",
            boxShadow: board.seed.snapshot ? "none" : "0 0 8px var(--gb-live)",
          }}
        />
        {board.seed.snapshot ? "Snapshot" : "Live"}
        <span className="h-px flex-1" style={{ background: "var(--gb-line)" }} />
        <span className="tabular-nums">D{stats.deepest}</span>
      </div>

      <Row label="Nodes" value={String(stats.nodes)} />
      <Row
        label="Grounded"
        value={`${pct}%`}
        tone={pct === 100 ? "var(--gb-live)" : "var(--gb-warn)"}
      />
      <Row label="Posts" value={String(stats.citedPosts)} />
      <Row label="Articles" value={String(stats.webCites)} />
      {stats.unverified > 0 ? (
        <Row
          label="Unverified"
          value={String(stats.unverified)}
          tone="var(--gb-warn)"
        />
      ) : null}

      <div className="my-2 h-px" style={{ background: "var(--gb-line)" }} />

      <Row label="Median" value={stats.median ? `${(stats.median / 1000).toFixed(1)}s` : "—"} />
      {stats.cached > 0 ? <Row label="Cached" value={String(stats.cached)} /> : null}
      {stats.failed > 0 ? (
        <Row label="Failed" value={String(stats.failed)} tone="var(--gb-warn)" />
      ) : null}
      <Row label="Open" value={String(expandedCount)} />

      {stats.bySource.length ? (
        <>
          <div className="my-2 h-px" style={{ background: "var(--gb-line)" }} />
          {stats.bySource.slice(0, 4).map(([src, n]) => (
            <Row key={src} label={src.replace(/_/g, " ")} value={String(n)} />
          ))}
        </>
      ) : null}
    </div>
  );
}
