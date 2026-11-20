// CPU profile of the main thread during the in-app bench. Usage: node scripts/cpuprofile.mjs <url> <out.json>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const [url, outFile] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ ...devices["Pixel 7"] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.__plavFirstFrame, null, { timeout: 120000 });
await page.waitForTimeout(3000);
await cdp.send("Profiler.start");
await page.waitForFunction(() => window.__plavBench, null, { timeout: 900000, polling: 1000 });
const { profile } = await cdp.send("Profiler.stop");
// self time per function
const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; let total = 0;
profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); total += dt[i] || 0; });
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
fs.writeFileSync(outFile, JSON.stringify(profile));
console.log(`total ${(total / 1000).toFixed(0)} ms\n` + top.join("\n"));
await browser.close();
