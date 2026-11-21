import * as THREE from "three";
import type { Building } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { offsetRing, signedArea, triangulate, type P2 } from "./poly";

/**
 * Builds two merged meshes (walls, roofs) from real footprints.
 * Heights and roof shapes are estimates (see pipeline rules); geometry follows the footprint exactly.
 *
 * Roof model: the oriented bounding box (OBB) of the footprint defines eave planes rising
 * inward at the roof pitch. The roof surface is the lower envelope of those planes
 * (4 planes = hip, 2 planes = gable), clipped to the footprint offset by the overhang.
 * Walls rise to that same surface, so gable ends and L-shaped wings close without gaps.
 */

type Plane = { a: number; b: number; c: number }; // d(s,t) = a*s + b*t + c
type Face = { plane: number; poly: P2[]; axis: "s" | "t" };

export type RoofKind = "hip" | "gable" | "halfhip" | "flat";

/**
 * Roof planes over the OBB (half sizes L along s, W across t, incl. overhang). d(s,t) is the horizontal distance
 * inward from that plane's eave line; the roof surface is the lower envelope of the planes.
 * halfhip (Krüppelwalm): the end planes start higher, so each end is a gable up to ~45% of the rise, then a small hip.
 */
function roofPlanes(kind: RoofKind, L: number, W: number): Plane[] {
  const sides: Plane[] = [{ a: 0, b: -1, c: W }, { a: 0, b: 1, c: W }];
  if (kind === "gable") return sides;
  const k = kind === "halfhip" ? W * 0.45 : 0;
  return [...sides, { a: -1, b: 0, c: L + k }, { a: 1, b: 0, c: L + k }];
}

/** Keep the part of polygon `poly` where a*s + b*t + c >= 0 (Sutherland–Hodgman against one line). */
function clipHalf(poly: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [];
  const f = (p: P2) => a * p[0] + b * p[1] + c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/** Region of the outline where plane i is the lowest (the face that plane forms). */
function roofRegion(outline: P2[], planes: Plane[], i: number): P2[] {
  let poly = outline;
  for (let j = 0; j < planes.length && poly.length >= 3; j++) {
    if (j === i) continue;
    // p_j - p_i >= 0
    poly = clipHalf(poly, planes[j].a - planes[i].a, planes[j].b - planes[i].b, planes[j].c - planes[i].c);
  }
  return poly;
}

const evalP = (p: Plane, s: number, t: number) => p.a * s + p.b * t + p.c;

export type BuildingMeshes = {
  walls: THREE.BufferGeometry; roofs: THREE.BufferGeometry; details: THREE.BufferGeometry; count: number;
  /** Per building: [index in input list, wall vertex start, wall vertex end, roof vertex start, roof vertex end]. */
  ranges: Int32Array;
};

/** Deterministic hash of a building id + salt to [0, 1): same variation on every load. */
export function hash01(id: string, salt: string) {
  let h = 2166136261;
  const s = id + salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Facade window layouts. The shader reads floor(aStyle): layout = mod(.,4), +4 shop ground floor,
 * +8 traditional house (stone ground floor, shutters); the fraction is a per-building seed.
 */
export const FACADE = { grid: 0, tall: 1, paired: 2, band: 3 } as const;

/** Palettes by building type (all estimates; no facade colour data exists for Plav). */
const TRAD_WALLS = ["#f3eee6", "#efe9df", "#ebe4d6", "#f1ece2"];
const TRAD_ROOFS = ["#7a5b4c", "#6e6460", "#85604f", "#5f5a58", "#8f6a55"];
const OUT_WALLS = ["#a8977f", "#9c9184", "#b3a58f", "#8f8476"];
const OUT_ROOFS = ["#7a716a", "#6f665f", "#857a70", "#8a6f60"];
const BLOCK_WALLS = ["#d8d2c8", "#e5d6be", "#cdd3d0", "#e9e0cf", "#c9b9ab", "#ecd9a8", "#d9cfc2", "#e3c8b3", "#c4c9cc"];

/**
 * Deterministic architectural variation (all estimates, flagged in docs/LANDMARKS.md and DATA_SOURCES.md):
 * building type (traditional house / house / apartment block), roof type, pitch and overhang, window layout,
 * bay width, colour, chimney, balconies and entrance. The footprint itself is never changed.
 */
/**
 * Regional house families (ESTIMATES, applied only when estimated details are shown; documented in
 * docs/CITY_ESTIMATES.md). They describe what is typical for houses in Plav and the north of Montenegro, not facts
 * about a particular building: steep hipped roofs for snow, clay-tile or painted sheet-metal roofs, plastered walls,
 * some unfinished brick or block facades, concrete upper-floor balconies, deep eaves, timber barns for small sheds.
 * Every choice is a deterministic hash of the building id, so the same house always looks the same.
 */
const METAL_ROOFS = ["#6e5446", "#7f4a3c", "#5c6656", "#6a6d70", "#8c5a46", "#585c62", "#7a6a5c"];
const TILE_ROOFS = ["#c9724f", "#bd6748", "#d38160", "#b55f46", "#c87a56", "#a95b44"];
const CONC_ROOFS = ["#8c8a86", "#7d7b78", "#9a948c"];
const PLASTER = ["#efe9dd", "#f2ead6", "#e9dfc9", "#ece4d2", "#f4efe4", "#e6dccb", "#efe2c4", "#f0e6d8", "#f0dcaa", "#efcfb0", "#dfe3d2", "#e7d3c8", "#e9d9a8", "#d9d4c6"];
const BARN_WALLS = ["#7a5a40", "#6c4f39", "#80624a", "#5f4a38"];
export const ROOF_MAT = { tile: 0, metal: 1, concrete: 2 } as const;

/**
 * Phase 4 architectural detail (ESTIMATES, docs/ARCHITECTURE_DETAIL.md). Rolled out district by district: a building
 * gets the detailed treatment when its centre lies inside one of these circles (local metres, radius).
 */
export const DETAIL_AREAS: [number, number, number][] = [[170, -230, 520]];
export const inDetailXY = (px: number, py: number) => DETAIL_AREAS.some(([x, y, r]) => Math.hypot(px - x, py - y) <= r);
const inDetailArea = (b: Building) => inDetailXY(b.obb[0], b.obb[1]);

/**
 * Phase 5.1 evidence mode (pilot districts, buildings with recon.json data): only what a source shows is drawn.
 * Roof colour comes from the 1 m image; roof covering is estimated from that colour; facades are UNKNOWN and use one
 * neutral plaster tone; no balconies, porches, stairs, chimneys, stone plinths, shutters, curtains or blinds, and no
 * random roof variants, pitches or colour jitter. Unknown roof colours use a neutral grey.
 */
export const NEUTRAL = { wall: "#e3ded5", outb: "#bdb6aa", roof: "#8e8983", fascia: "#d8d3ca", soffit: "#cfc9bf" } as const;
export const NEUTRAL_BIT = 4096;

export function variation(b: Building, style: StyleConfig, est = false) {
  const area = b.obb[3] * b.obb[4];
  // Rules v2 (2026-11-20): style follows data, not chance. Apartment-block styling only where OSM records 4+ levels;
  // no randomly assigned traditional houses, shops, balconies or roof conversions. Only colour tone varies per building.
  const block = b.floors >= 4;
  const small = area < 60 || b.floors <= 1;
  const h = (k: string) => hash01(b.id, k);
  const sacred = b.cls === "mosque" || b.cls === "church";
  // small machine-detected footprints (< 30 m²): plain single-storey shed, garage or barn, no windows or details
  const outb = b.kind === "outbuilding";
  const trad = false; // no per-building evidence for the traditional Plav type yet (kept for documented cases later)
  const roof: RoofKind = b.roof === "flat" ? "flat" : b.roof === "gable" ? "gable" : "hip";
  const base = style.roof.pitchDeg;
  let pitch = block ? base - 8 : small ? base + 4 : roof === "gable" ? base + 3 : base;
  let overhang = style.roof.overhang * (block ? 0.8 : 1.0);
  const facade = block ? FACADE.band : FACADE.grid;
  const shop = !small && b.floors >= 2 && (b.cls === "commercial" || b.cls === "retail");
  const bay = style.window.bayWidth * (0.95 + h("b") * 0.15);
  const chimney = !outb && !block && roof !== "flat" && area > 35;
  let balcony = false; // balconies are not mapped; only drawn as an estimate below
  const entrance = !outb && !sacred && area >= 40;
  let wallPick = outb ? OUT_WALLS[Math.floor(h("wc") * OUT_WALLS.length)] : block ? BLOCK_WALLS[Math.floor(h("wc") * BLOCK_WALLS.length)] : null;
  let roofPick = outb ? OUT_ROOFS[Math.floor(h("rc") * OUT_ROOFS.length)] : null;
  let rail = "#efeeea";
  let roofMat: number = ROOF_MAT.tile;
  let finish = 0; // 0 plaster, 1 exposed brick, 2 grey block (unfinished facades)
  const ev = est && !sacred && !!b.recon && inDetailArea(b);
  if (ev) {
    const r = b.recon!;
    pitch = r.pitch ?? base + (block ? 4 : 9); overhang = Math.max(overhang, block ? 0.6 : 0.75);
    roofPick = r.rc ?? NEUTRAL.roof;
    roofMat = !r.mat ? ROOF_MAT.concrete : r.mat.startsWith("clay") ? ROOF_MAT.tile : ROOF_MAT.metal;
    wallPick = r.fc ?? (outb ? NEUTRAL.outb : NEUTRAL.wall);
    return {
      p4: true, ev, frameKind: 0, stone: false, porch: false, dormers: 0, cross: false, stair: false, shrubs: false,
      fascia: NEUTRAL.fascia, soffit: NEUTRAL.soffit, chimCol: null, pitch, overhang, facade, shop, bay: style.window.bayWidth,
      chimney: false, roof, trad: false, block, balcony: !!r.bal, entrance, wallPick, roofPick, rail, outb, roofMat, finish: 0, est, barn: false,
      seed: h("seed"), light: 0, roofLight: 0,
    };
  }
  if (est && !sacred && roof !== "flat") {
    // steeper snow roofs and deep eaves (estimate for the 900+ m valley)
    pitch += block ? 4 : 7 + h("pt") * 5;
    overhang = Math.max(overhang, block ? 0.6 : 0.75);
    const r = h("rm");
    if (outb) { roofMat = ROOF_MAT.metal; roofPick = METAL_ROOFS[Math.floor(h("rc") * METAL_ROOFS.length)]; wallPick = BARN_WALLS[Math.floor(h("wc") * BARN_WALLS.length)]; }
    else if (r < 0.42) { roofMat = ROOF_MAT.metal; roofPick = METAL_ROOFS[Math.floor(h("rc") * METAL_ROOFS.length)]; }
    else if (r < 0.88) { roofMat = ROOF_MAT.tile; roofPick = TILE_ROOFS[Math.floor(h("rc") * TILE_ROOFS.length)]; }
    else { roofMat = ROOF_MAT.concrete; roofPick = CONC_ROOFS[Math.floor(h("rc") * CONC_ROOFS.length)]; }
    if (!outb && !block) {
      const f = h("fin");
      finish = b.floors >= 2 && f < 0.14 ? 1 : b.floors >= 2 && f < 0.22 ? 2 : 0;
      if (finish === 0) wallPick = PLASTER[Math.floor(h("wc") * PLASTER.length)];
      else wallPick = finish === 1 ? "#b8664a" : "#9d9a94";
      // upper-floor balcony on houses with two or more storeys and a wall long enough for one
      balcony = b.floors >= 2 && Math.max(b.obb[3], b.obb[4]) >= 7 && h("bal") < 0.58;
      rail = h("rl") < 0.55 ? "#f1efe9" : h("rl") < 0.8 ? "#3e4247" : "#7a5638";
    } else if (block) balcony = h("bal") < 0.7;
  }
  // ---- Phase 4 regional detail (estimates): roof variants, timber or white joinery, stone ground floors, porches,
  // dormers, outside stairs, foundation planting. Deterministic per building id.
  const p4 = est && !sacred && inDetailArea(b);
  let roofK: RoofKind = roof;
  if (p4 && !outb && !block && roof === "hip" && h("hh") < 0.22) roofK = "halfhip";
  if (p4 && !outb && !block) { pitch += 2; overhang = Math.max(overhang, 0.9); }
  const frameKind = !p4 ? 0 : h("fr") < 0.55 ? 0 : h("fr") < 0.85 ? 1 : 2;      // 0 white PVC, 1 brown timber, 2 dark grey
  const stone = p4 && !outb && !block && finish === 0 && h("st") < 0.24;        // rubble-stone ground floor
  const porch = p4 && entrance && !block && area >= 70 && h("po") < 0.38;
  const dormers = false && p4 && !outb && !block && b.floors >= 2 && roofK !== "flat" && area >= 85 && h("dm") < 0.32 ? (Math.max(b.obb[3], b.obb[4]) >= 12 ? 2 : 1) : 0;
  const cross = false && p4 && !outb && !block && roofK !== "flat" && area >= 95 && b.obb[3] / Math.max(b.obb[4], 1) >= 1.25 && h("cg") < 0.3;
  const stair = p4 && !outb && !block && b.floors >= 2 && !balcony && h("stair") < 0.2;
  const shrubs = false; // Phase 5: foundation planting moved to surroundings.ts (rounder shrubs, on the terrain)
  const fascia = !p4 ? null : outb ? "#5b4636" : roofMat === ROOF_MAT.metal ? "#4f4740" : h("fa") < 0.55 ? "#efebe3" : "#5e4535";
  const soffit = !p4 ? null : outb ? "#6b5440" : h("so") < 0.6 ? "#8a6a4e" : "#d9d3c8";
  const chimCol = !p4 ? null : h("ch") < 0.5 ? "#a8a29a" : h("ch") < 0.8 ? "#9c5a44" : "#8d8b86";
  return {
    p4, ev: false, barn: outb && est, frameKind, stone, porch, dormers: cross ? 0 : dormers, cross, stair, shrubs, fascia, soffit, chimCol,
    pitch, overhang, facade, shop, bay, chimney, roof: roofK, trad, block, balcony, entrance, wallPick, roofPick, rail, outb, roofMat, finish, est,
    seed: h("seed"), light: (h("l") - 0.5) * 0.07, roofLight: (h("rl") - 0.5) * 0.08,
  };
}

/** Optional lookup: nearest road point to (x, y), used to put entrances on the street side. */
export type RoadLookup = (x: number, y: number) => P2 | null;

/** Optional colour override per building (geographic audit view); null keeps the normal colours. */
export type Tint = (b: Building) => string | null;

export function buildBuildings(list: Building[], datum: number, style: StyleConfig, road?: RoadLookup, tint?: Tint, est = false): BuildingMeshes {
  const W = { pos: [] as number[], col: [] as number[], uv: [] as number[], fl: [] as number[], st: [] as number[] };
  // small details (balconies, entrances): separate mesh, only drawn near the camera
  const D = { pos: [] as number[], col: [] as number[], uv: [] as number[], fl: [] as number[], st: [] as number[] };
  const R = { pos: [] as number[], col: [] as number[], uv: [] as number[], st: [] as number[] };
  const wallCols = style.walls.map((c) => new THREE.Color(c));
  const roofCols = style.roofs.map((c) => new THREE.Color(c));
  const white = new THREE.Color("#f2eee6");
  const flatCol = new THREE.Color("#b0aaa1");
  const fh = style.window.floorHeight;
  const chimCol = new THREE.Color("#a39c94");
  const ranges = new Int32Array(list.length * 5);

  for (let bi = 0; bi < list.length; bi++) {
    const b = list[bi];
    ranges[bi * 5] = bi;
    ranges[bi * 5 + 1] = W.pos.length / 3;
    ranges[bi * 5 + 3] = R.pos.length / 3;
    let ring = b.fp as P2[];
    if (ring.length < 3) continue;
    if (signedArea(ring) < 0) ring = [...ring].reverse();
    const [cx, cy, ang, Lfull, Wfull] = b.obb;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const toST = ([x, y]: P2): P2 => [(x - cx) * ca + (y - cy) * sa, -(x - cx) * sa + (y - cy) * ca];
    const toXY = ([s, t]: P2): P2 => [cx + s * ca - t * sa, cy + s * sa + t * ca];

    const ground = b.g0 + (b.g1 - b.g0) * 0.5;
    const eaveAbs = ground + b.eave;
    const base = b.g0 - 1.2 - datum;
    const eave = eaveAbs - datum;
    const sacred = b.cls === "mosque" || b.cls === "church";
    const vr = variation(b, style, est);
    const isFlat = vr.roof === "flat";
    const tc = tint?.(b);
    const wc = tc ? new THREE.Color(tc) : (sacred ? white : vr.wallPick ? new THREE.Color(vr.wallPick) : wallCols[b.v % wallCols.length]).clone().offsetHSL(0, 0, vr.light);
    const rc = tc ? new THREE.Color(tc).multiplyScalar(0.8) : (isFlat && !vr.ev ? flatCol : vr.roofPick ? new THREE.Color(vr.roofPick) : roofCols[(b.v * 7 + 3) % roofCols.length]).clone().offsetHSL(0, 0, vr.roofLight);
    const tan = Math.tan((vr.pitch * Math.PI) / 180), cosP = Math.cos((vr.pitch * Math.PI) / 180);
    const ov = vr.overhang, bay = vr.bay;
    const styleVal = (sacred ? FACADE.tall : vr.facade) + (vr.shop && !sacred ? 4 : 0) + (vr.trad ? 8 : 0) + (vr.outb ? 16 : 0) + (vr.finish === 1 ? 32 : vr.finish === 2 ? 64 : 0) + (vr.barn ? 128 : 0) + (vr.stone ? 256 : 0) + (vr.frameKind === 1 ? 512 : 0) + (vr.frameKind === 2 ? 1024 : 0) + (vr.p4 ? 2048 : 0) + (vr.ev ? NEUTRAL_BIT : 0) + vr.seed * 0.999;

    const L = Lfull / 2 + ov, Wd = Wfull / 2 + ov;
    const planes = isFlat ? [] : roofPlanes(vr.roof, L, Wd);
    const zE = eave - ov * tan;
    const roofZ = (s: number, t: number) => {
      let m = Infinity;
      for (const p of planes) m = Math.min(m, evalP(p, s, t));
      return zE + tan * Math.max(m, 0);
    };

    // ---- walls
    const n = ring.length;
    const pushWall = (x: number, y: number, z: number, u: number) => {
      W.pos.push(x, z, -y);
      W.col.push(wc.r, wc.g, wc.b);
      W.uv.push(u, (eave - z) / fh);
      W.fl.push(b.floors);
      W.st.push(styleVal);
    };
    for (let i = 0; i < n; i++) {
      const pa = ring[i], pb = ring[(i + 1) % n];
      const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      if (len < 0.05) continue;
      const nb = len >= 2.2 ? Math.max(1, Math.round(len / bay)) : 0;
      // breakpoints of the roof profile along this edge
      const ts = [0, 1];
      let topAt: (u: number) => number;
      if (isFlat) topAt = () => eave + 0.5;
      else {
        const sa_ = toST(pa), sb_ = toST(pb);
        const fA = planes.map((p) => evalP(p, sa_[0], sa_[1]));
        const fB = planes.map((p) => evalP(p, sb_[0], sb_[1]));
        for (let p = 0; p < planes.length; p++)
          for (let q = p + 1; q < planes.length; q++) {
            const den = fB[p] - fA[p] - (fB[q] - fA[q]);
            if (Math.abs(den) < 1e-9) continue;
            const u = (fA[q] - fA[p]) / den;
            if (u > 1e-4 && u < 1 - 1e-4) ts.push(u);
          }
        ts.sort((x, y) => x - y);
        topAt = (u: number) => {
          let m = Infinity;
          for (let p = 0; p < planes.length; p++) m = Math.min(m, fA[p] + (fB[p] - fA[p]) * u);
          return zE + tan * Math.max(m, 0);
        };
      }
      for (let k = 0; k < ts.length - 1; k++) {
        const u0 = ts[k], u1 = ts[k + 1];
        const x0 = pa[0] + (pb[0] - pa[0]) * u0, y0 = pa[1] + (pb[1] - pa[1]) * u0;
        const x1 = pa[0] + (pb[0] - pa[0]) * u1, y1 = pa[1] + (pb[1] - pa[1]) * u1;
        const t0 = topAt(u0), t1 = topAt(u1);
        // two triangles: (x0,base) (x1,base) (x1,t1) / (x0,base) (x1,t1) (x0,t0)
        pushWall(x0, y0, base, nb * u0); pushWall(x1, y1, base, nb * u1); pushWall(x1, y1, t1, nb * u1);
        pushWall(x0, y0, base, nb * u0); pushWall(x1, y1, t1, nb * u1); pushWall(x0, y0, t0, nb * u0);
      }
    }

    // chimney (estimate): small plastered box through the roof, off-centre along the ridge
    if (vr.chimney && !isFlat) {
      const cs = (hash01(b.id, "cx") - 0.5) * Math.max(Lfull - 3, 0) * 0.6, ct = (hash01(b.id, "ct") - 0.5) * Math.min(Wfull * 0.3, 2);
      const top = roofZ(cs, ct) + (vr.p4 ? 1.25 : 1.0), bot = roofZ(cs, ct) - 1.5, hw = vr.p4 ? 0.42 : 0.38;
      const chimC = vr.chimCol ? new THREE.Color(vr.chimCol) : chimCol;
      const corners: P2[] = [[cs - hw, ct - hw], [cs + hw, ct - hw], [cs + hw, ct + hw], [cs - hw, ct + hw]].map((q) => toXY(q as P2));
      const push = (x: number, y: number, z: number) => {
        W.pos.push(x, z, -y); W.col.push(chimC.r, chimC.g, chimC.b); W.uv.push(0, -1); W.fl.push(b.floors); W.st.push(styleVal);
      };
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
        push(ax, ay, bot); push(bx, by, bot); push(bx, by, top);
        push(ax, ay, bot); push(bx, by, top); push(ax, ay, top);
      }
      const [a, b2, c, d] = corners;
      push(a[0], a[1], top); push(b2[0], b2[1], top); push(c[0], c[1], top);
      push(a[0], a[1], top); push(c[0], c[1], top); push(d[0], d[1], top);
      if (vr.p4) {
        // concrete cap slab with a small overhang, lifted on corner posts (typical rain cap)
        const cc = new THREE.Color("#7d7a75"), cw = hw + 0.12, z0 = top + 0.22, z1 = top + 0.32;
        const cap: P2[] = [[cs - cw, ct - cw], [cs + cw, ct - cw], [cs + cw, ct + cw], [cs - cw, ct + cw]].map((q) => toXY(q as P2));
        const pushC = (x: number, y: number, z: number) => { W.pos.push(x, z, -y); W.col.push(cc.r, cc.g, cc.b); W.uv.push(0, -1); W.fl.push(b.floors); W.st.push(styleVal); };
        for (let i = 0; i < 4; i++) {
          const [ax, ay] = cap[i], [bx, by] = cap[(i + 1) % 4];
          pushC(ax, ay, z0); pushC(bx, by, z0); pushC(bx, by, z1); pushC(ax, ay, z0); pushC(bx, by, z1); pushC(ax, ay, z1);
          // dark gap under the cap (smoke outlet)
          const [px, py] = corners[i], [qx, qy] = corners[(i + 1) % 4];
          W.pos.push(px, top, -py, qx, top, -qy, qx, z0, -qy, px, top, -py, qx, z0, -qy, px, z0, -py);
          for (let k = 0; k < 6; k++) { W.col.push(0.16, 0.15, 0.14); W.uv.push(0, -1); W.fl.push(b.floors); W.st.push(styleVal); }
        }
        pushC(cap[0][0], cap[0][1], z1); pushC(cap[1][0], cap[1][1], z1); pushC(cap[2][0], cap[2][1], z1);
        pushC(cap[0][0], cap[0][1], z1); pushC(cap[2][0], cap[2][1], z1); pushC(cap[3][0], cap[3][1], z1);
      }
    }

    // ---- roof thickness (Phase 4): fascia / barge boards along every eave and rake, and the sloped soffit under the
    // overhang back to the wall, so roofs read as real timber-framed roofs instead of paper sheets.
    if (vr.p4 && !isFlat) {
      const fc = new THREE.Color(vr.fascia!), sc = new THREE.Color(vr.soffit!), th = 0.24;
      const eaveRing = offsetRing(ring, ov), wallZ = (p: P2) => { const q = toST(p); return roofZ(q[0], q[1]); };
      const pv = (x: number, y: number, z: number, c: THREE.Color) => { W.pos.push(x, z, -y); W.col.push(c.r, c.g, c.b); W.uv.push(0, -1); W.fl.push(b.floors); W.st.push(styleVal); };
      for (let i = 0; i < n; i++) {
        const ea = eaveRing[i], eb = eaveRing[(i + 1) % n], wa = ring[i], wb = ring[(i + 1) % n];
        const za = wallZ(ea), zb = wallZ(eb);
        // fascia (outward-facing band below the roof edge)
        pv(ea[0], ea[1], za - th, fc); pv(eb[0], eb[1], zb - th, fc); pv(eb[0], eb[1], zb + 0.02, fc);
        pv(ea[0], ea[1], za - th, fc); pv(eb[0], eb[1], zb + 0.02, fc); pv(ea[0], ea[1], za + 0.02, fc);
        // soffit: from the fascia bottom back to the wall, parallel to the roof
        const zwa = wallZ(wa) - th, zwb = wallZ(wb) - th;
        pv(ea[0], ea[1], za - th, sc); pv(wa[0], wa[1], zwa, sc); pv(wb[0], wb[1], zwb, sc);
        pv(ea[0], ea[1], za - th, sc); pv(wb[0], wb[1], zwb, sc); pv(eb[0], eb[1], zb - th, sc);
      }
    }

    // ---- details (estimates): entrance with door, canopy and step; balconies on upper floors
    if ((vr.entrance || vr.balcony || vr.p4) && n >= 3) {
      const zg = eave - b.floors * fh; // ground-floor level used by the facade shader
      const edges: { i: number; len: number; dx: number; dy: number; nx: number; ny: number }[] = [];
      for (let i = 0; i < n; i++) {
        const pa = ring[i], pb = ring[(i + 1) % n], len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        if (len < 3.2) continue;
        const dx = (pb[0] - pa[0]) / len, dy = (pb[1] - pa[1]) / len;
        edges.push({ i, len, dx, dy, nx: dy, ny: -dx });
      }
      if (edges.length) {
        const dc = (hex: string) => new THREE.Color(hex);
        const push = (x: number, y: number, z: number, c: THREE.Color) => {
          D.pos.push(x, z, -y); D.col.push(c.r, c.g, c.b); D.uv.push(0, -1); D.fl.push(b.floors); D.st.push(styleVal);
        };
        const quad = (p: number[][], c: THREE.Color) => {
          push(p[0][0], p[0][1], p[0][2], c); push(p[1][0], p[1][1], p[1][2], c); push(p[2][0], p[2][1], p[2][2], c);
          push(p[0][0], p[0][1], p[0][2], c); push(p[2][0], p[2][1], p[2][2], c); push(p[3][0], p[3][1], p[3][2], c);
        };
        // box on an edge frame: u along the edge (m from its start), o outward from the wall, z height
        const box = (e: typeof edges[0], u0: number, u1: number, o0: number, o1: number, z0: number, z1: number, c: THREE.Color, bottom = false) => {
          const pa = ring[e.i];
          const P = (u: number, o: number, z: number) => [pa[0] + e.dx * u + e.nx * o, pa[1] + e.dy * u + e.ny * o, z];
          quad([P(u0, o1, z0), P(u1, o1, z0), P(u1, o1, z1), P(u0, o1, z1)], c);                     // front
          quad([P(u1, o0, z0), P(u0, o0, z0), P(u0, o0, z1), P(u1, o0, z1)], c);                     // back
          quad([P(u0, o0, z0), P(u0, o1, z0), P(u0, o1, z1), P(u0, o0, z1)], c);                     // side
          quad([P(u1, o1, z0), P(u1, o0, z0), P(u1, o0, z1), P(u1, o1, z1)], c);                     // side
          quad([P(u0, o0, z1), P(u0, o1, z1), P(u1, o1, z1), P(u1, o0, z1)], c);                     // top
          if (bottom) quad([P(u0, o1, z0), P(u0, o0, z0), P(u1, o0, z0), P(u1, o1, z0)], c);
        };
        const longest = edges.reduce((m, e) => (e.len > m.len ? e : m), edges[0]);
        let front = longest;
        if (road) {
          const rp = road(cx, cy);
          if (rp) {
            let best = -Infinity;
            for (const e of edges) {
              const pa = ring[e.i], mx = pa[0] + e.dx * e.len / 2, my = pa[1] + e.dy * e.len / 2;
              const vx = rp[0] - mx, vy = rp[1] - my, vl = Math.hypot(vx, vy) || 1;
              const score = (vx * e.nx + vy * e.ny) / vl + Math.min(e.len, 10) * 0.03;
              if (score > best) { best = score; front = e; }
            }
          }
        }
        const nbOf = (e: typeof edges[0]) => Math.max(1, Math.round(e.len / bay));
        if (vr.entrance) {
          // door in the wall gap between two window bays (or a quarter along a one-bay wall)
          const nb = nbOf(front), bw = front.len / nb;
          const u = nb >= 2 ? Math.floor(nb / 2) * bw : front.len * 0.25 + 0.2;
          const doorC = dc(vr.trad ? "#5a3f2c" : hash01(b.id, "dr") < 0.5 ? "#6b4b36" : "#4c5057");
          box(front, u - 0.5, u + 0.5, -0.02, 0.06, zg, zg + 2.15, doorC);
          box(front, u - 0.6, u + 0.6, 0.0, 0.1, zg + 2.15, zg + 2.3, dc("#f1ede4"));            // lintel
          box(front, u - 0.85, u + 0.85, 0.0, 0.85, zg - 0.6, zg + 0.02, dc("#b3ada4"));         // step / stoop
          if (vr.porch) {
            // open porch (estimate): paved platform, two posts and a small lean-to roof in the house's roof colour
            const pc = dc(vr.frameKind === 1 ? "#6b4a33" : "#efebe3"), pw = Math.min(1.5, front.len / 2 - 0.3), dep = 2.0;
            box(front, u - pw, u + pw, 0.0, dep, zg - 0.6, zg + 0.04, dc("#b8b1a6"));
            for (const pu of [u - pw + 0.1, u + pw - 0.25]) box(front, pu, pu + 0.15, dep - 0.3, dep - 0.15, zg + 0.04, zg + 2.55, pc);
            const rc2 = rc.clone(), pa = ring[front.i];
            const P = (uu: number, o: number, z: number) => [pa[0] + front.dx * uu + front.nx * o, pa[1] + front.dy * uu + front.ny * o, z];
            quad([P(u - pw - 0.2, dep + 0.25, zg + 2.5), P(u + pw + 0.2, dep + 0.25, zg + 2.5), P(u + pw + 0.2, 0, zg + 3.05), P(u - pw - 0.2, 0, zg + 3.05)], rc2);
            quad([P(u + pw + 0.2, dep + 0.25, zg + 2.5), P(u - pw - 0.2, dep + 0.25, zg + 2.5), P(u - pw - 0.2, 0, zg + 3.05), P(u + pw + 0.2, 0, zg + 3.05)], rc2.clone().multiplyScalar(0.7));
            box(front, u - pw - 0.2, u + pw + 0.2, dep + 0.1, dep + 0.25, zg + 2.32, zg + 2.52, dc(vr.fascia ?? "#efebe3"));
          } else if (!vr.trad) box(front, u - 0.85, u + 0.85, 0.0, 0.95, zg + 2.45, zg + 2.57, dc(vr.block ? "#c9c5bd" : "#8f8a84"), true); // canopy
          if (vr.shrubs) {
            // foundation planting along the entrance wall (estimate): low shrubs and a few flowering perennials
            const greens = ["#4f7a3a", "#5d8a42", "#46703a", "#6b8f45"], flowers = ["#d9475a", "#f0c94a", "#e48bb0", "#f4f1ea", "#9a6fd0"];
            const nS = 4 + Math.floor(hash01(b.id, "ns") * 5);
            for (let k = 0; k < nS; k++) {
              const uu = 0.6 + hash01(b.id, "su" + k) * (front.len - 1.2);
              if (Math.abs(uu - u) < (vr.porch ? 1.9 : 1.2)) continue;
              const fl = hash01(b.id, "sf" + k) < 0.35, r = fl ? 0.35 : 0.5 + hash01(b.id, "sr" + k) * 0.35;
              const c = dc(fl ? flowers[Math.floor(hash01(b.id, "fc" + k) * flowers.length)] : greens[Math.floor(hash01(b.id, "gc" + k) * greens.length)]);
              const P = (o: number, uu2: number, z: number) => { const pa = ring[front.i]; return [pa[0] + front.dx * uu2 + front.nx * o, pa[1] + front.dy * uu2 + front.ny * o, z]; };
              const o = 0.55 + r, zc = zg - 0.6 + r * 0.8;
              // octahedron bush
              const top = P(o, uu, zc + r * 0.9), bot = P(o, uu, zg - 0.65), ring4 = [P(o + r, uu, zc), P(o, uu + r, zc), P(o - r, uu, zc), P(o, uu - r, zc)];
              for (let q = 0; q < 4; q++) {
                const a = ring4[q], c2 = ring4[(q + 1) % 4], shade = c.clone().multiplyScalar(0.85 + 0.15 * (q % 2));
                push(a[0], a[1], a[2], shade); push(c2[0], c2[1], c2[2], shade); push(top[0], top[1], top[2], shade.clone().multiplyScalar(1.12));
                push(c2[0], c2[1], c2[2], shade); push(a[0], a[1], a[2], shade); push(bot[0], bot[1], bot[2], shade.clone().multiplyScalar(0.7));
              }
            }
          }
        }
        // gutters along eave edges of pitched roofs (not gable ends), one downpipe at the first eave corner
        if (!isFlat && !vr.block) {
          const gut = dc("#6d6f72"), eaveRing = offsetRing(ring, ov);
          let piped = false;
          for (let i = 0; i < eaveRing.length; i++) {
            const pa = eaveRing[i], pb = eaveRing[(i + 1) % eaveRing.length], len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
            if (len < 1.5) continue;
            const mid = toST([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
            const zm = roofZ(mid[0], mid[1]);
            if (Math.abs(zm - zE) > 0.2) continue;
            const ux = (pb[0] - pa[0]) / len, uy = (pb[1] - pa[1]) / len, nx = uy * 0.06, ny = -ux * 0.06;
            quad([[pa[0] + nx, pa[1] + ny, zE - 0.2], [pb[0] + nx, pb[1] + ny, zE - 0.2], [pb[0] + nx, pb[1] + ny, zE - 0.02], [pa[0] + nx, pa[1] + ny, zE - 0.02]], gut);
            if (!piped) {
              piped = true;
              // downpipe from the gutter to the ground at the edge start, set back to the wall line
              const wx = pa[0] - (pa[0] - cx) / (Math.hypot(pa[0] - cx, pa[1] - cy) || 1) * ov * 0.9, wy = pa[1] - (pa[1] - cy) / (Math.hypot(pa[0] - cx, pa[1] - cy) || 1) * ov * 0.9;
              quad([[wx - ux * 0.05, wy - uy * 0.05, zg - 0.2], [wx + ux * 0.05, wy + uy * 0.05, zg - 0.2], [wx + ux * 0.05, wy + uy * 0.05, zE - 0.1], [wx - ux * 0.05, wy - uy * 0.05, zE - 0.1]], gut);
            }
          }
        }
        // exterior wooden stair to the upper floor on some 2-storey traditional houses (estimate, regional type)
        if ((vr.trad && b.floors >= 2 && hash01(b.id, "stair") < 0.45) || vr.stair) {
          const cand = edges.filter((e) => e !== front && e !== longest && e.len >= 4.2);
          const se = cand[0];
          if (se) {
            const wd = dc(vr.stair && hash01(b.id, "sc") < 0.5 ? "#b9b4ab" : "#6b4a33"), steps = 7, rise = fh / steps, run = 0.42, u0 = 0.4;
            for (let k = 0; k < steps; k++) box(se, u0 + k * run, u0 + (k + 1) * run, 0.05, 1.0, zg + k * rise - (k === 0 ? 0.3 : 0), zg + (k + 1) * rise, wd);
            const ul = u0 + steps * run;
            box(se, ul, ul + 1.1, 0.05, 1.0, zg + fh - 0.15, zg + fh, wd, true);                          // landing
            box(se, u0, ul + 1.1, 0.96, 1.02, zg + fh, zg + fh + 0.9, wd);                                // rail at the landing
            box(se, ul + 1.0, ul + 1.1, 0.05, 1.0, zg - 0.3, zg + fh - 0.15, wd);                         // post
          }
        }
        // ridge and hip caps (estimate, near only): a slim inverted V over every ridge line of near-rectangular roofs
        const rect = Math.abs(signedArea(ring)) / Math.max(Lfull * Wfull, 1) > 0.88;
        if (vr.p4 && !isFlat && rect) {
          const capC = rc.clone().multiplyScalar(vr.roofMat === ROOF_MAT.metal ? 0.82 : 0.78), zr = zE + tan * Wd;
          const segs: [P2, number, P2, number][] = [];
          if (vr.roof === "gable") segs.push([[-L, 0], zr, [L, 0], zr]);
          else {
            const k = vr.roof === "halfhip" ? Wd * 0.45 : 0, sr = Math.max(L + k - Wd, 0);
            segs.push([[-sr, 0], zr, [sr, 0], zr]);
            if (vr.roof === "hip") for (const sx of [-1, 1]) for (const ty of [-1, 1]) segs.push([[sx * sr, 0], zr, [sx * L, ty * Wd], zE]);
          }
          for (const [a, za, c, zc] of segs) {
            const A = toXY(a), C = toXY(c), dx = C[0] - A[0], dy = C[1] - A[1], l = Math.hypot(dx, dy);
            if (l < 0.3) continue;
            const px = (-dy / l) * 0.17, py = (dx / l) * 0.17;
            quad([[A[0] + px, A[1] + py, za - 0.02], [C[0] + px, C[1] + py, zc - 0.02], [C[0], C[1], zc + 0.08], [A[0], A[1], za + 0.08]], capC);
            quad([[C[0] - px, C[1] - py, zc - 0.02], [A[0] - px, A[1] - py, za - 0.02], [A[0], A[1], za + 0.08], [C[0], C[1], zc + 0.08]], capC);
          }
        }
        // dormers (estimate): small gabled dormers with a window on the roof slope facing the street side
        if ((vr.dormers || vr.cross) && rect && !isFlat) {
          let sg = 1;
          if (road) { const rp = road(cx, cy); if (rp) sg = toST(rp)[1] >= 0 ? 1 : -1; }
          // cross-gable: one wide gable rising from the wall plane over the central bays (a common way to light the attic)
          const wdh = vr.cross ? Math.min(Lfull * 0.17, 2.4) : 0.8, tf = vr.cross ? Wfull / 2 + 0.02 : Wfull / 2 - 0.7, wallC = wc.clone(), glass = dc("#2f3a44"), frm = dc(vr.frameKind === 1 ? "#6b4a33" : vr.frameKind === 2 ? "#3f4447" : "#f1eee8");
          const spots = vr.cross ? [0] : vr.dormers === 2 ? [-Lfull * 0.22, Lfull * 0.22] : [(hash01(b.id, "dmx") - 0.5) * Lfull * 0.3];
          for (const sd of spots) {
            const z0 = vr.cross ? roofZ(sd, sg * (Wfull / 2)) - 0.05 : roofZ(sd, sg * tf), z1 = z0 + (vr.cross ? 0.7 : 1.3), zp = z1 + (vr.cross ? wdh * tan * 0.85 : 0.6), ridgeZ = roofZ(sd, 0);
            if (zp > ridgeZ - 0.35 || Math.abs(sd) + wdh + 0.4 > L - (vr.roof === "gable" ? 0.4 : Wd * 0.9)) continue;
            const depth = (zp - z0) / tan + 0.2, tb = sg * (tf - depth);
            const X = (s2: number, t2: number, z: number) => { const q = toXY([s2, t2]); return [q[0], q[1], z]; };
            const fT = sg * tf;
            // front wall with gable
            quad([X(sd - wdh, fT, z0), X(sd + wdh, fT, z0), X(sd + wdh, fT, z1), X(sd - wdh, fT, z1)], wallC);
            const g1 = X(sd - wdh, fT, z1), g2 = X(sd + wdh, fT, z1), g3 = X(sd, fT, zp);
            push(g1[0], g1[1], g1[2], wallC); push(g2[0], g2[1], g2[2], wallC); push(g3[0], g3[1], g3[2], wallC);
            // window
            const wz0 = vr.cross ? z0 + 0.35 : z0 + 0.25, wz1 = vr.cross ? Math.min(zp - 0.45, z1 + 0.8) : z1 - 0.12, ww = vr.cross ? 0.55 : 0.5;
            if (wz1 - wz0 > 0.6) {
              quad([X(sd - ww, fT + sg * 0.02, wz0), X(sd + ww, fT + sg * 0.02, wz0), X(sd + ww, fT + sg * 0.02, wz1), X(sd - ww, fT + sg * 0.02, wz1)], frm);
              quad([X(sd - ww + 0.1, fT + sg * 0.04, wz0 + 0.08), X(sd + ww - 0.1, fT + sg * 0.04, wz0 + 0.08), X(sd + ww - 0.1, fT + sg * 0.04, wz1 - 0.08), X(sd - ww + 0.1, fT + sg * 0.04, wz1 - 0.08)], glass);
              quad([X(sd - 0.03, fT + sg * 0.05, wz0 + 0.08), X(sd + 0.03, fT + sg * 0.05, wz0 + 0.08), X(sd + 0.03, fT + sg * 0.05, wz1 - 0.08), X(sd - 0.03, fT + sg * 0.05, wz1 - 0.08)], frm);
            }
            // cheeks (side walls down to the main roof)
            for (const sx of [-1, 1]) {
              const a = X(sd + sx * wdh, fT, z0), c = X(sd + sx * wdh, fT, z1), d = X(sd + sx * wdh, sg * (tf - (z1 - z0) / tan), z1);
              push(a[0], a[1], a[2], wallC); push(c[0], c[1], c[2], wallC); push(d[0], d[1], d[2], wallC);
            }
            // dormer roof: two slopes from its ridge to the eaves, running back into the main roof
            const ov2 = 0.25, rcD = rc.clone();
            quad([X(sd - wdh - ov2, fT + sg * ov2, z1 - 0.1), X(sd - wdh - ov2, tb, z1 - 0.1), X(sd, tb, zp + 0.05), X(sd, fT + sg * ov2, zp + 0.05)], rcD);
            quad([X(sd, fT + sg * ov2, zp + 0.05), X(sd, tb, zp + 0.05), X(sd + wdh + ov2, tb, z1 - 0.1), X(sd + wdh + ov2, fT + sg * ov2, z1 - 0.1)], rcD);
          }
        }
        if (vr.balcony) {
          // balcony side: the longest wall, or the next longest when the entrance is there
          const others = edges.filter((e) => e !== front).sort((a, c) => c.len - a.len);
          const side = longest !== front || !others.length ? longest : others[0];
          const nb = nbOf(side), bw = side.len / nb;
          const railC = dc(vr.rail), slabC = dc(vr.trad ? "#5a3f2c" : "#d6d2ca");
          const dep = vr.trad ? 1.0 : 1.15;
          // bays that get a balcony: blocks every other bay, houses one or two central bays
          const bays: [number, number][] = [];
          if (vr.block) { for (let k = nb % 2 ? 0 : 1; k < nb && bays.length < 4; k += 2) bays.push([k * bw + 0.25, (k + 1) * bw - 0.25]); }
          else { const k0 = Math.max(0, Math.floor((nb - 1) / 2)), k1 = Math.min(nb, k0 + (nb >= 4 ? 2 : 1)); bays.push([k0 * bw + 0.2, k1 * bw - 0.2]); }
          const floorsWith = vr.block ? b.floors - 1 : 1;
          for (let f = 1; f <= floorsWith; f++) {
            const z = zg + f * fh;
            for (const [u0, u1] of bays) {
              if (u1 - u0 < 1.2) continue;
              box(side, u0, u1, 0, dep, z - 0.18, z, slabC, true);                                 // slab
              box(side, u0, u1, dep - 0.06, dep, z, z + 0.95, railC);                              // front railing
              box(side, u0, u0 + 0.06, 0, dep, z, z + 0.95, railC);                                // side railings
              box(side, u1 - 0.06, u1, 0, dep, z, z + 0.95, railC);
            }
          }
        }
      }
    }

    ranges[bi * 5 + 2] = W.pos.length / 3;
    ranges[bi * 5 + 3] = R.pos.length / 3;
    // ---- roof
    const pushRoof = (x: number, y: number, z: number, u: number, v: number) => {
      R.pos.push(x, z, -y);
      R.col.push(rc.r, rc.g, rc.b);
      R.uv.push(u, v);
      R.st.push(vr.roofMat + (vr.p4 ? 8 : 0));
    };
    if (isFlat) {
      const tris = triangulate(ring);
      for (const [x, y] of tris) pushRoof(x, y, eave + 0.25, x, y);
      ranges[bi * 5 + 4] = R.pos.length / 3;
      continue;
    }
    const outline = offsetRing(ring, ov).map(toST);
    for (let pi = 0; pi < planes.length; pi++) {
      const piece = roofRegion(outline, planes, pi);
      if (piece.length < 3 || Math.abs(signedArea(piece)) < 1e-3) continue;
      const tris = triangulate(piece);
      const pl = planes[pi], axisS = pl.a === 0;
      for (const st of tris) {
        const d = Math.max(evalP(pl, st[0], st[1]), 0);
        const z = roofZ(st[0], st[1]);
        const [x, y] = toXY(st);
        pushRoof(x, y, z, axisS ? st[0] : st[1], d / cosP);
      }
    }
    ranges[bi * 5 + 4] = R.pos.length / 3;
  }

  const walls = new THREE.BufferGeometry();
  walls.setAttribute("position", new THREE.Float32BufferAttribute(W.pos, 3));
  walls.setAttribute("color", new THREE.Float32BufferAttribute(W.col, 3));
  walls.setAttribute("aUv", new THREE.Float32BufferAttribute(W.uv, 2));
  walls.setAttribute("aFloors", new THREE.Float32BufferAttribute(W.fl, 1));
  walls.setAttribute("aStyle", new THREE.Float32BufferAttribute(W.st, 1));
  walls.computeVertexNormals();
  const roofs = new THREE.BufferGeometry();
  roofs.setAttribute("position", new THREE.Float32BufferAttribute(R.pos, 3));
  roofs.setAttribute("color", new THREE.Float32BufferAttribute(R.col, 3));
  roofs.setAttribute("aUv", new THREE.Float32BufferAttribute(R.uv, 2));
  roofs.setAttribute("aStyle", new THREE.Float32BufferAttribute(R.st, 1));
  fixWinding(roofs);
  roofs.computeVertexNormals();
  walls.computeBoundingSphere();
  roofs.computeBoundingSphere();
  const details = new THREE.BufferGeometry();
  details.setAttribute("position", new THREE.Float32BufferAttribute(D.pos, 3));
  details.setAttribute("color", new THREE.Float32BufferAttribute(D.col, 3));
  details.setAttribute("aUv", new THREE.Float32BufferAttribute(D.uv, 2));
  details.setAttribute("aFloors", new THREE.Float32BufferAttribute(D.fl, 1));
  details.setAttribute("aStyle", new THREE.Float32BufferAttribute(D.st, 1));
  details.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(D.fl.length), 1));
  details.computeVertexNormals();
  details.computeBoundingSphere();
  return { walls, roofs, details, count: list.length, ranges };
}

/**
 * One geometry per tile: walls and roofs merged (aPart 0 = wall, 1 = roof) so a tile is a single
 * draw call. `ranges` keeps per-building vertex spans for future picking/selection.
 */
export function buildBuildingTile(list: Building[], datum: number, style: StyleConfig, road?: RoadLookup, tint?: Tint, est = false) {
  const { walls, roofs, details, ranges } = buildBuildings(list, datum, style, road, tint, est);
  const nw = walls.getAttribute("position").count, nr = roofs.getAttribute("position").count;
  const g = new THREE.BufferGeometry();
  const cat = (name: string, size: number, roofDefault: number) => {
    const out = new Float32Array((nw + nr) * size);
    out.set((walls.getAttribute(name) as THREE.BufferAttribute).array as Float32Array, 0);
    const r = roofs.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (r) out.set(r.array as Float32Array, nw * size);
    else out.fill(roofDefault, nw * size);
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  };
  cat("position", 3, 0); cat("normal", 3, 0); cat("color", 3, 0); cat("aUv", 2, 0); cat("aFloors", 1, 0); cat("aStyle", 1, 0);
  const part = new Float32Array(nw + nr); part.fill(1, nw);
  g.setAttribute("aPart", new THREE.BufferAttribute(part, 1));
  walls.dispose(); roofs.dispose();
  for (let i = 0; i < ranges.length; i += 5) { ranges[i + 3] += nw; ranges[i + 4] += nw; }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.userData.ranges = ranges;
  g.userData.list = list;
  return { main: g, details };
}

/** Make every roof triangle face upward (triangulation order depends on clip results). */
function fixWinding(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const others = ["color", "aUv"].map((n) => g.getAttribute(n) as THREE.BufferAttribute);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (ny < 0) {
      for (const attr of [p, ...others]) {
        for (let k = 0; k < attr.itemSize; k++) {
          const t = attr.array[(i + 1) * attr.itemSize + k];
          (attr.array as Float32Array)[(i + 1) * attr.itemSize + k] = attr.array[(i + 2) * attr.itemSize + k];
          (attr.array as Float32Array)[(i + 2) * attr.itemSize + k] = t;
        }
      }
    }
  }
}
