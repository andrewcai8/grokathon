import { NextResponse } from "next/server";
import { exchangeCode, storeToken, takePkce } from "@/lib/xAuth";
import { getMe } from "@/lib/xClient";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const home = new URL("/", url.origin);

  if (error) {
    home.searchParams.set("auth_error", error);
    return NextResponse.redirect(home);
  }

  const stashed = await takePkce();
  if (!code || !stashed.verifier || state !== stashed.state) {
    home.searchParams.set("auth_error", "bad_state");
    return NextResponse.redirect(home);
  }

  try {
    const token = await exchangeCode(code, stashed.verifier);
    const me = await getMe(token.access_token);
    await storeToken({ ...token, user_id: me.id, handle: me.username });
    home.searchParams.set("connected", me.username);
    return NextResponse.redirect(home);
  } catch (err) {
    console.error("[auth/callback]", err);
    home.searchParams.set(
      "auth_error",
      err instanceof Error ? err.message.slice(0, 120) : "exchange_failed",
    );
    return NextResponse.redirect(home);
  }
}
