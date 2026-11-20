import type { AreaData, Road } from "@/data/load";
import type { StyleConfig } from "@/style/presets";

/** Classes cars can use (decorative traffic) and that get streetlights. */
export const CAR_CLASSES = new Set(["secondary", "tertiary", "primary", "trunk", "residential", "unclassified", "living_street"]);
export const LIT_CLASSES = new Set(["secondary", "tertiary", "primary", "trunk", "residential", "unclassified", "living_street"]);

export function roadWidth(style: StyleConfig, r: Road) {
  return style.roads.widths[r.c] ?? 3.5;
}

/** Junction degree per node id (all road pieces), and per node the widest road meeting there. */
export function roadNodes(d: AreaData, style: StyleConfig) {
  const deg = new Map<number, number>(), width = new Map<number, number>(), pos = new Map<number, [number, number]>();
  for (const r of d.roads) {
    const w = roadWidth(style, r);
    for (const [j, p] of [[r.j0, r.pts[0]], [r.j1, r.pts[r.pts.length - 1]]] as const) {
      if (j === undefined) continue;
      deg.set(j, (deg.get(j) ?? 0) + 1);
      width.set(j, Math.max(width.get(j) ?? 0, w));
      pos.set(j, p as [number, number]);
    }
  }
  return { deg, width, pos };
}

/** Polyline helpers. */
export function polyLength(pts: [number, number][]) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Point and unit tangent at distance u along a polyline. */
export function pointAt(pts: [number, number][], u: number, out: { x: number; y: number; tx: number; ty: number }) {
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
    const l = Math.hypot(bx - ax, by - ay);
    if (u <= l || i === pts.length - 1) {
      const t = l > 0 ? Math.min(u / l, 1) : 0;
      out.x = ax + (bx - ax) * t; out.y = ay + (by - ay) * t;
      out.tx = l > 0 ? (bx - ax) / l : 1; out.ty = l > 0 ? (by - ay) / l : 0;
      return out;
    }
    u -= l;
  }
  return out;
}

/**
 * Decorative streetlights (not surveyed: no lamp data exists for Plav): every LAMP_SPACING m along
 * lit road classes, alternating sides, set back from the edge. Phase matches the road shader's light pools.
 */
export const LAMP_SPACING = 34;
export function streetlights(d: AreaData, style: StyleConfig) {
  const out: { x: number; y: number; ang: number }[] = [];
  const p = { x: 0, y: 0, tx: 1, ty: 0 };
  let side = 1;
  for (const r of d.roads) {
    if (!LIT_CLASSES.has(r.c) || r.sc === "driveway" || r.sc === "parking_aisle") continue;
    const L = polyLength(r.pts);
    const w = roadWidth(style, r);
    for (let u = LAMP_SPACING / 2; u < L - 4; u += LAMP_SPACING) {
      pointAt(r.pts, u, p);
      const nx = -p.ty * side, ny = p.tx * side;
      const off = w / 2 + 0.7;
      // pole on the verge, arm pointing over the road
      out.push({ x: p.x + nx * off, y: p.y + ny * off, ang: Math.atan2(-ny, -nx) });
      side = -side;
    }
  }
  return out;
}
