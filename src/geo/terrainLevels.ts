import * as THREE from "three";
import type { AreaData, TerrainLevel } from "@/data/load";

/**
 * Real surrounding terrain (pipeline/terrain.py): nested 30 m / 60 m / 180 m levels centred on the town, each split
 * into chunks. Each chunk builds (lazily) one geometry per LOD stride 1, 2 or 4 with its own downward skirt, so a
 * chunk can switch detail independently without cracks showing; level borders are stitched in the baked data.
 * Cells covered by the next finer level (or, for L1, by the 8 m city core) are left out.
 */
export type Chunk = {
  level: number; i0: number; i1: number; j0: number; j1: number;
  /** chunk touches the city core: always full detail (the core hole is cut per cell) */
  pinned: boolean;
  box: THREE.Box3;
  geoms: Map<number, THREE.BufferGeometry>;
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Cell-index split of one level: uniform for L1, a 5×5 ring around the aligned square hole for coarser levels. */
function segments(L: TerrainLevel): number[] {
  const cells = L.meta.nx - 1;
  if (L.meta.hole == null) {
    const n = 4, out: number[] = [];
    for (let k = 0; k <= n; k++) out.push(Math.round((k * cells) / n));
    return out;
  }
  const h0 = Math.round((L.meta.half - L.meta.hole) / L.meta.step), h1 = cells - h0;
  return [0, Math.round(h0 / 2), h0, h1, h1 + Math.round((cells - h1) / 2), cells];
}

export function levelChunks(d: AreaData): Chunk[] {
  const out: Chunk[] = [];
  const c = d.meta.core;
  const core: Rect = { x0: c.x0, y0: c.y0, x1: c.x0 + (c.nx - 1) * c.step, y1: c.y0 + (c.ny - 1) * c.step };
  d.levels.forEach((L, li) => {
    const s = segments(L), { x0, y0, step } = L.meta;
    let lo = Infinity, hi = -Infinity;
    for (const v of L.hf.h) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let a = 0; a < s.length - 1; a++)
      for (let b = 0; b < s.length - 1; b++) {
        const i0 = s[a], i1 = s[a + 1], j0 = s[b], j1 = s[b + 1];
        const cx0 = x0 + i0 * step, cx1 = x0 + i1 * step, cy0 = y0 + j0 * step, cy1 = y0 + j1 * step;
        if (L.meta.hole != null) {
          const H = L.meta.hole;
          if (cx0 >= -H - 1e-6 && cx1 <= H + 1e-6 && cy0 >= -H - 1e-6 && cy1 <= H + 1e-6) continue; // inside the finer level
        }
        const pinned = li === 0 && cx0 < core.x1 && cx1 > core.x0 && cy0 < core.y1 && cy1 > core.y0;
        let clo = Infinity, chi = -Infinity;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = L.hf.h[j * L.meta.nx + i]; if (v < clo) clo = v; if (v > chi) chi = v; }
        const box = new THREE.Box3(new THREE.Vector3(cx0, clo - d.datum - 60, -cy1), new THREE.Vector3(cx1, chi - d.datum, -cy0));
        out.push({ level: li, i0, i1, j0, j1, pinned, box, geoms: new Map() });
      }
  });
  return out;
}

/** Per-level vertex normals from central differences; border vertices look into the next coarser level. */
const normalCache = new WeakMap<TerrainLevel, Float32Array>();
function levelNormals(d: AreaData, li: number): Float32Array {
  const L = d.levels[li];
  const hit = normalCache.get(L);
  if (hit) return hit;
  const { nx, ny, x0, y0, step } = L.meta;
  const outer = d.levels[li + 1]?.hf ?? L.hf;
  const H = (i: number, j: number) =>
    i < 0 || j < 0 || i >= nx || j >= ny ? outer.at(x0 + i * step, y0 + j * step) : L.hf.h[j * nx + i];
  const n = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step), dy = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      // scene axes: x = east, y = up, z = -north
      const vx = -dx, vy = 1, vz = dy, l = Math.hypot(vx, vy, vz);
      const k = (j * nx + i) * 3;
      n[k] = vx / l; n[k + 1] = vy / l; n[k + 2] = vz / l;
    }
  normalCache.set(L, n);
  return n;
}

function pick(a: number, b: number, s: number) {
  const r: number[] = [];
  for (let i = a; i < b; i += s) r.push(i);
  r.push(b);
  return r;
}

/** Geometry of one chunk at LOD stride s (built on first use, then cached on the chunk). */
export function chunkGeometry(d: AreaData, ch: Chunk, s: number): THREE.BufferGeometry {
  const hit = ch.geoms.get(s);
  if (hit) return hit;
  const L = d.levels[ch.level], { nx, ny, x0, y0, step } = L.meta;
  const N = levelNormals(d, ch.level);
  const xs = pick(ch.i0, ch.i1, s), ys = pick(ch.j0, ch.j1, s), w = xs.length, h = ys.length;
  const c = d.meta.core;
  const cx1 = c.x0 + (c.nx - 1) * c.step, cy1 = c.y0 + (c.ny - 1) * c.step;
  const inCore = (i: number, j: number) => {
    const x = x0 + i * step, y = y0 + j * step;
    return x >= c.x0 && x <= cx1 && y >= c.y0 && y <= cy1;
  };
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const push = (i: number, j: number, drop = 0) => {
    const k = j * nx + i;
    pos.push(x0 + i * step, L.hf.h[k] - d.datum - drop, -(y0 + j * step));
    nor.push(N[k * 3], N[k * 3 + 1], N[k * 3 + 2]);
    uv.push(i / (nx - 1), j / (ny - 1));
  };
  for (const j of ys) for (const i of xs) push(i, j);
  for (let b = 0; b < h - 1; b++)
    for (let a = 0; a < w - 1; a++) {
      // a cell whose four corners all lie in the 8 m city core is drawn by the core mesh instead
      if (ch.level === 0 && inCore(xs[a], ys[b]) && inCore(xs[a + 1], ys[b]) && inCore(xs[a], ys[b + 1]) && inCore(xs[a + 1], ys[b + 1])) continue;
      const p = b * w + a, q = p + 1, r = p + w, t = r + 1;
      idx.push(p, q, t, p, t, r); // CCW from +Y, same diagonal as Heightfield.atTri
    }
  // skirt: the chunk border dropped by about one LOD cell of relief, hides T-junction gaps between strides/levels
  const ring: [number, number][] = [];
  for (let a = 0; a < w; a++) ring.push([a, 0]);
  for (let b = 1; b < h; b++) ring.push([w - 1, b]);
  for (let a = w - 2; a >= 0; a--) ring.push([a, h - 1]);
  for (let b = h - 2; b >= 0; b--) ring.push([0, b]);
  const depth = 8 + s * step * 0.6;
  const start = pos.length / 3;
  for (const [a, b] of ring) push(xs[a], ys[b], depth);
  for (let m = 0; m < ring.length - 1; m++) {
    const top0 = ring[m][1] * w + ring[m][0], top1 = ring[m + 1][1] * w + ring[m + 1][0];
    const bot0 = start + m, bot1 = start + m + 1;
    idx.push(top0, bot0, bot1, top0, bot1, top1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.boundingBox = ch.box.clone();
  g.boundingSphere = ch.box.getBoundingSphere(new THREE.Sphere());
  ch.geoms.set(s, g);
  return g;
}

/** LOD stride for a chunk: the coarsest of 1/2/4 whose cell stays under `tol` radians as seen from the camera. */
export function chooseStride(d: AreaData, ch: Chunk, cam: THREE.Vector3, tol: number) {
  if (ch.pinned) return 1;
  const dist = Math.max(ch.box.distanceToPoint(cam), 1);
  const step = d.levels[ch.level].meta.step;
  let s = 1;
  while (s < 4 && (s * 2 * step) / dist <= tol) s *= 2;
  return s;
}
