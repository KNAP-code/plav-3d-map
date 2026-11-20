import * as THREE from "three";
import type { AreaData } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { densify, type P2 } from "./poly";
import { roadNodes, roadWidth } from "./roads";

/**
 * Street details.
 * - Sidewalks with kerbs along the main town streets (tertiary and above). OSM has no sidewalk tagging here, so
 *   these are an ESTIMATE (documented); they stop short of junctions so crossing streets stay open.
 * - Mapped street furniture only (benches, fountains/drinking water, bus stops, parking and information signs)
 *   and mapped walls, at their mapped positions (pipeline/furniture.py).
 */
const SIDEWALK_CLASSES = new Set(["tertiary", "secondary", "primary", "trunk"]);
const SW = 1.7;      // sidewalk width (m), estimate
const KERB = 0.15;   // kerb height above the carriageway (m)
const ROAD_LIFT = 0.22; // must match landscape.ts ROAD_LIFT[0] (carriageway)

type Buf = { pos: number[]; col: number[] };
const push = (b: Buf, p: number[], c: THREE.Color) => { b.pos.push(p[0], p[1], p[2]); b.col.push(c.r, c.g, c.b); };
const tri = (b: Buf, p: number[], q: number[], r: number[], c: THREE.Color) => { push(b, p, c); push(b, q, c); push(b, r, c); };
const quad = (b: Buf, p: number[], q: number[], r: number[], s: number[], c: THREE.Color) => { tri(b, p, q, r, c); tri(b, p, r, s, c); };

function finish(b: Buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Cut `trim0` metres from the start and `trim1` from the end of a polyline. */
function trimLine(pts: P2[], trim0: number, trim1: number): P2[] {
  const L: number[] = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = L[L.length - 1], a = trim0, b = total - trim1;
  if (b - a < 2) return [];
  const at = (u: number): P2 => {
    for (let i = 1; i < pts.length; i++) if (u <= L[i] || i === pts.length - 1) {
      const t = (u - L[i - 1]) / Math.max(L[i] - L[i - 1], 1e-6);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    return pts[pts.length - 1];
  };
  const out: P2[] = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) if (L[i] > a && L[i] < b) out.push(pts[i]);
  out.push(at(b));
  return out;
}

export function sidewalksGeometry(d: AreaData, style: StyleConfig) {
  const b: Buf = { pos: [], col: [] };
  const h = (x: number, y: number) => (d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y));
  const { deg, width } = roadNodes(d, style);
  const top = new THREE.Color("#cbc6bd"), kerb = new THREE.Color("#e4e0d8"), edge = new THREE.Color("#a9a49b");
  for (const r of d.roads) {
    if (!SIDEWALK_CLASSES.has(r.c) || r.sc === "driveway" || r.bridge || r.tunnel) continue;
    const w = roadWidth(style, r);
    const trimAt = (j: number | undefined) => (j !== undefined && (deg.get(j) ?? 0) >= 3 ? (width.get(j) ?? w) * 0.5 + SW + 1.2 : 0);
    const pts = densify(trimLine(r.pts as P2[], trimAt(r.j0), trimAt(r.j1)), 3);
    if (pts.length < 2) continue;
    for (const side of [1, -1]) {
      const inner: number[][] = [], innerLow: number[][] = [], outer: number[][] = [], outerLow: number[][] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], a = pts[Math.max(i - 1, 0)], c = pts[Math.min(i + 1, pts.length - 1)];
        let tx = c[0] - a[0], ty = c[1] - a[1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = -ty * side, ny = tx * side;
        const road = h(p[0], p[1]) + ROAD_LIFT - d.datum;
        const ix = p[0] + nx * (w / 2), iy = p[1] + ny * (w / 2);
        const ox = p[0] + nx * (w / 2 + SW), oy = p[1] + ny * (w / 2 + SW);
        const zt = Math.max(road, h(ix, iy) + 0.05 - d.datum) + KERB;
        const zo = Math.max(zt, h(ox, oy) + 0.05 - d.datum + KERB * 0.5);
        inner.push([ix, zt, -iy]); innerLow.push([ix, road - 0.05, -iy]);
        outer.push([ox, zo, -oy]); outerLow.push([ox, h(ox, oy) - 0.3 - d.datum, -oy]);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        quad(b, inner[i], outer[i], outer[i + 1], inner[i + 1], top);          // walking surface
        quad(b, innerLow[i], inner[i], inner[i + 1], innerLow[i + 1], kerb);   // kerb face
        quad(b, outer[i], outerLow[i], outerLow[i + 1], outer[i + 1], edge);   // outer edge down to the ground
      }
    }
  }
  const g = finish(b);
  fixUpFacing(g);
  return g;
}

/** Make top faces point up (winding depends on side); vertical faces are drawn double-sided anyway. */
function fixUpFacing(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const c = g.getAttribute("color") as THREE.BufferAttribute;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    A.fromBufferAttribute(p, i); B.fromBufferAttribute(p, i + 1); C.fromBufferAttribute(p, i + 2);
    const ny = (B.z - A.z) * (C.x - A.x) - (B.x - A.x) * (C.z - A.z);
    if (ny < -1e-6) for (const at of [p, c]) for (let k = 0; k < 3; k++) {
      const t = at.array[(i + 1) * 3 + k];
      (at.array as Float32Array)[(i + 1) * 3 + k] = at.array[(i + 2) * 3 + k];
      (at.array as Float32Array)[(i + 2) * 3 + k] = t;
    }
  }
  g.computeVertexNormals();
}

/** Mapped street furniture and walls as one merged mesh. */
export function furnitureGeometry(d: AreaData) {
  const b: Buf = { pos: [], col: [] };
  const h = (x: number, y: number) => (d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y)) - d.datum;
  // nearest road direction, to align benches and signs with the street
  const dirAt = (x: number, y: number): [number, number] => {
    let best = Infinity, dir: [number, number] = [1, 0];
    for (const r of d.roads) for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), q = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
      if (q < best) { best = q; const l = Math.sqrt(l2); dir = [dx / l, dy / l]; }
    }
    return dir;
  };
  const C = (s: string) => new THREE.Color(s);
  // oriented box: centre (x,y), along u=(ux,uy) half-length a, across half-width c, z0..z1
  const box = (x: number, y: number, u: [number, number], a: number, c: number, z0: number, z1: number, col: THREE.Color, du = 0, dv = 0) => {
    const [ux, uy] = u, vx = -uy, vy = ux;
    const cx = x + ux * du + vx * dv, cy = y + uy * du + vy * dv;
    const P = (s: number, t: number, z: number) => [cx + ux * s * a + vx * t * c, z, -(cy + uy * s * a + vy * t * c)];
    quad(b, P(-1, -1, z0), P(1, -1, z0), P(1, -1, z1), P(-1, -1, z1), col);
    quad(b, P(1, 1, z0), P(-1, 1, z0), P(-1, 1, z1), P(1, 1, z1), col);
    quad(b, P(1, -1, z0), P(1, 1, z0), P(1, 1, z1), P(1, -1, z1), col);
    quad(b, P(-1, 1, z0), P(-1, -1, z0), P(-1, -1, z1), P(-1, 1, z1), col);
    quad(b, P(-1, -1, z1), P(1, -1, z1), P(1, 1, z1), P(-1, 1, z1), col);
  };
  const wood = C("#7a5a3e"), metal = C("#4d5157"), stone = C("#b9b2a6"), blue = C("#2f63b5"), white = C("#f1efe9"), glass = C("#9fb4c4");
  for (const p of d.furniture.points) {
    const g = h(p.x, p.y), u = dirAt(p.x, p.y);
    if (p.k === "bench") {
      box(p.x, p.y, u, 0.9, 0.22, g + 0.42, g + 0.48, wood);
      box(p.x, p.y, u, 0.9, 0.04, g + 0.48, g + 0.85, wood, 0, -0.22);
      for (const s of [-0.75, 0.75]) box(p.x, p.y, u, 0.05, 0.22, g - 0.1, g + 0.42, metal, s);
    } else if (p.k === "fountain") {
      // public drinking fountain (česma): stone block with a spout
      box(p.x, p.y, u, 0.35, 0.25, g - 0.2, g + 1.1, stone);
      box(p.x, p.y, u, 0.4, 0.3, g - 0.2, g + 0.25, stone.clone().multiplyScalar(0.85), 0, 0.3);
      box(p.x, p.y, u, 0.03, 0.12, g + 0.75, g + 0.8, metal, 0, 0.3);
    } else if (p.k === "bus_stop") {
      for (const s of [-1.3, 1.3]) box(p.x, p.y, u, 0.05, 0.05, g - 0.1, g + 2.4, metal, s, -0.6);
      box(p.x, p.y, u, 1.4, 0.04, g + 0.1, g + 2.2, glass, 0, -0.65);
      box(p.x, p.y, u, 1.55, 0.8, g + 2.4, g + 2.5, white, 0, -0.25);
      box(p.x, p.y, u, 0.03, 0.03, g - 0.1, g + 2.6, metal, 1.9, 0.3);
      box(p.x, p.y, u, 0.25, 0.03, g + 2.3, g + 2.75, C("#e2b400"), 1.9, 0.3);
    } else if (p.k === "parking" || p.k === "info") {
      box(p.x, p.y, u, 0.03, 0.03, g - 0.1, g + 2.3, metal);
      box(p.x, p.y, u, 0.3, 0.02, g + 1.75, g + 2.35, p.k === "parking" ? blue : C("#5b4a3b"));
    }
  }
  for (const w of d.furniture.walls) {
    const ht = w.k === "retaining_wall" ? 1.0 : w.k === "fence" ? 1.1 : 1.4, th = w.k === "fence" ? 0.05 : 0.22;
    const col = w.k === "fence" ? wood : stone;
    const pts = densify(w.pts as P2[], 3);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], l = Math.hypot(bx - ax, by - ay);
      if (l < 0.05) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, g = Math.min(h(ax, ay), h(bx, by));
      box(mx, my, [(bx - ax) / l, (by - ay) / l], l / 2 + 0.02, th, g - 0.3, g + ht, col);
    }
  }
  return finish(b);
}
