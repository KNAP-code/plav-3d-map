// Fixed-camera comparison shots. Usage: node scripts/shots.mjs <baseUrl> <outDir> <prefix>
// Each view: name|query (cam=x,y,distance,azimuthDeg,polarDeg in local metres). Desktop 1280x800 @1x, high tier.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [base, outDir, prefix] = process.argv.slice(2);
// VIEWS=landmarks selects the authentic-architecture set (camera at each modelled building's entrance side)
// VIEWS=town: the whole-town set used from the city-wide batches on (same cameras before and after)
const town = [
  "town|q=high&off=tilt&cam=-150,0,3600,15,48",
  "north|q=high&off=tilt&cam=-1150,1300,700,200,52",
  "northeast|q=high&off=tilt&cam=250,950,520,205,55",
  "south|q=high&off=tilt&cam=250,-1450,620,25,52",
  "street|q=high&off=tilt&cam=283,-240,90,320,52",
  "houses|q=high&off=tilt&cam=120,-330,120,215,58",
  "suburb|q=high&off=tilt&cam=-700,760,170,160,58",
  "night|q=high&off=tilt&night=1&cam=150,-150,1100,40,50",
];
// VIEWS=atmos: accuracy + atmosphere brief (aerial, centre close-ups, sunset, night; same cameras before and after)
const atmos = [
  "aerial|q=high&off=tilt&cam=-150,0,3600,15,48",
  "centre|q=high&off=tilt&cam=200,-150,260,-120,55",
  "centre-street|q=high&off=tilt&cam=283,-240,90,320,52",
  "centre-houses|q=high&off=tilt&cam=120,-330,120,215,58",
  "northeast|q=high&off=tilt&cam=250,950,520,205,55",
  "sunset|q=high&off=tilt&sunset=1&cam=150,-150,1100,40,50",
  "sunset-centre|q=high&off=tilt&sunset=1&cam=200,-150,260,-120,55",
  "night|q=high&off=tilt&night=1&cam=150,-150,1100,40,50",
  "night-centre|q=high&off=tilt&night=1&cam=200,-150,260,-120,55",
];
// VIEWS=water: Phase 2 lake / rivers / waterfront (same cameras before and after)
const water = [
  "lake|q=high&off=tilt&cam=-1400,-300,2300,95,52",
  "lake-low|q=high&off=tilt&cam=-1300,-350,1100,100,74",
  "splavovi|q=high&off=tilt&cam=-770,-195,190,110,58",
  "boardwalks|q=high&off=tilt&cam=-1080,-1080,260,60,58",
  "lim-outlet|q=high&off=tilt&cam=-1250,950,420,170,55",
  "zioci-bridge|q=high&off=tilt&cam=-1228,1144,95,130,62",
  "ljuca|q=high&off=tilt&cam=-1950,-500,520,70,55",
  "town-stream|q=high&off=tilt&cam=374,-133,85,200,58",
  "sunset-lake|q=high&off=tilt&sunset=1&cam=-1300,-350,1100,100,74",
  "night-lake|q=high&off=tilt&night=1&cam=-1300,-350,1100,100,70",
  "medium-lake|q=medium&off=tilt&cam=-1300,-350,1100,100,74",
];
// VIEWS=verify: Phase 3 city geometry: each camera as the normal map and as the #verify evidence view
const verifyCams = [
  "town|cam=-150,0,3600,15,48", "centre|cam=200,-150,420,-120,60", "north|cam=-1150,1300,700,200,52",
  "northeast|cam=250,950,520,205,55", "south|cam=250,-1450,620,25,52", "skic|cam=-250,1150,520,180,55",
];
const verify = verifyCams.flatMap((v) => { const [n, c] = v.split("|"); return [`${n}|q=high&off=tilt&${c}`, `${n}-verify|q=high&off=tilt&verify=1&${c}`]; });
// VIEWS=fix: Phase 3b corrections: road surface cut back from footprints, Microsoft 2024 buildings added
const fixCams = [
  "cut-centre|cam=80,-160,140,200,55", "add-ravni|cam=-550,745,170,180,55", "add-east|cam=690,-40,130,200,55",
  "add-3785|cam=750,-138,100,200,55", "add-2431|cam=160,-652,100,200,55", "add-3035|cam=137,899,100,200,55",
];
const fix = fixCams.flatMap((v) => { const [n, c] = v.split("|"); return [`${n}|q=high&off=tilt&${c}`, `${n}-verify|q=high&off=tilt&verify=1&${c}`]; });
// VIEWS=arch: Phase 4 architectural detail, pilot area (central Plav) close-ups, same cameras before and after
const arch = [
  "pilot|q=high&off=tilt&cam=150,-280,260,200,55",
  "street|q=high&off=tilt&cam=120,-330,48,215,64",
  "houses|q=high&off=tilt&cam=283,-240,42,320,66",
  "roofs|q=high&off=tilt&cam=200,-200,110,-120,48",
  "yard|q=high&off=tilt&cam=40,-380,65,150,58",
  "suburb|q=high&off=tilt&cam=-700,760,60,160,62",
  "sunset|q=high&off=tilt&sunset=1&cam=120,-330,70,215,60",
  "night|q=high&off=tilt&night=1&cam=120,-330,70,215,60",
];
const views = process.env.CAMS ? process.env.CAMS.split(";") : process.env.VIEWS === "arch" ? arch : process.env.VIEWS === "fix" ? fix : process.env.VIEWS === "verify" ? verify : process.env.VIEWS === "water" ? water : process.env.VIEWS === "atmos" ? atmos : process.env.VIEWS === "town" ? town : process.env.VIEWS === "landmarks" ? [
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
