import * as THREE from "three";
import type { AreaData, Heightfield } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { densify, subdivide, triangulate, type P2 } from "./poly";

/** Height sampler that prefers the detailed core grid. */
export function makeSampler(d: AreaData) {
  return (x: number, y: number) => (d.core.contains(x, y) ? d.core.at(x, y) : d.context.at(x, y));
}

/** Grid mesh for a heightfield, with an optional downward skirt on the border. */
export function terrainGeometry(hf: Heightfield, datum: number, skirt = 0): THREE.BufferGeometry {
  const { x0, y0, nx, ny, step } = hf.g;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = x0 + i * step;
      pos[k * 3 + 1] = hf.h[k] - datum;
      pos[k * 3 + 2] = -(y0 + j * step);
      uv[k * 2] = i / (nx - 1);
      uv[k * 2 + 1] = j / (ny - 1);
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

const ROAD_KIND: Record<string, number> = {
  secondary: 0, tertiary: 0, primary: 0, trunk: 0,
  residential: 1, unclassified: 1, living_street: 1, service: 1, unknown: 1,
  pedestrian: 2, path: 2, footway: 2, cycleway: 2, steps: 2, bridleway: 2,
  track: 3,
};
const ROAD_LIFT = [0.22, 0.18, 0.14, 0.12];

/** Road ribbons draped on the terrain. aKind: 0 marked asphalt, 1 asphalt, 2 path, 3 track. */
export function roadsGeometry(d: AreaData, style: StyleConfig): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], kind: number[] = [];
  const h = makeSampler(d);
  for (const r of d.roads) {
    const k = ROAD_KIND[r.c] ?? 1;
    const w = style.roads.widths[r.c] ?? 3.5;
    const pts = densify(r.pts as P2[], 5);
    if (pts.length < 2) continue;
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
      L.push([lx, Math.max(h(lx, ly), hc - 0.4) + ROAD_LIFT[k] - d.datum, -ly]);
      R.push([rx, Math.max(h(rx, ry), hc - 0.4) + ROAD_LIFT[k] - d.datum, -ry]);
      us.push(acc);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const quad = [[L[i], 0, us[i]], [R[i], 1, us[i]], [R[i + 1], 1, us[i + 1]], [L[i], 0, us[i]], [R[i + 1], 1, us[i + 1]], [L[i + 1], 0, us[i + 1]]] as const;
      for (const [p, v, u] of quad) { pos.push(p[0], p[1], p[2]); uv.push(u, v); kind.push(k); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aUv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
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
