import * as THREE from "three";
import type { AreaData, Building } from "@/data/load";

/**
 * Hand-built low-poly landmark models placed on their real (OSM) footprints. A landmark replaces the
 * procedural building with the same id (no duplicates) and, where it has its own minaret, the generic
 * OSM minaret within `minaretRadius` metres.
 *
 * Every model lists which details are verified (written source or reference photo) and which are
 * estimated, so they can be reviewed. See docs/LANDMARKS.md.
 *
 * Vertex attribute aKind drives the landmark material: 0 plain, 1 shingle rows, 2 vertical wood planks,
 * 3 chevron shingles (minaret), 4 window glass (lit at night), 5 rough stone.
 */
export const K = { plain: 0, shingle: 1, planks: 2, chevron: 3, glass: 4, stone: 5 } as const;

type V3 = [number, number, number];

/** Collects coloured triangles in a building's local frame: s along the long axis, t across, z up (metres above ground). */
class Builder {
  pos: number[] = []; col: number[] = []; uv: number[] = []; kind: number[] = [];
  constructor(private toWorld: (s: number, t: number, z: number) => V3) {}
  tri(a: V3, b: V3, c: V3, color: THREE.Color, kind: number, ua: [number, number], ub: [number, number], uc: [number, number]) {
    for (const [p, u] of [[a, ua], [b, ub], [c, uc]] as const) {
      this.pos.push(...this.toWorld(p[0], p[1], p[2]));
      this.col.push(color.r, color.g, color.b);
      this.uv.push(u[0], u[1]);
      this.kind.push(kind);
    }
  }
  /** Quad a-b-c-d (counter-clockwise seen from outside); uv in metres along a→b and a→d. */
  quad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color, kind: number = K.plain) {
    const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), h = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    this.tri(a, b, c, color, kind, [0, 0], [w, 0], [w, h]);
    this.tri(a, c, d, color, kind, [0, 0], [w, h], [0, h]);
  }
  /** Vertical wall panel from (s0,t0) to (s1,t1), z0..z1, nudged `off` m along its outward normal. */
  panel(s0: number, t0: number, s1: number, t1: number, z0: number, z1: number, color: THREE.Color, kind: number = K.plain, off = 0) {
    const L = Math.hypot(s1 - s0, t1 - t0) || 1, ns = (t1 - t0) / L * off, nt = -(s1 - s0) / L * off;
    this.quad([s0 + ns, t0 + nt, z0], [s1 + ns, t1 + nt, z0], [s1 + ns, t1 + nt, z1], [s0 + ns, t0 + nt, z1], color, kind);
  }
  /** Axis-aligned (in local frame) box. */
  box(s0: number, s1: number, t0: number, t1: number, z0: number, z1: number, color: THREE.Color, kind: number = K.plain, top = true) {
    this.panel(s0, t0, s1, t0, z0, z1, color, kind);
    this.panel(s1, t0, s1, t1, z0, z1, color, kind);
    this.panel(s1, t1, s0, t1, z0, z1, color, kind);
    this.panel(s0, t1, s0, t0, z0, z1, color, kind);
    if (top) this.quad([s0, t0, z1], [s1, t0, z1], [s1, t1, z1], [s0, t1, z1], color, kind);
  }
  /** n-sided frustum around (cs,ct): radius r0 at z0 to r1 at z1; optional cap. */
  frustum(cs: number, ct: number, n: number, r0: number, r1: number, z0: number, z1: number, color: THREE.Color, kind: number = K.plain, cap = false, rot = 0) {
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, r: number, z: number): V3 => [cs + Math.cos(a) * r, ct + Math.sin(a) * r, z];
      const w = 2 * Math.PI * Math.max(r0, r1) / n, h = Math.hypot(z1 - z0, r1 - r0);
      this.tri(p(a0, r0, z0), p(a1, r0, z0), p(a1, r1, z1), color, kind, [i * w, 0], [(i + 1) * w, 0], [(i + 1) * w, h]);
      if (r1 > 1e-4) this.tri(p(a0, r0, z0), p(a1, r1, z1), p(a0, r1, z1), color, kind, [i * w, 0], [(i + 1) * w, h], [i * w, h]);
      if (cap && r1 > 1e-4) this.tri([cs, ct, z1], p(a0, r1, z1), p(a1, r1, z1), color, kind, [0, 0], [1, 0], [1, 1]);
    }
  }
  /**
   * Hipped roof over the rectangle |s|<=L, |t|<=W (half sizes incl. overhang), eave at z, pitch tan.
   * Ridge along s when L >= W. uv.y = distance up the slope (for shingle rows).
   */
  hipRoof(L: number, W: number, z: number, tan: number, color: THREE.Color, kind: number = K.shingle) {
    const r = Math.max(L - W, 0), h = W * tan, sl = Math.hypot(W, h);
    const A: V3 = [-L, -W, z], B: V3 = [L, -W, z], C: V3 = [L, W, z], D: V3 = [-L, W, z];
    const R0: V3 = [-r, 0, z + h], R1: V3 = [r, 0, z + h];
    this.tri(A, B, R1, color, kind, [0, 0], [2 * L, 0], [L + r, sl]);
    this.tri(A, R1, R0, color, kind, [0, 0], [L + r, sl], [L - r, sl]);
    this.tri(C, D, R0, color, kind, [0, 0], [2 * L, 0], [L + r, sl]);
    this.tri(C, R0, R1, color, kind, [0, 0], [L + r, sl], [L - r, sl]);
    this.tri(B, C, R1, color, kind, [0, 0], [2 * W, 0], [W, sl]);
    this.tri(D, A, R0, color, kind, [0, 0], [2 * W, 0], [W, sl]);
    // soffit (underside), so the overhang reads from low angles
    this.quad(A, D, C, B, color.clone().multiplyScalar(0.55), K.plain);
    return z + h;
  }
  /** Arch-topped window on the wall line (s0,t0)->(s1,t1) centred at u (m), width w, sill z0, top z1. */
  archWindow(s0: number, t0: number, s1: number, t1: number, u: number, w: number, z0: number, z1: number, color: THREE.Color, off = 0.04) {
    const L = Math.hypot(s1 - s0, t1 - t0), ds = (s1 - s0) / L, dt = (t1 - t0) / L;
    const ns = dt * off, nt = -ds * off;
    const at = (x: number, z: number): V3 => [s0 + ds * x + ns, t0 + dt * x + nt, z];
    const zs = z1 - w / 2; // springing line
    this.quad(at(u - w / 2, z0), at(u + w / 2, z0), at(u + w / 2, zs), at(u - w / 2, zs), color, K.glass);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI - (i / n) * Math.PI, a1 = Math.PI - ((i + 1) / n) * Math.PI;
      this.tri(at(u, zs), at(u + Math.cos(a0) * w / 2, zs + Math.sin(a0) * w / 2), at(u + Math.cos(a1) * w / 2, zs + Math.sin(a1) * w / 2), color, K.glass, [0, 0], [0, 0], [0, 0]);
    }
  }
  /** Hemispherical dome of radius r on a circle around (cs,ct) springing at z. */
  dome(cs: number, ct: number, r: number, z: number, color: THREE.Color, n = 16, rings = 5, kind: number = K.plain) {
    for (let k = 0; k < rings; k++) {
      const a0 = (k / rings) * Math.PI / 2, a1 = ((k + 1) / rings) * Math.PI / 2;
      this.frustum(cs, ct, n, r * Math.cos(a0), r * Math.cos(a1), z + r * Math.sin(a0), z + r * Math.sin(a1), color, kind);
    }
  }
  /** Walls along a closed polygon given counter-clockwise in (s,t). */
  walls(poly: [number, number][], z0: number, z1: number, color: THREE.Color, kind: number = K.plain, off = 0) {
    for (let i = 0; i < poly.length; i++) {
      const [s0, t0] = poly[i], [s1, t1] = poly[(i + 1) % poly.length];
      this.panel(s0, t0, s1, t1, z0, z1, color, kind, off);
    }
  }
  /** Flat cap over a convex polygon (fan). */
  flat(poly: [number, number][], z: number, color: THREE.Color, kind: number = K.plain) {
    for (let i = 1; i < poly.length - 1; i++)
      this.tri([poly[0][0], poly[0][1], z], [poly[i][0], poly[i][1], z], [poly[i + 1][0], poly[i + 1][1], z], color, kind, [0, 0], [1, 0], [1, 1]);
  }
  /** Rectangular window on the wall line (s0,t0)->(s1,t1) centred at u, width w, sill z0, head z1, with a light frame. */
  rectWindow(s0: number, t0: number, s1: number, t1: number, u: number, w: number, z0: number, z1: number, glass: THREE.Color, frame?: THREE.Color, off = 0.05) {
    const L = Math.hypot(s1 - s0, t1 - t0), ds = (s1 - s0) / L, dt = (t1 - t0) / L, ns = dt, nt = -ds;
    const at = (x: number, z: number, o: number): V3 => [s0 + ds * x + ns * o, t0 + dt * x + nt * o, z];
    if (frame) this.quad(at(u - w / 2 - 0.1, z0 - 0.1, off * 0.5), at(u + w / 2 + 0.1, z0 - 0.1, off * 0.5), at(u + w / 2 + 0.1, z1 + 0.1, off * 0.5), at(u - w / 2 - 0.1, z1 + 0.1, off * 0.5), frame);
    this.quad(at(u - w / 2, z0, off), at(u + w / 2, z0, off), at(u + w / 2, z1, off), at(u - w / 2, z1, off), glass, K.glass);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aUv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(this.kind, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const C = (s: string) => new THREE.Color(s);

export type LandmarkDef = {
  name: string;
  /** replaces generic OSM minaret nodes within this radius (m) of the footprint centre */
  minaretRadius?: number;
  /** needs the user's confirmation of the position before it is shown by default */
  provisional?: boolean;
  /** chip label and the pattern that matches the OSM name used by the generic chip list */
  chip?: { label: string; match: RegExp };
  /** which end the camera shortcut looks at: +1 the +s end, -1 the -s end (default +1) */
  focusSide?: 1 | -1;
  verified: string[];
  estimated: string[];
  sources?: string[];
  build: (b: Builder, fp: { L: number; W: number }) => void;
};

/**
 * Stara džamija (1471). Sources: avlija.me (16 × 10 m plan, stone + wooden sofraluci, 10 m wooden
 * minaret, shingle roof replaced in 1986 by a plastic wood-shingle imitation, wooden šadrvan in front)
 * and two reference photos supplied by the project owner. Front (entrance) is the +s end: the OSM
 * minaret node projects onto that half of the footprint, and that end faces north-west (away from the qibla).
 */
const STARA: LandmarkDef = {
  name: "Stara džamija",
  minaretRadius: 14,
  chip: { label: "Stara džamija", match: /stara džamija/i },
  sources: ["Two reference photos supplied by the project owner", "https://www.plavto.me/en/tourist-offer/imperial-mosque/", "avlija.me, Islamsko kulturno nasljeđe: Plav (2024)"],
  verified: [
    "Footprint and position: OSM building way named Stara džamija (17.5 × 10.1 m; source plan 16 × 10 m)",
    "Steep hipped roof with wood-shingle look (photos; avlija.me: plastic imitation of wooden shingles since 1986)",
    "Wooden minaret, shingle-clad shaft with chevron pattern, rising from the ridge near the entrance end, enclosed balcony and bell-shaped cap with finial (photos; avlija.me: wooden, 10 m)",
    "Entrance end and part of the long side built in dark timber (sofraluci) with ogee-shaped openings (photos; avlija.me: part stone, part wood)",
    "White plastered stone walls with tall round-arched windows and a grey plinth (photo 2)",
    "Wooden šadrvan (octagonal pavilion) in front of the mosque (photo 1; avlija.me)",
    "Hünkâr/Careva mosque, Plav, 1471 (İbrahimgil & Kudumovic 2023): 8.22 × 9.58 m, height 4.64 m, rectangular plan with the minaret rising from the roof, original wooden mahfil",
    "Also called the Carska (Imperial) mosque: built 1471 in the walled old town, present form from the 18th century, ground floor and first floor, ashlar and wood, wooden sofa, wooden minaret 10 m rising from the roof (plavto.me)",
  ],
  estimated: [
    "Eave height 5.0 m and roof pitch 45°, measured from photo proportions",
    "Minaret height ~10 m above the ridge, from photo proportions (source gives 10 m without saying from where)",
    "Length of the timber section along the side (≈40% of the side) and number of arched windows (4 per side)",
    "Exact position of the šadrvan in front of the entrance",
    "Rear (qibla) wall: no photo, modelled as plain plaster with two arched windows",
  ],
  build(B, { L, W }) {
    const plaster = C("#f1eee6"), plinth = C("#a9aaa6"), wood = C("#4a3426"), woodLight = C("#6b4c37"), beam = C("#3a281d");
    const shingle = C("#8b7a68"), glass = C("#33373d"), ogee = C("#e4ddcf");
    const eave = 5.0, pl = 1.3, tan = Math.tan((45 * Math.PI) / 180);
    const front = L, woodEnd = L - (2 * L) * 0.4; // timber section from the front to 40% of the length
    // plinth all round
    B.panel(-L, -W, L, -W, -1, pl, plinth, K.stone); B.panel(L, -W, L, W, -1, pl, plinth, K.stone);
    B.panel(L, W, -L, W, -1, pl, plinth, K.stone); B.panel(-L, W, -L, -W, -1, pl, plinth, K.stone);
    // plaster part (rear 60%)
    B.panel(-L, -W, woodEnd, -W, pl, eave, plaster); B.panel(woodEnd, W, -L, W, pl, eave, plaster);
    B.panel(-L, W, -L, -W, pl, eave, plaster);
    // timber part: entrance end + front 40% of both long sides
    B.panel(woodEnd, -W, front, -W, pl, eave, wood, K.planks); B.panel(front, -W, front, W, pl, eave, wood, K.planks);
    B.panel(front, W, woodEnd, W, pl, eave, wood, K.planks);
    // timber frame: rail between the two levels, posts
    const rail = (z: number, h: number) => {
      B.panel(woodEnd, -W, front, -W, z, z + h, beam, K.plain, 0.06);
      B.panel(front, -W, front, W, z, z + h, beam, K.plain, 0.06);
      B.panel(front, W, woodEnd, W, z, z + h, beam, K.plain, 0.06);
    };
    rail(pl, 0.18); rail(3.05, 0.18); rail(eave - 0.25, 0.25);
    for (const t of [-W, W]) for (let k = 0; k <= 3; k++) {
      const s = woodEnd + (k / 3) * (front - woodEnd);
      B.panel(s - 0.12, t, s + 0.12, t, pl, eave, beam, K.plain, t < 0 ? 0.07 : -0.07);
    }
    for (const t of [-W * 0.33, W * 0.33]) B.box(front - 0.02, front + 0.08, t - 0.12, t + 0.12, pl, eave, beam, K.plain, false);
    // ogee openings on the lower timber level (light panels), clerestory slots on the upper level
    const ogees = (s0: number, t0: number, s1: number, t1: number, n: number) => {
      const len = Math.hypot(s1 - s0, t1 - t0);
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) / n) * len, ds = (s1 - s0) / len, dt = (t1 - t0) / len;
        const cs = s0 + ds * u, ct = t0 + dt * u, off = 0.08;
        const ns = dt * off, nt = -ds * off;
        const w = 0.55, z0 = 2.35, z1 = 2.75;
        B.quad([cs - ds * w / 2 + ns, ct - dt * w / 2 + nt, z0], [cs + ds * w / 2 + ns, ct + dt * w / 2 + nt, z0],
          [cs + ds * w / 2 + ns, ct + dt * w / 2 + nt, z1], [cs - ds * w / 2 + ns, ct - dt * w / 2 + nt, z1], ogee);
        B.tri([cs - ds * w / 2 + ns, ct - dt * w / 2 + nt, z1], [cs + ds * w / 2 + ns, ct + dt * w / 2 + nt, z1], [cs + ns, ct + nt, z1 + 0.3], ogee, K.plain, [0, 0], [0, 0], [0, 0]);
        // upper clerestory window
        B.quad([cs - ds * 0.45 + ns, ct - dt * 0.45 + nt, 3.5], [cs + ds * 0.45 + ns, ct + dt * 0.45 + nt, 3.5],
          [cs + ds * 0.45 + ns, ct + dt * 0.45 + nt, 4.4], [cs - ds * 0.45 + ns, ct - dt * 0.45 + nt, 4.4], glass, K.glass);
      }
    };
    ogees(woodEnd, -W, front, -W, 3); ogees(front, W, woodEnd, W, 3);
    ogees(front, -W, front, -W * 0.38, 2); ogees(front, W * 0.38, front, W, 2);
    // entrance: arched door in the middle of the front
    B.archWindow(front, -W, front, W, W, 1.3, pl - 0.6, 3.0, C("#2a1d14"), 0.09);
    // arched windows on the plaster part (4 per long side, 2 at the rear)
    const nWin = 4, span = woodEnd + L;
    for (let i = 0; i < nWin; i++) {
      const u = ((i + 0.5) / nWin) * span;
      B.archWindow(-L, -W, woodEnd, -W, u, 0.85, 2.3, 4.1, glass);
      B.archWindow(woodEnd, W, -L, W, span - u, 0.85, 2.3, 4.1, glass);
    }
    B.archWindow(-L, W, -L, -W, W * 0.6, 0.85, 2.3, 4.1, glass);
    B.archWindow(-L, W, -L, -W, W * 1.4, 0.85, 2.3, 4.1, glass);
    // roof
    const ov = 0.8;
    const ridge = B.hipRoof(L + ov, W + ov, eave - ov * tan * 0.3, tan, shingle);
    // minaret on the ridge axis near the entrance end
    const ms = L - 3.6, top = ridge + 8.4;
    B.frustum(ms, 0, 8, 0.82, 0.76, eave, top, woodLight, K.chevron, false, Math.PI / 8);
    B.frustum(ms, 0, 8, 1.15, 1.15, top, top + 1.5, beam, K.planks, false, Math.PI / 8); // enclosed balcony
    B.frustum(ms, 0, 8, 1.15, 0.9, top - 0.25, top, beam, K.plain, false, Math.PI / 8);
    B.frustum(ms, 0, 8, 1.55, 0.0, top + 1.5, top + 3.3, shingle.clone().multiplyScalar(0.8), K.shingle, false, Math.PI / 8);
    B.frustum(ms, 0, 8, 1.55, 1.55, top + 1.42, top + 1.5, beam, K.plain, false, Math.PI / 8);
    B.frustum(ms, 0, 4, 0.05, 0.03, top + 3.3, top + 4.3, C("#8c8c86"), K.plain);
    B.box(ms - 0.04, ms + 0.04, -0.14, 0.14, top + 4.3, top + 4.36, C("#8c8c86"));
    // wooden šadrvan (octagonal pavilion) in front of the entrance
    const ss = L + 4.2, st = 0.6;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const cs = ss + Math.cos(a) * 1.55, ct = st + Math.sin(a) * 1.55;
      B.box(cs - 0.08, cs + 0.08, ct - 0.08, ct + 0.08, 0, 2.3, beam, K.plain, false);
    }
    B.frustum(ss, st, 8, 1.6, 1.6, 0, 0.9, woodLight, K.planks, false, Math.PI / 8); // lattice parapet
    B.frustum(ss, st, 8, 0.5, 0.5, 0, 0.8, C("#9aa0a0"), K.stone, true, Math.PI / 8); // fountain basin
    B.frustum(ss, st, 8, 2.1, 0.0, 2.3, 4.0, shingle, K.shingle, false, Math.PI / 8);
  },
};

/**
 * Redžepagića kula. Position confirmed by the project owner (2026-11-20): 42.595724 N, 19.945963 E,
 * OSM building way 221505346 (8.6 × 8.4 m footprint).
 */
const KULA: LandmarkDef = {
  name: "Redžepagića kula",
  verified: [
    "Position and footprint: OSM way 221505346 at 42.595724, 19.945963 (confirmed on site knowledge by the project owner)",
    "Square rubble-stone tower, walls tapering towards the top (montenegrina.net, photos)",
    "Two stone storeys plus a later dark timber top storey (čardak) overhanging the stone on all sides (sources, photos)",
    "Timber storey: small white-framed windows in pairs, diagonal braces and a light horizontal beam (photo 2)",
    "Closed timber erker on the front face hanging below the čardak with its own small reddish roof; erkers at the side corners (photos)",
    "Steep hipped roof, reddish-brown covering, deep eaves, finial rod at the apex (photos)",
    "Round-arched wooden door at ground level in a lighter stone arch, small square openings in the stone (photos)",
    "Rubble-stone walls with larger, lighter dressed stones at the corners (photos)",
  ],
  estimated: [
    "Heights: stone 10 m, timber storey 2.6 m, roof rise 3.4 m (from photo proportions: stone face ≈1.2× as tall as wide; no survey)",
    "Which face is the front (door + roofed erker): the face towards the nearest street",
    "Rear face: no photo; modelled like the front without door or erker",
    "Exact sizes of the erkers and windows (from photo proportions)",
    "Plinth course, threshold step, fascia board and rafter ends: plausible construction details, not distinct in the photos",
  ],
  build(B, { L, W }) {
    const stone = C("#bdb3a3"), wood = C("#4a3426"), beam = C("#2f2118"), band = C("#b08a5e"), roof = C("#8f4c3a");
    const frame = C("#efe9de"), dark = C("#2a2420"), door = C("#5a4130"), glass = C("#3b3f45");
    const hs = 10.0, hw = 2.6, taper = 0.35, ov = 1.0;
    const p = (s: number, t: number, z: number) => [s, t, z] as V3;
    const Ls = L - taper, Ws = W - taper;
    // tapering stone shaft (front = +s face)
    const faces: [number, number, number, number][] = [[-L, -W, L, -W], [L, -W, L, W], [L, W, -L, W], [-L, W, -L, -W]];
    const top: [number, number, number, number][] = [[-Ls, -Ws, Ls, -Ws], [Ls, -Ws, Ls, Ws], [Ls, Ws, -Ls, Ws], [-Ls, Ws, -Ls, -Ws]];
    for (let i = 0; i < 4; i++) {
      const [a0, b0, a1, b1] = faces[i], [c0, d0, c1, d1] = top[i];
      B.quad(p(a0, b0, -1), p(a1, b1, -1), p(c1, d1, hs), p(c0, d0, hs), stone, K.stone);
    }
    // square opening on a stone face (offset follows the taper)
    const hole = (f: number, u: number, z: number, w: number, h: number, c = dark) => {
      const [s0, t0, s1, t1] = faces[f], len = Math.hypot(s1 - s0, t1 - t0), ds = (s1 - s0) / len, dt = (t1 - t0) / len;
      const off = 0.05 - taper * ((z + h / 2) / hs), ns = dt * off, nt = -ds * off;
      const q = (du: number, zz: number): V3 => [s0 + ds * (u + du) + ns, t0 + dt * (u + du) + nt, zz];
      B.quad(q(-w / 2, z), q(w / 2, z), q(w / 2, z + h), q(-w / 2, z + h), c);
    };
    // plinth: slightly projecting base course of larger, darker stones
    const plinth = C("#a39a8c");
    B.box(-L - 0.12, L + 0.12, -W - 0.12, W + 0.12, -1, 0.55, plinth, K.stone, true);
    // quoins: dressed corner stones, alternating long/short on the two faces, following the taper
    const quoin = C("#d2cabd");
    for (let k = 0, z = 0.55; z < hs - 0.3; k++, z += 0.6) {
      const f = (z + 0.3) / hs, cs = L - taper * f, ct = W - taper * f, a = k % 2 ? 0.95 : 0.55, b = k % 2 ? 0.55 : 0.95;
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const s0 = sx * cs, t0 = sy * ct, o = 0.035;
        // face along s (normal ±t) and face along t (normal ±s)
        B.quad([s0, t0 + sy * o, z], [s0 - sx * a, t0 + sy * o, z], [s0 - sx * a, t0 + sy * o, z + 0.52], [s0, t0 + sy * o, z + 0.52], quoin, K.stone);
        B.quad([s0 + sx * o, t0, z], [s0 + sx * o, t0 - sy * b, z], [s0 + sx * o, t0 - sy * b, z + 0.52], [s0 + sx * o, t0, z + 0.52], quoin, K.stone);
      }
    }
    // front: arched door left of centre in a dressed-stone arch surround, threshold step (photo 2)
    B.archWindow(L + 0.02, -W, L + 0.02, W, W * 0.8, 1.55, 0, 2.6, C("#cfc6b8"), 0.02);
    B.archWindow(L - 0.01, -W, L - 0.01, W, W * 0.8, 1.05, 0, 2.3, door, 0.06);
    B.box(L + 0.12, L + 0.6, -W + W * 0.8 - 0.8, -W + W * 0.8 + 0.8, -0.4, 0.12, plinth, K.stone);
    hole(1, W * 0.8, 5.4, 0.35, 0.4); hole(1, W * 1.35, 3.9, 0.65, 0.75);
    // other faces: small slit/square openings on both stone storeys
    for (const f of [0, 2, 3]) { const u = (f === 3 ? W : L) * 1.0; hole(f, u, 3.8, 0.3, 0.5); hole(f, u * 0.9, 7.2, 0.3, 0.5); }
    // timber storey, overhanging the stone top by 0.6 m
    const Lt = Ls + 0.6, Wt = Ws + 0.6, zt = hs, zr = hs + hw;
    B.box(-Lt, Lt, -Wt, Wt, zt, zr, wood, K.planks, false);
    B.quad([-Lt, -Wt, zt], [-Lt, Wt, zt], [Lt, Wt, zt], [Lt, -Wt, zt], beam); // underside
    // corbel beams under the overhang, both directions
    for (const t of [-Wt * 0.6, 0, Wt * 0.6]) B.box(-Lt - 0.2, Lt + 0.2, t - 0.12, t + 0.12, zt - 0.3, zt, beam);
    for (const s of [-Lt * 0.6, Lt * 0.6]) B.box(s - 0.12, s + 0.12, -Wt - 0.2, Wt + 0.2, zt - 0.3, zt, beam);
    const tf: [number, number, number, number][] = [[-Lt, -Wt, Lt, -Wt], [Lt, -Wt, Lt, Wt], [Lt, Wt, -Lt, Wt], [-Lt, Wt, -Lt, -Wt]];
    for (const [s0, t0, s1, t1] of tf) {
      const len = Math.hypot(s1 - s0, t1 - t0), ds = (s1 - s0) / len, dt = (t1 - t0) / len;
      const at = (u: number, z: number, o: number): V3 => [s0 + ds * u + dt * o, t0 + dt * u - ds * o, z];
      // light beam band below the windows, sole plate and wall plate
      B.quad(at(0, zt + 0.55, 0.04), at(len, zt + 0.55, 0.04), at(len, zt + 0.7, 0.04), at(0, zt + 0.7, 0.04), band);
      B.quad(at(0, zt, 0.05), at(len, zt, 0.05), at(len, zt + 0.18, 0.05), at(0, zt + 0.18, 0.05), beam);
      B.quad(at(0, zr - 0.2, 0.05), at(len, zr - 0.2, 0.05), at(len, zr, 0.05), at(0, zr, 0.05), beam);
      // corner posts and diagonal braces from the corners
      for (const u of [0.1, len - 0.1]) B.quad(at(u - 0.1, zt, 0.06), at(u + 0.1, zt, 0.06), at(u + 0.1, zr, 0.06), at(u - 0.1, zr, 0.06), beam);
      for (const [u0, u1] of [[0.2, 1.6], [len - 0.2, len - 1.6]]) {
        const w = 0.09 * Math.sign(u1 - u0);
        B.quad(at(u0 - w, zt + 0.2, 0.06), at(u0 + w, zt + 0.2, 0.06), at(u1 + w, zr - 0.2, 0.06), at(u1 - w, zr - 0.2, 0.06), beam);
      }
      // a pair of small white-framed windows in the middle
      for (const u of [len / 2 - 0.65, len / 2 + 0.65]) {
        B.quad(at(u - 0.4, zt + 0.95, 0.07), at(u + 0.4, zt + 0.95, 0.07), at(u + 0.4, zt + 1.9, 0.07), at(u - 0.4, zt + 1.9, 0.07), frame);
        B.quad(at(u - 0.3, zt + 1.05, 0.09), at(u + 0.3, zt + 1.05, 0.09), at(u + 0.3, zt + 1.8, 0.09), at(u - 0.3, zt + 1.8, 0.09), glass, K.glass);
        B.quad(at(u - 0.03, zt + 1.05, 0.1), at(u + 0.03, zt + 1.05, 0.1), at(u + 0.03, zt + 1.8, 0.1), at(u - 0.03, zt + 1.8, 0.1), frame);
      }
    }
    // erker: timber box projecting from a face; framed window on its outer face; optional own roof
    const erker = (cs: number, ct: number, ds: number, dt: number, z0: number, z1: number, dir: [number, number], roofed: boolean) => {
      B.box(cs - ds, cs + ds, ct - dt, ct + dt, z0, z1, wood, K.planks, !roofed);
      B.quad([cs - ds, ct - dt, z0], [cs - ds, ct + dt, z0], [cs + ds, ct + dt, z0], [cs + ds, ct - dt, z0], beam);
      // brackets below
      B.box(cs - ds * 0.9, cs + ds * 0.9, ct - dt * 0.9, ct + dt * 0.9, z0 - 0.25, z0, beam);
      const os = cs + dir[0] * (ds + 0.04), ot = ct + dir[1] * (dt + 0.04), es = dir[1], et = -dir[0];
      const zc = (z0 + z1) / 2 + 0.15;
      const q = (u: number, z: number, o = 0): V3 => [os + es * u + dir[0] * o, ot + et * u + dir[1] * o, z];
      B.quad(q(-0.38, zc - 0.42), q(0.38, zc - 0.42), q(0.38, zc + 0.42), q(-0.38, zc + 0.42), frame);
      B.quad(q(-0.28, zc - 0.32, 0.02), q(0.28, zc - 0.32, 0.02), q(0.28, zc + 0.32, 0.02), q(-0.28, zc + 0.32, 0.02), glass, K.glass);
      B.quad(q(-0.5, z0 + 0.25, 0.01), q(0.5, z0 + 0.25, 0.01), q(0.5, z0 + 0.38, 0.01), q(-0.5, z0 + 0.38, 0.01), band);
      if (roofed) {
        // mono-pitch roof sloping outwards, reddish metal (photo 2)
        const o = 0.3, hi = 0.75;
        const A: V3 = [cs - ds - o, ct - dt - o, z1], Bc: V3 = [cs + ds + o, ct - dt - o, z1], Cc: V3 = [cs + ds + o, ct + dt + o, z1], D: V3 = [cs - ds - o, ct + dt + o, z1];
        const lift = (v: V3): V3 => { const back = (v[0] - cs) * dir[0] + (v[1] - ct) * dir[1] < 0; return [v[0], v[1], back ? v[2] + hi : v[2]]; };
        B.quad(lift(A), lift(Bc), lift(Cc), lift(D), roof, K.plain);
        B.quad(D, Cc, Bc, A, roof.clone().multiplyScalar(0.55), K.plain);
      }
    };
    // front erker: left of centre, hanging well below the čardak, with its own roof
    erker(Lt + 0.6, -Wt * 0.3, 0.6, 1.1, zt - 1.7, zt + 1.0, [1, 0], true);
    // side erkers near the front corners, at the čardak level, hanging a little lower
    erker(Lt * 0.45, -Wt - 0.55, 1.05, 0.55, zt - 0.6, zr - 0.15, [0, -1], false);
    erker(Lt * 0.45, Wt + 0.55, 1.05, 0.55, zt - 0.6, zr - 0.15, [0, 1], false);
    // steep hipped roof with deep eaves, finial rod
    const tan = 3.4 / (Math.min(Lt, Wt) + ov);
    const ridge = B.hipRoof(Lt + ov, Wt + ov, zr, tan, roof, K.shingle);
    // dark fascia board along the eaves and rafter ends below it
    const Le = Lt + ov, We = Wt + ov;
    B.panel(-Le, -We, Le, -We, zr - 0.18, zr, beam, K.plain, 0.01); B.panel(Le, -We, Le, We, zr - 0.18, zr, beam, K.plain, 0.01);
    B.panel(Le, We, -Le, We, zr - 0.18, zr, beam, K.plain, 0.01); B.panel(-Le, We, -Le, -We, zr - 0.18, zr, beam, K.plain, 0.01);
    for (let i = -3; i <= 3; i++) {
      const u = (i / 3.5) * Le, v = (i / 3.5) * We;
      B.box(u - 0.06, u + 0.06, -We + 0.05, -Wt, zr - 0.28, zr - 0.16, beam, K.plain); B.box(u - 0.06, u + 0.06, Wt, We - 0.05, zr - 0.28, zr - 0.16, beam, K.plain);
      B.box(-Le + 0.05, -Lt, v - 0.06, v + 0.06, zr - 0.28, zr - 0.16, beam, K.plain); B.box(Lt, Le - 0.05, v - 0.06, v + 0.06, zr - 0.28, zr - 0.16, beam, K.plain);
    }
    B.frustum(0, 0, 4, 0.04, 0.03, ridge, ridge + 1.4, C("#555"), K.plain);
  },
};

/**
 * Plav-type wooden minaret rising out of a pitched roof: octagonal timber shaft from inside the roof, enclosed
 * timber balcony (šerefe), conical shingled cap and a finial. The written sources give only material and height
 * for each mosque; the form follows the documented Stara džamija minaret and is marked estimated per model.
 */
function woodenMinaret(B: Builder, s: number, t: number, base: number, shaftTop: number, o: { r: number; balc: number; cap: number; wood: THREE.Color; dark: THREE.Color; capCol: THREE.Color; kind: number }) {
  const rot = Math.PI / 8;
  B.frustum(s, t, 8, o.r, o.r * 0.93, base, shaftTop, o.wood, o.kind, false, rot);
  // İbrahimgil & Kudumovic (2023): Montenegrin wooden minarets have 8- or 16-sided shafts clad in fishbone-pattern small
  // planks, a "slightly emphasized" balcony with small openings, and rise out of the roof body.
  B.frustum(s, t, 8, o.r * 1.25, o.r * 1.05, shaftTop - 0.25, shaftTop, o.dark, K.plain, false, rot); // bracket
  B.frustum(s, t, 8, o.r * 1.25, o.r * 1.25, shaftTop, shaftTop + o.balc, o.dark, K.planks, false, rot); // enclosed balcony
  B.frustum(s, t, 8, o.r * 1.6, o.r * 1.6, shaftTop + o.balc - 0.08, shaftTop + o.balc, o.dark, K.plain, false, rot);
  B.frustum(s, t, 8, o.r * 1.6, 0, shaftTop + o.balc, shaftTop + o.balc + o.cap, o.capCol, K.shingle, false, rot);
  const tip = shaftTop + o.balc + o.cap;
  B.frustum(s, t, 4, 0.05, 0.03, tip, tip + 0.9, C("#8c8c86"), K.plain);
  return tip + 0.9;
}

/**
 * Sultanija džamija (1907). Source: Tourist Organisation Plav (plavto.me "Sultanija Mosque"): built 1907 with funds
 * from Sultan Abdul Hamid II by builders from Debar, of carved stone brought from afar, stones tied with grooves and
 * lead; "the slender minaret and the dome" built of the same stone; minaret demolished 1927, building used as a
 * school, then police station and prison; returned 1991, renovated from 2000 and reopened 2005.
 * Footprint: OSM building "Sultanija" (L-shaped, 17.7 × 15.1 m). Minaret: OSM node tower:type=minaret, which stands
 * in the notch of the L, so the minaret is free-standing beside the hall. +s points SE (157°, close to the qibla 136°).
 */
const SULTANIJA: LandmarkDef = {
  name: "Sultanija džamija",
  minaretRadius: 16,
  focusSide: -1,
  chip: { label: "Sultanija", match: /sultanija/i },
  sources: ["https://www.plavto.me/en/tourist-offer/sultanija-mosque/", "OSM building 'Sultanija' and OSM minaret node (via Overture 2026-11-18.0)"],
  verified: [
    "Position and L-shaped footprint: OSM building named Sultanija (17.7 × 15.1 m)",
    "Built of cut stone, including the dome and the slender minaret (plavto.me)",
    "Large domed building today; renovated and extended with domes and a tall minaret, reopened 2005 (adrialine.me, upoznajcrnugoru.com, volimprokletije.art.blog)",
    "Minaret 41.5 m, concrete (adrialine.me), rebuilt after the 1927 demolition; position = OSM minaret node in the notch of the L",
    "Orientation: the long +s axis points SE, close to the qibla, so the entrance is on the NW side",
  ],
  estimated: [
    "Which part of the L is the prayer hall: the square-ish SE part (11.8 × 15.2 m) is modelled as the domed hall, the NW wing as a lower entrance wing with a flat roof",
    "Heights: hall walls 8.5 m, dome radius 5.4 m on an octagonal drum, entrance wing 5.2 m; minaret form (one balcony, pointed cap)",
    "Sources mention domes in the plural; only the main dome is modelled because the count and placement of the others are unknown",
    "Minaret material conflict: concrete (adrialine.me) vs the original stone minaret (plavto.me, demolished 1927); modelled light rendered",
    "Stone colour (light grey-beige ashlar), lead-grey dome and minaret cap",
    "Windows: two rows of arched windows on the hall, arched door in the middle of the NW wing; counts are estimates",
    "No photo was available: proportions, cornice and window layout need checking against a photo",
  ],
  build(B) {
    const stone = C("#d8d0c1"), stoneDark = C("#bdb4a4"), lead = C("#6f767c"), glass = C("#2f343a"), door = C("#3b2a1e");
    const hall: [number, number][] = [[-2.9, -7.6], [8.9, -7.6], [8.9, 7.6], [-2.9, 7.6]];
    const wing: [number, number][] = [[-8.8, -3.8], [-2.9, -3.8], [-2.9, 7.6], [-8.8, 7.6]];
    const hE = 8.5, wE = 5.2;
    B.walls(hall, -1, hE, stone, K.stone); B.walls(wing, -1, wE, stone, K.stone);
    // plinth and cornices
    B.walls(hall, -1, 0.7, stoneDark, K.stone, 0.05); B.walls(wing, -1, 0.7, stoneDark, K.stone, 0.05);
    B.walls(hall, hE - 0.35, hE, stoneDark, K.plain, 0.12); B.walls(wing, wE - 0.3, wE, stoneDark, K.plain, 0.12);
    B.flat(hall, hE, stoneDark); B.flat(wing, wE, stoneDark);
    // octagonal drum + dome over the hall
    const dc = 3.0, r = 5.4;
    B.frustum(dc, 0, 8, r * 1.08, r * 1.08, hE, hE + 1.1, stone, K.stone, false, Math.PI / 8);
    B.frustum(dc, 0, 8, r * 1.14, r * 1.14, hE + 1.0, hE + 1.2, stoneDark, K.plain, false, Math.PI / 8);
    B.dome(dc, 0, r, hE + 1.15, lead, 16, 6);
    B.frustum(dc, 0, 4, 0.06, 0.03, hE + 1.15 + r, hE + 2.6 + r, C("#c9b46a"), K.plain); // alem
    // windows: two rows on the hall's three free sides, arched door + windows on the wing
    for (const z of [[1.6, 3.6], [5.0, 6.8]] as const) {
      for (const u of [3.0, 7.6, 12.2]) { B.archWindow(-2.9, -7.6, 8.9, -7.6, u * 11.8 / 15.2, 1.0, z[0], z[1], glass); B.archWindow(8.9, 7.6, -2.9, 7.6, u * 11.8 / 15.2, 1.0, z[0], z[1], glass); }
      for (const u of [3.8, 11.4]) B.archWindow(8.9, -7.6, 8.9, 7.6, u, 1.0, z[0], z[1], glass);
    }
    B.archWindow(-8.8, 7.6, -8.8, -3.8, 5.7, 1.6, 0, 3.4, door, 0.08);
    for (const u of [2.0, 9.4]) B.archWindow(-8.8, 7.6, -8.8, -3.8, u, 0.9, 1.6, 3.6, glass);
    B.archWindow(-2.9, 7.6, -8.8, 7.6, 2.95, 0.9, 1.6, 3.6, glass);
    // free-standing minaret on the OSM minaret node; 41.5 m per adrialine.me (concrete, rebuilt after the 1927 demolition)
    const ms = -4.5, mt = -5.7, H = 41.5;
    B.box(ms - 1.3, ms + 1.3, mt - 1.3, mt + 1.3, -1, 5.0, stoneDark, K.stone); // square base
    B.frustum(ms, mt, 12, 1.4, 1.1, 5.0, 6.6, stone, K.plain, false); // transition
    B.frustum(ms, mt, 12, 1.1, 1.0, 6.6, H - 10.5, stone, K.plain, false); // shaft
    B.frustum(ms, mt, 12, 1.02, 1.6, H - 11.0, H - 10.2, stoneDark, K.plain, false); // corbelled balcony
    B.frustum(ms, mt, 12, 1.6, 1.6, H - 10.2, H - 9.2, stone, K.plain, false); // parapet
    B.frustum(ms, mt, 12, 0.9, 0.86, H - 10.2, H - 5.6, stone, K.plain, false); // upper shaft
    B.frustum(ms, mt, 12, 1.0, 0.0, H - 5.6, H - 0.9, lead, K.plain, false); // pointed cap
    B.frustum(ms, mt, 4, 0.05, 0.03, H - 0.9, H, C("#c9b46a"), K.plain); // alem
  },
};

/**
 * Redžepagića džamija (1774, rebuilt 1871 per the 1288 AH date on the facade). Sources: plavto.me ("Redžepagić
 * Mosque"): stone in lime mortar, wooden entrance porch, square plinth on the outer wall, 14 m minaret of pine;
 * upoznajcrnugoru.com: stone, covered with roof tiles (crep), wooden minaret rising out of the roof, richly carved
 * wooden entrance door. Footprint: OSM building "Redžepagića džamija" (17.9 × 8.0 m). +s points SE (144°, qibla 136°),
 * so the entrance and porch are at the NW (-s) end. Not to be confused with Redžepagića kula, ~55 m SW.
 */
const REDZEPAGICA_DZ: LandmarkDef = {
  name: "Redžepagića džamija",
  minaretRadius: 14,
  focusSide: -1,
  chip: { label: "Redžepagića džamija", match: /redžepagića džamija/i },
  sources: ["https://www.plavto.me/en/tourist-offer/redzepagic-mosque/", "https://upoznajcrnugoru.com/redzepagica-dzamija-plav/", "OSM building 'Redžepagića džamija' (via Overture 2026-11-18.0)"],
  verified: [
    "Position and footprint: OSM building named Redžepagića džamija (17.9 × 8.0 m)",
    "Stone walls in lime mortar with a plinth on the outer wall (plavto.me)",
    "Roof covered with clay tiles (upoznajcrnugoru.com)",
    "Wooden (pine) minaret rising out of the roof, 14 m (plavto.me, upoznajcrnugoru.com)",
    "Wooden entrance porch and carved wooden entrance door (plavto.me, upoznajcrnugoru.com)",
    "Orientation: long axis points SE, close to the qibla, so the entrance is at the NW end",
    "Prayer hall 6.53 × 7.90 m, height 4.80 m, stone-concrete; recent extensive restoration added an L-shaped concrete mahfil (İbrahimgil & Kudumovic 2023, listed as the 1774 Fatıma Hanım mosque in Plav)",
    "Minaret typology: rectangular mosque with the minaret rising from the roof; Montenegrin wooden minarets are 8/16-sided with fishbone plank cladding and a slightly emphasised balcony (same paper)",
  ],
  estimated: [
    "Roof shape: hipped (the sources say tiles but not the shape); pitch 38°, eaves 0.8 m",
    "Wall finish: whitewashed render over the stone (not stated; could be bare stone)",
    "The OSM footprint (17.9 × 8.0 m) is much longer than the 7.9 m prayer hall; the rest is modelled as part of the same building under one hipped roof with a 3.2 m wooden porch at the NW end. The real split between hall, extension and porch is unknown",
    "Minaret: octagonal fishbone-clad shaft (regional type), enclosed balcony and cone cap; position on the ridge near the entrance; the 14 m is read as the length above the eaves",
    "Windows: 3 rectangular windows per long side and 2 at the rear (no source)",
    "Harem, šadrvan and gasulhana exist (plavto.me) but their positions are unknown, so they are not modelled",
  ],
  build(B, { L, W }) {
    const render = C("#efebe2"), plinth = C("#a7a49c"), tile = C("#a65a40"), wood = C("#6b4c37"), dark = C("#3e2c20"), glass = C("#30353b"), frame = C("#7a5a3e");
    const eave = 4.8, pd = 3.2, hs = -L + pd, tan = Math.tan((38 * Math.PI) / 180);
    const hallP: [number, number][] = [[hs, -W], [L, -W], [L, W], [hs, W]];
    B.walls(hallP, 0.7, eave, render); B.walls(hallP, -1, 0.7, plinth, K.stone, 0.06);
    // porch: timber floor, posts, low railing, back wall with the carved door
    B.box(-L, hs, -W, W, -1, 0.45, plinth, K.stone);
    B.box(-L, hs, -W, W, 0.45, 0.55, wood, K.planks);
    for (const t of [-W + 0.15, -W / 3, W / 3, W - 0.15]) B.box(-L + 0.05, -L + 0.3, t - 0.12, t + 0.12, 0.55, eave, dark, K.plain, false);
    for (const [t0, t1] of [[-W + 0.15, -W / 3], [W / 3, W - 0.15]]) B.box(-L + 0.1, -L + 0.2, t0, t1, 0.55, 1.45, wood, K.planks);
    B.box(hs - pd + 0.05, hs, -W + 0.05, -W + 0.15, 0.55, 1.45, wood, K.planks); B.box(hs - pd + 0.05, hs, W - 0.15, W - 0.05, 0.55, 1.45, wood, K.planks);
    B.box(-L, hs, -W, W, eave - 0.3, eave, dark, K.plain, false); // porch beam
    B.rectWindow(hs, W, hs, -W, W, 1.3, 0.55, 2.75, C("#4a3020"), dark, 0.06); // carved door
    // windows
    const len = L - hs;
    for (let i = 0; i < 3; i++) {
      const u = ((i + 0.5) / 3) * len;
      B.rectWindow(hs, -W, L, -W, u, 0.9, 1.7, 3.4, glass, frame);
      B.rectWindow(L, W, hs, W, u, 0.9, 1.7, 3.4, glass, frame);
    }
    for (const u of [W * 0.55, W * 1.45]) B.rectWindow(L, -W, L, W, u, 0.9, 1.7, 3.4, glass, frame);
    // hipped tiled roof over hall and porch
    const ov = 0.8;
    const ridge = B.hipRoof(L + ov, W + ov, eave - ov * tan * 0.3, tan, tile);
    // wooden minaret on the ridge near the entrance end, 14 m above the roof (see estimated)
    woodenMinaret(B, -L + pd + 1.2, 0, eave, ridge + 9.6, { r: 0.85, balc: 1.7, cap: 2.0, wood, dark, capCol: tile.clone().multiplyScalar(0.8), kind: K.chevron });
  },
};

/**
 * Šabovića džamija (c. 1900; tarih 1316/1318 AH above the entrance). Source: plavto.me ("Šabović Mosque"): hewn
 * stone, roof of thermoplastic imitation shingles, minaret of pine 7.5 m high rising from the roof, an entrance
 * annex with three domes, renovated 1964 and 1979. Footprint: OSM building "Sabovica" (16.1 × 9.3 m) whose NW end is
 * a narrower polygonal part, which matches the entrance annex. +s points SE (139°, qibla 136°).
 */
const SABOVICA: LandmarkDef = {
  name: "Šabovića džamija",
  minaretRadius: 12,
  focusSide: -1,
  chip: { label: "Šabovića džamija", match: /šabovića|sabovica/i },
  sources: ["https://www.plavto.me/en/tourist-offer/sabovic-mosque/", "OSM building 'Sabovica' (via Overture 2026-11-18.0)"],
  verified: [
    "Position and footprint: OSM building named Sabovica (16.1 × 9.3 m, polygonal NW end)",
    "Hewn stone walls (plavto.me)",
    "Roof of thermoplastic imitation shingles (plavto.me)",
    "Pine minaret 7.5 m high rising from the roof (plavto.me)",
    "Entrance annex with three domes (plavto.me): a three-domed reinforced-concrete porch, narrower than the main front facade (İbrahimgil & Kudumovic 2023); modelled on the narrower NW part of the footprint",
    "Prayer hall 8.26 × 10.91 m, height 4.40 m; a new reinforced-concrete structure was built around the original stone walls; rectangular plan with the minaret rising from the roof (same paper)",
  ],
  estimated: [
    "Roof shape: hipped, pitch 40° (shape not stated)",
    "Eave 4.6 m (paper gives 4.40 m height), annex walls 3.4 m, porch dome radius 1.2 m",
    "Outer finish: the paper says a concrete shell now surrounds the stone walls, so the visible finish may be render, not stone; modelled as stone until a photo shows it",
    "Minaret: octagonal fishbone-clad shaft (regional type from the paper), enclosed balcony, cone cap; position on the ridge near the annex",
    "Windows (3 arched per long side, 2 at the rear) and the door position: no source",
  ],
  build(B) {
    const stone = C("#bfb5a4"), stoneDark = C("#9f9687"), roof = C("#7e6e60"), wood = C("#7a5a40"), dark = C("#3e2c20"), lead = C("#7a7f84"), glass = C("#30353b");
    const hall: [number, number][] = [[-4.0, -4.65], [8.1, -4.65], [8.1, 4.65], [-4.0, 4.65]];
    const annex: [number, number][] = [[-4.0, -4.65], [-4.0, 4.6], [-7.0, 3.2], [-8.0, 0.3], [-6.9, -2.8]];
    const eave = 4.6, aE = 3.4, tan = Math.tan((40 * Math.PI) / 180);
    B.walls(hall, -1, eave, stone, K.stone); B.walls(hall, -1, 0.6, stoneDark, K.stone, 0.05);
    B.walls(annex, -1, aE, stone, K.stone); B.flat(annex, aE, stoneDark);
    B.walls(annex, aE - 0.25, aE, stoneDark, K.plain, 0.1);
    for (const t of [-2.3, 0.15, 2.3]) {
      B.frustum(-6.0, t, 12, 1.25, 1.25, aE, aE + 0.35, stoneDark, K.plain);
      B.dome(-6.0, t, 1.2, aE + 0.35, lead, 12, 4);
    }
    B.archWindow(-8.0, 0.3, -7.0, 3.2, 1.55, 1.1, 0, 2.5, C("#3b2a1e"), 0.08);
    for (let i = 0; i < 3; i++) {
      const u = ((i + 0.5) / 3) * 12.1;
      B.archWindow(-4.0, -4.65, 8.1, -4.65, u, 0.8, 1.6, 3.6, glass);
      B.archWindow(8.1, 4.65, -4.0, 4.65, u, 0.8, 1.6, 3.6, glass);
    }
    for (const u of [2.9, 6.4]) B.archWindow(8.1, -4.65, 8.1, 4.65, u, 0.8, 1.6, 3.6, glass);
    // hipped roof over the hall only (hall centre is offset from the footprint centre)
    const ov = 0.7, hc = (8.1 + -4.0) / 2, hl = (8.1 + 4.0) / 2 + ov, hw = 4.65 + ov;
    const r = Math.max(hl - hw, 0), h = hw * tan, z = eave - 0.15;
    const P = (s: number, t: number, zz: number): V3 => [hc + s, t, zz];
    B.tri(P(-hl, -hw, z), P(hl, -hw, z), P(r, 0, z + h), roof, K.shingle, [0, 0], [2 * hl, 0], [hl + r, h]);
    B.tri(P(-hl, -hw, z), P(r, 0, z + h), P(-r, 0, z + h), roof, K.shingle, [0, 0], [hl + r, h], [hl - r, h]);
    B.tri(P(hl, hw, z), P(-hl, hw, z), P(-r, 0, z + h), roof, K.shingle, [0, 0], [2 * hl, 0], [hl + r, h]);
    B.tri(P(hl, hw, z), P(-r, 0, z + h), P(r, 0, z + h), roof, K.shingle, [0, 0], [hl + r, h], [hl - r, h]);
    B.tri(P(hl, -hw, z), P(hl, hw, z), P(r, 0, z + h), roof, K.shingle, [0, 0], [2 * hw, 0], [hw, h]);
    B.tri(P(-hl, hw, z), P(-hl, -hw, z), P(-r, 0, z + h), roof, K.shingle, [0, 0], [2 * hw, 0], [hw, h]);
    B.quad(P(-hl, -hw, z), P(-hl, hw, z), P(hl, hw, z), P(hl, -hw, z), roof.clone().multiplyScalar(0.55));
    const ridge = z + h;
    // 7.5 m pine minaret rising from the roof, near the annex end of the ridge
    woodenMinaret(B, hc - r + 0.6, 0, eave, ridge + 5.0, { r: 0.55, balc: 1.2, cap: 1.5, wood, dark, capCol: roof.clone().multiplyScalar(0.85), kind: K.chevron });
  },
};

/** Landmarks by building id (Overture/OSM id of the real footprint). */
export const LANDMARKS: Record<string, LandmarkDef> = {
  "d8f69ad5-7153-4d6e-955e-b92a1d3e95f6": STARA,
  "4a1e5139-8dfc-4753-80af-dac7d0240aaf": KULA,
  "7ab32b00-f4fc-4c90-b77b-ef344f97e8bc": SULTANIJA,
  "046e12de-83fc-4793-a0ea-d1e63069c2d7": REDZEPAGICA_DZ,
  "a7e3238c-8616-4b92-a8f1-60669e556198": SABOVICA,
};

/** +1 if the model's front (+s) faces along the OBB axis, -1 if flipped. The kula's front (door) is the face towards the nearest road. */
function frontFlip(d: AreaData, b: Building, def: LandmarkDef) {
  if (def !== KULA) return 1;
  const [cx, cy, ang] = b.obb;
  let best = Infinity, bx = 0, by = 0;
  for (const r of d.roads) for (const [x, y] of r.pts) { const q = Math.hypot(x - cx, y - cy); if (q < best) { best = q; bx = x; by = y; } }
  return (bx - cx) * Math.cos(ang) + (by - cy) * Math.sin(ang) >= 0 ? 1 : -1;
}

/** Camera shortcut for a landmark: footprint centre and the azimuth (deg, as used by flyTo) that looks at its front. */
export function landmarkFocus(d: AreaData, name: string, turnDeg = 0) {
  for (const b of d.buildings) {
    const def = LANDMARKS[b.id];
    if (!def || def.name !== name) continue;
    const [cx, cy, ang] = b.obb, f = frontFlip(d, b, def) * (def.focusSide ?? 1);
    const nx = Math.cos(ang) * f, ny = Math.sin(ang) * f;
    return { x: cx, y: cy, azimuth: (Math.atan2(nx, -ny) * 180) / Math.PI + turnDeg };
  }
  return null;
}

/** Build all landmark models present in the area as one merged geometry (one draw call). */
export function landmarkGeometry(d: AreaData, opts: { provisional: boolean }) {
  const parts: THREE.BufferGeometry[] = [];
  const used: Building[] = [];
  for (const b of d.buildings) {
    const def = LANDMARKS[b.id];
    if (!def || (def.provisional && !opts.provisional)) continue;
    const [cx, cy, ang, Lf, Wf] = b.obb;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ground = (b.g0 + b.g1) / 2 - d.datum;
    const flip = frontFlip(d, b, def);
    const B = new Builder((s, t, z) => {
      s *= flip; t *= flip;
      const x = cx + s * ca - t * sa, y = cy + s * sa + t * ca;
      return [x, ground + z, -y];
    });
    def.build(B, { L: Lf / 2, W: Wf / 2 });
    parts.push(B.geometry());
    used.push(b);
  }
  return { parts, used };
}

/** Ids replaced by a landmark model, and generic minarets to drop (the landmark has its own). */
export function landmarkReplacements(d: AreaData, opts: { provisional: boolean }) {
  const ids = new Set<string>();
  const minarets = new Set<number>();
  for (const b of d.buildings) {
    const def = LANDMARKS[b.id];
    if (!def || (def.provisional && !opts.provisional)) continue;
    ids.add(b.id);
    if (def.minaretRadius) d.minarets.forEach((m, i) => { if (Math.hypot(m.x - b.obb[0], m.y - b.obb[1]) < def.minaretRadius!) minarets.add(i); });
  }
  return { ids, minarets };
}
