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
  verified: string[];
  estimated: string[];
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
  verified: [
    "Footprint and position: OSM building way named Stara džamija (17.5 × 10.1 m; source plan 16 × 10 m)",
    "Steep hipped roof with wood-shingle look (photos; avlija.me: plastic imitation of wooden shingles since 1986)",
    "Wooden minaret, shingle-clad shaft with chevron pattern, rising from the ridge near the entrance end, enclosed balcony and bell-shaped cap with finial (photos; avlija.me: wooden, 10 m)",
    "Entrance end and part of the long side built in dark timber (sofraluci) with ogee-shaped openings (photos; avlija.me: part stone, part wood)",
    "White plastered stone walls with tall round-arched windows and a grey plinth (photo 2)",
    "Wooden šadrvan (octagonal pavilion) in front of the mosque (photo 1; avlija.me)",
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
 * Redžepagića kula. Position: 42.595724 N, 19.945963 E (photomontenegro.me), 7 m from a square
 * 8.6 × 8.4 m OSM footprint: provisional until the project owner confirms it.
 */
const KULA: LandmarkDef = {
  name: "Redžepagića kula",
  provisional: true,
  verified: [
    "Square stone tower, walls over 1 m thick tapering towards the top (montenegrina.net, photos)",
    "Two stone storeys plus a later timber top storey (čardak) overhanging the stone walls (sources, photos)",
    "Closed timber balconies (erkers) projecting from the top storey, one with its own small roof (photos)",
    "Steep hipped roof with deep eaves, reddish-brown covering (photo 2; sources: originally stone slabs, later shingles)",
    "Round-arched door and small slit openings in the stone (photos)",
  ],
  estimated: [
    "Position: one source coordinate matched to the nearest square OSM footprint (needs confirmation)",
    "Heights: stone 8 m, timber storey 2.6 m, roof rise 2.6 m (from photo proportions)",
    "Which face is the front (door + roofed erker): the face towards the nearest street",
    "Number and position of the small windows in the timber storey",
  ],
  build(B, { L, W }) {
    const stone = C("#b9b0a2"), wood = C("#4a3426"), beam = C("#33241a"), roof = C("#8c4f3f"), frame = C("#efe9de"), dark = C("#2a2420");
    const hs = 8.0, hw = 2.6, taper = 0.3, ov = 0.9;
    // tapering stone shaft (front = +s face)
    const p = (s: number, t: number, z: number) => [s, t, z] as V3;
    const Ls = L - taper, Ws = W - taper;
    const faces: [number, number, number, number][] = [[-L, -W, L, -W], [L, -W, L, W], [L, W, -L, W], [-L, W, -L, -W]];
    const top: [number, number, number, number][] = [[-Ls, -Ws, Ls, -Ws], [Ls, -Ws, Ls, Ws], [Ls, Ws, -Ls, Ws], [-Ls, Ws, -Ls, -Ws]];
    for (let i = 0; i < 4; i++) {
      const [a0, b0, a1, b1] = faces[i], [c0, d0, c1, d1] = top[i];
      B.quad(p(a0, b0, -1), p(a1, b1, -1), p(c1, d1, hs), p(c0, d0, hs), stone, K.stone);
    }
    // door (front) and slit windows
    B.archWindow(L - taper * 0.05, -W, L - taper * 0.05, W, W, 1.05, 0, 2.2, C("#4b3628"), 0.03);
    for (const [s0, t0, s1, t1] of faces) for (const z of [3.2, 5.6]) {
      const len = Math.hypot(s1 - s0, t1 - t0);
      B.archWindow(s0, t0, s1, t1, len * 0.5, 0.3, z, z + 0.6, dark, 0.06 + taper * (z / hs));
    }
    // timber storey, overhanging the stone top by 0.6 m
    const Lt = Ls + 0.6, Wt = Ws + 0.6;
    B.box(-Lt, Lt, -Wt, Wt, hs, hs + hw, wood, K.planks, false);
    B.quad([-Lt, -Wt, hs], [-Lt, Wt, hs], [Lt, Wt, hs], [Lt, -Wt, hs], beam); // underside
    // corbel beams under the overhang
    for (const t of [-Wt * 0.6, 0, Wt * 0.6]) B.box(-Lt - 0.2, Lt + 0.2, t - 0.12, t + 0.12, hs - 0.35, hs, beam);
    // small framed windows on each face of the timber storey
    const win = (s0: number, t0: number, s1: number, t1: number, n: number) => {
      const len = Math.hypot(s1 - s0, t1 - t0), ds = (s1 - s0) / len, dt = (t1 - t0) / len, ns = dt * 0.05, nt = -ds * 0.05;
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) / n) * len, cs = s0 + ds * u + ns, ct = t0 + dt * u + nt;
        const q = (du: number, z: number, o = 0): V3 => [cs + ds * du + ns * o, ct + dt * du + nt * o, z];
        B.quad(q(-0.42, hs + 0.9), q(0.42, hs + 0.9), q(0.42, hs + 1.85), q(-0.42, hs + 1.85), frame);
        B.quad(q(-0.32, hs + 1.0, 1), q(0.32, hs + 1.0, 1), q(0.32, hs + 1.75, 1), q(-0.32, hs + 1.75, 1), C("#3b3f45"), K.glass);
      }
    };
    win(-Lt, -Wt, Lt, -Wt, 2); win(Lt, -Wt, Lt, Wt, 2); win(Lt, Wt, -Lt, Wt, 2); win(-Lt, Wt, -Lt, -Wt, 2);
    // erkers: front one hangs lower and has its own roof; one on each side face at the top storey
    const erker = (cs: number, ct: number, ds: number, dt: number, z0: number, z1: number, roofed: boolean) => {
      B.box(cs - ds, cs + ds, ct - dt, ct + dt, z0, z1, wood, K.planks);
      B.quad([cs - ds, ct - dt, z0], [cs - ds, ct + dt, z0], [cs + ds, ct + dt, z0], [cs + ds, ct - dt, z0], beam);
      if (roofed) {
        const o = 0.25;
        B.quad([cs + ds + o, ct - dt - o, z1], [cs + ds + o, ct + dt + o, z1], [cs - ds, ct + dt + o, z1 + 0.7], [cs - ds, ct - dt - o, z1 + 0.7], roof, K.shingle);
      }
    };
    erker(Lt + 0.55, -Wt * 0.35, 0.55, 1.05, hs - 1.5, hs + 0.9, true);
    erker(Wt * 0.15, -Wt - 0.5, 1.1, 0.5, hs - 0.2, hs + hw - 0.1, false);
    erker(-Wt * 0.15, Wt + 0.5, 1.1, 0.5, hs - 0.2, hs + hw - 0.1, false);
    // roof with deep eaves
    const tan = 2.6 / (Math.min(Lt, Wt) + ov);
    const ridge = B.hipRoof(Lt + ov, Wt + ov, hs + hw, tan, roof, K.shingle);
    B.frustum(0, 0, 4, 0.04, 0.03, ridge, ridge + 1.2, C("#555"), K.plain);
  },
};

/** Landmarks by building id (Overture/OSM id of the real footprint). */
export const LANDMARKS: Record<string, LandmarkDef> = {
  "d8f69ad5-7153-4d6e-955e-b92a1d3e95f6": STARA,
  "4a1e5139-8dfc-4753-80af-dac7d0240aaf": KULA,
};

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
    let flip = 1;
    if (def === KULA) {
      // front (door) face: the +s or -s face, whichever points towards the nearest road
      let best = Infinity, bx = 0, by = 0;
      for (const r of d.roads) for (const [x, y] of r.pts) { const q = Math.hypot(x - cx, y - cy); if (q < best) { best = q; bx = x; by = y; } }
      flip = (bx - cx) * ca + (by - cy) * sa >= 0 ? 1 : -1;
    }
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
