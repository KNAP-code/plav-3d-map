// Close-up renders of each modelled landmark from 4 sides. Usage: node scripts/landmark-angles.mjs <baseUrl> <outDir> <prefix>
// Hides ordinary buildings (off=buildings) so each model is seen unobstructed. Uses ?closeup=1 (lower min distance / higher max polar for renders only). Desktop 1280x800, high tier, no tilt-shift, no cars.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [base, outDir, prefix] = process.argv.slice(2);
// name, centre x,y (local m), distance, polar, lift, azimuth of the entrance side (deg, flyTo convention)
const L = [
  ["kula", 283.4, -263.2, 58, 76, 15, -48],
  ["stara", 148.0, -169.8, 42, 76, 4, -156],
  ["sultanija", 133.2, -66.4, 80, 76, 18, -157],
  ["redzepagica", 304.2, -206.1, 44, 72, 6, -144],
  ["sabovica", 123.1, -345.2, 38, 74, 4, -139],
];
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const [name, x, y, dist, pol, lift, az0] of L) {
  if (only && !only.includes(name)) continue;
  for (const [k, turn] of [["front", 25], ["left", 115], ["back", 205], ["right", 295]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(`${base}?q=high&off=tilt,buildings,lights&cars=0&closeup=1&cam=${x},${y},${dist},${az0 + turn},${pol},${lift}`, { waitUntil: "load" });
    await page.waitForSelector("canvas", { timeout: 60000 });
    await page.waitForTimeout(14000);
    await page.screenshot({ path: `${outDir}/${prefix}-${name}-${k}.jpg`, quality: 85, timeout: 180000 });
    await page.close();
    console.log(name, k);
  }
}
await browser.close();
