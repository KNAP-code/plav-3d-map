import * as THREE from "three";
import type { StyleConfig } from "@/style/presets";
import { LAMP_SPACING } from "@/geo/roads";

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

/** Scene-wide uniforms shared by every patched material (day/night blend; 0 = day, 1 = night). */
export const SCENE = { uNight: { value: 0 } };

type Patch = {
  uniforms?: Record<string, THREE.IUniform>;
  vertexHead?: string;
  vertexMain?: string;
  fragHead?: string;
  fragColor?: string;
  /** runs after the emissive chunk: add to totalEmissiveRadiance (night lights) */
  fragEmissive?: string;
};

function patch<M extends THREE.Material>(m: M, p: Patch, key: string): M {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uNoise: { value: noiseTexture() }, uNight: SCENE.uNight }, p.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${p.vertexHead ?? ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${p.vertexMain ?? ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${NOISE}\nuniform float uNight;\n${p.fragHead ?? ""}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${p.fragColor ?? ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${p.fragEmissive ?? ""}`);
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
      uPath: { value: c3(r.path) }, uTrack: { value: c3(r.track) }, uLamp: { value: LAMP_SPACING },
    },
    vertexHead: "attribute vec2 aUv; attribute float aKind; attribute float aEnd; varying vec2 vRd; varying float vK; varying float vEnd; varying vec3 vWp2;",
    vertexMain: "vRd = aUv; vK = aKind; vEnd = aEnd; vWp2 = (modelMatrix * vec4(transformed,1.0)).xyz;",
    fragHead: "uniform vec3 uAsphalt, uEdge, uMark, uPath, uTrack; uniform float uLamp; varying vec2 vRd; varying float vK; varying float vEnd; varying vec3 vWp2; float gPool;",
    fragColor: /* glsl */ `
      {
        vec3 col;
        float n = fbm(vWp2.xz * 0.6);
        float k = floor(vK + 0.01);
        float nearJ = smoothstep(2.0, 6.0, vEnd);           // fade markings into junctions
        if (k < 1.5) {
          col = uAsphalt * mix(0.93, 1.05, n);
          // subtle wear: lighter wheel tracks, darker centre
          float across = abs(vRd.y - 0.5);
          col *= 1.0 + 0.035 * (smoothstep(0.12, 0.2, across) - smoothstep(0.28, 0.36, across));
          float edge = 1.0 - smoothstep(0.04, 0.09, min(vRd.y, 1.0 - vRd.y));
          col = mix(col, uEdge, edge * 0.8 * nearJ);
          if (k < 0.5) {
            float dash = step(0.5, fract(vRd.x / 6.0));
            float centre = 1.0 - smoothstep(0.012, 0.03, abs(vRd.y - 0.5));
            col = mix(col, uMark, centre * dash * nearJ);
            // solid edge lines on marked roads
            float side = 1.0 - smoothstep(0.012, 0.026, abs(min(vRd.y, 1.0 - vRd.y) - 0.1));
            col = mix(col, uMark * 0.92, side * 0.85 * nearJ);
          }
        } else if (k < 2.5) {
          col = uPath * mix(0.92, 1.05, n);
        } else {
          col = uTrack * mix(0.88, 1.06, n);
        }
        diffuseColor.rgb = col;
        // night: warm pools under the (decorative) streetlights, which stand at uLamp/2 + k*uLamp
        float lit = step(0.1, fract(vK + 0.001));
        float d = (fract(vRd.x / uLamp - 0.5) - 0.5) * uLamp;
        gPool = lit * exp(-d * d / 60.0) * (0.75 + 0.25 * (1.0 - abs(vRd.y - 0.5) * 2.0));
      }
    `,
    fragEmissive: /* glsl */ `
      if (uNight > 0.001) totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * (gPool * 0.32 + 0.012) * uNight;
    `,
  }, "roads-v2");
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
 * aStyle: floor() % 4 = window layout (grid, tall, paired, band), +4 = shop ground floor, fract = building seed.
 * At night (uNight) a deterministic share of windows glows warm (some cool), as emissive light.
 */
export function buildingMaterial(style: StyleConfig, detail: boolean) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, side: THREE.DoubleSide });
  return patch(m, {
    uniforms: {
      uGlass: { value: c3(style.window.glass) },
      uSpacing: { value: style.roof.tileSpacing }, uContrast: { value: style.roof.tileContrast },
    },
    vertexHead: "attribute vec2 aUv; attribute float aFloors; attribute float aPart; attribute float aStyle; varying vec2 vW; varying float vFl; varying float vPart; varying float vSt;",
    vertexMain: "vW = aUv; vFl = aFloors; vPart = aPart; vSt = aStyle;",
    fragHead: "uniform vec3 uGlass; uniform float uSpacing; uniform float uContrast; varying vec2 vW; varying float vFl; varying float vPart; varying float vSt; float gWin;",
    fragColor: detail ? /* glsl */ `
      gWin = 0.0;
      float nFl = floor(vFl + 0.5);
      float nSeed = floor(fract(vSt) * 512.0 + 0.5); // quantised: interpolation noise must not reseed the hash per pixel
      if (vPart < 0.5) {
        float fl = floor(vW.y);
        vec2 c = fract(vW);
        vec2 fw = max(fwidth(vW), vec2(1e-4));
        float kind = mod(floor(vSt + 0.001), 4.0);
        bool shop = floor(vSt + 0.001) >= 4.0;
        bool ground = fl > nFl - 1.5;
        // window rectangle per layout: x half-margin, y range (y runs downward from the eave)
        float wx = 0.33, wy0 = 0.30, wy1 = 0.76;
        float cx = c.x;
        if (kind > 2.5) { wx = 0.10; wy0 = 0.36; wy1 = 0.72; }                    // band: wide windows (blocks)
        else if (kind > 1.5) { cx = fract(c.x * 2.0); wx = 0.24; wy0 = 0.28; }       // paired windows
        else if (kind > 0.5) { wx = 0.36; wy0 = 0.20; wy1 = 0.80; }                 // tall windows
        if (ground) { wy0 = 0.16; if (shop) { wx = 0.08; wy0 = 0.10; wy1 = 0.84; cx = c.x; } }
        float fx = kind > 1.5 && kind < 2.5 && !(ground && shop) ? fw.x * 2.0 : fw.x;
        float inX = smoothstep(wx - fx, wx + fx, cx) * (1.0 - smoothstep(1.0 - wx - fx, 1.0 - wx + fx, cx));
        float inY = smoothstep(wy0 - fw.y, wy0 + fw.y, c.y) * (1.0 - smoothstep(wy1 - fw.y, wy1 + fw.y, c.y));
        inX *= 1.0 - smoothstep(0.12, 0.3, fx);
        float valid = step(0.0, vW.y) * step(fl, nFl - 1.0);
        float win = inX * inY * valid;
        diffuseColor.rgb = mix(diffuseColor.rgb, uGlass, win * 0.92);
        // plinth: darker base course below the ground-floor windows
        diffuseColor.rgb *= mix(1.0, 0.82, step(nFl, vW.y));
        diffuseColor.rgb *= mix(1.0, 0.9, step(0.0, vW.y) * step(nFl - 0.12, vW.y) * (1.0 - step(nFl, vW.y)));
        // night: about 45% of windows lit, chosen per window from the building seed
        float r = h21(vec2(floor(vW.x * (kind > 1.5 && kind < 2.5 ? 2.0 : 1.0)) + nSeed * 0.19, fl + nSeed * 0.11));
        gWin = win * step(r, 0.45 + (shop && ground ? 0.4 : 0.0)) * (0.75 + 0.5 * fract(r * 13.0));
      } else {
        float row = fract(vW.y / uSpacing);
        float line = smoothstep(0.0, 0.18, row) * (1.0 - smoothstep(0.82, 1.0, row) * 0.4);
        float n = h21(floor(vec2(vW.x / (uSpacing*0.85), vW.y / uSpacing)));
        diffuseColor.rgb *= mix(1.0 - uContrast, 1.0, line) * mix(0.95, 1.05, n);
      }
    ` : /* glsl */ `
      float nFl = floor(vFl + 0.5);
      float nSeed = floor(fract(vSt) * 512.0 + 0.5); // quantised: interpolation noise must not reseed the hash per pixel
      // far LOD: average tone of the window grid / tile rows instead of the pattern
      diffuseColor.rgb *= vPart < 0.5 ? mix(0.82, 0.9, step(vW.y, nFl) * step(0.0, vW.y)) : (1.0 - uContrast * 0.35);
      gWin = vPart < 0.5 ? step(0.0, vW.y) * step(vW.y, nFl - 1.0) * 0.16 * step(0.4, h21(floor(vW) + nSeed * 0.19)) : 0.0;
    `,
    fragEmissive: /* glsl */ `
      if (uNight > 0.001) {
        float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(0.8, 0.85, 1.0), uNight * 0.6);
        vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.75, 0.85, 1.0), step(0.85, fract(gWin * 7.31)));
        totalEmissiveRadiance += warm * gWin * uNight * 1.6;
      }
    `,
  }, detail ? "building-near-v3" : "building-far-v3");
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

/**
 * Landmark models: vertex colours plus small procedural patterns by aKind
 * (1 shingle rows, 2 vertical planks, 3 chevron shingles, 4 glass lit at night, 5 rough stone).
 */
export function landmarkMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  return patch(m, {
    vertexHead: "attribute vec2 aUv; attribute float aKind; varying vec2 vLu; varying float vLk;",
    vertexMain: "vLu = aUv; vLk = aKind;",
    fragHead: "varying vec2 vLu; varying float vLk; float gLm;",
    fragColor: /* glsl */ `
      gLm = 0.0;
      {
        float k = floor(vLk + 0.5);
        vec2 fw = max(fwidth(vLu), vec2(1e-4));
        if (k == 1.0) {            // shingle rows (0.35 m) with staggered joints
          float row = fract(vLu.y / 0.35);
          float jx = fract(vLu.x / 0.3 + 0.5 * floor(vLu.y / 0.35));
          float line = smoothstep(0.0, 0.2, row) * mix(0.9, 1.0, smoothstep(0.0, 0.12, jx));
          float n = h21(floor(vec2(vLu.x / 0.3, vLu.y / 0.35)));
          diffuseColor.rgb *= mix(0.78, 1.0, line) * mix(0.9, 1.08, n);
        } else if (k == 2.0) {     // vertical planks (0.22 m)
          float p = fract(vLu.x / 0.22);
          diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 0.12 + fw.x * 4.0, p)) * mix(0.92, 1.06, h21(vec2(floor(vLu.x / 0.22), 3.0)));
        } else if (k == 3.0) {     // chevron (herringbone) shingles on the minaret
          float c = fract((vLu.y + abs(fract(vLu.x / 0.8) - 0.5) * 0.9) / 0.32);
          diffuseColor.rgb *= mix(0.72, 1.05, smoothstep(0.0, 0.35, c));
        } else if (k == 5.0) {     // rubble stone
          float n = fbm(vLu * 1.7) * 0.6 + h21(floor(vLu * vec2(2.4, 3.2))) * 0.4;
          diffuseColor.rgb *= mix(0.82, 1.1, n);
        } else if (k == 4.0) {
          gLm = 1.0;
        }
      }
    `,
    fragEmissive: /* glsl */ `
      if (uNight > 0.001) totalEmissiveRadiance += vec3(1.0, 0.74, 0.42) * gLm * uNight * 1.4;
    `,
  }, "landmark-v1");
}

/** Streetlight poles: dark grey metal; the lamp head (aLamp) glows at night. */
export function streetlightMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: "#5c6066", roughness: 0.6, metalness: 0.3 });
  return patch(m, {
    vertexHead: "attribute float aLamp; varying float vLamp;",
    vertexMain: "vLamp = aLamp;",
    fragHead: "varying float vLamp;",
    fragColor: "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.9, 0.84), vLamp);",
    fragEmissive: "totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * vLamp * uNight * 3.0;",
  }, "streetlight-v1");
}

/**
 * Night glow halos: camera-facing quads with a soft radial falloff, additive, no depth write.
 * One instanced draw for every lamp (and reused for car lights). Hidden in daytime.
 */
export function glowMaterial(color: string, size: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uNight: SCENE.uNight, uColor: { value: new THREE.Color(color) }, uSize: { value: size } },
    vertexShader: /* glsl */ `
      uniform float uSize; varying vec2 vQ;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vQ = position.xy;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * uSize;
        vec4 mvPosition = mv;
        gl_Position = projectionMatrix * mv;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uNight; uniform vec3 uColor; varying vec2 vQ;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        float r = length(vQ);
        float a = exp(-r * r * 5.0) * 0.9 + exp(-r * r * 40.0) * 0.6;
        gl_FragColor = vec4(uColor * a * uNight, 1.0);
        #include <fog_fragment>
      }
    `,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  });
}

/** Cars: instance colour paints the body only; head/tail lights glow at night. */
export function carMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = SCENE.uNight;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aPaint; attribute float aLight; varying float vLight;")
      .replace("#include <color_vertex>", `
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          vColor.xyz = color.rgb;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz = mix(vColor.xyz, vColor.xyz * instanceColor.xyz, aPaint);
        #endif
        vLight = aLight;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uNight; varying float vLight;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += (vLight > 1.5 ? vec3(1.0, 0.1, 0.06) * 2.0 : vec3(1.0, 0.93, 0.75) * 3.0) * step(0.5, vLight) * uNight;`);
  };
  m.customProgramCacheKey = () => "car-v1";
  return m;
}
