import * as THREE from "three";
import type { AreaData } from "@/data/load";
import { densify, gridClip, triangulate, type P2 } from "./poly";

/**
 * City-wide street surfaces and mapped infrastructure from public/data/<area>/streets.json (pipeline/streets.py).
 * DATA: carriageway centrelines, bridge spans, power towers/lines, piers, pitches, cemetery outlines, crossings.
 * ESTIMATE (drawn only when estimates are shown): sidewalks, cemetery headstones. Widths, pylon heights and pitch
 * line layout are documented estimates applied to mapped features.
 */

type Buf = { pos: number[]; col: number[] };
const C = (s: string) => new THREE.Color(s);
const push = (b: Buf, p: number[], c: THREE.Color) => { b.pos.push(p[0], p[1], p[2]); b.col.push(c.r, c.g, c.b); };
const tri = (b: Buf, p: number[], q: number[], r: number[], c: THREE.Color) => { push(b, p, c); push(b, q, c); push(b, r, c); };
const quad = (b: Buf, p: number[], q: number[], r: number[], s: number[], c: THREE.Color) => { tri(b, p, q, r, c); tri(b, p, r, s, c); };

function finish(b: Buf, upFix = true) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
  if (upFix) fixUpOnly(g);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Flip near-horizontal triangles that face down (triangulation order varies); vertical faces are left alone. */
function fixUpOnly(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position") as THREE.BufferAttribute, c = g.getAttribute("color") as THREE.BufferAttribute;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    A.fromBufferAttribute(p, i); B.fromBufferAttribute(p, i + 1); D.fromBufferAttribute(p, i + 2);
    n.crossVectors(e1.subVectors(B, A), e2.subVectors(D, A));
    const l = n.length() || 1;
    if (n.y / l < -0.5) for (const at of [p, c]) for (let k = 0; k < 3; k++) {
      const t = at.array[(i + 1) * 3 + k];
      (at.array as Float32Array)[(i + 1) * 3 + k] = at.array[(i + 2) * 3 + k];
      (at.array as Float32Array)[(i + 2) * 3 + k] = t;
    }
  }
}

const groundOf = (d: AreaData) => (x: number, y: number) => (d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y)) - d.datum;

/** Asphalt carriageway polygons (junction fillets come from the pipeline), draped on the terrain mesh. */
export function carriageTriangles(d: AreaData, lift: number) {
  const out: number[] = [];
  if (!d.streets) return out;
  const h = groundOf(d);
  for (const p of d.streets.carriage) {
    const tris = gridClip(triangulate(p.outer as P2[], p.holes as P2[][]), d.core.g.x0, d.core.g.y0, d.core.g.step);
    for (const [x, y] of tris) out.push(x, h(x, y) + lift, -y);
  }
  return out;
}

/** Estimated sidewalks: raised slabs with a kerb face on every edge (paving joints come from the material). */
export function sidewalkGeometry(d: AreaData, roadLift: number) {
  const b: Buf = { pos: [], col: [] };
  if (!d.streets) return finish(b);
  const h = groundOf(d);
  const top = C("#cfcac1"), kerb = C("#e2ded6");
  const KERB = 0.15;
  for (const p of d.streets.sidewalks) {
    const z = (x: number, y: number) => h(x, y) + roadLift + KERB;
    for (const [x, y] of gridClip(triangulate(p.outer as P2[], p.holes as P2[][]), d.core.g.x0, d.core.g.y0, d.core.g.step)) push(b, [x, z(x, y), -y], top);
    for (const r of [p.outer, ...p.holes]) {
      const pts = densify([...r, r[0]] as P2[], 3);
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        quad(b, [ax, h(ax, ay) - 0.15, -ay], [bx, h(bx, by) - 0.15, -by], [bx, z(bx, by), -by], [ax, z(ax, ay), -ay], kerb);
      }
    }
  }
  return finish(b);
}

/**
 * Bridges on the exact mapped spans: deck following a straight grade between the two banks, slab edge and
 * parapets. Car bridges are concrete with an asphalt deck; foot bridges have a timber deck and rails (estimate).
 */
export function bridgeGeometry(d: AreaData, roadLift: number) {
  const b: Buf = { pos: [], col: [] };
  if (!d.streets) return finish(b);
  const h = groundOf(d);
  const conc = C("#b8b3aa"), asph = C("#5d6068"), wood = C("#8a6b4e"), rail = C("#9a958c");
  for (const br of d.streets.bridges) {
    const foot = /foot|path|cycle|pedestrian/.test(br.c);
    const pts = densify(br.pts as P2[], 2);
    if (pts.length < 2) continue;
    const L: number[] = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const tot = L[L.length - 1] || 1;
    const z0 = h(pts[0][0], pts[0][1]) + roadLift, z1 = h(pts[pts.length - 1][0], pts[pts.length - 1][1]) + roadLift;
    const hw = br.w / 2 + (foot ? 0 : 0.5);
    const deckC = foot ? wood : asph, sideC = foot ? wood : conc, railC = foot ? wood : rail;
    const railH = foot ? 1.0 : 0.95, thick = foot ? 0.35 : 0.8;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const l = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / l, ny = (bx - ax) / l;
      const za = z0 + (z1 - z0) * (L[i] / tot) + 0.05, zb = z0 + (z1 - z0) * (L[i + 1] / tot) + 0.05;
      const P = (x: number, y: number, o: number, z: number) => [x + nx * o, z, -(y + ny * o)];
      quad(b, P(ax, ay, -hw, za), P(bx, by, -hw, zb), P(bx, by, hw, zb), P(ax, ay, hw, za), deckC);                       // deck
      quad(b, P(ax, ay, hw, za - thick), P(bx, by, hw, zb - thick), P(bx, by, -hw, zb - thick), P(ax, ay, -hw, za - thick), sideC); // soffit
      if (foot) {
        // timber footbridge: deck edge boards, posts every ~2 m and a thin top rail (no solid parapet)
        for (const s of [-1, 1]) {
          const o = s * hw;
          quad(b, P(ax, ay, o, za - thick), P(bx, by, o, zb - thick), P(bx, by, o, zb + 0.08), P(ax, ay, o, za + 0.08), sideC);
          const oi = s * (hw - 0.08);
          quad(b, P(ax, ay, oi, za + railH - 0.08), P(bx, by, oi, zb + railH - 0.08), P(bx, by, oi, zb + railH), P(ax, ay, oi, za + railH), railC);
          quad(b, P(ax, ay, oi, za + railH * 0.5 - 0.05), P(bx, by, oi, zb + railH * 0.5 - 0.05), P(bx, by, oi, zb + railH * 0.5), P(ax, ay, oi, za + railH * 0.5), railC);
          const px = ax + nx * oi, py = ay + ny * oi, ux = (bx - ax) / l * 0.05, uy = (by - ay) / l * 0.05;
          quad(b, [px - ux, za, -(py - uy)], [px + ux, za, -(py + uy)], [px + ux, za + railH, -(py + uy)], [px - ux, za + railH, -(py - uy)], railC);
        }
        continue;
      }
      for (const s of [-1, 1]) {
        const o = s * hw;
        quad(b, P(ax, ay, o, za - thick), P(bx, by, o, zb - thick), P(bx, by, o, zb + railH), P(ax, ay, o, za + railH), s > 0 ? sideC : railC); // slab edge + parapet outer
        const oi = s * (hw - 0.2);
        quad(b, P(ax, ay, oi, za), P(bx, by, oi, zb), P(bx, by, oi, zb + railH), P(ax, ay, oi, za + railH), railC);         // parapet inner
        quad(b, P(ax, ay, oi, za + railH), P(bx, by, oi, zb + railH), P(bx, by, o, zb + railH), P(ax, ay, o, za + railH), railC); // parapet top
      }
    }
  }
  return finish(b, false);
}

/** Mapped pedestrian crossings: zebra stripes across the nearest carriageway. */
export function zebraGeometry(d: AreaData, roadLift: number, width: (c: string) => number) {
  const b: Buf = { pos: [], col: [] };
  const h = groundOf(d);
  const white = C("#f1efe8");
  for (const [x, y] of d.crossings) {
    let best = 400, dir: P2 = [1, 0], w = 6;
    for (const r of d.roads) {
      if (!/secondary|tertiary|residential|unclassified|living|primary/.test(r.c)) continue;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), q = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
        if (q < best) { best = q; const l = Math.sqrt(l2); dir = [dx / l, dy / l]; w = width(r.c); }
      }
    }
    if (best >= 400) continue;
    const [ux, uy] = dir, vx = -uy, vy = ux;
    for (let s = -w / 2 + 0.4; s < w / 2 - 0.3; s += 1.0) {
      const P = (a: number, c: number) => { const px = x + ux * a + vx * c, py = y + uy * a + vy * c; return [px, h(px, py) + roadLift + 0.07, -py]; };
      quad(b, P(-1.5, s), P(1.5, s), P(1.5, s + 0.5), P(-1.5, s + 0.5), white);
    }
  }
  return finish(b);
}

/** Mapped sports pitch: standard football markings scaled to the mapped size, and two goals (layout = estimate). */
export function pitchGeometry(d: AreaData) {
  const b: Buf = { pos: [], col: [] };
  if (!d.streets) return finish(b);
  const h = groundOf(d);
  const white = C("#f4f3ee");
  for (const p of d.streets.pitches) {
    if (p.L < 30 || p.W < 18) continue;
    const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
    const k = Math.min(1, p.W / 68);
    const P = (s: number, t: number, dz = 0.32) => { const x = p.x + s * ca - t * sa, y = p.y + s * sa + t * ca; return [x, h(x, y) + dz, -y]; };
    const line = (s0: number, t0: number, s1: number, t1: number, w = 0.3) => { // drawn wider than the real 0.12 m so it reads at map scale
      const l = Math.hypot(s1 - s0, t1 - t0) || 1, ns = (-(t1 - t0) / l) * w / 2, nt = ((s1 - s0) / l) * w / 2;
      const segs = Math.max(1, Math.ceil(l / 6));
      for (let i = 0; i < segs; i++) {
        const a = i / segs, c = (i + 1) / segs;
        const sa_ = s0 + (s1 - s0) * a, ta = t0 + (t1 - t0) * a, sc = s0 + (s1 - s0) * c, tc = t0 + (t1 - t0) * c;
        quad(b, P(sa_ - ns, ta - nt), P(sc - ns, tc - nt), P(sc + ns, tc + nt), P(sa_ + ns, ta + nt), white);
      }
    };
    const L = p.L / 2 - 1, W = p.W / 2 - 1;
    line(-L, -W, L, -W); line(L, -W, L, W); line(L, W, -L, W); line(-L, W, -L, -W); line(0, -W, 0, W);
    const R = 9.15 * k;
    for (let i = 0; i < 24; i++) { const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2; line(Math.cos(a0) * R, Math.sin(a0) * R, Math.cos(a1) * R, Math.sin(a1) * R); }
    for (const s of [-1, 1]) {
      const pd = 16.5 * k, pw = 20.15 * k, gd = 5.5 * k, gw = 9.15 * k;
      line(s * L, -pw, s * (L - pd), -pw); line(s * (L - pd), -pw, s * (L - pd), pw); line(s * (L - pd), pw, s * L, pw);
      line(s * L, -gw, s * (L - gd), -gw); line(s * (L - gd), -gw, s * (L - gd), gw); line(s * (L - gd), gw, s * L, gw);
      // goal frame (posts + crossbar), 7.32 × 2.44 m scaled
      const gwh = 3.66 * k, gh = 2.44, t = 0.12;
      for (const tt of [-gwh, gwh]) {
        quad(b, P(s * L - t, tt, 0), P(s * L + t, tt, 0), P(s * L + t, tt, gh), P(s * L - t, tt, gh), white);
        quad(b, P(s * L, tt - t, 0), P(s * L, tt + t, 0), P(s * L, tt + t, gh), P(s * L, tt - t, gh), white);
      }
      quad(b, P(s * L, -gwh, gh - t), P(s * L, gwh, gh - t), P(s * L, gwh, gh + t), P(s * L, -gwh, gh + t), white);
      quad(b, P(s * L - t, -gwh, gh), P(s * L + t, -gwh, gh), P(s * L + t, gwh, gh), P(s * L - t, gwh, gh), white);
    }
  }
  return finish(b, false);
}

/** Mapped piers: timber deck 0.5 m above the lake level (or the ground) with a dark edge. */
export function pierGeometry(d: AreaData) {
  const b: Buf = { pos: [], col: [] };
  if (!d.streets) return finish(b);
  const h = groundOf(d);
  const lake = d.water.find((w) => w.kind === "lake" && w.level != null);
  const deck = C("#9c7a58"), edge = C("#5e4632");
  for (const p of d.streets.piers) {
    const [cx, cy] = p.outer[0];
    const z = Math.max(lake ? lake.level! - d.datum + 0.5 : -1e9, h(cx, cy) + 0.3);
    for (const [x, y] of triangulate(p.outer as P2[], p.holes as P2[][])) push(b, [x, z, -y], deck);
    const r = p.outer;
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
      quad(b, [ax, z - 0.35, -ay], [bx, z - 0.35, -by], [bx, z, -by], [ax, z, -ay], edge);
    }
  }
  return finish(b);
}

/**
 * Power infrastructure at mapped positions. Lattice towers (height ESTIMATE 24 m) or wooden poles (9 m), and the
 * mapped lines as three sagging conductors between consecutive supports. Returns solid geometry and wire segments.
 */
export function powerGeometry(d: AreaData) {
  const b: Buf = { pos: [], col: [] };
  const wires: number[] = [];
  if (!d.streets) return { solid: finish(b, false), wires: new THREE.BufferGeometry() };
  const h = groundOf(d);
  const steel = C("#8e949a"), wood = C("#6e5a46");
  const TOWER = 24, POLE = 9;
  const beam = (a: number[], c: number[], w: number, col: THREE.Color) => {
    // thin square beam from a to c (scene coords)
    const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2], l = Math.hypot(dx, dy, dz) || 1;
    const u = Math.abs(dy / l) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(dx / l, dy / l, dz / l);
    const s = new THREE.Vector3().crossVectors(dir, u).normalize().multiplyScalar(w / 2);
    const t = new THREE.Vector3().crossVectors(dir, s).normalize().multiplyScalar(w / 2);
    const corner = (p: number[], i: number) => { const sx = i === 0 || i === 3 ? -1 : 1, ty = i < 2 ? -1 : 1; return [p[0] + s.x * sx + t.x * ty, p[1] + s.y * sx + t.y * ty, p[2] + s.z * sx + t.z * ty]; };
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(b, corner(a, i), corner(a, j), corner(c, j), corner(c, i), col); }
  };
  const sup = d.streets.towers.map((t) => ({ ...t, g: h(t.x, t.y), top: t.k === "tower" ? TOWER : POLE, arm: t.k === "tower" ? 4.2 : 0.8, dir: 0 }));
  // tower orientation: perpendicular to the line through it
  const nearestLine = (x: number, y: number) => {
    let best = 900, dir = 0;
    for (const ln of d.streets!.lines) for (let i = 0; i < ln.pts.length - 1; i++) {
      const [ax, ay] = ln.pts[i], [bx, by] = ln.pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), q = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
      if (q < best) { best = q; dir = Math.atan2(dy, dx); }
    }
    return dir;
  };
  for (const s of sup) {
    s.dir = nearestLine(s.x, s.y);
    const ux = Math.cos(s.dir), uy = Math.sin(s.dir), vx = -uy, vy = ux; // u along the line, v across (arms)
    const P = (a: number, c: number, z: number) => [s.x + ux * a + vx * c, s.g + z, -(s.y + uy * a + vy * c)];
    if (s.k === "tower") {
      const base = 2.6, topw = 0.7;
      const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [a, c] of legs) beam(P(a * base, c * base, -0.3), P(a * topw, c * topw, s.top), 0.22, steel);
      for (const z of [6, 12, 18]) {
        const w = base + (topw - base) * (z / s.top);
        for (let i = 0; i < 4; i++) { const [a0, c0] = legs[i], [a1, c1] = legs[(i + 1) % 4]; beam(P(a0 * w, c0 * w, z), P(a1 * w, c1 * w, z), 0.1, steel); }
      }
      // diagonal bracing on the two broad faces
      for (const c of [-1, 1]) for (const [z0, z1] of [[0, 6], [6, 12], [12, 18]]) {
        const w0 = base + (topw - base) * (z0 / s.top), w1 = base + (topw - base) * (z1 / s.top);
        beam(P(-w0, c * w0, z0), P(w1, c * w1, z1), 0.08, steel); beam(P(w0, c * w0, z0), P(-w1, c * w1, z1), 0.08, steel);
      }
      beam(P(0, -s.arm, s.top - 3), P(0, s.arm, s.top - 3), 0.3, steel);
      beam(P(0, -s.arm * 0.7, s.top), P(0, s.arm * 0.7, s.top), 0.25, steel);
    } else {
      beam(P(0, 0, -0.5), P(0, 0, s.top), 0.26, wood);
      beam(P(0, -1.0, s.top - 0.5), P(0, 1.0, s.top - 0.5), 0.12, wood);
    }
  }
  // conductors: along each mapped line, between consecutive vertices that are supports (or line ends)
  const supAt = (x: number, y: number) => {
    let best = 225, out: (typeof sup)[0] | null = null;
    for (const s of sup) { const q = (s.x - x) ** 2 + (s.y - y) ** 2; if (q < best) { best = q; out = s; } }
    return out;
  };
  for (const ln of d.streets.lines) {
    const minor = ln.k === "minor";
    const ends = ln.pts.map(([x, y]) => {
      const s = supAt(x, y);
      return s ? { x: s.x, y: s.y, z: s.g + s.top - (s.k === "tower" ? 3 : 0.5), arm: s.arm } : { x, y, z: h(x, y) + (minor ? POLE - 0.5 : TOWER - 3), arm: minor ? 0.8 : 4.2 };
    });
    for (let i = 0; i < ends.length - 1; i++) {
      const a = ends[i], c = ends[i + 1], l = Math.hypot(c.x - a.x, c.y - a.y);
      if (l < 2) continue;
      const nx = -(c.y - a.y) / l, ny = (c.x - a.x) / l, sag = Math.min(0.035 * l, 9), n = Math.max(4, Math.ceil(l / 12));
      for (const o of minor ? [-0.6, 0.6] : [-0.92, 0, 0.92]) {
        const oa = o * a.arm, oc = o * c.arm;
        let prev: number[] | null = null;
        for (let k = 0; k <= n; k++) {
          const t = k / n, off = oa + (oc - oa) * t;
          const x = a.x + (c.x - a.x) * t + nx * off, y = a.y + (c.y - a.y) * t + ny * off;
          const z = a.z + (c.z - a.z) * t - sag * 4 * t * (1 - t);
          const p = [x, z, -y];
          if (prev) wires.push(...prev, ...p);
          prev = p;
        }
      }
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute("position", new THREE.Float32BufferAttribute(wires, 3));
  wg.computeBoundingSphere();
  return { solid: finish(b, false), wires: wg };
}

/**
 * ESTIMATE: headstone rows inside mapped cemeteries (no grave survey exists). Stones on a 2.6 × 1.7 m grid aligned
 * with the cemetery's longest edge, deterministic jitter, kept 1.5 m inside the outline. Returns instance matrices.
 */
export function headstoneMatrices(d: AreaData) {
  const out: THREE.Matrix4[] = [];
  if (!d.streets) return out;
  const h = groundOf(d);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const inside = (r: [number, number][], x: number, y: number) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const distEdge = (r: [number, number][], x: number, y: number) => {
    let best = Infinity;
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
    }
    return best;
  };
  for (const c of d.streets.cemeteries) {
    const r = c.outer;
    let ang = 0, bestL = 0;
    for (let i = 0; i < r.length; i++) { const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length], l = Math.hypot(bx - ax, by - ay); if (l > bestL) { bestL = l; ang = Math.atan2(by - ay, bx - ax); } }
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const R = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
    // irregular rows: each row has its own offset and gaps, stones come in loose family groups
    for (let b = -R; b <= R; b += 2.4 + rnd() * 0.8) {
      const rowOff = rnd() * 2;
      for (let a = -R + rowOff; a <= R; a += 1.1 + rnd() * 1.6) {
        if (rnd() < 0.35) { a += rnd() * 3; continue; }
        const x = cx + ux * a + vx * (b + (rnd() - 0.5) * 0.6), y = cy + uy * a + vy * (b + (rnd() - 0.5) * 0.6);
        if (!inside(r, x, y) || distEdge(r, x, y) < 1.5) continue;
        q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.12, ang + (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.1, "YXZ"));
        const tall = 0.45 + rnd() * 0.55, wide = 0.8 + rnd() * 0.5;
        out.push(m.compose(pos.set(x, h(x, y) + tall / 2 - 0.05, -y), q, sc.set(wide, tall, 1)).clone());
      }
    }
  }
  return out;
}
