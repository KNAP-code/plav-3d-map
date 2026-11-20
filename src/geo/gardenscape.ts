import * as THREE from "three";
import type { AreaData } from "@/data/load";
import { densify, triangulate, type P2 } from "./poly";

/**
 * ESTIMATED gardens (pipeline/gardens.py): yard lawns, street-side fences, vegetable plots and haystacks.
 * Nothing here is mapped; it is only drawn when estimated details are on (≈).
 */
const groundOf = (d: AreaData) => (x: number, y: number) => (d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y)) - d.datum;
const hash = (i: number, s: number) => ((((i + 1) * 2654435761) ^ (s * 2246822519)) >>> 0) / 4294967296;

/** Yard lawns (mown, slightly brighter and finer than the meadow) and vegetable plots (soil rows), vertex-coloured. */
export function yardGeometry(d: AreaData) {
  const pos: number[] = [], col: number[] = [];
  if (!d.gardens) return new THREE.BufferGeometry();
  const h = groundOf(d);
  // close to the base grass: a hint of a mown yard, not a patch
  const lawns = ["#87b94f", "#85b64e", "#89bb52", "#86b850"].map((c) => new THREE.Color(c));
  d.gardens.yards.forEach((y, i) => {
    const c = lawns[Math.floor(hash(i, 3) * lawns.length)];
    // yards are small (≤ 30 m): plain triangulation, a little higher above the ground instead of cutting into cells
    for (const [x, yy] of triangulate(y.outer as P2[], y.holes as P2[][])) {
      pos.push(x, h(x, yy) + 0.16, -yy); col.push(c.r, c.g, c.b);
    }
  });
  const soil = new THREE.Color("#8a6a4c"), green = new THREE.Color("#5f8f3c");
  for (const p of d.gardens.plots) {
    const ca = Math.cos(p.a), sa = Math.sin(p.a);
    // 7 rows across the plot, alternating soil and crop
    for (let r = 0; r < 7; r++) {
      const t0 = -2 + (r * 4) / 7, t1 = -2 + ((r + 1) * 4) / 7, c = r % 2 ? green : soil;
      const P = (s: number, t: number) => { const x = p.c[0] + ca * s - sa * t, y = p.c[1] + sa * s + ca * t; return [x, h(x, y) + 0.12 + (r % 2 ? 0.08 : 0), -y]; };
      const q = [P(-3.5, t0), P(3.5, t0), P(3.5, t1), P(-3.5, t1)];
      for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...q[k]); col.push(c.r, c.g, c.b); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  // all faces up
  const p = geo.getAttribute("position") as THREE.BufferAttribute, A = p.array as Float32Array, C = (geo.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
  for (let i = 0; i < p.count; i += 3) {
    const ax = A[i * 3], az = A[i * 3 + 2];
    const ny = (A[(i + 1) * 3 + 2] - az) * (A[(i + 2) * 3] - ax) - (A[(i + 1) * 3] - ax) * (A[(i + 2) * 3 + 2] - az);
    if (ny < 0) for (const arr of [A, C]) for (let k = 0; k < 3; k++) { const t = arr[(i + 1) * 3 + k]; arr[(i + 1) * 3 + k] = arr[(i + 2) * 3 + k]; arr[(i + 2) * 3 + k] = t; }
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Fences as one vertical strip per segment; the material cuts pickets / wire mesh out of it (aF = metres, height 0..1, kind). */
export function fenceGeometry(d: AreaData) {
  const pos: number[] = [], f: number[] = [];
  if (!d.gardens) return new THREE.BufferGeometry();
  const h = groundOf(d);
  for (const fe of d.gardens.fences) {
    const wood = fe.k === "wood" ? 0 : 1, H = wood === 0 ? 1.0 : 1.2;
    const pts = densify(fe.pts as P2[], 3);
    let u = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], l = Math.hypot(bx - ax, by - ay);
      const za = h(ax, ay), zb = h(bx, by);
      const q = [[ax, za - 0.05, -ay, u, 0], [bx, zb - 0.05, -by, u + l, 0], [bx, zb + H, -by, u + l, 1], [ax, za + H, -ay, u, 1]];
      for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(q[k][0], q[k][1], q[k][2]); f.push(q[k][3], q[k][4], wood); }
      u += l;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aF", new THREE.Float32BufferAttribute(f, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Haystack (plast): a dome-topped cone of hay around a central pole. Instance matrices for the estimated stacks. */
export function haystack() {
  const body = new THREE.CylinderGeometry(0.35, 1.25, 2.6, 8, 1); body.translate(0, 1.3, 0);
  const top = new THREE.ConeGeometry(0.42, 0.7, 8); top.translate(0, 2.95, 0);
  const pole = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 4, 1, true); pole.translate(0, 3.6, 0);
  const parts = [body, top, pole].map((g, i) => {
    const n = g.toNonIndexed(); n.deleteAttribute("uv");
    const c = new THREE.Color(i === 2 ? "#5a4632" : i === 1 ? "#a88a52" : "#b99a5e"), cnt = n.getAttribute("position").count, arr = new Float32Array(cnt * 3);
    for (let k = 0; k < cnt; k++) { arr[k * 3] = c.r; arr[k * 3 + 1] = c.g; arr[k * 3 + 2] = c.b; }
    n.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    return n;
  });
  const pos: number[] = [], col: number[] = [];
  for (const p of parts) { pos.push(...(p.getAttribute("position").array as Float32Array)); col.push(...(p.getAttribute("color").array as Float32Array)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function hayMatrices(d: AreaData) {
  const out: THREE.Matrix4[] = [];
  if (!d.gardens) return out;
  const h = groundOf(d), m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  d.gardens.hay.forEach(([x, y, s], i) => {
    q.setFromAxisAngle(up, hash(i, 5) * Math.PI * 2);
    out.push(m.compose(new THREE.Vector3(x, h(x, y) - 0.1, -y), q, new THREE.Vector3(s, s * (0.9 + hash(i, 6) * 0.2), s)).clone());
  });
  return out;
}

/** Fruit trees as extra tree instances (x, y, scale, kind 0.5 = garden fruit tree) for the tree system. */
export function fruitTrees(d: AreaData) {
  if (!d.gardens) return new Float32Array(0);
  const a = new Float32Array(d.gardens.fruit.length * 4);
  d.gardens.fruit.forEach(([x, y, s], i) => { a[i * 4] = x; a[i * 4 + 1] = y; a[i * 4 + 2] = s; a[i * 4 + 3] = 0.5; });
  return a;
}
