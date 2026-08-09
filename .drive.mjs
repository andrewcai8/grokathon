import { chromium } from "playwright";

const SHOT = "/private/tmp/claude-501/-Users-andrew-Desktop-grok-branches/2363833e-9b5f-4a81-be90-c75dc55452d4/scratchpad";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`CONSOLE: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("response", (r) => {
  if (r.url().includes("/api/") && !r.ok()) errors.push(`HTTP ${r.status()} ${r.url()}`);
});

page.on("request", (r) => {
  if (r.url().includes("/api/board/options")) console.log("-> options request sent");
});
page.on("response", async (r) => {
  if (r.url().includes("/api/board/options")) {
    console.log("<- options response", r.status());
    if (!r.ok()) console.log("   body:", (await r.text().catch(() => "")).slice(0, 300));
  }
});

process.on("unhandledRejection", () => {});

await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// start an options board from the prompt
const input = page.getByPlaceholder("help me pick a car under $30k");
await input.fill("help me pick a laptop for programming under $1500");
await page.getByRole("button", { name: /three options/i }).click();
console.log("submitted, waiting for board…");

// wait for option cards to replace the news board
await page.waitForFunction(
  () => document.body.innerText.includes("/ option"),
  null,
  { timeout: 120000 },
);
console.log("options board rendered");

// let the generated images land (~7.6s each, in parallel)
await page.waitForTimeout(22000);
await page.screenshot({ path: `${SHOT}/board-roots.png` });

const imgs = await page.evaluate(() =>
  [...document.querySelectorAll("img")]
    .filter((i) => i.src.includes("gb-images"))
    .map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src.split("/").pop() })),
);
console.log("generated images on screen:", JSON.stringify(imgs));

const cardText = await page.evaluate(() => {
  const c = document.querySelector(".gb-card");
  return c ? c.innerText.slice(0, 400) : "NO CARD";
});
console.log("--- first card ---\n" + cardText);

// expand one, to exercise recursion in the UI
await page.locator(".gb-card").first().click();
console.log("clicked card, expanding…");
await page.waitForTimeout(45000);
await page.screenshot({ path: `${SHOT}/board-expanded.png` });

const cols = await page.evaluate(
  () => new Set([...document.querySelectorAll(".gb-card")].map((c) => c.style.transform.split(",")[0])).size,
);
console.log("distinct card columns:", cols);
console.log("errors:", errors.length ? errors.join("\n") : "none");

await browser.close();
