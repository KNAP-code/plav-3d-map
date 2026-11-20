/** Loads the baked area assets produced by pipeline/build.py. */

export type GridMeta = {
  x0: number; y0: number; nx: number; ny: number; step: number; base: number; scale: number;
  file: string; cover: string; coreSink?: number;
};

export type AreaMeta = {
  area: string; title: string; bbox: [number, number, number, number]; generated: string;
  crs: string; origin: [number, number];
  core: GridMeta; context: GridMeta;
  extent: { halfW: number; halfH: number };
  stats: Record<string, number>;
  landmarks: { name: string; x: number; y: number; cls: string | null }[];
  estimates: Record<string, string>;
  sources: { overture_release: string; attribution: string[] };
  treesFile?: string;
};

export type Building = {
  id: string; src: string; cls: string | null; name: string | null;
  fp: [number, number][]; g0: number; g1: number; eave: number; floors: number;
  hSrc: string; roof: "hip" | "gable" | "flat"; roofSrc: string;
  obb: [number, number, number, number, number]; v: number;
  /** "outbuilding": small machine-detected footprint shown as a plain single-storey shed */
  kind?: string;
  /** share of the footprint lying on a mapped street carriageway (audit) */
  onStreet?: number;
};
export type Minaret = { x: number; y: number; g: number; height: number };
export type Road = {
  c: string; n: string | null; bridge: boolean; tunnel: boolean; pts: [number, number][];
  /** Overture subclass (driveway, parking_aisle, ...), surface, max speed km/h, junction node ids at the ends */
  sc?: string; surf?: string; spd?: number; j0?: number; j1?: number;
};
export type PolyJ = { outer: [number, number][]; holes: [number, number][][] };
export type Water = PolyJ & { kind: "lake" | "river"; name: string | null; level: number | null };
export type Stream = { c: string; n: string | null; pts: [number, number][] };
export type Overlay = PolyJ & { k: string };
export type Gardens = {
  yards: PolyJ[]; fences: { k: string; pts: [number, number][] }[]; plots: { c: [number, number]; a: number }[];
  fruit: [number, number, number][]; hay: [number, number, number][];
};
export type Streets = {
  carriage: PolyJ[]; sidewalks: PolyJ[];
  bridges: { c: string; n: string | null; w: number; pts: [number, number][] }[];
  towers: { k: string; x: number; y: number }[]; lines: { k: string; pts: [number, number][] }[];
  piers: PolyJ[]; pitches: { x: number; y: number; ang: number; L: number; W: number }[];
  cemeteries: (PolyJ & { name: string | null })[];
};

export type AreaData = {
  meta: AreaMeta;
  datum: number; // elevation subtracted from every height in the scene
  core: Heightfield;
  context: Heightfield;
  coverCore: HTMLImageElement;
  coverContext: HTMLImageElement;
  buildings: Building[];
  /** source footprints left out by the reconciliation rules (shown only in the #audit view) */
  removed: { id: string; src: string; reason: string; fp: [number, number][] }[];
  minarets: Minaret[];
  roads: Road[];
  crossings: [number, number][];
  water: Water[];
  streams: Stream[];
  overlays: Overlay[];
  /** mapped street furniture (benches, fountains, bus stops, parking signs...) and walls; empty if not exported */
  furniture: { points: { k: string; x: number; y: number }[]; walls: { k: string; pts: [number, number][] }[] };
  trees: Float32Array; // x, y, scale, kind
  /** street surfaces and mapped infrastructure (pipeline/streets.py); null for areas built before it existed */
  streets: Streets | null;
  /** ESTIMATED gardens, fences, plots, fruit trees, haystacks (pipeline/gardens.py); null if not exported */
  gardens: Gardens | null;
  bytes: number;
};

/** Bilinear heightfield in local metres (absolute elevation). */
export class Heightfield {
  constructor(public g: GridMeta, public h: Float32Array) {}
  at(x: number, y: number): number {
    const { x0, y0, nx, ny, step } = this.g;
    let fx = (x - x0) / step, fy = (y - y0) / step;
    fx = Math.min(Math.max(fx, 0), nx - 1.0001);
    fy = Math.min(Math.max(fy, 0), ny - 1.0001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const i = iy * nx + ix;
    const a = this.h[i], b = this.h[i + 1], c = this.h[i + nx], d = this.h[i + nx + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  /** Height exactly as the terrain mesh draws it (same two-triangle split per cell), so draped lines sit on it. */
  atTri(x: number, y: number): number {
    const { x0, y0, nx, ny, step } = this.g;
    let fx = (x - x0) / step, fy = (y - y0) / step;
    fx = Math.min(Math.max(fx, 0), nx - 1.0001);
    fy = Math.min(Math.max(fy, 0), ny - 1.0001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const i = iy * nx + ix;
    const a = this.h[i], b = this.h[i + 1], c = this.h[i + nx], d = this.h[i + nx + 1];
    return tx >= ty ? a + (b - a) * tx + (d - b) * ty : a + (c - a) * ty + (d - c) * tx;
  }
  contains(x: number, y: number) {
    const { x0, y0, nx, ny, step } = this.g;
    return x >= x0 && y >= y0 && x <= x0 + (nx - 1) * step && y <= y0 + (ny - 1) * step;
  }
}

async function bin(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

function img(url: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(url));
    im.src = url;
  });
}

export async function loadArea(base: string, onProgress?: (p: number) => void): Promise<AreaData> {
  const metaR = await fetch(`${base}/meta.json`);
  const meta: AreaMeta = await metaR.json();
  let done = 0;
  const tick = <T,>(p: Promise<T>) => p.then((v) => { done++; onProgress?.(done / 7); return v; });
  const streetsP = fetch(`${base}/streets.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const gardensP = fetch(`${base}/gardens.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const furnP = fetch(`${base}/furniture.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [coreBuf, ctxBuf, bjs, vjs, treeBuf, coverCore, coverContext] = await Promise.all([
    tick(bin(`${base}/${meta.core.file}`)),
    tick(bin(`${base}/${meta.context.file}`)),
    tick(fetch(`${base}/buildings.json`).then((r) => r.text())),
    tick(fetch(`${base}/vectors.json`).then((r) => r.text())),
    tick(bin(`${base}/${meta.treesFile ?? "trees.bin"}`)),
    tick(img(`${base}/${meta.core.cover}`)),
    tick(img(`${base}/${meta.context.cover}`)),
  ]);
  const decode = (buf: ArrayBuffer, g: GridMeta) => {
    const q = new Uint16Array(buf);
    const h = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) h[i] = g.base + q[i] / g.scale;
    return new Heightfield(g, h);
  };
  const core = decode(coreBuf, meta.core);
  const context = decode(ctxBuf, meta.context);
  const b = JSON.parse(bjs);
  const v = JSON.parse(vjs);
  const furniture = (await furnP) ?? { points: [], walls: [] };
  const streets = (await streetsP) as Streets | null;
  return {
    furniture, streets, gardens: (await gardensP) as Gardens | null,
    meta, core, context, coverCore, coverContext,
    datum: meta.core.base,
    buildings: b.buildings, removed: b.removed ?? [], minarets: b.minarets,
    roads: v.roads, crossings: v.crossings ?? [], water: v.water, streams: v.streams, overlays: v.overlays,
    trees: new Float32Array(treeBuf),
    bytes: coreBuf.byteLength + ctxBuf.byteLength + bjs.length + vjs.length + treeBuf.byteLength,
  };
}
