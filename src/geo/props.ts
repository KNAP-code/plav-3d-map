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
  leaf.computeVertexNormals();
  conifer.computeVertexNormals();
  return { leaf, conifer };
}

/** Tree instances grouped into square tiles so they can be frustum-culled and thinned by distance. */
export type TreeSet = {
  matrices: Float32Array; colors: Float32Array; count: number;
  tiles: { start: number; end: number; box: THREE.Box3; cx: number; cz: number }[];
};

export function treeSets(d: AreaData, leaf: string[], conifer: string[], size: number, tile = 256): { leaf: TreeSet; conifer: TreeSet } {
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
  return { leaf: build(items.filter((i) => i.kind < 1), lc), conifer: build(items.filter((i) => i.kind >= 1), cc) };
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
