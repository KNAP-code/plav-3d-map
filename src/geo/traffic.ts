import type { AreaData, Road } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { CAR_CLASSES, pointAt, polyLength, roadWidth } from "./roads";

/**
 * Decorative traffic (not real traffic data): cars drive along the real road graph (Overture segments
 * split at connectors), keep to the right lane, pick a deterministic pseudo-random turn at each junction,
 * avoid U-turns except at dead ends, and round every junction with a short Bezier curve.
 */
type Edge = { id: number; pts: [number, number][]; len: number; a: number; b: number; w: number; speed: number };
type Car = { e: number; dir: 1 | -1; s: number; next: number; ndir: 1 | -1; speed: number; rng: number };
export type CarPose = { x: number; y: number; ang: number };

const KMH = { secondary: 40, tertiary: 35, primary: 45, trunk: 50, residential: 25, unclassified: 25, living_street: 15 } as Record<string, number>;

export class Traffic {
  edges: Edge[] = [];
  adj = new Map<number, { e: number; dir: 1 | -1 }[]>();
  cars: Car[] = [];
  private p = { x: 0, y: 0, tx: 1, ty: 0 };
  private q = { x: 0, y: 0, tx: 1, ty: 0 };

  constructor(d: AreaData, style: StyleConfig, count: number, seed = 1) {
    for (const r of d.roads) {
      if (!CAR_CLASSES.has(r.c) || r.sc === "driveway" || r.sc === "parking_aisle" || r.j0 === undefined || r.j1 === undefined) continue;
      if (r.surf === "unpaved" || r.surf === "gravel") continue;
      this.addEdge(r, style);
    }
    // keep only the largest connected network so cars never get stuck in fragments
    const comp = this.largestComponent();
    const keep = this.edges.filter((e) => comp.has(e.a));
    this.edges = []; this.adj.clear();
    for (const e of keep) { e.id = this.edges.length; this.edges.push(e); this.link(e); }
    let rng = seed * 9973 + 1;
    const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
    // spread cars over edges by length
    const total = this.edges.reduce((s, e) => s + e.len, 0);
    for (let i = 0; i < count && this.edges.length; i++) {
      let t = rand() * total, e = 0;
      while (e < this.edges.length - 1 && t > this.edges[e].len) { t -= this.edges[e].len; e++; }
      const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
      const car: Car = { e, dir, s: Math.min(t, this.edges[e].len * 0.8), next: e, ndir: dir, speed: 0, rng: (rand() * 4294967296) >>> 0 };
      this.chooseNext(car);
      car.speed = (this.edges[e].speed * (0.85 + rand() * 0.3)) / 3.6;
      this.cars.push(car);
    }
  }

  private addEdge(r: Road, style: StyleConfig) {
    const len = polyLength(r.pts);
    if (len < 2) return;
    this.edges.push({ id: this.edges.length, pts: r.pts, len, a: r.j0!, b: r.j1!, w: roadWidth(style, r), speed: Math.min(r.spd ?? KMH[r.c] ?? 25, KMH[r.c] ?? 25) });
    this.link(this.edges[this.edges.length - 1]);
  }
  private link(e: Edge) {
    if (!this.adj.has(e.a)) this.adj.set(e.a, []);
    if (!this.adj.has(e.b)) this.adj.set(e.b, []);
    this.adj.get(e.a)!.push({ e: e.id, dir: 1 });
    this.adj.get(e.b)!.push({ e: e.id, dir: -1 });
  }
  private largestComponent() {
    const seen = new Map<number, number>();
    let best = -1, bestSize = 0, c = 0;
    for (const start of this.adj.keys()) {
      if (seen.has(start)) continue;
      let size = 0;
      const stack = [start];
      seen.set(start, c);
      while (stack.length) {
        const n = stack.pop()!;
        for (const { e } of this.adj.get(n)!) {
          const E = this.edges[e];
          size += E.len;
          for (const m of [E.a, E.b]) if (!seen.has(m)) { seen.set(m, c); stack.push(m); }
        }
      }
      if (size > bestSize) { bestSize = size; best = c; }
      c++;
    }
    return new Set([...seen].filter(([, k]) => k === best).map(([n]) => n));
  }
  private endNode(c: { e: number; dir: 1 | -1 }) { const E = this.edges[c.e]; return c.dir === 1 ? E.b : E.a; }
  private chooseNext(car: Car) {
    const node = this.endNode(car);
    const opts = (this.adj.get(node) ?? []).filter((o) => o.e !== car.e);
    car.rng = (car.rng * 1664525 + 1013904223) >>> 0;
    if (!opts.length) { car.next = car.e; car.ndir = car.dir === 1 ? -1 : 1; return; } // dead end: turn round
    const o = opts[car.rng % opts.length];
    car.next = o.e; car.ndir = o.dir;
  }
  /** Point along an edge at distance s in travel direction, shifted to the right-hand lane. */
  private lanePoint(e: number, dir: 1 | -1, s: number, out: { x: number; y: number; tx: number; ty: number }) {
    const E = this.edges[e];
    pointAt(E.pts, dir === 1 ? s : E.len - s, out);
    if (dir === -1) { out.tx = -out.tx; out.ty = -out.ty; }
    const lane = Math.min(E.w * 0.25, 1.6);
    out.x += out.ty * lane; out.y -= out.tx * lane;
    return out;
  }
  /** Advance the simulation by dt seconds and write each car's pose. */
  step(dt: number, poses: CarPose[]) {
    dt = Math.min(dt, 0.1);
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      let E = this.edges[c.e];
      c.s += c.speed * dt;
      let N = this.edges[c.next];
      let R = Math.min(5, E.len / 3, N.len / 3);
      if (c.s >= E.len - R + 2 * R) {
        // finished the corner: continue on the next edge past its first R metres
        const over = c.s - E.len - R;
        c.e = c.next; c.dir = c.ndir; c.s = R + Math.max(over, 0);
        E = this.edges[c.e];
        c.speed = (E.speed * (0.85 + ((c.rng >>> 8) % 100) / 333)) / 3.6;
        this.chooseNext(c);
        N = this.edges[c.next];
        R = Math.min(5, E.len / 3, N.len / 3);
      }
      const pose = poses[i];
      if (c.s < E.len - R) {
        this.lanePoint(c.e, c.dir, c.s, this.p);
        pose.x = this.p.x; pose.y = this.p.y; pose.ang = Math.atan2(this.p.ty, this.p.tx);
      } else {
        // quadratic Bezier from (E at len-R) through the junction to (N at R)
        const t = Math.min((c.s - (E.len - R)) / (2 * R), 1);
        const a = this.lanePoint(c.e, c.dir, E.len - R, this.p);
        const ax = a.x, ay = a.y, atx = a.tx, aty = a.ty;
        const b = this.lanePoint(c.next, c.ndir, R, this.q);
        // control point: intersection of the two tangents (fallback: midpoint)
        const den = atx * b.ty - aty * b.tx;
        let mx = (ax + b.x) / 2, my = (ay + b.y) / 2;
        if (Math.abs(den) > 0.15) {
          const k = ((b.x - ax) * b.ty - (b.y - ay) * b.tx) / den;
          if (k > 0 && k < 3 * R) { mx = ax + atx * k; my = ay + aty * k; }
        }
        const u = 1 - t;
        pose.x = u * u * ax + 2 * u * t * mx + t * t * b.x;
        pose.y = u * u * ay + 2 * u * t * my + t * t * b.y;
        const dx = 2 * u * (mx - ax) + 2 * t * (b.x - mx), dy = 2 * u * (my - ay) + 2 * t * (b.y - my);
        pose.ang = Math.atan2(dy, dx);
      }
    }
  }
}
