// Usage: node scripts/shoot.mjs <url> <out.png> [width height dpr waitMs]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url, out, w = "393", h = "852", dpr = "1", wait = "15000"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +dpr });
const logs = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("canvas", { timeout: 60000 }).catch(() => logs.push("no canvas"));
await page.waitForTimeout(+wait);
await page.screenshot({ path: out, timeout: 180000 });
const perf = await page.evaluate(() => window.__plavPerf?.slice(-3));
console.log(JSON.stringify({ perf, logs: logs.slice(0, 15) }, null, 1));
await browser.close();
