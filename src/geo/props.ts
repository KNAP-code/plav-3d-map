import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AreaData } from "@/data/load";

/** Low-poly "toy" tree parts, unit scale (≈ 8–9 m tall). */
export function treeParts() {
  const crown = new THREE.DodecahedronGeometry(2.8, 0);
  crown.scale(1, 0.92, 1);
  crown.translate(0, 5.0, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 2.9, 5, 1, true);
  trunk.translate(0, 1.45, 0);
  const c1 = new THREE.ConeGeometry(2.3, 4.2, 7, 1, true);
  c1.translate(0, 3.6, 0);
  const c2 = new THREE.ConeGeometry(1.7, 3.6, 7);
  c2.translate(0, 5.9, 0);
  const conifer = mergeGeometries([c1.index ? c1.toNonIndexed() : c1, c2.index ? c2.toNonIndexed() : c2])!;
  const ctrunk = new THREE.CylinderGeometry(0.2, 0.28, 1.8, 5, 1, true);
  ctrunk.translate(0, 0.9, 0);
  const crownN = crown.index ? crown.toNonIndexed() : crown;
  crownN.computeVertexNormals();
  conifer.computeVertexNormals();
  return { crown: crownN, trunk, conifer, ctrunk };
}

export type TreeInstances = { leaf: THREE.Matrix4[]; leafCol: THREE.Color[]; con: THREE.Matrix4[]; conCol: THREE.Color[] };

export function treeInstances(d: AreaData, leaf: string[], conifer: string[], size: number, density = 1): TreeInstances {
  const out: TreeInstances = { leaf: [], leafCol: [], con: [], conCol: [] };
  const t = d.trees;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const lc = leaf.map((c) => new THREE.Color(c));
  const cc = conifer.map((c) => new THREE.Color(c));
  for (let i = 0; i < t.length; i += 4) {
    const k = i / 4;
    const hash = ((k * 2654435761) >>> 0) / 4294967296;
    if (hash > density) continue;
    const x = t[i], y = t[i + 1], sc = t[i + 2] * size, kind = t[i + 3];
    p.set(x, d.core.at(x, y) - d.datum - 0.25, -y);
    q.setFromAxisAngle(up, hash * Math.PI * 2);
    s.set(sc, sc * (0.9 + ((k * 7919) % 100) / 500), sc);
    m.compose(p, q, s);
    const col = (kind >= 1 ? cc : lc)[(k * 31) % (kind >= 1 ? cc.length : lc.length)].clone();
    col.offsetHSL(0, 0, (hash - 0.5) * 0.06);
    if (kind >= 1) { out.con.push(m.clone()); out.conCol.push(col); }
    else { out.leaf.push(m.clone()); out.leafCol.push(col); }
  }
  return out;
}

/** Stylised minaret (pencil type common in the region): shaft, balcony, cone cap. */
export function minaretGeometry(height: number) {
  const shaftH = height * 0.78;
  const shaft = new THREE.CylinderGeometry(0.85, 1.0, shaftH, 10);
  shaft.translate(0, shaftH / 2, 0);
  const balcony = new THREE.CylinderGeometry(1.35, 1.0, 0.7, 12);
  balcony.translate(0, shaftH * 0.82, 0);
  const top = new THREE.CylinderGeometry(0.75, 0.85, height * 0.08, 10);
  top.translate(0, shaftH + height * 0.04, 0);
  const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const body = mergeGeometries([ni(shaft), ni(balcony), ni(top)])!;
  const cap = new THREE.ConeGeometry(0.95, height * 0.16, 10);
  cap.translate(0, shaftH + height * 0.08 + height * 0.08, 0);
  return { body, cap };
}
