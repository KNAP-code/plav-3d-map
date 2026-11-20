import * as THREE from "three";
import type { AreaData, Heightfield } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { densify, subdivide, triangulate, type P2 } from "./poly";
import { LIT_CLASSES, polyLength, roadNodes, roadWidth } from "./roads";
import { carriageTriangles } from "./streetscape";

/** Classes whose carriageway is part of the unioned asphalt surface from streets.json (same list as pipeline/streets.py). */
const CARRIAGE = new Set(["secondary", "tertiary", "primary", "residential", "unclassified", "living_street", "service", "unknown"]);

/** Height sampler that prefers the detailed core grid. */
export function makeSampler(d: AreaData) {
  return (x: number, y: number) => (d.core.contains(x, y) ? d.core.at(x, y) : d.context.at(x, y));
}

/** Grid mesh for a heightfield, with an optional downward skirt on the border. stride > 1 skips samples (LOD). */
export function terrainGeometry(hf: Heightfield, datum: number, skirt = 0, stride = 1): THREE.BufferGeometry {
  const { x0, y0, nx: NX, ny: NY, step } = hf.g;
  const pick = (n: number) => { const a: number[] = []; for (let i = 0; i < n - 1; i += stride) a.push(i); a.push(n - 1); return a; };
  const xs = pick(NX), ys = pick(NY), nx = xs.length, ny = ys.length;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, si = xs[i], sj = ys[j];
      pos[k * 3] = x0 + si * step;
      pos[k * 3 + 1] = hf.h[sj * NX + si] - datum;
      pos[k * 3 + 2] = -(y0 + sj * step);
      uv[k * 2] = si / (NX - 1);
      uv[k * 2 + 1] = sj / (NY - 1);
    }
  const idx: number[] = [];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      // CCW seen from +Y (remember z = -y)
      idx.push(a, b, d, a, d, c);
    }
  let P: number[] = Array.from(pos), U: number[] = Array.from(uv);
  if (skirt > 0) {
    const border: number[] = [];
    for (let i = 0; i < nx; i++) border.push(i);
    for (let j = 1; j < ny; j++) border.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) border.push((ny - 1) * nx + i);
    for (let j = ny - 2; j > 0; j--) border.push(j * nx);
    border.push(0);
    const start = P.length / 3;
    for (const k of border) {
      P.push(pos[k * 3], pos[k * 3 + 1] - skirt, pos[k * 3 + 2]);
      U.push(uv[k * 2], uv[k * 2 + 1]);
    }
    for (let m = 0; m < border.length - 1; m++) {
      const a = border[m], b = border[m + 1], c = start + m, d = start + m + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Split an indexed mesh into n×n tiles by triangle centroid. Tiles share the vertex attributes
 * (uploaded once) and only own an index + bounding sphere, so the renderer can frustum-cull them.
 */
export function splitTiles(g: THREE.BufferGeometry, n: number): THREE.BufferGeometry[] {
  const p = g.getAttribute("position") as THREE.BufferAttribute, idx = g.index!.array;
  g.computeBoundingBox();
  const bb = g.boundingBox!, w = bb.max.x - bb.min.x || 1, d = bb.max.z - bb.min.z || 1;
  const buckets: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const cx = (p.getX(a) + p.getX(b) + p.getX(c)) / 3, cz = (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
    const i = Math.min(n - 1, Math.floor(((cx - bb.min.x) / w) * n)), j = Math.min(n - 1, Math.floor(((cz - bb.min.z) / d) * n));
    buckets[j * n + i].push(a, b, c);
  }
  const v = new THREE.Vector3();
  return buckets.filter((b) => b.length).map((b) => {
    const t = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) t.setAttribute(name, attr);
    t.setIndex(new THREE.BufferAttribute(p.count > 65535 ? new Uint32Array(b) : new Uint16Array(b), 1));
    const box = new THREE.Box3();
    for (const k of b) box.expandByPoint(v.fromBufferAttribute(p, k));
    t.boundingBox = box;
    t.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return t;
  });
}

const ROAD_KIND: Record<string, number> = {
  secondary: 0, tertiary: 0, primary: 0, trunk: 0,
  residential: 1, unclassified: 1, living_street: 1, service: 1, unknown: 1,
  pedestrian: 2, path: 2, footway: 2, cycleway: 2, steps: 2, bridleway: 2,
  track: 3,
};
const ROAD_LIFT = [0.22, 0.18, 0.14, 0.12];

/**
 * Road ribbons draped on the terrain. aKind: 0 marked asphalt, 1 asphalt, 2 path, 3 track / unpaved.
 * aUv: x = metres along the piece, y = 0..1 across. aEnd = metres to the nearest junction end of the
 * piece (markings and edge bands fade out there). Junctions (3+ pieces) get a plain asphalt patch on top
 * so overlapping ribbons and their markings don't show through each other.
 * Heights follow the terrain mesh's own triangles (atTri) so roads don't dip into it.
 */
/** part "night": only the unmarked light-pool overlays (shown at night only); "day": everything else. */
export function roadsGeometry(d: AreaData, style: StyleConfig, part: "day" | "night" = "day"): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], kind: number[] = [], end: number[] = [];
  const h = (x: number, y: number) => (d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y));
  const { deg, width, pos: npos } = roadNodes(d, style);
  const isJ = (j: number | undefined) => j !== undefined && (deg.get(j) ?? 0) >= 3;
  // With streets.json, car roads are one unioned asphalt surface (filleted junctions); their ribbons only carry the
  // markings and the night light pools (kind 4 = marked, 5 = unmarked), drawn just above it. Bridges get decks.
  const surface = !!d.streets;
  for (const r of d.roads) {
    let k = ROAD_KIND[r.c] ?? 1;
    if (surface && (r.bridge || r.tunnel)) continue;
    const overlay = surface && CARRIAGE.has(r.c);
    // verified surface tags override the class look
    if (r.surf === "unpaved" || r.surf === "gravel" || r.surf === "dirt" || r.surf === "ground") k = k < 2 ? 3 : k;
    if (r.sc === "driveway" || r.sc === "parking_aisle") k = Math.max(k, 1);
    const w = roadWidth(style, r);
    const pts = densify(r.pts as P2[], overlay ? 6 : 3);
    if (pts.length < 2) continue;
    const total = polyLength(r.pts as [number, number][]);
    const e0 = isJ(r.j0), e1 = isJ(r.j1);
    const lit = LIT_CLASSES.has(r.c) && r.sc !== "driveway" && r.sc !== "parking_aisle" ? 0.25 : 0; // fraction = streetlit
    if (overlay) {
      if (k > 0.5 && !lit) continue; // unmarked, unlit: the asphalt surface alone is enough
      k = k < 0.5 ? 4 : 5;
    }
    if ((part === "night") !== (overlay && k === 5)) continue;
    const lift = overlay ? ROAD_LIFT[0] + 0.05 : ROAD_LIFT[Math.min(k, 3)];
    let acc = 0;
    const L: number[][] = [], R: number[][] = [], us: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      let m = 1;
      if (i > 0 && i < pts.length - 1) {
        const ax = p[0] - a[0], ay = p[1] - a[1], al = Math.hypot(ax, ay) || 1;
        m = Math.min(1 / Math.max((ax / al) * tx + (ay / al) * ty, 0.5), 2);
      }
      const nx = -ty * (w / 2) * m, ny = tx * (w / 2) * m;
      if (i > 0) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const lx = p[0] + nx, ly = p[1] + ny, rx = p[0] - nx, ry = p[1] - ny;
      const hc = h(p[0], p[1]);
      L.push([lx, Math.max(h(lx, ly), hc - 0.4) + lift - d.datum, -ly]);
      R.push([rx, Math.max(h(rx, ry), hc - 0.4) + lift - d.datum, -ry]);
      us.push(acc);
    }
    const scale = acc > 0 ? total / acc : 1;
    const endAt = (u: number) => Math.min(e0 ? u * scale : 1e4, e1 ? (acc - u) * scale : 1e4);
    for (let i = 0; i < pts.length - 1; i++) {
      const quad = [[L[i], 0, us[i]], [R[i], 1, us[i]], [R[i + 1], 1, us[i + 1]], [L[i], 0, us[i]], [R[i + 1], 1, us[i + 1]], [L[i + 1], 0, us[i + 1]]] as const;
      for (const [p, v, u] of quad) { pos.push(p[0], p[1], p[2]); uv.push(u, v); kind.push(k + lit); end.push(endAt(u)); }
    }
  }
  // junction patches: n-gon slightly above every ribbon meeting there
  if (surface && part === "day") {
    const t = carriageTriangles(d, ROAD_LIFT[0]);
    for (let i = 0; i < t.length; i += 3) { pos.push(t[i], t[i + 1], t[i + 2]); uv.push(0, 0.5); kind.push(6); end.push(0); }
  }
  for (const [j, n] of deg) {
    if (n < 3 || surface) continue;
    const [x, y] = npos.get(j)!, r = (width.get(j) ?? 5) * 0.52, seg = 12;
    const z = h(x, y) + ROAD_LIFT[0] + 0.04 - d.datum;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const pa = [x + Math.cos(a0) * r, y + Math.sin(a0) * r], pb = [x + Math.cos(a1) * r, y + Math.sin(a1) * r];
      const za = Math.max(h(pa[0], pa[1]) + ROAD_LIFT[0] + 0.04 - d.datum, z - 0.3), zb = Math.max(h(pb[0], pb[1]) + ROAD_LIFT[0] + 0.04 - d.datum, z - 0.3);
      for (const [px, py, pz] of [[x, y, z], [pa[0], pa[1], za], [pb[0], pb[1], zb]]) {
        pos.push(px, pz, -py); uv.push(12, 0.5); kind.push(1.25); end.push(0); // lit, moderate light pool
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aUv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute("aEnd", new THREE.Float32BufferAttribute(end, 1));
  fixUp(g);
  g.computeVertexNormals();
  return g;
}

/** Ribbons for streams (water lines). */
export function streamsGeometry(d: AreaData): THREE.BufferGeometry {
  const pos: number[] = [];
  const h = makeSampler(d);
  for (const s of d.streams) {
    const w = s.c === "river" ? 7 : s.c === "canal" ? 3 : s.c === "stream" ? 2.4 : 1.4;
    const pts = densify(s.pts as P2[], 4);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const l = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (-(y2 - y1) / l) * (w / 2), ny = ((x2 - x1) / l) * (w / 2);
      const v = (x: number, y: number) => [x, h(x, y) + 0.45 - d.datum, -y];
      const a = v(x1 + nx, y1 + ny), b = v(x1 - nx, y1 - ny), c = v(x2 - nx, y2 - ny), e = v(x2 + nx, y2 + ny);
      pos.push(...a, ...b, ...c, ...a, ...c, ...e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  fixUp(g);
  g.computeVertexNormals();
  return g;
}

/** Lakes are flat at their DEM level; river areas are draped. */
export function waterGeometry(d: AreaData): THREE.BufferGeometry {
  const pos: number[] = [];
  const h = makeSampler(d);
  for (const w of d.water) {
    let tris = triangulate(w.outer as P2[], w.holes as P2[][]);
    if (w.kind === "lake" && w.level != null) {
      const z = w.level - d.datum;
      for (const [x, y] of tris) pos.push(x, z, -y);
    } else {
      tris = subdivide(tris, 10);
      for (const [x, y] of tris) pos.push(x, h(x, y) + 1.25 - d.datum, -y);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  fixUp(g);
  g.computeVertexNormals();
  return g;
}

/** Land-use overlays (pitches, cemeteries, squares) draped on the terrain. */
export function overlaysGeometry(d: AreaData, style: StyleConfig): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const h = makeSampler(d);
  for (const o of d.overlays) {
    const c = new THREE.Color(style.overlays[o.k] ?? "#999");
    const tris = subdivide(triangulate(o.outer as P2[], o.holes as P2[][]), 8);
    for (const [x, y] of tris) { pos.push(x, h(x, y) + 0.1 - d.datum, -y); col.push(c.r, c.g, c.b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  fixUp(g);
  g.computeVertexNormals();
  return g;
}

/** Ensure triangles face +Y (non-indexed geometry). */
export function fixUp(g: THREE.BufferGeometry) {
  const attrs = Object.values(g.attributes) as THREE.BufferAttribute[];
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const A = p.array as Float32Array;
  for (let i = 0; i < p.count; i += 3) {
    const ax = A[i * 3], az = A[i * 3 + 2];
    const ny = (A[(i + 1) * 3 + 2] - az) * (A[(i + 2) * 3] - ax) - (A[(i + 1) * 3] - ax) * (A[(i + 2) * 3 + 2] - az);
    if (ny < 0)
      for (const at of attrs) {
        const s = at.itemSize, arr = at.array as Float32Array;
        for (let k = 0; k < s; k++) {
          const t = arr[(i + 1) * s + k];
          arr[(i + 1) * s + k] = arr[(i + 2) * s + k];
          arr[(i + 2) * s + k] = t;
        }
      }
  }
}

/** Split a non-indexed geometry into n×n tiles by triangle centroid so the renderer can frustum-cull them. */
export function splitNonIndexed(g: THREE.BufferGeometry, n: number): THREE.BufferGeometry[] {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  if (!p || p.count === 0) return [];
  g.computeBoundingBox();
  const bb = g.boundingBox!, w = bb.max.x - bb.min.x || 1, dd = bb.max.z - bb.min.z || 1;
  const buckets: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < p.count; t += 3) {
    const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3, cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
    const i = Math.min(n - 1, Math.floor(((cx - bb.min.x) / w) * n)), j = Math.min(n - 1, Math.floor(((cz - bb.min.z) / dd) * n));
    buckets[j * n + i].push(t);
  }
  const names = Object.keys(g.attributes);
  return buckets.filter((b) => b.length).map((b) => {
    const out = new THREE.BufferGeometry();
    for (const name of names) {
      const a = g.getAttribute(name) as THREE.BufferAttribute, sz = a.itemSize, arr = new Float32Array(b.length * 3 * sz);
      let o = 0;
      for (const t of b) for (let v = 0; v < 3; v++) for (let k = 0; k < sz; k++) arr[o++] = a.array[(t + v) * sz + k];
      out.setAttribute(name, new THREE.BufferAttribute(arr, sz));
    }
    out.computeBoundingSphere();
    return out;
  });
}
