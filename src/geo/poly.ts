import * as THREE from "three";

export type P2 = [number, number];

export function signedArea(r: P2[]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Outward miter offset of a CCW ring. */
export function offsetRing(r: P2[], d: number): P2[] {
  const n = r.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = r[(i - 1 + n) % n], p1 = r[i], p2 = r[(i + 1) % n];
    let ax = p1[0] - p0[0], ay = p1[1] - p0[1];
    let bx = p2[0] - p1[0], by = p2[1] - p1[1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    ax /= la; ay /= la; bx /= lb; by /= lb;
    const n1x = ay, n1y = -ax, n2x = by, n2y = -bx; // outward normals for CCW
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const cos = mx * n1x + my * n1y;
    const k = Math.min(d / Math.max(cos, 0.35), d * 2.5);
    out.push([p1[0] + mx * k, p1[1] + my * k]);
  }
  return out;
}

/** Sutherland–Hodgman: clip any simple polygon by a convex CCW polygon. */
export function clipConvex(subject: P2[], clip: P2[]): P2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p: P2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
    const inter = (p: P2, q: P2): P2 => {
      const x1 = p[0], y1 = p[1], x2 = q[0], y2 = q[1];
      const x3 = a[0], y3 = a[1], x4 = b[0], y4 = b[1];
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      const t = den === 0 ? 0 : ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j - 1 + input.length) % input.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(inter(prev, cur));
        out.push(cur);
      } else if (pi) out.push(inter(prev, cur));
    }
  }
  // drop near-duplicate points
  const res: P2[] = [];
  for (const p of out) {
    const q = res[res.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) res.push(p);
  }
  if (res.length > 2 && Math.hypot(res[0][0] - res[res.length - 1][0], res[0][1] - res[res.length - 1][1]) < 1e-4) res.pop();
  return res;
}

/** Triangulate a polygon (with holes); returns flat triangle list of points. */
export function triangulate(outer: P2[], holes: P2[][] = []): P2[] {
  if (outer.length < 3) return [];
  const o = signedArea(outer) < 0 ? [...outer].reverse() : outer;
  const hs = holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h));
  const tris = THREE.ShapeUtils.triangulateShape(
    o.map(([x, y]) => new THREE.Vector2(x, y)),
    hs.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y))),
  );
  const all = [...o, ...hs.flat()];
  const out: P2[] = [];
  for (const [a, b, c] of tris) out.push(all[a], all[b], all[c]);
  return out;
}

/** Split triangles until every edge is shorter than maxLen (for draping on terrain). */
export function subdivide(tris: P2[], maxLen: number): P2[] {
  const out: P2[] = [];
  const stack: P2[][] = [];
  for (let i = 0; i < tris.length; i += 3) stack.push([tris[i], tris[i + 1], tris[i + 2]]);
  let guard = 0;
  while (stack.length && guard++ < 2_000_000) {
    const [a, b, c] = stack.pop()!;
    const lab = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const lbc = Math.hypot(b[0] - c[0], b[1] - c[1]);
    const lca = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const m = Math.max(lab, lbc, lca);
    if (m <= maxLen) { out.push(a, b, c); continue; }
    if (m === lab) { const p: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; stack.push([a, p, c], [p, b, c]); }
    else if (m === lbc) { const p: P2 = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; stack.push([a, b, p], [a, p, c]); }
    else { const p: P2 = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; stack.push([a, b, p], [p, b, c]); }
  }
  return out;
}

/** Densify a polyline so no segment is longer than maxLen. */
export function densify(pts: P2[], maxLen: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / maxLen));
    for (let k = 0; k < n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Cut triangles along a regular grid (the terrain cells) instead of subdividing them: each piece then lies inside one
 * terrain cell, so draping by vertex height follows the ground with far fewer triangles than uniform subdivision.
 */
export function gridClip(tris: P2[], x0: number, y0: number, step: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const t = [tris[i], tris[i + 1], tris[i + 2]];
    const xs = t.map((p) => p[0]), ys = t.map((p) => p[1]);
    const i0 = Math.floor((Math.min(...xs) - x0) / step), i1 = Math.floor((Math.max(...xs) - x0) / step);
    const j0 = Math.floor((Math.min(...ys) - y0) / step), j1 = Math.floor((Math.max(...ys) - y0) / step);
    if (i0 === i1 && j0 === j1) { out.push(t[0], t[1], t[2]); continue; }
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) {
      const bx0 = x0 + a * step, by0 = y0 + b * step, bx1 = bx0 + step, by1 = by0 + step;
      const poly = clipConvex(t, [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]);
      if (poly.length < 3) continue;
      // CCW check: clipConvex keeps the subject's winding
      for (let k = 1; k < poly.length - 1; k++) out.push(poly[0], poly[k], poly[k + 1]);
    }
  }
  return out;
}
