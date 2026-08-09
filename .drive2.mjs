import { chromium } from "playwright";
const SHOT = "/private/tmp/claude-501/-Users-andrew-Desktop-grok-branches/2363833e-9b5f-4a81-be90-c75dc55452d4/scratchpad";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(`CONSOLE: ${m.text().slice(0,200)}`); });
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message.slice(0,200)}`));
page.on("response", async (r) => {
  if (r.url().includes("/api/")) {
    const tag = `${r.status()} ${r.url().replace("http://localhost:3000","")}`;
    if (!r.ok()) errors.push(`HTTP ${tag} :: ${(await r.text().catch(()=>"" )).slice(0,200)}`);
    else console.log("   ok:", tag);
  }
});
try {
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const ph = page.getByPlaceholder("help me pick a car under $30k");
  console.log("input found:", await ph.count());
  await ph.fill("help me pick a laptop for programming under $1500");
  const btn = page.getByRole("button", { name: /three options/i });
  console.log("button found:", await btn.count(), "| disabled:", await btn.isDisabled());
  await btn.click();
  console.log("clicked, waiting…");
  await page.waitForFunction(() => document.body.innerText.includes("/ option"), null, { timeout: 150000 });
  console.log("OPTIONS BOARD RENDERED");
  await page.waitForTimeout(24000);
  await page.screenshot({ path: `${SHOT}/board-roots.png` });
  const imgs = await page.evaluate(() => [...document.querySelectorAll("img")].filter(i=>i.src.includes("gb-images")).map(i=>({w:i.naturalWidth,h:i.naturalHeight})));
  console.log("generated images:", JSON.stringify(imgs));
  console.log("--- card ---\n" + await page.evaluate(() => document.querySelector(".gb-card")?.innerText.slice(0,400)));
  await page.locator(".gb-card").first().click();
  await page.waitForTimeout(50000);
  await page.screenshot({ path: `${SHOT}/board-expanded.png` });
  console.log("cards after expand:", await page.locator(".gb-card").count());
} catch (e) {
  console.log("FAILED:", e.message.slice(0, 300));
  await page.screenshot({ path: `${SHOT}/failure.png` });
  console.log("page text:", (await page.evaluate(() => document.body.innerText)).slice(0, 600));
}
console.log("\nERRORS:", errors.length ? errors.join("\n") : "none");
await browser.close();
