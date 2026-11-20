import * as THREE from "three";
import type { Building } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { clipConvex, offsetRing, signedArea, triangulate, type P2 } from "./poly";

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

function roofFaces(kind: "hip" | "gable", L: number, W: number): { planes: Plane[]; faces: Face[] } {
  const planes: Plane[] = [
    { a: 0, b: -1, c: W }, // long side +t
    { a: 0, b: 1, c: W },  // long side -t
    { a: -1, b: 0, c: L }, // end +s
    { a: 1, b: 0, c: L },  // end -s
  ];
  if (kind === "gable") {
    return {
      planes: planes.slice(0, 2),
      faces: [
        { plane: 0, axis: "s", poly: [[-4 * L, 0], [4 * L, 0], [4 * L, 4 * W], [-4 * L, 4 * W]] },
        { plane: 1, axis: "s", poly: [[-4 * L, -4 * W], [4 * L, -4 * W], [4 * L, 0], [-4 * L, 0]] },
      ],
    };
  }
  const r = Math.max(L - W, 0);
  const E = 3 * W + 1;
  return {
    planes,
    faces: [
      { plane: 0, axis: "s", poly: [[-r, 0], [r, 0], [r + E, E], [-r - E, E]] },
      { plane: 1, axis: "s", poly: [[-r - E, -E], [r + E, -E], [r, 0], [-r, 0]] },
      { plane: 2, axis: "t", poly: [[r, 0], [r + E, -E], [r + E, E]] },
      { plane: 3, axis: "t", poly: [[-r, 0], [-r - E, E], [-r - E, -E]] },
    ],
  };
}

const evalP = (p: Plane, s: number, t: number) => p.a * s + p.b * t + p.c;

export type BuildingMeshes = {
  walls: THREE.BufferGeometry; roofs: THREE.BufferGeometry; count: number;
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

/** Facade window layouts (shader reads floor(aStyle) % 4; +4 = shop ground floor; fraction = per-building seed). */
export const FACADE = { grid: 0, tall: 1, paired: 2, band: 3 } as const;

/**
 * Deterministic architectural variation (all estimates, flagged in DATA_SOURCES.md):
 * roof pitch and overhang by building type, window layout, bay width, colour jitter, chimneys.
 */
export function variation(b: Building, style: StyleConfig) {
  const area = b.obb[3] * b.obb[4];
  const block = b.floors >= 4 || (b.floors >= 3 && area > 260);
  const small = area < 60 || b.floors <= 1;
  const h = (k: string) => hash01(b.id, k);
  const base = style.roof.pitchDeg;
  // houses: steeper (traditional), blocks: shallow; gables a little steeper than hips
  let pitch = block ? base - 10 + h("p") * 5 : small ? base + 2 + h("p") * 8 : base - 3 + h("p") * 9;
  if (b.roof === "gable") pitch += 3;
  const overhang = style.roof.overhang * (block ? 0.8 : 0.75 + h("o") * 0.6);
  const r = h("f");
  const facade = block ? (r < 0.6 ? FACADE.band : FACADE.grid) : small ? (r < 0.7 ? FACADE.grid : FACADE.tall) : r < 0.45 ? FACADE.grid : r < 0.75 ? FACADE.tall : FACADE.paired;
  const shop = !small && b.floors >= 2 && (b.cls === "commercial" || b.cls === "retail" || h("s") < 0.12);
  const bay = style.window.bayWidth * (0.85 + h("b") * 0.35);
  const chimney = !block && b.roof !== "flat" && area > 35 && h("c") < 0.8;
  return { pitch, overhang, facade, shop, bay, chimney, seed: h("seed"), light: (h("l") - 0.5) * 0.07, roofLight: (h("rl") - 0.5) * 0.08 };
}

export function buildBuildings(list: Building[], datum: number, style: StyleConfig): BuildingMeshes {
  const W = { pos: [] as number[], col: [] as number[], uv: [] as number[], fl: [] as number[], st: [] as number[] };
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
    const isFlat = b.roof === "flat";
    const sacred = b.cls === "mosque" || b.cls === "church";
    const vr = variation(b, style);
    const wc = (sacred ? white : wallCols[b.v % wallCols.length]).clone().offsetHSL(0, 0, vr.light);
    const rc = (isFlat ? flatCol : roofCols[(b.v * 7 + 3) % roofCols.length]).clone().offsetHSL(0, 0, vr.roofLight);
    const tan = Math.tan((vr.pitch * Math.PI) / 180), cosP = Math.cos((vr.pitch * Math.PI) / 180);
    const ov = vr.overhang, bay = vr.bay;
    const styleVal = (sacred ? FACADE.tall : vr.facade) + (vr.shop && !sacred ? 4 : 0) + vr.seed * 0.999;

    const L = Lfull / 2 + ov, Wd = Wfull / 2 + ov;
    const { planes, faces } = isFlat ? { planes: [], faces: [] } : roofFaces(b.roof === "gable" ? "gable" : "hip", L, Wd);
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
    for (const f of faces) {
      const piece = clipConvex(outline, f.poly);
      if (piece.length < 3) continue;
      const tris = triangulate(piece);
      const pl = planes[f.plane];
      for (const st of tris) {
        const d = Math.max(evalP(pl, st[0], st[1]), 0);
        const z = roofZ(st[0], st[1]);
        const [x, y] = toXY(st);
        pushRoof(x, y, z, f.axis === "s" ? st[0] : st[1], d / cosP);
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
  return { walls, roofs, count: list.length, ranges };
}

/**
 * One geometry per tile: walls and roofs merged (aPart 0 = wall, 1 = roof) so a tile is a single
 * draw call. `ranges` keeps per-building vertex spans for future picking/selection.
 */
export function buildBuildingTile(list: Building[], datum: number, style: StyleConfig) {
  const { walls, roofs, ranges } = buildBuildings(list, datum, style);
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
  return g;
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
