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
export function variation(b: Building, style: StyleConfig) {
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
  const pitch = block ? base - 8 : small ? base + 4 : roof === "gable" ? base + 3 : base;
  const overhang = style.roof.overhang * (block ? 0.8 : 1.0);
  const facade = block ? FACADE.band : FACADE.grid;
  const shop = !small && b.floors >= 2 && (b.cls === "commercial" || b.cls === "retail");
  const bay = style.window.bayWidth * (0.95 + h("b") * 0.15);
  const chimney = !outb && !block && roof !== "flat" && area > 35;
  const balcony = false; // balconies are not mapped; none are drawn
  const entrance = !outb && !sacred && area >= 40;
  const wallPick = outb ? OUT_WALLS[Math.floor(h("wc") * OUT_WALLS.length)] : block ? BLOCK_WALLS[Math.floor(h("wc") * BLOCK_WALLS.length)] : null;
  const roofPick = outb ? OUT_ROOFS[Math.floor(h("rc") * OUT_ROOFS.length)] : null;
  const rail = "#efeeea";
  return {
    pitch, overhang, facade, shop, bay, chimney, roof, trad, block, balcony, entrance, wallPick, roofPick, rail, outb,
    seed: h("seed"), light: (h("l") - 0.5) * 0.07, roofLight: (h("rl") - 0.5) * 0.08,
  };
}

/** Optional lookup: nearest road point to (x, y), used to put entrances on the street side. */
export type RoadLookup = (x: number, y: number) => P2 | null;

/** Optional colour override per building (geographic audit view); null keeps the normal colours. */
export type Tint = (b: Building) => string | null;

export function buildBuildings(list: Building[], datum: number, style: StyleConfig, road?: RoadLookup, tint?: Tint): BuildingMeshes {
  const W = { pos: [] as number[], col: [] as number[], uv: [] as number[], fl: [] as number[], st: [] as number[] };
  // small details (balconies, entrances): separate mesh, only drawn near the camera
  const D = { pos: [] as number[], col: [] as number[], uv: [] as number[], fl: [] as number[], st: [] as number[] };
  const R = { pos: [] as number[], col: [] as number[], uv: [] as number[] };
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
    const vr = variation(b, style);
    const isFlat = vr.roof === "flat";
    const tc = tint?.(b);
    const wc = tc ? new THREE.Color(tc) : (sacred ? white : vr.wallPick ? new THREE.Color(vr.wallPick) : wallCols[b.v % wallCols.length]).clone().offsetHSL(0, 0, vr.light);
    const rc = tc ? new THREE.Color(tc).multiplyScalar(0.8) : (isFlat ? flatCol : vr.roofPick ? new THREE.Color(vr.roofPick) : roofCols[(b.v * 7 + 3) % roofCols.length]).clone().offsetHSL(0, 0, vr.roofLight);
    const tan = Math.tan((vr.pitch * Math.PI) / 180), cosP = Math.cos((vr.pitch * Math.PI) / 180);
    const ov = vr.overhang, bay = vr.bay;
    const styleVal = (sacred ? FACADE.tall : vr.facade) + (vr.shop && !sacred ? 4 : 0) + (vr.trad ? 8 : 0) + (vr.outb ? 16 : 0) + vr.seed * 0.999;

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
      const top = roofZ(cs, ct) + 1.0, bot = roofZ(cs, ct) - 1.5, hw = 0.38;
      const corners: P2[] = [[cs - hw, ct - hw], [cs + hw, ct - hw], [cs + hw, ct + hw], [cs - hw, ct + hw]].map((q) => toXY(q as P2));
      const push = (x: number, y: number, z: number) => {
        W.pos.push(x, z, -y); W.col.push(chimCol.r, chimCol.g, chimCol.b); W.uv.push(0, -1); W.fl.push(b.floors); W.st.push(styleVal);
      };
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
        push(ax, ay, bot); push(bx, by, bot); push(bx, by, top);
        push(ax, ay, bot); push(bx, by, top); push(ax, ay, top);
      }
      const [a, b2, c, d] = corners;
      push(a[0], a[1], top); push(b2[0], b2[1], top); push(c[0], c[1], top);
      push(a[0], a[1], top); push(c[0], c[1], top); push(d[0], d[1], top);
    }

    // ---- details (estimates): entrance with door, canopy and step; balconies on upper floors
    if ((vr.entrance || vr.balcony) && n >= 3) {
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
          if (!vr.trad) box(front, u - 0.85, u + 0.85, 0.0, 0.95, zg + 2.45, zg + 2.57, dc(vr.block ? "#c9c5bd" : "#8f8a84"), true); // canopy
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
        if (vr.trad && b.floors >= 2 && hash01(b.id, "stair") < 0.45) {
          const cand = edges.filter((e) => e !== front && e !== longest && e.len >= 4.2);
          const se = cand[0];
          if (se) {
            const wd = dc("#6b4a33"), steps = 7, rise = fh / steps, run = 0.42, u0 = 0.4;
            for (let k = 0; k < steps; k++) box(se, u0 + k * run, u0 + (k + 1) * run, 0.05, 1.0, zg + k * rise - (k === 0 ? 0.3 : 0), zg + (k + 1) * rise, wd);
            const ul = u0 + steps * run;
            box(se, ul, ul + 1.1, 0.05, 1.0, zg + fh - 0.15, zg + fh, wd, true);                          // landing
            box(se, u0, ul + 1.1, 0.96, 1.02, zg + fh, zg + fh + 0.9, wd);                                // rail at the landing
            box(se, ul + 1.0, ul + 1.1, 0.05, 1.0, zg - 0.3, zg + fh - 0.15, wd);                         // post
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
export function buildBuildingTile(list: Building[], datum: number, style: StyleConfig, road?: RoadLookup, tint?: Tint) {
  const { walls, roofs, details, ranges } = buildBuildings(list, datum, style, road, tint);
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
