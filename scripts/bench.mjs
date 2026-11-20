// Runs the in-app #bench under phone emulation for several configurations.
// Usage: node scripts/bench.mjs <baseUrl> <frames> <config> [<config> ...]
//   config = "label|query" e.g. "baseline|q=medium" "no-ao|q=medium&off=ao"
// Headless Chromium uses SwiftShader (CPU rasteriser): absolute fps is NOT a phone number,
// but the relative cost of each subsystem (and JS main-thread time) is meaningful.
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const [base, frames, ...configs] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const out = [];
for (const cfg of configs) {
  const [label, query] = cfg.split("|");
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}?${query}&bench=${frames}`, { waitUntil: "load" });
  try {
    await page.waitForFunction(() => window.__plavBench, null, { timeout: 900000, polling: 1000 });
    const r = await page.evaluate(() => ({ ...window.__plavBench, firstFrame: window.__plavFirstFrame, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null }));
    out.push({ label, query, ...r, errors });
    console.error(`${label}: p50 ${r.p50.toFixed(0)} ms, js ${r.jsP50.toFixed(1)} ms, ${r.calls} calls, ${Math.round(r.tris / 1000)}k tris, shadowUpd ${r.shadowUpdates}, renders ${r.reactRenders}`);
  } catch (e) { out.push({ label, query, error: String(e), errors }); console.error(label, "failed", errors); }
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
