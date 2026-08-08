import { NextResponse } from "next/server";
import { expandNode, hasGrok } from "@/lib/grokClient";
import {
  ancestorTitles,
  childrenToNodes,
  relevantPosts,
} from "@/lib/boardBuilder";
import { getBoard, patchBoard } from "@/lib/serverBoard";
import { ForkSchema, type Fork } from "@/lib/schema";

/**
 * The expand contract (doc §3.4): structured children, never a chat dump.
 * Capped, cited, honestly labelled.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    nodeId?: string;
    fork?: string;
  };
  const nodeId = body.nodeId;
  if (!nodeId) {
    return NextResponse.json({ error: "nodeId required" }, { status: 400 });
  }

  const fork: Fork = ForkSchema.safeParse(body.fork).success
    ? (body.fork as Fork)
    : "deeper";

  const board = getBoard();
  if (!board) {
    return NextResponse.json({ error: "no board" }, { status: 409 });
  }
  const node = board.nodes[nodeId];
  if (!node) {
    return NextResponse.json({ error: "unknown node" }, { status: 404 });
  }

  // already expanded on this fork — serve from the graph, instantly
  if (fork === "deeper" && node.children_ids.length > 0) {
    return NextResponse.json({
      children: node.children_ids.map((id) => board.nodes[id]).filter(Boolean),
      cached: true,
    });
  }

  if (!hasGrok()) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 503 });
  }

  try {
    const posts = relevantPosts(board, nodeId);
    const raw = await expandNode(node, fork, posts, ancestorTitles(board, nodeId));
    const children = childrenToNodes(node, raw, board.posts, fork);

    patchBoard((b) => {
      const nodes = { ...b.nodes };
      for (const c of children) nodes[c.id] = c;
      nodes[nodeId] = {
        ...nodes[nodeId],
        children_ids:
          fork === "deeper"
            ? children.map((c) => c.id)
            : [...nodes[nodeId].children_ids, ...children.map((c) => c.id)],
        has_children: true,
        updated_at: new Date().toISOString(),
      };
      return { ...b, nodes };
    });

    return NextResponse.json({ children, fork });
  } catch (err) {
    console.error("[expand]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "expand failed" },
      { status: 500 },
    );
  }
}
