import { NextResponse } from "next/server";
import { generateImage, hasImagen } from "@/lib/imagenClient";

export const dynamic = "force-dynamic";

/**
 * A card asks for its own picture.
 *
 * Generation is ~7.6s, which is far too slow to sit inside an expand the user
 * is watching — the column has to land on the click. So the expander returns
 * the option with an image PROMPT and no image, and the card requests the
 * bytes itself once it's on screen. Three cards then generate in parallel
 * instead of serially behind one response, and a failure belongs to the one
 * card that failed rather than taking the whole branch down with it.
 */
export async function POST(req: Request) {
  const { prompt } = (await req.json().catch(() => ({}))) as { prompt?: string };
  if (!prompt) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  if (!hasImagen()) {
    return NextResponse.json({ error: "image generation off" }, { status: 503 });
  }

  try {
    const url = await generateImage(prompt);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[image]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "image failed" },
      { status: 500 },
    );
  }
}
