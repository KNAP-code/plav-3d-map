"use client";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useFrame, useThree } from "@react-three/fiber";
import type { AreaData, Building } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { buildBuildingTile } from "@/geo/buildings";
import { overlaysGeometry, roadsGeometry, splitTiles, streamsGeometry, terrainGeometry, waterGeometry } from "@/geo/landscape";
import { carGeometry, minaretGeometry, streetlightGeometry, treeGeometries, treeSets, type TreeSet } from "@/geo/props";
import { streetlights } from "@/geo/roads";
import { furnitureGeometry, sidewalksGeometry } from "@/geo/street";
import { Traffic as TrafficSim, type CarPose } from "@/geo/traffic";
import { SCENE, buildingMaterial, carMaterial, glowMaterial, landmarkMaterial, roadMaterial, streetlightMaterial, terrainMaterial, treeMaterial, waterMaterial } from "./materials";
import { landmarkGeometry, landmarkReplacements } from "@/geo/landmarks";
import { bump } from "@/ui/perf";

export type Quality = "high" | "medium" | "low";

/** Per-tier level-of-detail settings (the one place to tune the presets). */
export const TIERS: Record<Quality, {
  terrainStride: number; contextStride: number; buildingNear: number; treeDensity: number; treeFar: number; detailNear: number;
}> = {
  // buildingNear: tiles closer than this (m, camera to tile sphere) use the window/tile-pattern shader
  // detailNear: balconies/entrances (separate mesh per tile) drawn only for tiles closer than this; 0 = never
  // treeFar: beyond this distance only every 2nd tree in a tile is drawn (tiny on screen there)
  high: { terrainStride: 1, contextStride: 1, buildingNear: 1400, treeDensity: 1, treeFar: 1600, detailNear: 650 },
  medium: { terrainStride: 1, contextStride: 2, buildingNear: 900, treeDensity: 1, treeFar: 1100, detailNear: 420 },
  low: { terrainStride: 2, contextStride: 2, buildingNear: 600, treeDensity: 2, treeFar: 800, detailNear: 0 },
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

/** Core terrain split into 4×4 frustum-culled tiles sharing one vertex buffer; context ring at reduced density. */
export function Terrain({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const T = TIERS[quality];
  const core = useMemo(() => { bump("geometryBuilds"); return terrainGeometry(data.core, data.datum, 25, T.terrainStride); }, [data, T.terrainStride]);
  // ~600 m terrain tiles so the renderer can cull most of a town-sized core
  const tiles = useMemo(() => splitTiles(core, Math.max(4, Math.round((2 * data.meta.extent.halfW) / 600))), [core, data]);
  const ctx = useMemo(() => terrainGeometry(data.context, data.datum, 0, T.contextStride), [data, T.contextStride]);
  const covCore = useMemo(() => coverTexture(data.coverCore), [data]);
  const covCtx = useMemo(() => coverTexture(data.coverContext), [data]);
  const mCore = useMemo(() => terrainMaterial(style, covCore, false), [style, covCore]);
  const mCtx = useMemo(() => terrainMaterial(style, covCtx, true), [style, covCtx]);
  useDispose(useMemo(() => [core, ctx, ...tiles], [core, ctx, tiles]));
  useDispose(useMemo(() => [covCore, covCtx, mCore, mCtx], [covCore, covCtx, mCore, mCtx]));
  return (
    <group>
      {tiles.map((g, i) => <mesh key={i} geometry={g} material={mCore} receiveShadow />)}
      {/* nothing casts shadows outside the core, so the context ring skips shadow lookups */}
      <mesh geometry={ctx} material={mCtx} />
    </group>
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
export type AuditEntry = { flags: string[]; status: string; osm: string | null; area: number };
export const REVIEW_FLAGS = new Set(["overlap", "odd_shape", "large_ml", "isolated_ml", "skewed_to_street", "on_street", "duplicate", "duplicate_ml_of_osm"]);
export const needsReview = (e?: AuditEntry) => !!e && e.flags.some((f) => REVIEW_FLAGS.has(f));
const auditTint = (b: Building, e?: AuditEntry) =>
  needsReview(e) ? AUDIT_COLORS.review
  : b.hSrc !== "estimated" ? AUDIT_COLORS.heightSrc
  : b.src === "osm" ? ((b.onStreet ?? 0) >= 0.15 ? AUDIT_COLORS.osmOnStreet : AUDIT_COLORS.osm)
  : b.kind === "outbuilding" ? AUDIT_COLORS.outbuilding : AUDIT_COLORS.ms;

export function Buildings({ data, style, quality, provisional = true, audit = false, auditMap, onPick }: {
  data: AreaData; style: StyleConfig; quality: Quality; provisional?: boolean; audit?: boolean;
  auditMap?: Map<string, AuditEntry>; onPick?: (b: Building) => void;
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
    return buckets.filter((b) => b.length).map((b) => buildBuildingTile(b, data.datum, style, road, audit ? (bb) => auditTint(bb, auditMap?.get(bb.id)) : undefined));
  }, [data, skip, audit, auditMap, style.roof.pitchDeg, style.roof.overhang, style.walls, style.roofs, style.window.bayWidth, style.window.floorHeight]); // eslint-disable-line react-hooks/exhaustive-deps
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
function roadLookup(data: AreaData) {
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

/** Sidewalks with kerbs on main streets (estimate) and mapped street furniture/walls: two draw calls, receive shadows only. */
export function StreetDetails({ data, style }: { data: AreaData; style: StyleConfig }) {
  const sw = useMemo(() => sidewalksGeometry(data, style), [data, style]);
  const fu = useMemo(() => furnitureGeometry(data), [data]);
  const m = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }), []);
  useDispose(useMemo(() => [sw, fu, m], [sw, fu, m]));
  return (
    <group>
      <mesh geometry={sw} material={m} receiveShadow />
      {fu.getAttribute("position").count > 0 && <mesh geometry={fu} material={m} castShadow receiveShadow />}
    </group>
  );
}

export function Roads({ data, style }: { data: AreaData; style: StyleConfig }) {
  const g = useMemo(() => roadsGeometry(data, style), [data, style.roads.widths]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMemo(() => roadMaterial(style), [style]);
  const og = useMemo(() => overlaysGeometry(data, style), [data, style]);
  const om = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), []);
  useDispose(useMemo(() => [g, m, og, om], [g, m, og, om]));
  return (
    <group>
      <mesh geometry={og} material={om} receiveShadow />
      <mesh geometry={g} material={m} receiveShadow />
    </group>
  );
}

export function Water({ data, style }: { data: AreaData; style: StyleConfig }) {
  const g = useMemo(() => waterGeometry(data), [data]);
  const s = useMemo(() => streamsGeometry(data), [data]);
  const m = useMemo(() => waterMaterial(style), [style]);
  useDispose(useMemo(() => [g, s, m], [g, s, m]));
  return (
    <group>
      <mesh geometry={g} material={m} receiveShadow />
      <mesh geometry={s} material={m} receiveShadow />
    </group>
  );
}

/** Shared flag: the sun sets it when the shadow map is about to be re-rendered, so trees write their full set first. */
export const shadowSync = { full: false };

/**
 * Trees: two InstancedMeshes (deciduous, conifer), crown + trunk merged. Instances are sorted into
 * 256 m tiles; only tiles inside the view frustum are written to the instance buffer, and tiles far
 * from the camera keep every 2nd tree. The buffer is rewritten only when that visible set changes.
 */
export function Trees({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const T = TIERS[quality];
  const geo = useMemo(() => treeGeometries(style.trees.trunk), [style.trees.trunk]);
  const sets = useMemo(() => treeSets(data, style.trees.leaf, style.trees.conifer, style.trees.size), [data, style.trees]);
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
