// Measures load and render cost of the static build under phone emulation.
// Usage: node scripts/perf.mjs <baseUrl> [cpuThrottle]
// NOTE: headless Chromium renders WebGL with SwiftShader (CPU), so fps here is NOT a phone GPU number.
import { createRequire } from "node:module";
import zlib from "node:zlib";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const [base, throttle = "4"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results = [];
for (const [label, dev] of [["Pixel 7", devices["Pixel 7"]], ["iPhone 13", devices["iPhone 13"]]]) {
  for (const q of ["medium", "low"]) {
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: +throttle });
    let raw = 0, gz = 0; const byType = {};
    page.on("response", async (r) => {
      try {
        const b = await r.body(); raw += b.length; const g = zlib.gzipSync(b).length; gz += g;
        const t = r.url().includes("/data/") ? "data" : r.url().endsWith(".js") ? "js" : "other";
        byType[t] = (byType[t] || 0) + g;
      } catch {}
    });
    const t0 = Date.now();
    await page.goto(`${base}?q=${q}&stats=1`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__plavFirstFrame, null, { timeout: 180000 });
    const firstFrame = await page.evaluate(() => window.__plavFirstFrame);
    await page.waitForTimeout(6000);
    const perf = await page.evaluate(() => window.__plavPerf?.slice(-1)[0]);
    const heap = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
    results.push({ device: label, quality: q, cpuThrottle: +throttle, firstFrameMs: Math.round(firstFrame), wallMs: Date.now() - t0,
      transferGzipMB: +(gz / 1e6).toFixed(2), rawMB: +(raw / 1e6).toFixed(2), gzipByTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, +(v / 1e6).toFixed(2)])),
      drawCalls: perf?.calls, trianglesK: perf ? Math.round(perf.tris / 1000) : null, dpr: perf?.dpr, jsHeapMB: heap, swiftshaderFps: perf ? +perf.fps.toFixed(1) : null });
    await ctx.close();
  }
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
