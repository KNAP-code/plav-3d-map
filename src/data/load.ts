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
  /** Phase 5.1 evidence for pilot buildings (public/data/<area>/recon.json, pipeline/reconstruct.py) */
  recon?: Recon;
};
/** Confidence: V verified (read from a source), E estimated (derived by a stated rule), U unknown (neutral placeholder). */
export type Conf = "V" | "E" | "U";
export type Recon = {
  L: number; W: number; az: number; area: number; fpSrc: string; fpC: Conf;
  rc?: string; rcN: number; rcC: Conf; rcNote?: string; mat?: string; matC: Conf;
  fl: number; eave: number; flC: Conf; flSrc: string;
  roof: string; roofC: Conf; roofSrc: string;
  use: string; useC: Conf; useSrc?: string; name?: string; facC: Conf; balC: Conf;
};
export type ReconMeta = { pilot: [number, number, number]; n: number; imagery: string; confidence: Record<string, Record<Conf, number>>; rejected: Record<string, string> };
export type Minaret = { x: number; y: number; g: number; height: number };
export type Road = {
  c: string; n: string | null; bridge: boolean; tunnel: boolean; pts: [number, number][];
  /** Overture subclass (driveway, parking_aisle, ...), surface, max speed km/h, junction node ids at the ends */
  sc?: string; surf?: string; spd?: number; j0?: number; j1?: number;
};
export type PolyJ = { outer: [number, number][]; holes: [number, number][][] };
/** axis: index into AreaData.rivers for mapped river areas whose surface follows a levelled profile */
export type Water = PolyJ & { kind: "lake" | "river"; name: string | null; level: number | null; axis?: number };
/** i: intermittent (OSM intermittent=yes) */
export type Stream = { c: string; n: string | null; pts: [number, number][]; i?: 1 };
/** Levelled water-surface profile along a river centreline (pipeline/build.py river_profiles): x, y, z (m a.s.l.). */
export type River = { n: string | null; pts: [number, number, number][] };
/**
 * Lake surface grid (pipeline/water.py), 10 m cells over the valley lakes, row 0 = south. veg: Sentinel-2 summer
 * vegetation cover 0..255 (reed / sedge / floating plants), rgb: S2 natural colour, shore: metres from the mapped shore.
 */
export type Marsh = { x0: number; y0: number; nx: number; ny: number; step: number; veg: Uint8Array; rgb: Uint8Array; shore: Uint8Array };
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

/** One nested terrain level from pipeline/terrain.py (public/data/<area>/terrain/terrain.json). */
export type LevelMeta = GridMeta & { name: string; half: number; hole: number | null; demMin: number; demMax: number; maxCurvatureDrop: number };
export type TerrainInfo = {
  crs: string; origin: [number, number]; source: string; verticalDatum: string;
  curvature: { applied: boolean; refraction_k: number; R_eff_m: number; note: string };
  levels: LevelMeta[];
  treesBand?: { file: string; count: number; band_m: number; note: string };
};
export type TerrainLevel = { meta: LevelMeta; hf: Heightfield; cover: HTMLImageElement };

/**
 * Height lookup across the nested real-terrain levels (finest first). Same interface as Heightfield.at/atTri
 * so every "ground outside the core" sampler keeps working.
 */
export class LevelStack {
  constructor(public levels: TerrainLevel[]) {}
  private pick(x: number, y: number) {
    for (const l of this.levels) if (Math.max(Math.abs(x), Math.abs(y)) <= l.meta.half) return l.hf;
    return this.levels[this.levels.length - 1].hf;
  }
  at(x: number, y: number) { return this.pick(x, y).at(x, y); }
  atTri(x: number, y: number) { return this.pick(x, y).atTri(x, y); }
  contains(x: number, y: number) { const L = this.levels[this.levels.length - 1].meta.half; return Math.abs(x) <= L && Math.abs(y) <= L; }
}

export type AreaData = {
  meta: AreaMeta;
  /** Phase 5.1 pilot evidence summary (recon.json), null when absent */
  reconMeta: ReconMeta | null;
  datum: number; // elevation subtracted from every height in the scene
  core: Heightfield;
  /** ground outside the core: the real-terrain level stack when baked, else the legacy 60 m context grid */
  context: Heightfield | LevelStack;
  /** nested real-terrain levels (empty for areas without pipeline/terrain.py output) */
  levels: TerrainLevel[];
  terrainInfo: TerrainInfo | null;
  coverCore: HTMLImageElement;
  coverContext: HTMLImageElement | null;
  buildings: Building[];
  /** source footprints left out by the reconciliation rules (shown only in the #audit view) */
  removed: { id: string; src: string; reason: string; fp: [number, number][] }[];
  minarets: Minaret[];
  roads: Road[];
  crossings: [number, number][];
  water: Water[];
  streams: Stream[];
  rivers: River[];
  /** lake vegetation + shore grid (pipeline/water.py); null if not exported */
  marsh: Marsh | null;
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
  const waterP = fetch(`${base}/water.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const reconP = fetch(`${base}/recon.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const furnP = fetch(`${base}/furniture.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const terrainInfo: TerrainInfo | null = await fetch(`${base}/terrain/terrain.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const bandP = terrainInfo?.treesBand ? bin(`${base}/terrain/${terrainInfo.treesBand.file}`).catch(() => null) : Promise.resolve(null);
  const levelsP = Promise.all((terrainInfo?.levels ?? []).map(async (m) => {
    const [buf, cover] = await Promise.all([bin(`${base}/terrain/${m.file}`), img(`${base}/terrain/${m.cover}`)]);
    return { meta: m, buf, cover };
  }));
  const [coreBuf, ctxBuf, bjs, vjs, treeBuf, coverCore, coverContext] = await Promise.all([
    tick(bin(`${base}/${meta.core.file}`)),
    // the legacy context ring is only needed when no real-terrain levels were baked
    tick(terrainInfo ? Promise.resolve(new ArrayBuffer(0)) : bin(`${base}/${meta.context.file}`)),
    tick(fetch(`${base}/buildings.json`).then((r) => r.text())),
    tick(fetch(`${base}/vectors.json`).then((r) => r.text())),
    tick(bin(`${base}/${meta.treesFile ?? "trees.bin"}`)),
    tick(img(`${base}/${meta.core.cover}`)),
    tick(terrainInfo ? Promise.resolve(null) : img(`${base}/${meta.context.cover}`)),
  ]);
  const decode = (buf: ArrayBuffer, g: GridMeta) => {
    const q = new Uint16Array(buf);
    const h = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) h[i] = g.base + q[i] / g.scale;
    return new Heightfield(g, h);
  };
  const core = decode(coreBuf, meta.core);
  const lv = await levelsP;
  const levels: TerrainLevel[] = lv.map(({ meta: m, buf, cover }) => ({ meta: m, hf: decode(buf, m), cover }));
  const context = levels.length ? new LevelStack(levels) : decode(ctxBuf, meta.context);
  const levelBytes = lv.reduce((a, l) => a + l.buf.byteLength, 0);
  const b = JSON.parse(bjs);
  const recon = (await reconP) as { meta: ReconMeta; b: Record<string, Recon> } | null;
  if (recon) for (const bb of b.buildings as Building[]) { const r = recon.b[bb.id]; if (r) bb.recon = r; }
  const v = JSON.parse(vjs);
  // trees in a thinning band just outside the core (pipeline/terrain.py), appended to the city's WorldCover trees
  const band = await bandP;
  const trees = band && band.byteLength ? (() => { const a = new Float32Array(treeBuf.byteLength / 4 + band.byteLength / 4); a.set(new Float32Array(treeBuf)); a.set(new Float32Array(band), treeBuf.byteLength / 4); return a; })() : new Float32Array(treeBuf);
  const furniture = (await furnP) ?? { points: [], walls: [] };
  const streets = (await streetsP) as Streets | null;
  const wj = await waterP;
  const unb64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  const marsh: Marsh | null = wj?.marsh ? { ...wj.marsh, veg: unb64(wj.marsh.veg), rgb: unb64(wj.marsh.rgb), shore: unb64(wj.marsh.shore) } : null;
  return {
    marsh, rivers: v.rivers ?? [],
    furniture, streets, gardens: (await gardensP) as Gardens | null,
    meta, core, context, levels, terrainInfo, coverCore, coverContext,
    datum: meta.core.base,
    reconMeta: recon?.meta ?? null,
    buildings: b.buildings, removed: b.removed ?? [], minarets: b.minarets,
    roads: v.roads, crossings: v.crossings ?? [], water: v.water, streams: v.streams, overlays: v.overlays,
    trees,
    bytes: levelBytes + coreBuf.byteLength + ctxBuf.byteLength + bjs.length + vjs.length + treeBuf.byteLength,
  };
}
