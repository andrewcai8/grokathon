import { NextResponse } from "next/server";
import { authorizeUrl, hasXCredentials, makePkce, stashPkce } from "@/lib/xAuth";

export async function GET() {
  if (!hasXCredentials()) {
    return NextResponse.json(
      { error: "X_CLIENT_ID / X_CLIENT_SECRET not set" },
      { status: 503 },
    );
  }
  const { verifier, challenge, state } = makePkce();
  await stashPkce(verifier, state);
  return NextResponse.redirect(authorizeUrl(challenge, state));
}
