import { NextResponse } from "next/server";
import { activeToken } from "@/lib/xAuth";

export const dynamic = "force-dynamic";

/**
 * Diagnostic: the raw personalized-trends payload, unparsed.
 *
 * The trending seed silently produced nothing while returning 200, which means
 * the endpoint answered but our field mapping missed. Rather than guess at the
 * shape, look at it.
 */
export async function GET() {
  const token = await activeToken();
  if (!token?.access_token) {
    return NextResponse.json({ error: "not connected to X" }, { status: 401 });
  }

  const res = await fetch("https://api.x.com/2/users/personalized_trends", {
    headers: { authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
  });
  const body = await res.text();

  console.log("[trends] status=%d body=%s", res.status, body.slice(0, 1200));

  return NextResponse.json({
    status: res.status,
    ok: res.ok,
    parsed: (() => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })(),
    raw: body.slice(0, 2000),
  });
}
