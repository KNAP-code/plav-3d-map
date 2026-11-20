import * as THREE from "three";
import type { StyleConfig } from "@/style/presets";

/**
 * Noise: one tileable 256² fbm texture generated once on the CPU. Shaders sample it instead of
 * evaluating 4-octave value noise per pixel (measured as a large share of terrain fill cost).
 */
const NOISE = /* glsl */ `
uniform sampler2D uNoise;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float fbm(vec2 p){ return texture2D(uNoise, p * 0.125).r; }
`;

let noiseTex: THREE.DataTexture | null = null;
export function noiseTexture() {
  if (noiseTex) return noiseTex;
  const N = 256, data = new Uint8Array(N * N * 4);
  const lattice = (period: number, seed: number) => {
    const g = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; g[i] = s / 4294967296; }
    return g;
  };
  const octaves = [8, 16, 32, 64].map((p, i) => ({ p, g: lattice(p, 1234 + i * 97), a: 0.5 / 2 ** i }));
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let v = 0;
      for (const { p, g, a } of octaves) {
        const fx = (x / N) * p, fy = (y / N) * p;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy);
        const i0 = ix % p, i1 = (ix + 1) % p, j0 = iy % p, j1 = (iy + 1) % p;
        const a0 = g[j0 * p + i0] * (1 - tx) + g[j0 * p + i1] * tx;
        const a1 = g[j1 * p + i0] * (1 - tx) + g[j1 * p + i1] * tx;
        v += a * (a0 * (1 - ty) + a1 * ty);
      }
      const k = (y * N + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = Math.round(Math.min(1, v) * 255);
      data[k + 3] = 255;
    }
  noiseTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

type Patch = {
  uniforms?: Record<string, THREE.IUniform>;
  vertexHead?: string;
  vertexMain?: string;
  fragHead?: string;
  fragColor?: string;
};

function patch<M extends THREE.Material>(m: M, p: Patch, key: string): M {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uNoise: { value: noiseTexture() } }, p.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${p.vertexHead ?? ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${p.vertexMain ?? ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${NOISE}\n${p.fragHead ?? ""}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${p.fragColor ?? ""}`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

const c3 = (s: string) => new THREE.Color(s);

export function wallMaterial(style: StyleConfig) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  return patch(m, {
    uniforms: { uGlass: { value: c3(style.window.glass) }, uFrame: { value: c3(style.window.frame) } },
    vertexHead: "attribute vec2 aUv; attribute float aFloors; varying vec2 vW; varying float vFl;",
    vertexMain: "vW = aUv; vFl = aFloors;",
    fragHead: "uniform vec3 uGlass; uniform vec3 uFrame; varying vec2 vW; varying float vFl;",
    fragColor: /* glsl */ `
      {
        float fl = floor(vW.y);
        vec2 c = fract(vW);
        vec2 fw = max(fwidth(vW), vec2(1e-4));
        bool ground = fl > vFl - 1.5;
        float wx = ground ? 0.31 : 0.33; float wy0 = ground ? 0.16 : 0.30; float wy1 = 0.76;
        float inX = smoothstep(wx - fw.x, wx + fw.x, c.x) * (1.0 - smoothstep(1.0 - wx - fw.x, 1.0 - wx + fw.x, c.x));
        float inY = smoothstep(wy0 - fw.y, wy0 + fw.y, c.y) * (1.0 - smoothstep(wy1 - fw.y, wy1 + fw.y, c.y));
        float frX = 0.0; float frY = 0.0;
        // fade the pattern out when a bay becomes smaller than ~3 px (avoids shimmering)
        inX *= 1.0 - smoothstep(0.12, 0.3, fw.x);
        // windows only on real floors (below the eave, above the plinth); edges < 2.2 m have u == 0
        float valid = step(0.0, vW.y) * step(fl, vFl - 1.0);
        float frame = frX * frY * (1.0 - inX * inY) * valid;
        float glass = inX * inY * valid;
        diffuseColor.rgb = mix(diffuseColor.rgb, uFrame, frame * 0.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, uGlass, glass * 0.92);
        // plinth below the ground floor is slightly darker
        diffuseColor.rgb *= mix(1.0, 0.82, step(vFl, vW.y));
      }
    `,
  }, "walls-v1");
}

export function roofMaterial(style: StyleConfig) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  return patch(m, {
    uniforms: { uSpacing: { value: style.roof.tileSpacing }, uContrast: { value: style.roof.tileContrast } },
    vertexHead: "attribute vec2 aUv; varying vec2 vR;",
    vertexMain: "vR = aUv;",
    fragHead: "uniform float uSpacing; uniform float uContrast; varying vec2 vR;",
    fragColor: /* glsl */ `
      {
        float row = fract(vR.y / uSpacing);
        float line = smoothstep(0.0, 0.18, row) * (1.0 - smoothstep(0.82, 1.0, row) * 0.4);
        float col = fract(vR.x / (uSpacing * 0.85) + floor(vR.y / uSpacing) * 0.5);
        float joint = smoothstep(0.0, 0.08, col);
        float n = h21(floor(vec2(vR.x / (uSpacing*0.85), vR.y / uSpacing)));
        diffuseColor.rgb *= mix(1.0 - uContrast, 1.0, line * mix(0.9, 1.0, joint)) * mix(0.95, 1.05, n);
      }
    `,
  }, "roofs-v1");
}

export function terrainMaterial(style: StyleConfig, cover: THREE.Texture, context: boolean) {
  const g = style.ground;
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide });
  return patch(m, {
    uniforms: {
      uCover: { value: cover },
      uGrass: { value: c3(context ? g.context : g.grass) },
      uGrassDark: { value: c3(g.grassDark) },
      uForest: { value: c3(context ? g.contextForest : g.forestFloor) },
      uDirt: { value: c3(g.dirt) },
      uBuilt: { value: c3(context ? g.contextRock : g.built) },
      uMottle: { value: g.mottle },
      uScale: { value: g.mottleScale },
    },
    vertexHead: "varying vec2 vCov; varying vec3 vWp; varying vec3 vNw;",
    vertexMain: "vCov = uv; vWp = (modelMatrix * vec4(transformed,1.0)).xyz; vNw = normal;",
    fragHead: `uniform sampler2D uCover; uniform vec3 uGrass, uGrassDark, uForest, uDirt, uBuilt; uniform float uMottle, uScale;
               varying vec2 vCov; varying vec3 vWp; varying vec3 vNw;`,
    fragColor: /* glsl */ `
      {
        vec3 w = texture2D(uCover, vCov).rgb;
        vec2 p = vWp.xz * uScale;
        float n1 = fbm(p);
        float n2 = fbm(p * 3.1 + 7.0);
        vec3 col = mix(uGrass, uGrassDark, smoothstep(0.35, 0.75, n2) * 0.6);
        // built-up / bare land: mottled dirt patches between the grass, like a model base
        float patchy = smoothstep(0.66 - w.b * 0.22, 0.70 - w.b * 0.2, n1 + n2 * 0.3) * uMottle;
        col = mix(col, mix(uDirt, uBuilt, 0.35), patchy * clamp(w.b * 1.2 + 0.15, 0.0, 1.0));
        col = mix(col, uForest, smoothstep(0.25, 0.75, w.r));
        // steep slopes show rock
        float steep = 1.0 - normalize(vNw).y;
        col = mix(col, uBuilt * 0.95, smoothstep(0.35, 0.6, steep) * 0.7);
        diffuseColor.rgb = col;
      }
    `,
  }, context ? "terrain-ctx-v1" : "terrain-core-v1");
}

export function roadMaterial(style: StyleConfig) {
  const r = style.roads;
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  return patch(m, {
    uniforms: {
      uAsphalt: { value: c3(r.asphalt) }, uEdge: { value: c3(r.edge) }, uMark: { value: c3(r.marking) },
      uPath: { value: c3(r.path) }, uTrack: { value: c3(r.track) },
    },
    vertexHead: "attribute vec2 aUv; attribute float aKind; varying vec2 vRd; varying float vK; varying vec3 vWp2;",
    vertexMain: "vRd = aUv; vK = aKind; vWp2 = (modelMatrix * vec4(transformed,1.0)).xyz;",
    fragHead: "uniform vec3 uAsphalt, uEdge, uMark, uPath, uTrack; varying vec2 vRd; varying float vK; varying vec3 vWp2;",
    fragColor: /* glsl */ `
      {
        vec3 col;
        float n = fbm(vWp2.xz * 0.6);
        if (vK < 1.5) {
          col = uAsphalt * mix(0.93, 1.05, n);
          float edge = 1.0 - smoothstep(0.04, 0.09, min(vRd.y, 1.0 - vRd.y));
          col = mix(col, uEdge, edge * 0.8);
          if (vK < 0.5) {
            float dash = step(0.5, fract(vRd.x / 6.0));
            float centre = 1.0 - smoothstep(0.012, 0.03, abs(vRd.y - 0.5));
            col = mix(col, uMark, centre * dash);
          }
        } else if (vK < 2.5) {
          col = uPath * mix(0.92, 1.05, n);
        } else {
          col = uTrack * mix(0.88, 1.06, n);
        }
        diffuseColor.rgb = col;
      }
    `,
  }, "roads-v1");
}

export function waterMaterial(style: StyleConfig) {
  const m = new THREE.MeshStandardMaterial({
    color: style.water.color, roughness: style.water.roughness, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  return patch(m, {
    uniforms: { uDeep: { value: c3(style.water.deep) }, uTime: { value: 0 } },
    vertexHead: "varying vec3 vWw;",
    vertexMain: "vWw = (modelMatrix * vec4(transformed,1.0)).xyz;",
    fragHead: "uniform vec3 uDeep; uniform float uTime; varying vec3 vWw;",
    fragColor: /* glsl */ `
      {
        float n = fbm(vWw.xz * 0.04 + vec2(uTime * 0.01, 0.0));
        float r = fbm(vWw.xz * 0.35 + vec2(0.0, uTime * 0.05));
        diffuseColor.rgb = mix(diffuseColor.rgb, uDeep, smoothstep(0.35, 0.8, n) * 0.55);
        diffuseColor.rgb += vec3(0.05) * smoothstep(0.72, 0.9, r);
      }
    `,
  }, "water-v1");
}

/**
 * Walls and roofs in one material (aPart: 0 wall, 1 roof) so a building tile is one draw call.
 * detail=false is the distance LOD: same colours, no window/tile pattern (cheaper fragment shader).
 */
export function buildingMaterial(style: StyleConfig, detail: boolean) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, side: THREE.DoubleSide });
  return patch(m, {
    uniforms: {
      uGlass: { value: c3(style.window.glass) },
      uSpacing: { value: style.roof.tileSpacing }, uContrast: { value: style.roof.tileContrast },
    },
    vertexHead: "attribute vec2 aUv; attribute float aFloors; attribute float aPart; varying vec2 vW; varying float vFl; varying float vPart;",
    vertexMain: "vW = aUv; vFl = aFloors; vPart = aPart;",
    fragHead: "uniform vec3 uGlass; uniform float uSpacing; uniform float uContrast; varying vec2 vW; varying float vFl; varying float vPart;",
    fragColor: detail ? /* glsl */ `
      if (vPart < 0.5) {
        float fl = floor(vW.y);
        vec2 c = fract(vW);
        vec2 fw = max(fwidth(vW), vec2(1e-4));
        bool ground = fl > vFl - 1.5;
        float wx = ground ? 0.31 : 0.33; float wy0 = ground ? 0.16 : 0.30; float wy1 = 0.76;
        float inX = smoothstep(wx - fw.x, wx + fw.x, c.x) * (1.0 - smoothstep(1.0 - wx - fw.x, 1.0 - wx + fw.x, c.x));
        float inY = smoothstep(wy0 - fw.y, wy0 + fw.y, c.y) * (1.0 - smoothstep(wy1 - fw.y, wy1 + fw.y, c.y));
        inX *= 1.0 - smoothstep(0.12, 0.3, fw.x);
        float valid = step(0.0, vW.y) * step(fl, vFl - 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, uGlass, inX * inY * valid * 0.92);
        diffuseColor.rgb *= mix(1.0, 0.82, step(vFl, vW.y));
      } else {
        float row = fract(vW.y / uSpacing);
        float line = smoothstep(0.0, 0.18, row) * (1.0 - smoothstep(0.82, 1.0, row) * 0.4);
        float n = h21(floor(vec2(vW.x / (uSpacing*0.85), vW.y / uSpacing)));
        diffuseColor.rgb *= mix(1.0 - uContrast, 1.0, line) * mix(0.95, 1.05, n);
      }
    ` : /* glsl */ `
      // far LOD: average tone of the window grid / tile rows instead of the pattern
      diffuseColor.rgb *= vPart < 0.5 ? mix(0.82, 0.9, step(vW.y, vFl) * step(0.0, vW.y)) : (1.0 - uContrast * 0.35);
    `,
  }, detail ? "building-near-v2" : "building-far-v2");
}

/** Tree material: instance colour tints the crown only (vertex colour g == 1), trunks keep their colour. */
export function treeMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <color_vertex>", /* glsl */ `
      #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
        vColor.xyz = vec3( 1.0 );
      #endif
      #ifdef USE_COLOR
        vColor.xyz *= color.rgb;
      #endif
      #ifdef USE_INSTANCING_COLOR
        if (color.g > 0.99) vColor.xyz *= instanceColor.xyz;
      #endif
    `);
  };
  m.customProgramCacheKey = () => "tree-v2";
  return m;
}
