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
  /** photo batch (photo.json): which photo, what it shows, and the values read from it */
  photo?: string; label?: string; fc?: string; facSrc?: string; rcSrc?: string; flNote?: string; roofNote?: string;
  bal?: boolean; balNote?: string; pitch?: number; splitNote?: string;
};
export type PhotoInfo = { title: string; camera: [number, number, number, number, number, number]; size: [number, number] };
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
  /** reference photos used for building reconstruction (photo.json) */
  photos: Record<string, PhotoInfo>;
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
  /** centre route (pipeline/route_recon.py): landmarks, eye-level walk path, paved-area colour; null if not exported */
  route: Route | null;
  bytes: number;
};

export type RouteStop = { s: number; label: string; id: string; x: number; y: number };
export type RouteLandmark = { id: string; label: string; x: number; y: number; src: string; posC: Conf; idC: Conf; note?: string; building?: string };
export type Route = {
  meta: { walk: { length_m: number; eye_m: number }; trees: { n: number; rule: string } };
  landmarks: RouteLandmark[];
  paved: { outer: [number, number][]; rgb: string; conf: Conf; src: string };
  walk: { pts: [number, number][]; stops: RouteStop[]; endLook?: [number, number] };
  trees: [number, number, number, number][];
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
  const photoP = fetch(`${base}/photo.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const routeP = fetch(`${base}/route.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const reconP = fetch(`${base}/recon.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const archP = fetch(`${base}/arch.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
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
  // automatic facade pipeline (pipeline/arch_pipeline.py): only values that passed its validation gate carry fc / fl;
  // the raw readings (fcAuto / flAuto) are kept for the inspector. Hand-read photo values below still win.
  const arch = (await archP) as { b: Record<string, { fc?: string; facC?: string; fl?: number; flC?: string; flNote?: string; src?: string }> } | null;
  if (arch) for (const bb of b.buildings as Building[]) {
    const a = arch.b[bb.id];
    if (!a) continue;
    const r = (bb.recon = { ...(bb.recon ?? ({} as Recon)) } as Recon);
    if (a.fc) { r.fc = a.fc; r.facSrc = a.src; r.facC = (a.facC ?? "E") as Conf; }
    if (a.fl && a.flC) { bb.floors = a.fl; r.fl = a.fl; r.flC = a.flC as Conf; r.flNote = a.flNote; }
  }
  // photo batches (pipeline/photo_recon.py): values read from reference photos override the Phase 5.1 evidence
  const photo = (await photoP) as { photos: Record<string, PhotoInfo>; b: Record<string, Partial<Recon> & { eave?: number; fl?: number; roof?: string }>;
    splits: Record<string, Record<string, { fp: [number, number][]; obb: [number, number, number, number, number] }>>; minarets: { near: [number, number]; height: number }[] } | null;
  if (photo) {
    const list: Building[] = [];
    for (const bb of b.buildings as Building[]) {
      const parts = photo.splits[bb.id];
      if (parts) for (const [k, pt] of Object.entries(parts)) list.push({ ...bb, id: `${bb.id}#${k}`, fp: pt.fp, obb: pt.obb, recon: bb.recon ? { ...bb.recon } : undefined });
      else list.push(bb);
    }
    for (const bb of list) {
      const p = photo.b[bb.id];
      if (!p) continue;
      bb.recon = { ...(bb.recon ?? ({} as Recon)), ...(p as Partial<Recon>) } as Recon;
      if (p.fl) { bb.floors = p.fl; bb.eave = p.eave ?? bb.eave; }
      if (p.roof === "flat" || p.roof === "hip" || p.roof === "gable") bb.roof = p.roof;
      if (bb.id.includes("#")) { const r = bb.recon; r.L = bb.obb[3]; r.W = bb.obb[4]; r.area = Math.round(bb.obb[3] * bb.obb[4]); }
    }
    b.buildings = list;
    for (const m of photo.minarets ?? []) for (const mm of b.minarets as Minaret[]) if (Math.hypot(mm.x - m.near[0], mm.y - m.near[1]) < 3) mm.height = m.height;
  }
  const v = JSON.parse(vjs);
  // trees in a thinning band just outside the core (pipeline/terrain.py), appended to the city's WorldCover trees
  const band = await bandP;
  const route = (await routeP) as Route | null;
  // route landmarks name their building in the inspector (with how sure the identification is)
  for (const lm of route?.landmarks ?? []) {
    if (!lm.building) continue;
    const bb = (b.buildings as Building[]).find((x) => x.id.startsWith(lm.building!));
    if (bb?.recon && !bb.recon.label) bb.recon.label = lm.idC === "V" ? lm.label : `${lm.label}? (${lm.note ?? "identity estimated"})`;
  }
  // + single trees on the centre route measured as crowns in the 1 m image (WorldCover's 10 m pixels miss them)
  const extra = [new Float32Array(treeBuf), band && band.byteLength ? new Float32Array(band) : new Float32Array(0), new Float32Array((route?.trees ?? []).flat())];
  const trees = new Float32Array(extra.reduce((n, a) => n + a.length, 0));
  extra.reduce((o, a) => { trees.set(a, o); return o + a.length; }, 0);
  const furniture = (await furnP) ?? { points: [], walls: [] };
  const streets = (await streetsP) as Streets | null;
  const wj = await waterP;
  const unb64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  const marsh: Marsh | null = wj?.marsh ? { ...wj.marsh, veg: unb64(wj.marsh.veg), rgb: unb64(wj.marsh.rgb), shore: unb64(wj.marsh.shore) } : null;
  return {
    marsh, rivers: v.rivers ?? [],
    furniture, streets, gardens: (await gardensP) as Gardens | null, route,
    meta, core, context, levels, terrainInfo, coverCore, coverContext,
    datum: meta.core.base,
    reconMeta: recon?.meta ?? null, photos: photo?.photos ?? {},
    buildings: b.buildings, removed: b.removed ?? [], minarets: b.minarets,
    roads: v.roads, crossings: v.crossings ?? [], water: v.water, streams: v.streams, overlays: v.overlays,
    trees,
    bytes: levelBytes + coreBuf.byteLength + ctxBuf.byteLength + bjs.length + vjs.length + treeBuf.byteLength,
  };
}
