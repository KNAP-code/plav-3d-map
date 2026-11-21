import * as THREE from "three";
import type { AreaData } from "@/data/load";
import { hash01, inDetailXY } from "./buildings";
import { offsetRing, signedArea, type P2 } from "./poly";

/**
 * Phase 4 house surroundings (ESTIMATES, only in the detail districts and only with ≈ on):
 * a paved or gravel path from each house's street-facing wall to the street, a parking pad beside some of them,
 * clipped hedges along parts of the back of some yards, and shrubs in the yards. Nothing here is mapped.
 * Everything is merged into one vertex-coloured mesh draped on the terrain.
 */
type Road = (x: number, y: number) => P2 | null;
const groundOf = (d: AreaData) => (x: number, y: number) => (d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y)) - d.datum;

function inPoly(p: P2, r: P2[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function surroundingsGeometry(d: AreaData, road: Road) {
  const pos: number[] = [], col: number[] = [];
  const h = groundOf(d);
  const put = (x: number, y: number, z: number, c: THREE.Color) => { pos.push(x, z, -y); col.push(c.r, c.g, c.b); };
  /** ground strip from a to b, width w, lifted by `lift`, draped every ~1 m */
  const strip = (a: P2, b: P2, w: number, c: THREE.Color, lift: number) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) return;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * w / 2, ny = ux * w / 2, n = Math.max(1, Math.ceil(L));
    for (let k = 0; k < n; k++) {
      const t0 = (k / n) * L, t1 = ((k + 1) / n) * L;
      const p = (t: number, s: number): [number, number, number] => { const x = a[0] + ux * t + nx * s, y = a[1] + uy * t + ny * s; return [x, y, h(x, y) + lift]; };
      const A = p(t0, -1), B = p(t1, -1), C = p(t1, 1), D = p(t0, 1);
      const cc = c.clone().multiplyScalar(0.94 + 0.12 * hash01(String(k), "pv" + a[0]));
      put(A[0], A[1], A[2], cc); put(B[0], B[1], B[2], cc); put(C[0], C[1], C[2], cc);
      put(A[0], A[1], A[2], cc); put(C[0], C[1], C[2], cc); put(D[0], D[1], D[2], cc);
    }
  };
  /** box along a ground line (hedge): from a to b, width w, height ht */
  const hedge = (a: P2, b: P2, w: number, ht: number, c: THREE.Color) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.8) return;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * w / 2, ny = ux * w / 2, n = Math.max(1, Math.ceil(L / 2));
    for (let k = 0; k < n; k++) {
      const t0 = (k / n) * L, t1 = ((k + 1) / n) * L;
      const g0 = h(a[0] + ux * t0, a[1] + uy * t0), g1 = h(a[0] + ux * t1, a[1] + uy * t1);
      const P = (t: number, s: number, z: number): [number, number, number] => [a[0] + ux * t + nx * s, a[1] + uy * t + ny * s, z];
      const top = (t: number, g: number) => g + ht * (0.92 + 0.16 * hash01(String(k), "ht" + t.toFixed(1)));
      const z0a = g0 - 0.2, z0b = g1 - 0.2, za = top(t0, g0), zb = top(t1, g1);
      const quad = (q: [number, number, number][], cc: THREE.Color) => { for (const i of [0, 1, 2, 0, 2, 3]) put(q[i][0], q[i][1], q[i][2], cc); };
      const side = c.clone().multiplyScalar(0.82), topC = c.clone().multiplyScalar(1.1);
      quad([P(t0, -1, z0a), P(t1, -1, z0b), P(t1, -1, zb), P(t0, -1, za)], side);
      quad([P(t1, 1, z0b), P(t0, 1, z0a), P(t0, 1, za), P(t1, 1, zb)], side);
      quad([P(t0, -1, za), P(t1, -1, zb), P(t1, 1, zb), P(t0, 1, za)], topC);
      if (k === 0) quad([P(t0, 1, z0a), P(t0, -1, z0a), P(t0, -1, za), P(t0, 1, za)], side);
      if (k === n - 1) quad([P(t1, -1, z0b), P(t1, 1, z0b), P(t1, 1, zb), P(t1, -1, zb)], side);
    }
  };
  /** rounded shrub: 7-sided blob with three rings and jittered radii (reads as a soft bush, ~35 triangles) */
  const shrub = (x: number, y: number, r: number, c: THREE.Color, seed = 0) => {
    const g = h(x, y) - 0.05, S = 7;
    const rings: [number, number][] = [[0.75, 0], [1.0, 0.55], [0.72, 1.15]];
    const pts = rings.map(([rr, dz], k) => Array.from({ length: S }, (_, i) => {
      const a = (i / S) * Math.PI * 2 + k * 0.45 + seed, j = 0.85 + 0.3 * hash01(String(i + 7 * k), "j" + seed.toFixed(2));
      return [x + Math.cos(a) * r * rr * j, y + Math.sin(a) * r * rr * j, g + dz * r] as [number, number, number];
    }));
    const top: [number, number, number] = [x, y, g + r * 1.45];
    const shade = (k: number, i: number) => c.clone().multiplyScalar(0.72 + 0.12 * k + 0.1 * hash01(String(i), "s" + k + seed.toFixed(2)));
    for (let k = 0; k < 2; k++) for (let i = 0; i < S; i++) {
      const a = pts[k][i], b = pts[k][(i + 1) % S], c2 = pts[k + 1][(i + 1) % S], d2 = pts[k + 1][i], cc = shade(k, i);
      put(a[0], a[1], a[2], cc); put(b[0], b[1], b[2], cc); put(c2[0], c2[1], c2[2], cc);
      put(a[0], a[1], a[2], cc); put(c2[0], c2[1], c2[2], cc); put(d2[0], d2[1], d2[2], cc);
    }
    for (let i = 0; i < S; i++) { const a = pts[2][i], b = pts[2][(i + 1) % S], cc = shade(2, i); put(a[0], a[1], a[2], cc); put(b[0], b[1], b[2], cc); put(top[0], top[1], top[2], cc.clone().multiplyScalar(1.08)); }
  };
  const gravel = new THREE.Color("#c9bfae"), flags = new THREE.Color("#b5ada2"), conc = new THREE.Color("#a9a59e");
  const hedgeC = ["#3f6a32", "#4a7638", "#3a5f2f"].map((c) => new THREE.Color(c));
  const shrubC = ["#4f7a3a", "#5d8a42", "#46703a", "#6b8f45", "#7a8f3f"].map((c) => new THREE.Color(c));
  const bloom = ["#b85a5a", "#d8b45a", "#c99aa6", "#e6e2d6", "#c07a62"].map((c) => new THREE.Color(c));

  // ---- paths and parking pads, per house in the detail districts
  for (const b of d.buildings) {
    const [cx, cy, , Lf, Wf] = b.obb;
    if (!inDetailXY(cx, cy) || b.kind === "outbuilding" || Lf * Wf < 40 || b.cls === "mosque" || b.cls === "church") continue;
    const rp = road(cx, cy); if (!rp) continue;
    let ring = b.fp as P2[]; if (signedArea(ring) < 0) ring = [...ring].reverse();
    // street-facing wall: outward normal most aligned with the direction to the street
    let best = -Infinity, mid: P2 | null = null, nrm: P2 = [0, 0];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length], len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 3.2) continue;
      const dx = (c[0] - a[0]) / len, dy = (c[1] - a[1]) / len, nx = dy, ny = -dx, mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
      const vx = rp[0] - mx, vy = rp[1] - my, vl = Math.hypot(vx, vy) || 1, sc = (vx * nx + vy * ny) / vl + Math.min(len, 10) * 0.03;
      if (sc > best) { best = sc; mid = [mx + nx * 0.9, my + ny * 0.9]; nrm = [nx, ny]; }
    }
    if (!mid) continue;
    {
      // foundation planting along the street-facing wall, clear of the door in the middle
      const tx = -nrm[1], ty = nrm[0], wallLen = Math.max(3, Math.min(Lf, 14));
      const nS = 2 + Math.floor(hash01(b.id, "fp") * 4);
      for (let k = 0; k < nS; k++) {
        const u = (hash01(b.id, "fu" + k) - 0.5) * (wallLen - 1.2);
        if (Math.abs(u) < 1.4) continue;
        const fl = hash01(b.id, "ff" + k) < 0.3, r = fl ? 0.38 : 0.5 + hash01(b.id, "fr" + k) * 0.3;
        const px = mid[0] - nrm[0] * 0.2 + tx * u, py = mid[1] - nrm[1] * 0.2 + ty * u;
        shrub(px, py, r, fl ? bloom[Math.floor(hash01(b.id, "fb" + k) * bloom.length)] : shrubC[Math.floor(hash01(b.id, "fc" + k) * shrubC.length)], k * 1.7);
      }
    }
    const dist = Math.hypot(rp[0] - mid[0], rp[1] - mid[1]);
    if (dist < 4.5 || dist > 26) continue;
    const ux = (rp[0] - mid[0]) / dist, uy = (rp[1] - mid[1]) / dist, end: P2 = [rp[0] - ux * 3.0, rp[1] - uy * 3.0];
    const paved = hash01(b.id, "pv") < 0.55;
    strip(mid, end, paved ? 1.3 : 1.1, paved ? flags : gravel, 0.2);
    if (Lf * Wf >= 80 && hash01(b.id, "pk") < 0.4 && dist > 9) {
      // parking pad beside the path, from the street edge 5.5 m into the yard
      const sgn = hash01(b.id, "ps") < 0.5 ? -1 : 1, ox = -uy * sgn * 2.6, oy = ux * sgn * 2.6;
      const a: P2 = [end[0] + ox, end[1] + oy], c: P2 = [end[0] + ox - ux * 5.5, end[1] + oy - uy * 5.5];
      if (!inPoly(c, ring) && !inPoly([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], ring)) strip(a, c, 2.8, hash01(b.id, "pm") < 0.5 ? conc : gravel, 0.19);
    }
  }

  // ---- hedges and shrubs in the yards of the detail districts
  d.gardens?.yards.forEach((y, i) => {
    const outer = y.outer as P2[];
    let mx = 0, my = 0; for (const [x, yy] of outer) { mx += x; my += yy; } mx /= outer.length; my /= outer.length;
    if (!inDetailXY(mx, my)) return;
    const key = String(i), holes = (y.holes ?? []) as P2[][];
    if (hash01(key, "hg") < 0.33) {
      const hc = hedgeC[Math.floor(hash01(key, "hc") * hedgeC.length)];
      for (let k = 0; k < outer.length; k++) {
        const a = outer[k], c = outer[(k + 1) % outer.length], len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (len < 2) continue;
        const ex = (a[0] + c[0]) / 2, ey = (a[1] + c[1]) / 2, rp = road(ex, ey);
        if (rp && Math.hypot(rp[0] - ex, rp[1] - ey) < 9) continue; // street side keeps its fence / stays open
        if (hash01(key, "he" + k) < 0.35) continue;
        // pull the hedge 0.5 m into the yard
        const ix = (mx - ex), iy = (my - ey), il = Math.hypot(ix, iy) || 1;
        const s = 0.5 / il;
        hedge([a[0] + ix * s, a[1] + iy * s], [c[0] + ix * s, c[1] + iy * s], 0.75, 1.15, hc);
      }
    }
    const nS = Math.floor(hash01(key, "ns") * 4);
    for (let k = 0, tries = 0; k < nS && tries < 20; tries++) {
      const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
      const p: P2 = [Math.min(...xs) + hash01(key, "sx" + tries) * (Math.max(...xs) - Math.min(...xs)), Math.min(...ys) + hash01(key, "sy" + tries) * (Math.max(...ys) - Math.min(...ys))];
      if (!inPoly(p, outer) || holes.some((hl) => inPoly(p, hl))) continue;
      const near = holes.some((hl) => hl.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 2.2));
      if (near) continue;
      const fl = hash01(key, "fl" + k) < 0.3;
      shrub(p[0], p[1], fl ? 0.45 : 0.6 + hash01(key, "sr" + k) * 0.5, fl ? bloom[Math.floor(hash01(key, "bc" + k) * bloom.length)] : shrubC[Math.floor(hash01(key, "sc" + k) * shrubC.length)], k + i * 0.13);
      k++;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Soft contact shadow on the ground around each house in the detail districts (all quality tiers; the high tier
 * also has screen-space AO). A 1.4 m ring fading from 38 % black at the wall to nothing, draped on the terrain.
 */
export function contactShadowGeometry(d: AreaData) {
  const pos: number[] = [], col: number[] = [];
  const h = groundOf(d);
  for (const b of d.buildings) {
    if (!inDetailXY(b.obb[0], b.obb[1])) continue;
    let ring = b.fp as P2[]; if (ring.length < 3) continue;
    if (signedArea(ring) < 0) ring = [...ring].reverse();
    const out = offsetRing(ring, 1.4), n = ring.length, a0 = b.kind === "outbuilding" ? 0.26 : 0.38;
    const v = (p: P2, a: number) => { pos.push(p[0], h(p[0], p[1]) + 0.24, -p[1]); col.push(0.05, 0.05, 0.04, a); };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      v(ring[i], a0); v(ring[j], a0); v(out[j], 0);
      v(ring[i], a0); v(out[j], 0); v(out[i], 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}
