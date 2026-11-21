"use client";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useFrame, useThree } from "@react-three/fiber";
import type { AreaData, Building, Heightfield } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { buildBuildingTile } from "@/geo/buildings";
import { overlaysGeometry, roadsGeometry, splitNonIndexed, splitTiles, terrainGeometry } from "@/geo/landscape";
import { marshGeometry, marshTexture, streamsGeometry, tuftGeometry, waterGeometry } from "@/geo/water";
import { carGeometry, minaretGeometry, streetlightGeometry, treeGeometries, treeSets, type TreeSet } from "@/geo/props";
import { streetlights } from "@/geo/roads";
import { furnitureGeometry, sidewalksGeometry } from "@/geo/street";
import { Traffic as TrafficSim, type CarPose } from "@/geo/traffic";
import { bridgeGeometry, headstoneMatrices, pierGeometry, pitchGeometry, powerGeometry, sidewalkGeometry, zebraGeometry } from "@/geo/streetscape";
import { fenceGeometry, fruitTrees, hayMatrices, haystack, yardGeometry } from "@/geo/gardenscape";
import { SCENE, fenceMaterial, pavingMaterial, buildingMaterial, carMaterial, glowMaterial, landmarkMaterial, roadMaterial, streetlightMaterial, terrainMaterial, farTerrainMaterial, skyMaterial, treeMaterial, waterMaterial, reedMaterial, tuftMaterial, REFLECT } from "./materials";
import { landmarkGeometry, landmarkReplacements } from "@/geo/landmarks";
import { contactShadowGeometry, surroundingsGeometry } from "@/geo/surroundings";
import { chooseStride, chunkGeometry, levelChunks, type Chunk } from "@/geo/terrainLevels";
import { bump } from "@/ui/perf";

export type Quality = "high" | "medium" | "low";

/** Per-tier level-of-detail settings (the one place to tune the presets). */
export const TIERS: Record<Quality, {
  terrainStride: number; contextStride: number; buildingNear: number; treeDensity: number; treeFar: number; detailNear: number;
  /** real-terrain LOD: a chunk drops to a coarser stride while one coarse cell stays under this angle (radians) */
  farTol: number;
}> = {
  // buildingNear: tiles closer than this (m, camera to tile sphere) use the window/tile-pattern shader
  // detailNear: balconies/entrances (separate mesh per tile) drawn only for tiles closer than this; 0 = never
  // treeFar: beyond this distance only every 2nd tree in a tile is drawn (tiny on screen there)
  high: { terrainStride: 1, contextStride: 1, buildingNear: 1400, treeDensity: 1, treeFar: 1600, detailNear: 650, farTol: 0.005 },
  medium: { terrainStride: 1, contextStride: 2, buildingNear: 900, treeDensity: 1, treeFar: 1100, detailNear: 420, farTol: 0.011 },
  low: { terrainStride: 2, contextStride: 2, buildingNear: 600, treeDensity: 2, treeFar: 800, detailNear: 0, farTol: 0.02 },
};

function useDispose(items: { dispose: () => void }[]) {
  useEffect(() => () => items.forEach((i) => i.dispose()), [items]);
}

function coverTexture(img: HTMLImageElement) {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Core terrain split into frustum-culled tiles sharing one vertex buffer. Around it either the real surrounding
 * terrain (FarTerrain: nested 30/60/180 m levels, chunked, per-chunk LOD) or, for areas baked before it, the legacy
 * 60 m context ring.
 */
export function Terrain({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const T = TIERS[quality];
  const core = useMemo(() => { bump("geometryBuilds"); return terrainGeometry(data.core, data.datum, 25, T.terrainStride); }, [data, T.terrainStride]);
  // ~600 m terrain tiles so the renderer can cull most of a town-sized core
  const tiles = useMemo(() => splitTiles(core, Math.max(4, Math.round((2 * data.meta.extent.halfW) / 600))), [core, data]);
  const covCore = useMemo(() => coverTexture(data.coverCore), [data]);
  const mCore = useMemo(() => terrainMaterial(style, covCore, false), [style, covCore]);
  useDispose(useMemo(() => [core, ...tiles, covCore, mCore], [core, tiles, covCore, mCore]));
  return (
    <group>
      <group ref={reflectableNear}>{tiles.map((g, i) => <mesh key={i} geometry={g} material={mCore} receiveShadow />)}</group>
      {/* nothing casts shadows outside the core, so the surrounding terrain skips shadow lookups */}
      {data.levels.length ? <FarTerrain data={data} style={style} quality={quality} /> : <LegacyContext data={data} style={style} quality={quality} />}
    </group>
  );
}

function LegacyContext({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const T = TIERS[quality];
  const ctx = useMemo(() => terrainGeometry(data.context as Heightfield, data.datum, 0, T.contextStride), [data, T.contextStride]);
  const covCtx = useMemo(() => coverTexture(data.coverContext!), [data]);
  const mCtx = useMemo(() => terrainMaterial(style, covCtx, true), [style, covCtx]);
  useDispose(useMemo(() => [ctx, covCtx, mCtx], [ctx, covCtx, mCtx]));
  return <mesh geometry={ctx} material={mCtx} />;
}

/**
 * Real surrounding terrain: one mesh per chunk (three culls them by the frustum); each frame the camera position picks
 * every chunk's LOD stride (geometries are built on first use and cached). Plus the sky dome behind it.
 */
export function FarTerrain({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const tol = TIERS[quality].farTol;
  const { scene, invalidate } = useThree();
  const chunks = useMemo(() => levelChunks(data), [data]);
  const covers = useMemo(() => data.levels.map((l) => coverTexture(l.cover)), [data]);
  const rEff = data.terrainInfo?.curvature.R_eff_m ?? 7_323_000;
  const edge = data.levels[data.levels.length - 1].meta.half;
  const mats = useMemo(() => data.levels.map((l, i) => {
    const m = farTerrainMaterial(style, covers[i], { datum: data.datum, rEff, edge, x0: l.meta.x0, size: (l.meta.nx - 1) * l.meta.step });
    // L1 overlaps the core's border cells: draw it just behind so the core always wins there
    if (i === 0) { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 2; }
    return m;
  }), [data, style, covers, rEff, edge]);
  const group = useMemo(() => {
    const g = new THREE.Group();
    for (const ch of chunks) {
      const mesh = new THREE.Mesh(chunkGeometry(data, ch, 4), mats[ch.level]);
      mesh.userData.chunk = ch;
      mesh.userData.stride = 4;
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
    }
    reflectable(g);
    return g;
  }, [chunks, mats, data]);
  const sky = useMemo(() => {
    const mat = skyMaterial(new THREE.Color(style.terrain.zenith));
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    m.scale.setScalar(140_000);
    m.renderOrder = -10;
    m.layers.enable(REFLECT_LAYER);
    m.frustumCulled = false;
    m.onBeforeRender = (_r, sc, cam) => {
      m.position.copy(cam.position); m.updateMatrixWorld();
      if (sc.fog instanceof THREE.Fog) mat.uniforms.uFog.value.copy(sc.fog.color); // follows day / sunset / night
    };
    return m;
  }, [scene, style]);
  useEffect(() => () => {
    for (const ch of chunks) for (const g of ch.geoms.values()) g.dispose();
    covers.forEach((c) => c.dispose()); mats.forEach((m) => m.dispose());
    sky.geometry.dispose(); (sky.material as THREE.Material).dispose();
  }, [chunks, covers, mats, sky]);
  const cam = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    cam.copy(camera.position);
    let changed = false;
    for (const m of group.children as THREE.Mesh[]) {
      const ch = m.userData.chunk as Chunk;
      const s = chooseStride(data, ch, cam, tol);
      if (s !== m.userData.stride) { m.geometry = chunkGeometry(data, ch, s); m.userData.stride = s; changed = true; }
    }
    if (changed) invalidate();
  });
  return (
    <>
      <primitive object={sky} />
      <primitive object={group} />
    </>
  );
}

/**
 * Buildings in 4×4 tiles: one merged mesh (one draw call) per tile, frustum-culled by the renderer.
 * Tiles near the camera use the detailed facade/roof shader, far tiles a flat-tone LOD shader.
 * Footprints are unchanged; every building stays in the scene. Per-building vertex spans are
 * kept in geometry.userData.ranges for selection.
 */
/** Audit view colours: green OSM, blue Microsoft ML, light blue ML outbuilding, orange OSM overlapping a street, purple = height from source. */
export const AUDIT_COLORS = { review: "#f2c84b", osm: "#3fae64", ms: "#4f86d9", outbuilding: "#7cc7d6", osmOnStreet: "#f29d38", heightSrc: "#9b6ad6", removed: "#e0453a", gap: "#d6338f" };
export type AuditEntry = { flags: string[]; status: string; osm: string | null; area: number; img?: string };
export const REVIEW_FLAGS = new Set(["overlap", "odd_shape", "large_ml", "isolated_ml", "skewed_to_street", "on_street", "duplicate", "duplicate_ml_of_osm", "s2_vegetation", "road_through"]);
export const needsReview = (e?: AuditEntry) => !!e && e.flags.some((f) => REVIEW_FLAGS.has(f));
const auditTint = (b: Building, e?: AuditEntry) =>
  needsReview(e) ? AUDIT_COLORS.review
  : b.hSrc !== "estimated" ? AUDIT_COLORS.heightSrc
  : b.src === "osm" ? ((b.onStreet ?? 0) >= 0.15 ? AUDIT_COLORS.osmOnStreet : AUDIT_COLORS.osm)
  : b.kind === "outbuilding" ? AUDIT_COLORS.outbuilding : AUDIT_COLORS.ms;

/**
 * Phase 3 geometry-evidence view (#verify, public/data/<area>/verify.json from pipeline/verify_city.py):
 * verified = OSM and Microsoft (two independent producers) agree on the outline; confirmed = the 1 m imagery shows
 * the roof at the mapped position within the measured tolerance; present = an independent source shows a
 * building there but outline/position is not confirmed; unconfirmed = nothing confirms or contradicts it;
 * disputed = Microsoft ML only and two independent sources show vegetation there.
 */
export const VERIFY_COLORS = { verified: "#2f9e57", confirmed: "#7fcf8a", present: "#d9c94a", unconfirmed: "#9aa0a6", disputed: "#e0453a", missing: "#d6338f", street: "#f29d38" };
export type VerifyEntry = { tier: keyof typeof VERIFY_COLORS; why?: string; area?: string; ms_iou?: number; res?: number; img?: number; chm?: number; obsc?: boolean; det?: number; corr?: { kind: string; confidence: string; evidence: string[] } };
const verifyTint = (e?: VerifyEntry) => VERIFY_COLORS[e?.tier ?? "unconfirmed"] ?? VERIFY_COLORS.unconfirmed;

export function Buildings({ data, style, quality, provisional = true, audit = false, auditMap, verifyMap, onPick, estimates = false }: {
  data: AreaData; style: StyleConfig; quality: Quality; provisional?: boolean; audit?: boolean; estimates?: boolean;
  auditMap?: Map<string, AuditEntry>; verifyMap?: Map<string, VerifyEntry>; onPick?: (b: Building) => void;
}) {
  const near = TIERS[quality].buildingNear;
  const skip = useMemo(() => landmarkReplacements(data, { provisional }).ids, [data, provisional]);
  const geos = useMemo(() => {
    const { halfW, halfH } = data.meta.extent, n = Math.max(4, Math.round((2 * halfW) / 550)); // ~550 m building tiles
    const buckets: Building[][] = Array.from({ length: n * n }, () => []);
    for (const b of data.buildings) {
      if (skip.has(b.id)) continue;
      let cx = 0, cy = 0;
      for (const [x, y] of b.fp) { cx += x; cy += y; }
      cx /= b.fp.length; cy /= b.fp.length;
      const i = Math.min(n - 1, Math.max(0, Math.floor(((cx + halfW) / (2 * halfW)) * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor(((cy + halfH) / (2 * halfH)) * n)));
      buckets[j * n + i].push(b);
    }
    bump("geometryBuilds");
    const road = roadLookup(data);
    const tint = verifyMap ? (bb: Building) => verifyTint(verifyMap.get(bb.id)) : audit ? (bb: Building) => auditTint(bb, auditMap?.get(bb.id)) : undefined;
    return buckets.filter((b) => b.length).map((b) => buildBuildingTile(b, data.datum, style, road, tint, estimates && !tint));
  }, [data, skip, audit, auditMap, verifyMap, estimates, style.roof.pitchDeg, style.roof.overhang, style.walls, style.roofs, style.window.bayWidth, style.window.floorHeight]); // eslint-disable-line react-hooks/exhaustive-deps
  const mNear = useMemo(() => buildingMaterial(style, true), [style]);
  const mFar = useMemo(() => buildingMaterial(style, false), [style]);
  useDispose(useMemo(() => geos.flatMap((g) => [g.main, g.details]), [geos]));
  useDispose(useMemo(() => [mNear, mFar], [mNear, mFar]));
  const group = useRef<THREE.Group>(null);
  const details = useRef<THREE.Group>(null);
  const detailNear = TIERS[quality].detailNear;
  const { camera } = useThree();
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    for (const m of g.children as THREE.Mesh[]) {
      const s = m.geometry.boundingSphere!;
      const d = camera.position.distanceTo(s.center) - s.radius;
      const want = d < near ? mNear : mFar;
      if (m.material !== want) m.material = want;
    }
    // small details only near the camera (distance-based visibility; they do not cast shadows)
    for (const m of (details.current?.children ?? []) as THREE.Mesh[]) {
      const s = m.geometry.boundingSphere!;
      m.visible = camera.position.distanceTo(s.center) - s.radius < detailNear;
    }
  });
  return (
    <>
      <group ref={group}>
        {geos.map((g, i) => (
          <mesh key={i} geometry={g.main} material={mNear} castShadow receiveShadow
            onClick={onPick ? (e) => {
              // non-indexed geometry: face -> vertex -> building via the per-building vertex ranges
              e.stopPropagation();
              const v = (e.faceIndex ?? -1) * 3, r = g.main.userData.ranges as Int32Array, list = g.main.userData.list as Building[];
              for (let k = 0; k < r.length; k += 5) if ((v >= r[k + 1] && v < r[k + 2]) || (v >= r[k + 3] && v < r[k + 4])) { onPick(list[r[k]]); break; }
            } : undefined} />
        ))}
      </group>
      {detailNear > 0 && (
        <group ref={details}>
          {geos.map((g, i) => <mesh key={i} geometry={g.details} material={mNear} receiveShadow />)}
        </group>
      )}
    </>
  );
}

/** Nearest road point (car roads and residential streets, not footpaths) to a position, within 60 m; grid-indexed. */
export function roadLookup(data: AreaData) {
  const cell = 30, grid = new Map<string, [number, number][]>();
  for (const r of data.roads) {
    if (/foot|path|steps|track|cycle|pedestrian|bridleway/.test(r.c)) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x1, y1] = r.pts[i], [x2, y2] = r.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4));
      for (let k = 0; k < n; k++) {
        const x = x1 + ((x2 - x1) * k) / n, y = y1 + ((y2 - y1) * k) / n, key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push([x, y]);
      }
    }
  }
  return (x: number, y: number): [number, number] | null => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let best = 60 * 60, out: [number, number] | null = null;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const p of grid.get(`${gx + i},${gy + j}`) ?? []) {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < best) { best = d; out = p; }
    }
    return out;
  };
}

/**
 * Developer geographic-audit overlay (#audit): footprints removed by the reconciliation rules (red outlines on the
 * ground) and 50 m cells that ESA WorldCover classes as built-up but that contain no mapped footprint (magenta).
 */
export function AuditLayer({ data, gaps }: { data: AreaData; gaps: { x: number; y: number }[] }) {
  const g = useMemo(() => {
    const pos: number[] = [], col: number[] = [];
    const h = (x: number, y: number) => (d => d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y))(data) - data.datum + 0.6;
    const red = new THREE.Color(AUDIT_COLORS.removed), mag = new THREE.Color(AUDIT_COLORS.gap);
    const push = (x: number, y: number, c: THREE.Color) => { pos.push(x, h(x, y), -y); col.push(c.r, c.g, c.b); };
    for (const r of data.removed) {
      // outline as a 0.6 m wide band just inside the footprint, plus a fill fan
      const fp = r.fp, n = fp.length;
      let cx = 0, cy = 0; for (const [x, y] of fp) { cx += x; cy += y; } cx /= n; cy /= n;
      for (let i = 0; i < n; i++) { const a = fp[i], b = fp[(i + 1) % n]; push(cx, cy, red); push(a[0], a[1], red); push(b[0], b[1], red); }
    }
    for (const c of gaps) {
      const s = 24;
      const q = [[c.x - s, c.y - s], [c.x + s, c.y - s], [c.x + s, c.y + s], [c.x - s, c.y + s]];
      for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) { push(q[i][0], q[i][1], mag); push(q[j][0], q[j][1], mag); push(q[k][0], q[k][1], mag); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }, [data, gaps]);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }), []);
  useDispose(useMemo(() => [g, m], [g, m]));
  return <mesh geometry={g} material={m} renderOrder={5} />;
}

/**
 * #verify overlay: Microsoft 2024 footprints (GlobalBuildingAtlas) that are missing from the model but whose roof the
 * 1 m imagery shows (magenta, listed only, nothing added) and car roads whose imagery road line lies >= 5 m from the OSM centreline (orange).
 */
export function VerifyLayer({ data, missing, streets }: { data: AreaData; missing: number[][]; streets: { x: number; y: number }[] }) {
  const g = useMemo(() => {
    const pos: number[] = [], col: number[] = [];
    const h = (x: number, y: number) => (d => d.core.contains(x, y) ? d.core.atTri(x, y) : d.context.at(x, y))(data) - data.datum + 0.8;
    const quad = (x: number, y: number, s: number, c: THREE.Color) => {
      const q = [[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]];
      for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) for (const n of [i, j, k]) { pos.push(q[n][0], h(q[n][0], q[n][1]), -q[n][1]); col.push(c.r, c.g, c.b); }
    };
    const mag = new THREE.Color(VERIFY_COLORS.missing), org = new THREE.Color(VERIFY_COLORS.street);
    for (const m of missing) quad(m[0], m[1], Math.max(3, Math.sqrt(m[2] ?? 40) / 2), mag);
    for (const s of streets) quad(s.x, s.y, 7, org);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }, [data, missing, streets]);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }), []);
  useDispose(useMemo(() => [g, m], [g, m]));
  return <mesh geometry={g} material={m} renderOrder={5} />;
}

/**
 * Street details. With streets.json: estimated sidewalks (only when estimates are shown), bridge decks, mapped
 * zebra crossings, pitch markings, piers, mapped power lines and estimated cemetery headstones. Older areas fall
 * back to the kerb ribbons along main streets. Mapped furniture/walls in both cases.
 */
export function StreetDetails({ data, style, estimates = true, quality = "high" }: { data: AreaData; style: StyleConfig; estimates?: boolean; quality?: Quality }) {
  const lift = 0.22; // carriageway lift, as in landscape.ts
  const geos = useMemo(() => {
    if (!data.streets) return { sw: sidewalksGeometry(data, style), fixed: [] as THREE.BufferGeometry[] };
    const fixed = [bridgeGeometry(data, lift), zebraGeometry(data, lift, (c) => style.roads.widths[c] ?? 5), pitchGeometry(data), pierGeometry(data)]
      .filter((g) => g.getAttribute("position").count > 0);
    return { sw: sidewalkGeometry(data, lift), fixed };
  }, [data, style]);
  const fu = useMemo(() => furnitureGeometry(data), [data]);
  const power = useMemo(() => powerGeometry(data), [data]);
  const stones = useMemo(() => headstoneMatrices(data), [data]);
  const m = useMemo(() => pavingMaterial(), []);
  const plain = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }), []);
  const wireM = useMemo(() => new THREE.LineBasicMaterial({ color: "#3b3f45", transparent: true, opacity: 0.75 }), []);
  const stoneMesh = useMemo(() => {
    if (!stones.length) return null;
    const g = new THREE.BoxGeometry(0.42, 1, 0.14); g.deleteAttribute("uv");
    console.info(`[plav] headstones (estimate): ${stones.length}`);
    const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: "#e8e5dc", roughness: 0.8 }), stones.length);
    stones.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.computeBoundingSphere();
    im.castShadow = true; im.receiveShadow = true;
    return im;
  }, [stones]);
  useDispose(useMemo(() => [geos.sw, ...geos.fixed, fu, m, plain, wireM, power.solid, power.wires], [geos, fu, m, plain, wireM, power]));
  useEffect(() => () => { if (stoneMesh) { stoneMesh.geometry.dispose(); (stoneMesh.material as THREE.Material).dispose(); stoneMesh.dispose(); } }, [stoneMesh]);
  const showSw = !data.streets || estimates;
  return (
    <group>
      {showSw && <mesh geometry={geos.sw} material={m} receiveShadow />}
      {geos.fixed.map((g, i) => <mesh key={i} geometry={g} material={m} castShadow receiveShadow />)}
      {fu.getAttribute("position").count > 0 && <mesh geometry={fu} material={plain} castShadow receiveShadow />}
      {power.solid.getAttribute("position").count > 0 && <mesh geometry={power.solid} material={plain} castShadow />}
      {power.wires.getAttribute("position").count > 0 && <lineSegments geometry={power.wires} material={wireM} />}
      {estimates && quality !== "low" && stoneMesh && <primitive object={stoneMesh} />}
    </group>
  );
}

export function Roads({ data, style }: { data: AreaData; style: StyleConfig }) {
  // ~500 m tiles (culled), plus the night-only light-pool overlays on unmarked streets
  const n = Math.max(2, Math.round((2 * data.meta.extent.halfW) / 500));
  const tiles = useMemo(() => { const g = roadsGeometry(data, style); const t = splitNonIndexed(g, n); g.dispose(); return t; }, [data, style.roads.widths, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const nightTiles = useMemo(() => { const g = roadsGeometry(data, style, "night"); const t = splitNonIndexed(g, n); g.dispose(); return t; }, [data, style.roads.widths, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMemo(() => roadMaterial(style), [style]);
  const og = useMemo(() => overlaysGeometry(data, style), [data, style]);
  const om = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), []);
  useDispose(useMemo(() => [...tiles, ...nightTiles, m, og, om], [tiles, nightTiles, m, og, om]));
  const night = useRef<THREE.Group>(null);
  useFrame(() => { if (night.current) night.current.visible = SCENE.uNight.value > 0.02; });
  return (
    <group>
      <mesh geometry={og} material={om} receiveShadow />
      {tiles.map((g, i) => <mesh key={i} geometry={g} material={m} receiveShadow />)}
      <group ref={night} visible={false}>{nightTiles.map((g, i) => <mesh key={i} geometry={g} material={m} />)}</group>
    </group>
  );
}

/** Objects drawn into the lake reflection carry this layer (terrain, far terrain, sky; buildings and trees on high). */
export const REFLECT_LAYER = 3;
/** the city-core terrain tiles: reflected on high only (they are the most triangles near the lake) */
export const REFLECT_NEAR = 4;
const reflectable = (o: THREE.Object3D | null) => o?.traverse((c) => c.layers.enable(REFLECT_LAYER));
const reflectableNear = (o: THREE.Object3D | null) => o?.traverse((c) => c.layers.enable(REFLECT_NEAR));

/**
 * Water: lakes, mapped river areas and stream ribbons in one material (water v2), the Sentinel-2 reed belt over the
 * lakes, reed tufts along the open-water edge (medium/high) and the planar lake reflection (medium/high).
 */
export function Water({ data, style, quality, reflect = true, reeds = true }: { data: AreaData; style: StyleConfig; quality: Quality; reflect?: boolean; reeds?: boolean }) {
  const g = useMemo(() => waterGeometry(data), [data]);
  const s = useMemo(() => streamsGeometry(data), [data]);
  const mt = useMemo(() => (data.marsh ? marshTexture(data.marsh) : null), [data]);
  const box = useMemo(() => {
    const mm = data.marsh;
    return mm ? new THREE.Vector4(mm.x0, mm.y0, mm.nx * mm.step, mm.ny * mm.step) : new THREE.Vector4(0, 0, 1, 1);
  }, [data]);
  const m = useMemo(() => waterMaterial(style, mt, box), [style, mt, box]);
  const marsh = useMemo(() => (data.marsh ? marshGeometry(data, style, quality === "high" ? 2 : quality === "medium" ? 1 : 0) : null), [data, style, quality]);
  const rm = useMemo(() => (mt ? reedMaterial(mt, box) : null), [mt, box]);
  const tm = useMemo(() => tuftMaterial(style), [style]);
  const tg = useMemo(() => tuftGeometry(), []);
  const tufts = useMemo(() => {
    if (!marsh || !marsh.tufts.length) return null;
    const im = new THREE.InstancedMesh(tg, tm, marsh.tufts.length);
    marsh.tufts.forEach((M, i) => { im.setMatrixAt(i, M); im.setColorAt(i, marsh.tuftColors[i]); });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    return im;
  }, [marsh, tg, tm]);
  useDispose(useMemo(() => [g, s, m, ...(rm ? [rm] : []), tm, tg, ...(mt ? [mt] : []), ...(marsh ? [marsh.canopy] : [])], [g, s, m, rm, tm, tg, mt, marsh]));
  const { scene } = useThree();
  useFrame(({ clock }) => {
    const U = m.userData.u as { uSkyCol: { value: THREE.Color }; uTime: { value: number } };
    if (scene.fog instanceof THREE.Fog) U.uSkyCol.value.copy(scene.fog.color);
    U.uTime.value = clock.elapsedTime;
  });
  const lake = useMemo(() => data.water.find((w) => w.kind === "lake" && w.name && /plav/i.test(w.name)) ?? null, [data]);
  return (
    <group>
      <mesh geometry={g} material={m} receiveShadow />
      <mesh geometry={s} material={m} receiveShadow />
      {reeds && marsh && rm && <mesh geometry={marsh.canopy} material={rm} receiveShadow />}
      {reeds && tufts && <primitive object={tufts} />}
      {lake && reflect && quality !== "low" && <LakeReflection data={data} level={lake.level! - data.datum} outer={lake.outer} high={quality === "high"} />}
    </group>
  );
}

/**
 * Planar reflection of the lake (Reflector-style mirrored camera with an oblique near plane at the water level).
 * Renders only REFLECT_LAYER objects into a reduced-size target, and only on frames the scene renders anyway
 * (demand frameloop) while the lake is inside the view frustum. Shadow maps are not re-rendered for it.
 */
function LakeReflection({ data, level, outer, high }: { data: AreaData; level: number; outer: [number, number][]; high: boolean }) {
  // medium: 1/3 resolution, far terrain + sky, refreshed every 2nd drawn frame; high: 1/2, + core terrain, every frame
  const scale = high ? 0.5 : 0.33, every = high ? 1 : 2;
  const { gl, scene, camera, size } = useThree();
  const rt = useMemo(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true }), []);
  const vcam = useMemo(() => { const c = new THREE.PerspectiveCamera(); c.layers.set(REFLECT_LAYER); if (high) c.layers.enable(REFLECT_NEAR); return c; }, [high]);
  const bounds = useMemo(() => {
    const b = new THREE.Box3();
    for (const [x, y] of outer) b.expandByPoint(new THREE.Vector3(x, level, -y));
    b.min.y -= 1; b.max.y += 1;
    return b;
  }, [outer, level]);
  useEffect(() => {
    const dpr = gl.getPixelRatio();
    rt.setSize(Math.max(64, Math.round(size.width * dpr * scale)), Math.max(64, Math.round(size.height * dpr * scale)));
  }, [gl, size, scale, rt]);
  useEffect(() => {
    REFLECT.map.value = rt.texture; REFLECT.level.value = level;
    return () => { REFLECT.on.value = 0; REFLECT.map.value = null; rt.dispose(); };
  }, [rt, level]);
  void data;
  const tmp = useMemo(() => ({
    n: new THREE.Vector3(0, 1, 0), p: new THREE.Vector3(), cam: new THREE.Vector3(), look: new THREE.Vector3(), rot: new THREE.Matrix4(),
    view: new THREE.Vector3(), target: new THREE.Vector3(), plane: new THREE.Plane(), clip: new THREE.Vector4(), q: new THREE.Vector4(),
    frustum: new THREE.Frustum(), pv: new THREE.Matrix4(), lights: [] as THREE.Light[], frame: 0,
  }), []);
  useFrame(() => {
    const t = tmp;
    const cam = camera as THREE.PerspectiveCamera;
    t.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    t.frustum.setFromProjectionMatrix(t.pv);
    t.cam.setFromMatrixPosition(cam.matrixWorld);
    if (!t.frustum.intersectsBox(bounds) || t.cam.y < level + 0.5) { REFLECT.on.value = 0; return; }
    REFLECT.on.value = 1;
    if (t.frame++ % every !== 0) return; // the texture and its matrix stay from the last refresh (consistent pair)
    if (t.frame % 120 === 1) { t.lights = []; scene.traverse((o) => { if ((o as THREE.Light).isLight) { o.layers.enable(REFLECT_LAYER); o.layers.enable(REFLECT_NEAR); t.lights.push(o as THREE.Light); } }); }
    t.p.set(0, level, 0);
    t.rot.extractRotation(cam.matrixWorld);
    t.look.set(0, 0, -1).applyMatrix4(t.rot).add(t.cam);
    t.view.subVectors(t.p, t.cam).reflect(t.n).negate().add(t.p);
    t.target.subVectors(t.p, t.look).reflect(t.n).negate().add(t.p);
    vcam.position.copy(t.view);
    vcam.up.set(0, 1, 0).applyMatrix4(t.rot).reflect(t.n);
    vcam.lookAt(t.target);
    vcam.near = cam.near; vcam.far = cam.far; vcam.fov = cam.fov; vcam.aspect = cam.aspect;
    vcam.updateMatrixWorld();
    vcam.projectionMatrix.copy(cam.projectionMatrix);
    REFLECT.matrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(vcam.projectionMatrix).multiply(vcam.matrixWorldInverse);
    // oblique near plane = the water plane, so nothing under the water is reflected
    t.plane.setFromNormalAndCoplanarPoint(t.n, t.p).applyMatrix4(vcam.matrixWorldInverse);
    t.clip.set(t.plane.normal.x, t.plane.normal.y, t.plane.normal.z, t.plane.constant);
    const e = vcam.projectionMatrix.elements;
    t.q.set((Math.sign(t.clip.x) + e[8]) / e[0], (Math.sign(t.clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    t.clip.multiplyScalar(2 / t.clip.dot(t.q));
    e[2] = t.clip.x; e[6] = t.clip.y; e[10] = t.clip.z + 1 - 0.003; e[14] = t.clip.w;
    vcam.projectionMatrixInverse.copy(vcam.projectionMatrix).invert();
    const prev = gl.getRenderTarget();
    const au = gl.shadowMap.autoUpdate, nu = gl.shadowMap.needsUpdate;
    gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = false;
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, vcam);
    gl.setRenderTarget(prev);
    gl.shadowMap.autoUpdate = au; gl.shadowMap.needsUpdate = nu;
  }, -1);
  return null;
}

/** Shared flag: the sun sets it when the shadow map is about to be re-rendered, so trees write their full set first. */
export const shadowSync = { full: false };

/**
 * Trees: two InstancedMeshes (deciduous, conifer), crown + trunk merged. Instances are sorted into
 * 256 m tiles; only tiles inside the view frustum are written to the instance buffer, and tiles far
 * from the camera keep every 2nd tree. The buffer is rewritten only when that visible set changes.
 */
export function Trees({ data, style, quality, estimates = false }: { data: AreaData; style: StyleConfig; quality: Quality; estimates?: boolean }) {
  const T = TIERS[quality];
  const geo = useMemo(() => treeGeometries(style.trees.trunk), [style.trees.trunk]);
  const sets = useMemo(() => treeSets(data, style.trees.leaf, style.trees.conifer, style.trees.size, 256, estimates ? fruitTrees(data) : undefined), [data, style.trees, estimates]);
  const mat = useMemo(() => treeMaterial(), []);
  const meshes = useMemo(() => {
    const mk = (g: THREE.BufferGeometry, s: TreeSet) => {
      const im = new THREE.InstancedMesh(g, mat, Math.max(s.count, 1));
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(s.count, 1) * 3), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false; // culled per tile below
      return { im, s, sig: new Int8Array(s.tiles.length).fill(-1), next: new Int8Array(s.tiles.length) };
    };
    return [mk(geo.leaf, sets.leaf), mk(geo.oval, sets.oval), mk(geo.broad, sets.broad), mk(geo.conifer, sets.conifer)];
  }, [geo, sets, mat]);
  useEffect(() => () => { meshes.forEach((m) => m.im.dispose()); Object.values(geo).forEach((g) => g.dispose()); }, [meshes, geo]);
  useEffect(() => () => mat.dispose(), [mat]);

  const { camera } = useThree();
  const tmp = useMemo(() => ({ frustum: new THREE.Frustum(), pv: new THREE.Matrix4() }), []);
  useFrame(() => {
    const full = shadowSync.full;
    camera.updateMatrixWorld();
    tmp.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    tmp.frustum.setFromProjectionMatrix(tmp.pv);
    const cx = camera.position.x, cz = camera.position.z;
    for (const M of meshes) {
      const { s, sig, next, im } = M;
      let changed = false;
      for (let t = 0; t < s.tiles.length; t++) {
        const tl = s.tiles[t];
        let v: number;
        if (full) v = T.treeDensity;
        else if (!tmp.frustum.intersectsBox(tl.box)) v = 0;
        else v = Math.hypot(tl.cx - cx, tl.cz - cz) > T.treeFar ? T.treeDensity * 2 : T.treeDensity;
        next[t] = v;
        if (v !== sig[t]) changed = true;
      }
      if (!changed) continue;
      sig.set(next);
      const mArr = im.instanceMatrix.array as Float32Array, cArr = im.instanceColor!.array as Float32Array;
      let n = 0;
      for (let t = 0; t < s.tiles.length; t++) {
        const stride = next[t];
        if (!stride) continue;
        const tl = s.tiles[t];
        for (let i = tl.start; i < tl.end; i += stride) {
          mArr.set(s.matrices.subarray(i * 16, i * 16 + 16), n * 16);
          cArr[n * 3] = s.colors[i * 3]; cArr[n * 3 + 1] = s.colors[i * 3 + 1]; cArr[n * 3 + 2] = s.colors[i * 3 + 2];
          n++;
        }
      }
      im.count = n;
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, n * 16);
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.clearUpdateRanges();
      im.instanceColor!.addUpdateRange(0, n * 3);
      im.instanceColor!.needsUpdate = true;
    }
    if (full) shadowSync.full = false; // next frame goes back to the culled set
  }, -5);
  return (
    <group>
      {meshes.map((m, i) => <primitive key={i} object={m.im} />)}
    </group>
  );
}

/** Hand-built landmark models on their real footprints (one draw call). */
export function Landmarks({ data, provisional = true }: { data: AreaData; provisional?: boolean }) {
  const geo = useMemo(() => {
    const { parts } = landmarkGeometry(data, { provisional });
    return parts.length ? mergeGeometries(parts) : null;
  }, [data, provisional]);
  const mat = useMemo(() => landmarkMaterial(), []);
  useEffect(() => () => { geo?.dispose(); mat.dispose(); }, [geo, mat]);
  return geo ? <mesh geometry={geo} material={mat} castShadow receiveShadow /> : null;
}

export function Minarets({ data, style, provisional = true }: { data: AreaData; style: StyleConfig; provisional?: boolean }) {
  const geos = useMemo(() => {
    const drop = landmarkReplacements(data, { provisional }).minarets;
    return data.minarets.filter((_, i) => !drop.has(i)).map((m) => ({ m, g: minaretGeometry(m.height) }));
  }, [data, provisional]);
  const body = useMemo(() => new THREE.MeshStandardMaterial({ color: style.minaret.color, roughness: 0.8 }), [style.minaret.color]);
  const cap = useMemo(() => new THREE.MeshStandardMaterial({ color: style.minaret.cap, roughness: 0.5, metalness: 0.2 }), [style.minaret.cap]);
  useDispose(useMemo(() => [body, cap, ...geos.flatMap(({ g }) => [g.body, g.cap])], [body, cap, geos]));
  return (
    <group>
      {geos.map(({ m, g }, i) => (
        <group key={i} position={[m.x, m.g - data.datum - 0.5, -m.y]}>
          <mesh geometry={g.body} material={body} castShadow receiveShadow />
          <mesh geometry={g.cap} material={cap} castShadow />
        </group>
      ))}
    </group>
  );
}

/**
 * Decorative streetlights along lit road classes (no lamp survey data exists): one instanced draw for the
 * poles and, at night only, one instanced draw of additive glow halos at the lamp heads.
 */
export function Streetlights({ data, style }: { data: AreaData; style: StyleConfig }) {
  const lamps = useMemo(() => streetlights(data, style), [data, style]);
  const geo = useMemo(() => streetlightGeometry(), []);
  const mat = useMemo(() => streetlightMaterial(), []);
  const quad = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  const glow = useMemo(() => glowMaterial("#ffb866", 4.2), []);
  const { poles, halos } = useMemo(() => {
    const poles = new THREE.InstancedMesh(geo, mat, Math.max(lamps.length, 1));
    const halos = new THREE.InstancedMesh(quad, glow, Math.max(lamps.length, 1));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const h = (x: number, y: number) => (data.core.contains(x, y) ? data.core.atTri(x, y) : data.context.at(x, y)) - data.datum;
    lamps.forEach((l, i) => {
      // arm points along local +x; ang is the world direction (x, y) of the arm, scene z = -y
      q.setFromAxisAngle(up, l.ang);
      p.set(l.x, h(l.x, l.y) - 0.1, -l.y);
      poles.setMatrixAt(i, m.compose(p, q, one));
      p.set(l.x + Math.cos(l.ang) * 1.2, h(l.x, l.y) + 5.75, -l.y - Math.sin(l.ang) * 1.2);
      halos.setMatrixAt(i, m.compose(p, q.identity(), one));
    });
    poles.count = halos.count = lamps.length;
    poles.castShadow = true;
    poles.computeBoundingSphere();
    halos.frustumCulled = false;
    halos.renderOrder = 10;
    halos.visible = false;
    return { poles, halos };
  }, [lamps, geo, mat, quad, glow, data]);
  useEffect(() => () => { poles.dispose(); halos.dispose(); geo.dispose(); mat.dispose(); quad.dispose(); glow.dispose(); }, [poles, halos, geo, mat, quad, glow]);
  useFrame(() => { halos.visible = SCENE.uNight.value > 0.02; });
  return (
    <group>
      <primitive object={poles} />
      <primitive object={halos} />
    </group>
  );
}

const CAR_COLOURS = ["#c8372d", "#f2f0ea", "#2f5d8c", "#e3e1da", "#3a3d42", "#9aa3ab", "#d9a03a", "#2e6b4a", "#f2f0ea", "#8c2430"];

/**
 * Decorative traffic: `count` instanced cars on the real road graph (see geo/traffic.ts). One draw call
 * for the cars, plus (at night) one for headlight glows. Needs frames to animate, so while it runs the
 * view is redrawn at ~30 fps when idle (full rate during interaction); paused when the tab is hidden.
 */
export function Traffic({ data, style, count }: { data: AreaData; style: StyleConfig; count: number }) {
  const sim = useMemo(() => new TrafficSim(data, style, count, 7), [data, style, count]);
  const poses = useMemo<CarPose[]>(() => sim.cars.map(() => ({ x: 0, y: 0, ang: 0 })), [sim]);
  useEffect(() => { (window as unknown as { __plavCars?: CarPose[] }).__plavCars = poses; }, [poses]);
  const geo = useMemo(() => carGeometry(), []);
  const mat = useMemo(() => carMaterial(), []);
  const quad = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  const glow = useMemo(() => glowMaterial("#fff1d0", 2.6), []);
  const { cars, lights } = useMemo(() => {
    const n = Math.max(sim.cars.length, 1);
    const cars = new THREE.InstancedMesh(geo, mat, n);
    const lights = new THREE.InstancedMesh(quad, glow, n * 2);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) cars.setColorAt(i, c.set(CAR_COLOURS[(i * 7) % CAR_COLOURS.length]));
    cars.count = sim.cars.length; lights.count = sim.cars.length * 2;
    cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cars.frustumCulled = false; lights.frustumCulled = false;
    cars.castShadow = false; cars.receiveShadow = true;
    lights.renderOrder = 11; lights.visible = false;
    return { cars, lights };
  }, [sim, geo, mat, quad, glow]);
  useEffect(() => () => { cars.dispose(); lights.dispose(); }, [cars, lights]);
  useEffect(() => () => { geo.dispose(); mat.dispose(); quad.dispose(); glow.dispose(); }, [geo, mat, quad, glow]);

  const { invalidate } = useThree();
  // idle ticker: keep animating at ~30 fps; stops automatically while the tab is hidden
  useEffect(() => {
    if (!sim.cars.length) return;
    let id = 0, last = 0;
    const tick = (t: number) => {
      id = requestAnimationFrame(tick);
      if (document.hidden || t - last < 32) return;
      last = t;
      invalidate();
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [sim, invalidate]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1), up: new THREE.Vector3(0, 1, 0), last: 0 }), []);
  useFrame(() => {
    const now = performance.now();
    const dt = tmp.last ? (now - tmp.last) / 1000 : 0;
    tmp.last = now;
    if (document.hidden) return;
    sim.step(dt, poses);
    const night = SCENE.uNight.value > 0.02;
    lights.visible = night;
    for (let i = 0; i < poses.length; i++) {
      const { x, y, ang } = poses[i];
      const z = (data.core.contains(x, y) ? data.core.atTri(x, y) : data.context.at(x, y)) - data.datum + 0.18;
      tmp.q.setFromAxisAngle(tmp.up, ang);
      cars.setMatrixAt(i, tmp.m.compose(tmp.p.set(x, z, -y), tmp.q, tmp.one));
      if (night) {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        for (const side of [-0.6, 0.6]) {
          tmp.p.set(x + ca * 2.3 + sa * side, z + 0.75, -(y + sa * 2.3 - ca * side));
          lights.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), tmp.m.compose(tmp.p, tmp.q, tmp.one));
        }
      }
    }
    cars.instanceMatrix.needsUpdate = true;
    if (night) lights.instanceMatrix.needsUpdate = true;
  }, -4);
  return (
    <group>
      <primitive object={cars} />
      <primitive object={lights} />
    </group>
  );
}

/**
 * ESTIMATED gardens (only with estimates on): yard lawns and vegetable plots (one draw), street-side fences (one draw,
 * medium/high only) and haystacks on mapped meadows (one instanced draw, medium/high only).
 */
export function Gardens({ data, quality }: { data: AreaData; quality: Quality }) {
  const yards = useMemo(() => yardGeometry(data), [data]);
  const fences = useMemo(() => fenceGeometry(data), [data]);
  const surround = useMemo(() => surroundingsGeometry(data, roadLookup(data)), [data]);
  const contact = useMemo(() => contactShadowGeometry(data), [data]);
  const contactM = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), []);
  const surroundM = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), []);
  const yardM = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), []);
  const fenceM = useMemo(() => fenceMaterial(), []);
  const hay = useMemo(() => {
    const mats = hayMatrices(data);
    if (!mats.length) return null;
    const im = new THREE.InstancedMesh(haystack(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }), mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    im.castShadow = true; im.receiveShadow = true;
    return im;
  }, [data]);
  useDispose(useMemo(() => [yards, fences, yardM, fenceM, surround, surroundM, contact, contactM], [yards, fences, yardM, fenceM, surround, surroundM, contact, contactM]));
  useEffect(() => () => { if (hay) { hay.geometry.dispose(); (hay.material as THREE.Material).dispose(); hay.dispose(); } }, [hay]);
  if (!data.gardens) return null;
  return (
    <group>
      <mesh geometry={yards} material={yardM} receiveShadow />
      <mesh geometry={contact} material={contactM} renderOrder={1} />
      {quality !== "low" && <mesh geometry={fences} material={fenceM} castShadow receiveShadow />}
      {quality !== "low" && <mesh geometry={surround} material={surroundM} castShadow receiveShadow />}
      {quality !== "low" && hay && <primitive object={hay} />}
    </group>
  );
}
