import { NextResponse } from "next/server";
import { activeToken, hasXCredentials } from "@/lib/xAuth";
import { hasGrok } from "@/lib/grokClient";

export const dynamic = "force-dynamic";

/** What the UI needs to tell you the truth about where the board came from. */
export async function GET() {
  const token = await activeToken();
  return NextResponse.json({
    connected: Boolean(token?.user_id),
    handle: token?.handle ?? null,
    canConnect: hasXCredentials(),
    grok: hasGrok(),
  });
}
