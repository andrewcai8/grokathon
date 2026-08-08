import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

/**
 * X OAuth 2.0 Authorization Code + PKCE. Verified against docs.x.com:
 *   authorize  https://x.com/i/oauth2/authorize
 *   token      https://api.x.com/2/oauth2/token
 *   scopes     tweet.read users.read offline.access
 *   access token lifetime: 2 hours (offline.access gives us a refresh token)
 *
 * You connect YOUR account. That's the product, not a demo shortcut.
 */

export const X_AUTHORIZE = "https://x.com/i/oauth2/authorize";
export const X_TOKEN = "https://api.x.com/2/oauth2/token";
export const X_SCOPES = ["tweet.read", "users.read", "offline.access"];

const COOKIE = "gb_x_token";
const VERIFIER_COOKIE = "gb_x_verifier";
const STATE_COOKIE = "gb_x_state";

export interface XToken {
  access_token: string;
  refresh_token?: string;
  /** epoch ms */
  expires_at: number;
  user_id?: string;
  handle?: string;
}

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makePkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, state: b64url(randomBytes(16)) };
}

export function redirectUri() {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base}/api/auth/callback`;
}

export function authorizeUrl(challenge: string, state: string) {
  const u = new URL(X_AUTHORIZE);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.X_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", X_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

function basicAuth() {
  const id = process.env.X_CLIENT_ID ?? "";
  const secret = process.env.X_CLIENT_SECRET ?? "";
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function tokenRequest(body: URLSearchParams): Promise<XToken> {
  const res = await fetch(X_TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(),
    },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? `token exchange failed (${res.status})`);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 7200) * 1000,
  };
}

export function exchangeCode(code: string, verifier: string) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.X_CLIENT_ID ?? "",
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  );
}

export function refresh(refreshToken: string) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.X_CLIENT_ID ?? "",
    }),
  );
}

// ---- cookie plumbing -------------------------------------------------------

export async function storeToken(token: XToken) {
  const jar = await cookies();
  jar.set(COOKIE, JSON.stringify(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function readToken(): Promise<XToken | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as XToken;
  } catch {
    return null;
  }
}

/** Returns a live access token, refreshing if it's within 5 minutes of expiry. */
export async function activeToken(): Promise<XToken | null> {
  const token = await readToken();
  if (!token) return null;
  if (token.expires_at - Date.now() > 5 * 60 * 1000) return token;
  if (!token.refresh_token) return null;
  try {
    const next = await refresh(token.refresh_token);
    // X rotates refresh tokens — always persist whatever comes back
    const merged: XToken = {
      ...next,
      refresh_token: next.refresh_token ?? token.refresh_token,
      user_id: token.user_id,
      handle: token.handle,
    };
    await storeToken(merged);
    return merged;
  } catch {
    return null;
  }
}

export async function stashPkce(verifier: string, state: string) {
  const jar = await cookies();
  const opts = {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  };
  jar.set(VERIFIER_COOKIE, verifier, opts);
  jar.set(STATE_COOKIE, state, opts);
}

export async function takePkce() {
  const jar = await cookies();
  return {
    verifier: jar.get(VERIFIER_COOKIE)?.value ?? null,
    state: jar.get(STATE_COOKIE)?.value ?? null,
  };
}

export function hasXCredentials() {
  return Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);
}
