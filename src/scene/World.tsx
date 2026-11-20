"use client";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { AreaData, Building } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { buildBuildingTile } from "@/geo/buildings";
import { overlaysGeometry, roadsGeometry, splitTiles, streamsGeometry, terrainGeometry, waterGeometry } from "@/geo/landscape";
import { minaretGeometry, treeGeometries, treeSets, type TreeSet } from "@/geo/props";
import { buildingMaterial, roadMaterial, terrainMaterial, treeMaterial, waterMaterial } from "./materials";
import { bump } from "@/ui/perf";

export type Quality = "high" | "medium" | "low";

/** Per-tier level-of-detail settings (the one place to tune the presets). */
export const TIERS: Record<Quality, {
  terrainStride: number; contextStride: number; buildingNear: number; treeDensity: number; treeFar: number;
}> = {
  // buildingNear: tiles closer than this (m, camera to tile sphere) use the window/tile-pattern shader
  // treeFar: beyond this distance only every 2nd tree in a tile is drawn (tiny on screen there)
  high: { terrainStride: 1, contextStride: 1, buildingNear: 1400, treeDensity: 1, treeFar: 1600 },
  medium: { terrainStride: 1, contextStride: 2, buildingNear: 900, treeDensity: 1, treeFar: 1100 },
  low: { terrainStride: 2, contextStride: 2, buildingNear: 600, treeDensity: 2, treeFar: 800 },
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
  const tiles = useMemo(() => splitTiles(core, 4), [core]);
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
export function Buildings({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const near = TIERS[quality].buildingNear;
  const geos = useMemo(() => {
    const { halfW, halfH } = data.meta.extent, n = 4;
    const buckets: Building[][] = Array.from({ length: n * n }, () => []);
    for (const b of data.buildings) {
      let cx = 0, cy = 0;
      for (const [x, y] of b.fp) { cx += x; cy += y; }
      cx /= b.fp.length; cy /= b.fp.length;
      const i = Math.min(n - 1, Math.max(0, Math.floor(((cx + halfW) / (2 * halfW)) * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor(((cy + halfH) / (2 * halfH)) * n)));
      buckets[j * n + i].push(b);
    }
    bump("geometryBuilds");
    return buckets.filter((b) => b.length).map((b) => buildBuildingTile(b, data.datum, style));
  }, [data, style.roof.pitchDeg, style.roof.overhang, style.walls, style.roofs, style.window.bayWidth, style.window.floorHeight]); // eslint-disable-line react-hooks/exhaustive-deps
  const mNear = useMemo(() => buildingMaterial(style, true), [style]);
  const mFar = useMemo(() => buildingMaterial(style, false), [style]);
  useDispose(geos);
  useDispose(useMemo(() => [mNear, mFar], [mNear, mFar]));
  const group = useRef<THREE.Group>(null);
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
  });
  return (
    <group ref={group}>
      {geos.map((g, i) => <mesh key={i} geometry={g} material={mNear} castShadow receiveShadow />)}
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
    return [mk(geo.leaf, sets.leaf), mk(geo.conifer, sets.conifer)];
  }, [geo, sets, mat]);
  useEffect(() => () => { meshes.forEach((m) => m.im.dispose()); geo.leaf.dispose(); geo.conifer.dispose(); }, [meshes, geo]);
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

export function Minarets({ data, style }: { data: AreaData; style: StyleConfig }) {
  const geos = useMemo(() => data.minarets.map((m) => ({ m, g: minaretGeometry(m.height) })), [data]);
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
