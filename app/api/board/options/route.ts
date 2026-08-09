import { NextResponse } from "next/server";
import { optionsToNodes } from "@/lib/boardBuilder";
import { hasGrok } from "@/lib/grokClient";
import { expandOptions, optionCorpus } from "@/lib/optionsExpander";
import { hasExa } from "@/lib/exaClient";
import { setBoard } from "@/lib/serverBoard";
import type { Board, BranchNode } from "@/lib/schema";

export const dynamic = "force-dynamic";

/**
 * Start a decision from a sentence: "help me pick a car under $30k".
 *
 * The prompt becomes a synthetic parent that never renders — it exists only so
 * the first expansion is the SAME call as every expansion after it. A separate
 * "make roots" path would be a second thing to keep correct, and the roots
 * would drift from the children the way the two expand prompts drifted before
 * they were merged.
 */
export async function POST(req: Request) {
  const { prompt } = (await req.json().catch(() => ({}))) as { prompt?: string };
  const question = prompt?.trim();
  if (!question) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  if (!hasGrok()) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 503 });
  }
  if (!hasExa()) {
    return NextResponse.json(
      { error: "EXA_API_KEY not set — options boards are grounded in the web" },
      { status: 503 },
    );
  }

  try {
    const { web, query } = await optionCorpus(question, [], new Set());
    if (!web.length) {
      return NextResponse.json(
        { error: `nothing found on the web for "${query}"` },
        { status: 404 },
      );
    }

    const { options, summary, axis } = await expandOptions(
      { title: question },
      [],
      [],
      web,
    );
    if (!options.length) {
      return NextResponse.json({ error: "no options returned" }, { status: 502 });
    }

    // the synthetic parent is a wiring fixture, never a card
    const seedNode: BranchNode = {
      id: "__seed",
      type: "option",
      title: question,
      parent_id: null,
      children_ids: [],
      priority: 1,
      generality: 1,
      depth: -1,
      source_post_ids: [],
      has_children: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const roots = optionsToNodes(seedNode, options, web).map((n) => ({
      ...n,
      parent_id: null,
      depth: 0,
      generality: 1,
      axis: undefined,
    }));

    const board: Board = {
      date: new Date().toISOString().slice(0, 10),
      kind: "options",
      seed: { mode: "search", label: question },
      nodes: Object.fromEntries(roots.map((r) => [r.id, r])),
      root_ids: roots.map((r) => r.id),
      posts: {},
    };

    setBoard(board);
    console.log(
      "[options] %s -> %s -> %d roots (axis: %s)",
      question, query, roots.length, axis ?? "none",
    );
    return NextResponse.json({ board, source: "options", summary, axis, query });
  } catch (err) {
    console.error("[options]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "options board failed" },
      { status: 500 },
    );
  }
}
