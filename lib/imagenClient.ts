import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * grok-imagine, for option cards where seeing the thing beats reading about it.
 *
 * Verified against the live API before any of this was built:
 *   POST https://api.x.ai/v1/images/generations
 *   model grok-imagine-image-quality  (grok-imagine-image is the faster tier)
 *   ~7.6s, cost_in_usd_ticks 500000000 = $0.05 per image
 *   returns { data: [{ url, mime_type }] }
 *
 * The risk going in was that it would return generic AI art rather than a
 * usable picture of the thing. It does not: asked for a 2026 Honda Civic it
 * produced a correctly badged Civic on a neutral studio background, framed
 * better for a card than the publisher photo we retrieved alongside it.
 *
 * Two consequences worth stating plainly:
 *
 * 1. The returned URL is `xai-tmp-imgen-...` and temporary. Boards are
 *    snapshotted to disk and replayed as the demo safety net, so storing that
 *    URL would produce a board that renders today and 404s on stage. We
 *    download the bytes and serve them ourselves.
 *
 * 2. A photoreal generated image of a real product is the one thing on the
 *    board not retrieved from the world. It is rendered with a visible marker
 *    for the same reason an unverified post is: the audience must never have to
 *    guess which pixels we fetched and which we made.
 */

const MODEL = process.env.GROK_IMAGE_MODEL ?? "grok-imagine-image-quality";

/** Written into public/ so Next serves the bytes with no route in the path. */
const DIR = path.join(process.cwd(), "public", "gb-images");
const PUBLIC_PREFIX = "/gb-images";

export function hasImagen() {
  return Boolean(process.env.XAI_API_KEY) && process.env.GB_OPTION_IMAGES !== "0";
}

function keyFor(prompt: string) {
  return createHash("sha256").update(`${MODEL}:${prompt}`).digest("hex").slice(0, 20);
}

/**
 * Generate once, keep forever.
 *
 * Cached by prompt hash, so re-opening a branch, reloading the page or
 * replaying a snapshot costs nothing and returns instantly. At $0.05 a call
 * that is the difference between a rehearsable demo and a metered one.
 */
export async function generateImage(prompt: string): Promise<string> {
  if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY not set");

  const file = `${keyFor(prompt)}.jpg`;
  const dest = path.join(DIR, file);
  const served = `${PUBLIC_PREFIX}/${file}`;

  try {
    await readFile(dest);
    return served;
  } catch {
    // not cached yet
  }

  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, prompt, n: 1 }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`imagen ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: { url?: string }[] };
  const url = json.data?.[0]?.url;
  if (!url) throw new Error("imagen returned no image");

  const bytes = await fetch(url, { cache: "no-store" });
  if (!bytes.ok) throw new Error(`imagen fetch ${bytes.status}`);

  await mkdir(DIR, { recursive: true });
  await writeFile(dest, Buffer.from(await bytes.arrayBuffer()));
  return served;
}
