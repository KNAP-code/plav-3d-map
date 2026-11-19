"use client";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { AreaData } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { buildBuildings } from "@/geo/buildings";
import { overlaysGeometry, roadsGeometry, streamsGeometry, terrainGeometry, waterGeometry } from "@/geo/landscape";
import { minaretGeometry, treeInstances, treeParts } from "@/geo/props";
import { roadMaterial, roofMaterial, terrainMaterial, wallMaterial, waterMaterial } from "./materials";

export type Quality = "high" | "medium" | "low";

function useDispose<T extends { dispose: () => void }>(items: T[]) {
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

export function Terrain({ data, style }: { data: AreaData; style: StyleConfig }) {
  const core = useMemo(() => terrainGeometry(data.core, data.datum, 25), [data]);
  const ctx = useMemo(() => terrainGeometry(data.context, data.datum, 0), [data]);
  const covCore = useMemo(() => coverTexture(data.coverCore), [data]);
  const covCtx = useMemo(() => coverTexture(data.coverContext), [data]);
  const mCore = useMemo(() => terrainMaterial(style, covCore, false), [style, covCore]);
  const mCtx = useMemo(() => terrainMaterial(style, covCtx, true), [style, covCtx]);
  useDispose([core, ctx, covCore, covCtx, mCore, mCtx]);
  return (
    <group>
      <mesh geometry={core} material={mCore} receiveShadow />
      <mesh geometry={ctx} material={mCtx} receiveShadow />
    </group>
  );
}

export function Buildings({ data, style }: { data: AreaData; style: StyleConfig }) {
  const geo = useMemo(() => buildBuildings(data.buildings, data.datum, style), [data, style.roof.pitchDeg, style.roof.overhang, style.walls, style.roofs, style.window.bayWidth, style.window.floorHeight]); // eslint-disable-line react-hooks/exhaustive-deps
  const wm = useMemo(() => wallMaterial(style), [style]);
  const rm = useMemo(() => roofMaterial(style), [style]);
  useDispose([geo.walls, geo.roofs, wm, rm]);
  return (
    <group>
      <mesh geometry={geo.walls} material={wm} castShadow receiveShadow />
      <mesh geometry={geo.roofs} material={rm} castShadow receiveShadow />
    </group>
  );
}

export function Roads({ data, style }: { data: AreaData; style: StyleConfig }) {
  const g = useMemo(() => roadsGeometry(data, style), [data, style.roads.widths]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMemo(() => roadMaterial(style), [style]);
  const og = useMemo(() => overlaysGeometry(data, style), [data, style]);
  const om = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), []);
  useDispose([g, m, og, om]);
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
  useDispose([g, s, m]);
  return (
    <group>
      <mesh geometry={g} material={m} receiveShadow />
      <mesh geometry={s} material={m} receiveShadow />
    </group>
  );
}

export function Trees({ data, style, quality }: { data: AreaData; style: StyleConfig; quality: Quality }) {
  const parts = useMemo(() => treeParts(), []);
  const density = quality === "low" ? 0.45 : quality === "medium" ? 0.8 : 1;
  const inst = useMemo(() => treeInstances(data, style.trees.leaf, style.trees.conifer, style.trees.size, density), [data, style.trees, density]);
  const crownM = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), []);
  const trunkM = useMemo(() => new THREE.MeshStandardMaterial({ color: style.trees.trunk, roughness: 1 }), [style.trees.trunk]);
  const meshes = useMemo(() => {
    const mk = (geo: THREE.BufferGeometry, mats: THREE.Matrix4[], cols: THREE.Color[] | null, mat: THREE.Material) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(mats.length, 1));
      im.count = mats.length;
      mats.forEach((m, i) => im.setMatrixAt(i, m));
      if (cols) cols.forEach((c, i) => im.setColorAt(i, c));
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.needsUpdate = true;
      return im;
    };
    return [
      mk(parts.crown, inst.leaf, inst.leafCol, crownM),
      mk(parts.trunk, inst.leaf, null, trunkM),
      mk(parts.conifer, inst.con, inst.conCol, crownM),
      mk(parts.ctrunk, inst.con, null, trunkM),
    ];
  }, [parts, inst, crownM, trunkM]);
  useEffect(() => () => meshes.forEach((m) => m.dispose()), [meshes]);
  return (
    <group>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  );
}

export function Minarets({ data, style }: { data: AreaData; style: StyleConfig }) {
  const geos = useMemo(() => data.minarets.map((m) => ({ m, g: minaretGeometry(m.height) })), [data]);
  const body = useMemo(() => new THREE.MeshStandardMaterial({ color: style.minaret.color, roughness: 0.8 }), [style.minaret.color]);
  const cap = useMemo(() => new THREE.MeshStandardMaterial({ color: style.minaret.cap, roughness: 0.5, metalness: 0.2 }), [style.minaret.cap]);
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
