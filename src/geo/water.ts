import * as THREE from "three";
import type { AreaData, Marsh } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { densify, subdivide, triangulate, type P2 } from "./poly";
import { fixUp, makeSampler } from "./landscape";

/**
 * Phase 2 water. Every height here comes from the pipeline:
 *  - lakes: flat at their GLO-30 level (Plavsko jezero 904.5 m),
 *  - mapped river areas (Lim, Ljuča ...): the levelled profile of their centreline (pipeline/build.py river_profiles),
 *    which falls monotonically downstream and joins the lake level at the outlet / mouth,
 *  - streams without a mapped area: ribbons on the carved channel, as before.
 * The lake surface grid (pipeline/water.py) adds the Sentinel-2 reed / vegetation belt and the distance to the shore.
 */

const inPoly = (x: number, y: number, r: number[][]) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

type Box = { x0: number; y0: number; x1: number; y1: number };
const boxOf = (r: number[][]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
};

/** Nearest-station lookup on the river profiles (25 m hash). */
function riverIndex(d: AreaData) {
  const C = 25, cells = new Map<string, [number, number][]>();
  d.rivers.forEach((r, ri) => r.pts.forEach((p, pi) => {
    const k = `${Math.floor(p[0] / C)},${Math.floor(p[1] / C)}`;
    let a = cells.get(k); if (!a) cells.set(k, (a = [])); a.push([ri, pi]);
  }));
  /** surface (absolute m) of river `axis` (or any river when undefined) at x,y; searches up to `reach` m */
  return (x: number, y: number, axis?: number, reach = 150): { z: number; dist: number } | null => {
    const cx = Math.floor(x / C), cy = Math.floor(y / C);
    let best = Infinity, z = 0;
    for (let ring = 0; ring * C <= reach; ring++) {
      for (let i = cx - ring; i <= cx + ring; i++)
        for (let j = cy - ring; j <= cy + ring; j++) {
          if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== ring) continue;
          for (const [ri, pi] of cells.get(`${i},${j}`) ?? []) {
            if (axis !== undefined && ri !== axis) continue;
            const p = d.rivers[ri].pts[pi], dd = Math.hypot(p[0] - x, p[1] - y);
            if (dd < best) { best = dd; z = p[2]; }
          }
        }
      if (best < (ring - 0.5) * C) break; // nothing nearer can exist in outer rings
    }
    return best <= reach ? { z, dist: best } : null;
  };
}

/** Water surface (scene height, i.e. minus datum) at a point, or null when the point is not on mapped water. */
export function waterSurface(d: AreaData) {
  const riv = riverIndex(d);
  const polys = d.water.map((w) => ({ w, b: boxOf(w.outer) }));
  return (x: number, y: number): number | null => {
    for (const { w, b } of polys) {
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || !inPoly(x, y, w.outer)) continue;
      if (w.holes.some((h) => inPoly(x, y, h))) continue;
      if (w.kind === "lake" && w.level != null) return w.level - d.datum;
      if (w.axis !== undefined) { const s = riv(x, y, w.axis); if (s) return s.z - d.datum; }
    }
    return null;
  };
}

/** Distance from (x,y) to the nearest edge of a ring set (metres). */
function edgeDist(x: number, y: number, rings: number[][][], cap: number) {
  let best = cap * cap;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, ay] = r[j], [bx, by] = r[i];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const ex = ax + t * dx - x, ey = ay + t * dy - y, e = ex * ex + ey * ey;
      if (e < best) best = e;
    }
  return Math.sqrt(best);
}

/**
 * Lakes flat at their level; mapped river areas on their levelled profile (fallback for an area without a profile:
 * lowest ground within ~7 m + 1.05 m, the previous rule). Attributes: aShore = metres to the mapped bank for rivers
 * (-1 on lakes: the shader reads the lake grid instead), aFlow = unit flow direction on rivers (x, -y in scene).
 */
export function waterGeometry(d: AreaData): THREE.BufferGeometry {
  const pos: number[] = [], shore: number[] = [], flow: number[] = [];
  const h = makeSampler(d);
  const riv = riverIndex(d);
  for (const w of d.water) {
    let tris = triangulate(w.outer as P2[], w.holes as P2[][]);
    if (w.kind === "lake" && w.level != null) {
      const z = w.level - d.datum;
      for (const [x, y] of tris) { pos.push(x, z, -y); shore.push(-1); flow.push(0, 0); }
      continue;
    }
    tris = subdivide(tris, 10);
    const rings = [w.outer, ...w.holes];
    const cache = new Map<string, number>();
    const at = (x: number, y: number) => {
      const k = `${x.toFixed(1)},${y.toFixed(1)}`;
      let v = cache.get(k);
      if (v === undefined) {
        const s = w.axis !== undefined ? riv(x, y, w.axis, 400) : null;
        if (s) v = s.z;
        else {
          v = Infinity;
          for (const [dx, dy] of [[0, 0], [7, 0], [-7, 0], [0, 7], [0, -7], [5, 5], [-5, -5], [5, -5], [-5, 5]]) v = Math.min(v, h(x + dx, y + dy));
          v += 1.05;
        }
        cache.set(k, v);
      }
      return v;
    };
    const ax = w.axis !== undefined ? d.rivers[w.axis].pts : null;
    for (const [x, y] of tris) {
      pos.push(x, at(x, y) - d.datum, -y);
      shore.push(Math.min(30, edgeDist(x, y, rings, 30)));
      // flow direction: the profile segment nearest to this vertex
      let fx = 0, fy = 0;
      if (ax) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < ax.length - 1; i += 2) { const e = (ax[i][0] - x) ** 2 + (ax[i][1] - y) ** 2; if (e < bd) { bd = e; bi = i; } }
        const j = Math.min(bi + 1, ax.length - 1), i0 = Math.max(0, j - 1);
        const dx = ax[j][0] - ax[i0][0], dy = ax[j][1] - ax[i0][1], l = Math.hypot(dx, dy) || 1;
        fx = dx / l; fy = -dy / l;
      }
      flow.push(fx, fy);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aShore", new THREE.Float32BufferAttribute(shore, 1));
  g.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 2));
  fixUp(g);
  // water reads as one smooth sheet: every normal points up (faceted DEM normals showed as dark triangles)
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  return g;
}

/**
 * Ribbons for waterways without a mapped area (streams, ditches; rivers outside their mapped area). A river line uses
 * its levelled profile; streams sit on their carved channel. Intermittent streams are drawn narrower.
 * Culverted stretches (OSM layer=-1) and stretches inside lakes are already removed by the pipeline.
 */
export function streamsGeometry(d: AreaData): THREE.BufferGeometry {
  const pos: number[] = [], shore: number[] = [], flow: number[] = [];
  const h = makeSampler(d);
  const riv = riverIndex(d);
  const surf = waterSurface(d);
  for (const s of d.streams) {
    let w = s.c === "river" ? 7 : s.c === "canal" ? 3 : s.c === "stream" ? 2.4 : 1.4;
    if (s.i) w *= 0.6;
    const pts = densify(s.pts as P2[], 4);
    const zAt = (x: number, y: number) => {
      if (s.c === "river") { const r = riv(x, y, undefined, 20); if (r) return r.z - d.datum + 0.02; }
      return h(x, y) + 0.45 - d.datum;
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      // under a mapped water area the area itself is the water surface
      if (surf((x1 + x2) / 2, (y1 + y2) / 2) !== null) continue;
      const l = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (-(y2 - y1) / l) * (w / 2), ny = ((x2 - x1) / l) * (w / 2);
      const z1 = zAt(x1, y1), z2 = zAt(x2, y2);
      const a = [x1 + nx, z1, -(y1 + ny)], b = [x1 - nx, z1, -(y1 - ny)], c = [x2 - nx, z2, -(y2 - ny)], e = [x2 + nx, z2, -(y2 + ny)];
      pos.push(...a, ...b, ...c, ...a, ...c, ...e);
      shore.push(0, 0, 0, 0, 0, 0);
      const fx = (x2 - x1) / l, fy = -(y2 - y1) / l;
      for (let k = 0; k < 6; k++) flow.push(fx, fy);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aShore", new THREE.Float32BufferAttribute(shore, 1));
  g.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 2));
  fixUp(g);
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  return g;
}

/** Lake grid as a texture: r = vegetation cover, g = shore distance / 64 m (linear filtered; row 0 = south). */
export function marshTexture(m: Marsh) {
  const n = m.nx * m.ny, a = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { a[i * 4] = m.veg[i]; a[i * 4 + 1] = Math.min(255, m.shore[i] * 4); a[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(a, m.nx, m.ny, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const hash = (i: number, j: number) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };

/**
 * Reed / sedge belt: a low canopy over every 10 m lake cell where Sentinel-2 sees summer vegetation (NDVI), its
 * height following the cover (0.35–1.1 m above the water; real reed height not measured, stylised), its colour a blend
 * of the palette and the cell's own Sentinel-2 colour. Corner heights are shared, so cells merge into one surface that
 * slopes into the water at the belt's edge. Returns the canopy and the tuft instance matrices for the open-water edge.
 */
export function marshGeometry(d: AreaData, style: StyleConfig, tufts: 0 | 1 | 2) {
  const m = d.marsh!;
  const { nx, ny, step, x0, y0 } = m;
  const lakes = d.water.filter((w) => w.kind === "lake" && w.level != null).map((w) => ({ w, b: boxOf(w.outer) }));
  const lvl = new Float32Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (m.veg[k] < 30) continue;
      const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step;
      const L = lakes.find(({ w, b }) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && inPoly(x, y, w.outer));
      if (L) lvl[k] = L.w.level! - d.datum;
    }
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && !Number.isNaN(lvl[j * nx + i]);
  // walkways over the water (mapped piers and footbridges): the canopy is kept low along them, so they stay visible
  const clear = new Uint8Array((nx + 1) * (ny + 1));
  const walk: P2[] = [];
  for (const p of d.streets?.piers ?? []) walk.push(...densify([...p.outer, p.outer[0]] as P2[], 2));
  for (const b of d.streets?.bridges ?? []) if (/foot|path|pedestrian/.test(b.c)) walk.push(...densify(b.pts as P2[], 2));
  for (const [x, y] of walk) {
    const ci = (x - x0) / step, cj = (y - y0) / step;
    for (let i = Math.floor(ci - 0.7); i <= Math.ceil(ci + 0.7); i++)
      for (let j = Math.floor(cj - 0.7); j <= Math.ceil(cj + 0.7); j++)
        if (i >= 0 && j >= 0 && i <= nx && j <= ny && Math.hypot(i - ci, j - cj) * step < 7) clear[j * (nx + 1) + i] = 1;
  }
  // corner heights: mean cover of the up-to-4 cells around the corner; a corner touching open water sits at the water
  const cz = (i: number, j: number) => {
    let s = 0, c = 0, base = NaN, edge = false;
    for (const [di, dj] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const a = i + di, b = j + dj;
      if (on(a, b)) { s += m.veg[b * nx + a] / 255; c++; base = lvl[b * nx + a]; } else edge = true;
    }
    const v = s / Math.max(c, 1);
    const top = 0.35 + 0.75 * Math.min(1, Math.max(0, (v - 0.2) / 0.8)) + (hash(i, j) - 0.5) * 0.3;
    return base + (edge || clear[j * (nx + 1) + i] ? -0.05 : top);
  };
  const pos: number[] = [], col: number[] = [];
  const pal = [new THREE.Color(style.water.reed), new THREE.Color(style.water.reedDry)];
  const tmp = new THREE.Color(), s2 = new THREE.Color();
  const cornerCol = (i: number, j: number) => {
    let r = 0, g = 0, b = 0, c = 0;
    for (const [di, dj] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const a = Math.min(nx - 1, Math.max(0, i + di)), q = Math.min(ny - 1, Math.max(0, j + dj)), k = q * nx + a;
      if (!on(a, q)) continue;
      r += m.rgb[k * 3]; g += m.rgb[k * 3 + 1]; b += m.rgb[k * 3 + 2]; c++;
    }
    s2.setRGB(r / c / 255, g / c / 255, b / c / 255, THREE.SRGBColorSpace);
    tmp.copy(pal[0]).lerp(pal[1], hash(j, i) * 0.5).lerp(s2, 0.4);
    return [tmp.r, tmp.g, tmp.b];
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!on(i, j)) continue;
      const X0 = x0 + i * step, Y0 = y0 + j * step, X1 = X0 + step, Y1 = Y0 + step;
      const a = [X0, cz(i, j), -Y0], b = [X1, cz(i + 1, j), -Y0], c = [X1, cz(i + 1, j + 1), -Y1], e = [X0, cz(i, j + 1), -Y1];
      const ca = cornerCol(i, j), cb = cornerCol(i + 1, j), cc = cornerCol(i + 1, j + 1), ce = cornerCol(i, j + 1);
      pos.push(...a, ...b, ...c, ...a, ...c, ...e);
      col.push(...ca, ...cb, ...cc, ...ca, ...cc, ...ce);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  fixUp(g);
  g.computeVertexNormals();
  // tufts: on belt cells that border open water (the reed edge seen from the shore and the boats), and with
  // tufts = 2 (high tier) also one on every second dense cell inside the belt, standing out of the canopy
  const mats: THREE.Matrix4[] = [], cols: THREE.Color[] = [];
  if (tufts) {
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), Yax = new THREE.Vector3(0, 1, 0);
    const add = (i: number, j: number, t: number, k: number, hMul: number) => {
      const x = x0 + (i + hash(i + t, j)) * step, y = y0 + (j + hash(i, j + t)) * step;
      const sc = 0.8 + hash(i * 3 + t, j * 7) * 0.7;
      P.set(x, lvl[k], -y); q.setFromAxisAngle(Yax, hash(j + t, i) * Math.PI); S.set(sc * 1.6, sc * hMul * (1.2 + m.veg[k] / 255), sc * 1.6);
      mats.push(M.compose(P, q, S).clone());
      cols.push(pal[0].clone().lerp(pal[1], hash(i + 7 * t, j + 3)).multiplyScalar(0.8 + hash(j, i + t) * 0.3));
    };
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!on(i, j)) continue;
        const k = j * nx + i;
        const openNb = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !on(i + a, j + b) && m.shore[(j + b) * nx + (i + a)] > 0);
        if (openNb) { for (let t = 0; t < (tufts === 2 ? 3 : 2); t++) add(i, j, t, k, 1); continue; }
        if (tufts === 2 && m.veg[k] > 128 && (i + j) % 2 === 0 && !clear[j * (nx + 1) + i]) add(i, j, 5, k, 1.25);
      }
  }
  return { canopy: g, tufts: mats, tuftColors: cols };
}

/** One reed tuft: 5 thin leaning blades (10 triangles), 1 m tall before scaling, base at y = 0. */
export function tuftGeometry() {
  const pos: number[] = [];
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * Math.PI * 2, r = 0.18, lean = 0.22;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, tx = Math.cos(a) * (r + lean), tz = Math.sin(a) * (r + lean);
    const wx = -Math.sin(a) * 0.06, wz = Math.cos(a) * 0.06;
    pos.push(cx - wx, 0, cz - wz, cx + wx, 0, cz + wz, tx, 1 + (b % 2) * 0.25, tz);
    pos.push(cx + wx, 0, cz + wz, cx - wx, 0, cz - wz, tx, 1 + (b % 2) * 0.25, tz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
