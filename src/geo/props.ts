import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AreaData } from "@/data/load";

/** Low-poly "toy" trees: crown + trunk merged into one geometry per type (one draw call each). */
export function treeGeometries(trunkColor: string) {
  const tc = new THREE.Color(trunkColor);
  const paint = (g: THREE.BufferGeometry, c: THREE.Color | null) => {
    const n = g.getAttribute("position").count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c ? c.r : 1; col[i * 3 + 1] = c ? Math.min(c.g, 0.95) : 1; col[i * 3 + 2] = c ? c.b : 1; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.deleteAttribute("uv");
    return g;
  };
  const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const crown = new THREE.DodecahedronGeometry(2.8, 0);
  crown.scale(1, 0.92, 1);
  crown.translate(0, 5.0, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 2.9, 5, 1, true);
  trunk.translate(0, 1.45, 0);
  const c1 = new THREE.ConeGeometry(2.3, 4.2, 7, 1, true);
  c1.translate(0, 3.6, 0);
  const c2 = new THREE.ConeGeometry(1.7, 3.6, 7);
  c2.translate(0, 5.9, 0);
  const ctrunk = new THREE.CylinderGeometry(0.2, 0.28, 1.8, 5, 1, true);
  ctrunk.translate(0, 0.9, 0);
  const leaf = mergeGeometries([paint(ni(crown), null), paint(ni(trunk), tc)])!;
  const conifer = mergeGeometries([paint(ni(c1), null), paint(ni(c2), null), paint(ni(ctrunk), tc)])!;
  // tall oval crown (poplar-like silhouette), same triangle count as the round crown
  const oCrown = new THREE.DodecahedronGeometry(2.2, 0);
  oCrown.scale(0.72, 1.75, 0.72);
  oCrown.translate(0, 5.6, 0);
  const oTrunk = new THREE.CylinderGeometry(0.18, 0.26, 2.4, 5, 1, true);
  oTrunk.translate(0, 1.2, 0);
  const oval = mergeGeometries([paint(ni(oCrown), null), paint(ni(oTrunk), tc)])!;
  // broad two-lobed crown (fruit / garden tree): two low-poly icosahedra, lower and wider
  const l1 = new THREE.IcosahedronGeometry(2.2, 0); l1.scale(1.1, 0.8, 1.0); l1.translate(-0.9, 3.9, 0.2);
  const l2 = new THREE.IcosahedronGeometry(1.9, 0); l2.scale(1.0, 0.85, 1.1); l2.translate(1.0, 4.4, -0.3);
  const bTrunk = new THREE.CylinderGeometry(0.2, 0.3, 2.6, 5, 1, true);
  bTrunk.translate(0, 1.3, 0);
  const broad = mergeGeometries([paint(ni(l1), null), paint(ni(l2), null), paint(ni(bTrunk), tc)])!;
  for (const g of [leaf, conifer, oval, broad]) g.computeVertexNormals();
  return { leaf, conifer, oval, broad };
}

/** Tree instances grouped into square tiles so they can be frustum-culled and thinned by distance. */
export type TreeSet = {
  matrices: Float32Array; colors: Float32Array; count: number;
  tiles: { start: number; end: number; box: THREE.Box3; cx: number; cz: number }[];
};

export function treeSets(d: AreaData, leaf: string[], conifer: string[], size: number, tile = 256): { leaf: TreeSet; oval: TreeSet; broad: TreeSet; conifer: TreeSet } {
  const t = d.trees;
  const lc = leaf.map((c) => new THREE.Color(c));
  const cc = conifer.map((c) => new THREE.Color(c));
  const { halfW, halfH } = d.meta.extent;
  const nx = Math.ceil((2 * halfW) / tile), ny = Math.ceil((2 * halfH) / tile);
  type Item = { k: number; tile: number; x: number; y: number; z: number; sc: number; kind: number };
  const items: Item[] = [];
  for (let i = 0; i < t.length; i += 4) {
    const x = t[i], y = t[i + 1];
    const tx = Math.min(nx - 1, Math.max(0, Math.floor((x + halfW) / tile)));
    const ty = Math.min(ny - 1, Math.max(0, Math.floor((y + halfH) / tile)));
    items.push({ k: i / 4, tile: ty * nx + tx, x, y, z: d.core.at(x, y) - d.datum - 0.25, sc: t[i + 2] * size, kind: t[i + 3] });
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const build = (list: Item[], pal: THREE.Color[]): TreeSet => {
    list.sort((a, b) => a.tile - b.tile || a.k - b.k);
    const matrices = new Float32Array(list.length * 16), colors = new Float32Array(list.length * 3);
    const tiles: TreeSet["tiles"] = [];
    const col = new THREE.Color();
    list.forEach((it, i) => {
      const hash = ((it.k * 2654435761) >>> 0) / 4294967296;
      p.set(it.x, it.z, -it.y);
      q.setFromAxisAngle(up, hash * Math.PI * 2);
      s.set(it.sc, it.sc * (0.9 + ((it.k * 7919) % 100) / 500), it.sc);
      m.compose(p, q, s).toArray(matrices, i * 16);
      col.copy(pal[(it.k * 31) % pal.length]).offsetHSL(0, 0, (hash - 0.5) * 0.06);
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
      const last = tiles[tiles.length - 1];
      if (!last || (list[i - 1] && list[i - 1].tile !== it.tile)) {
        tiles.push({ start: i, end: i + 1, box: new THREE.Box3(new THREE.Vector3(it.x - 4, it.z, -it.y - 4), new THREE.Vector3(it.x + 4, it.z + 10, -it.y + 4)), cx: 0, cz: 0 });
      } else {
        last.end = i + 1;
        last.box.expandByPoint(new THREE.Vector3(it.x - 4, it.z, -it.y - 4)).expandByPoint(new THREE.Vector3(it.x + 4, it.z + 10, -it.y + 4));
      }
    });
    for (const tl of tiles) { const c = tl.box.getCenter(new THREE.Vector3()); tl.cx = c.x; tl.cz = c.z; }
    return { matrices, colors, count: list.length, tiles };
  };
  // deciduous trees get one of three crown shapes (deterministic per tree): 55% round, 20% tall oval, 25% broad
  const shape = (k: number) => { const h = (((k + 7) * 2246822519) >>> 0) / 4294967296; return h < 0.55 ? 0 : h < 0.75 ? 1 : 2; };
  const dec = items.filter((i) => i.kind < 1);
  return {
    leaf: build(dec.filter((i) => shape(i.k) === 0), lc),
    oval: build(dec.filter((i) => shape(i.k) === 1), lc),
    broad: build(dec.filter((i) => shape(i.k) === 2), lc),
    conifer: build(items.filter((i) => i.kind >= 1), cc),
  };
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

/**
 * Streetlight: thin pole, short arm and lamp head (aLamp = 1 on the head, which glows at night).
 * Local frame: pole at the origin, arm along +x (towards the road).
 */
export function streetlightGeometry() {
  const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 6.2, 5, 1, true); pole.translate(0, 3.1, 0);
  const arm = new THREE.BoxGeometry(1.3, 0.08, 0.08); arm.translate(0.6, 6.05, 0);
  const head = new THREE.BoxGeometry(0.55, 0.14, 0.26); head.translate(1.2, 5.95, 0);
  const parts = [ni(pole), ni(arm), ni(head)].map((g, i) => {
    g.deleteAttribute("uv");
    const n = g.getAttribute("position").count;
    g.setAttribute("aLamp", new THREE.BufferAttribute(new Float32Array(n).fill(i === 2 ? 1 : 0), 1));
    return g;
  });
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

/**
 * Toy car, ~4.2 × 1.8 m, facing +x. aPaint = 1 where the instance colour applies (body),
 * aLight = 1 headlights, 2 taillights (both glow at night).
 */
export function carGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, col: string, paint: number, light: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute("uv");
    const n = ng.getAttribute("position").count, c = new THREE.Color(col);
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
    ng.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    ng.setAttribute("aPaint", new THREE.BufferAttribute(new Float32Array(n).fill(paint), 1));
    ng.setAttribute("aLight", new THREE.BufferAttribute(new Float32Array(n).fill(light), 1));
    parts.push(ng);
  };
  const body = new THREE.BoxGeometry(4.1, 0.72, 1.76); body.translate(0, 0.62, 0);
  const cabin = new THREE.BoxGeometry(2.1, 0.58, 1.56); cabin.translate(-0.25, 1.27, 0);
  const wheels = new THREE.BoxGeometry(3.0, 0.5, 1.84); wheels.translate(0, 0.27, 0);
  const head = new THREE.BoxGeometry(0.05, 0.16, 1.4); head.translate(2.06, 0.74, 0);
  const tail = new THREE.BoxGeometry(0.05, 0.16, 1.4); tail.translate(-2.06, 0.74, 0);
  add(body, "#ffffff", 1, 0);
  add(cabin, "#2e3540", 0, 0);
  add(wheels, "#1d1f22", 0, 0);
  add(head, "#f4f1e6", 0, 1);
  add(tail, "#9b1c1c", 0, 2);
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}
