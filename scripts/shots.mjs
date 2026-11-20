// Fixed-camera comparison shots. Usage: node scripts/shots.mjs <baseUrl> <outDir> <prefix>
// Each view: name|query (cam=x,y,distance,azimuthDeg,polarDeg in local metres). Desktop 1280x800 @1x, high tier.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [base, outDir, prefix] = process.argv.slice(2);
// VIEWS=landmarks selects the authentic-architecture set (camera at each modelled building's entrance side)
const views = process.env.VIEWS === "landmarks" ? [
  "sultanija|q=high&off=tilt&cam=133.2,-66.4,110,-127,64,14",
  "redzepagica|q=high&off=tilt&cam=304.2,-206.1,95,-114,62,9",
  "sabovica|q=high&off=tilt&cam=123.1,-345.2,70,-109,64,6",
  "stara|q=high&off=tilt&cam=148.0,-169.8,70,-126,64,6",
  "kula|q=high&off=tilt&cam=283,-263,75,250,70",
  "centre|q=high&off=tilt&cam=200,-150,260,-120,55",
] : [
  "overview|q=high&off=tilt",
  "houses|q=high&off=tilt&cam=120,-330,120,215,58",
  "street|q=high&off=tilt&cam=283,-240,90,320,52",
  "kula|q=high&off=tilt&cam=283,-263,75,250,70",
  "night|q=high&off=tilt&night=1",
  "night-street|q=high&off=tilt&night=1&cam=283,-240,90,320,52",
];
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const v of views) {
  const [name, query] = v.split("|");
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${base}?${query}&cars=0`, { waitUntil: "load" });
  await page.waitForSelector("canvas", { timeout: 60000 });
  await page.waitForTimeout(16000);
  await page.screenshot({ path: `${outDir}/${prefix}-${name}.jpg`, quality: 85, timeout: 180000 });
  console.log(name, errs.length ? errs : "ok");
  await page.close();
}
await browser.close();
