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
  /** runs just before the opaque/output chunk: may modify outgoingLight (after lighting, before fog) */
  fragOut?: string;
  /** runs after the emissive chunk: add to totalEmissiveRadiance (night lights) */
  fragEmissive?: string;
  /** replaces three's fog chunk (custom aerial perspective) */
  fragFog?: string;
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
    if (p.fragOut) shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `${p.fragOut}\n#include <opaque_fragment>`);
    if (p.fragFog) shader.fragmentShader = shader.fragmentShader.replace("#include <fog_fragment>", p.fragFog);
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
        // macro variation (estimate of natural meadow tones): drier warm patches and lusher cool hollows
        float macro = fbm(p * 0.14 + 3.7);
        col = mix(col, col * vec3(1.1, 1.02, 0.78), smoothstep(0.5, 0.72, macro) * 0.75);
        col = mix(col, col * vec3(0.86, 0.97, 0.9), smoothstep(0.45, 0.25, macro) * 0.6);
        // fine grass grain near the camera
        col *= mix(0.96, 1.04, fbm(vWp.xz * 0.9));
        col = mix(col, uForest, smoothstep(0.25, 0.75, w.r));
        // steep slopes show rock
        float steep = 1.0 - normalize(vNw).y;
        col = mix(col, uBuilt * 0.95, smoothstep(0.35, 0.6, steep) * 0.7);
        diffuseColor.rgb = col;
      }
    `,
  }, context ? "terrain-ctx-v2" : "terrain-core-v2");
}

/**
 * Real surrounding terrain (L1–L3). Colours come from ESA WorldCover classes (forest / meadow / bare rock / water)
 * baked per level, shifted by true elevation (alpine meadow above ~1 600 m, conifers higher up, pale limestone on
 * bare ground and steep open slopes) and kept in the same palette and mottling as the city core at the valley floor.
 * Aerial perspective: the scene's linear haze is used near the town (identical to the core and buildings), but it is
 * capped by a slow exponential curve with distance, so ridges 10–40 km away stay readable as softened silhouettes;
 * the outermost few km fade fully into the horizon colour so the data edge never shows.
 */
export function farTerrainMaterial(style: StyleConfig, cover: THREE.Texture, opts: { datum: number; rEff: number; edge: number; x0: number; size: number }) {
  const g = style.ground, t = style.terrain;
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  return patch(m, {
    uniforms: {
      uCover: { value: cover },
      uGrass: { value: c3(g.grass) }, uGrassDark: { value: c3(g.grassDark) }, uForest: { value: c3(g.forestFloor) },
      uDirt: { value: c3(g.dirt) }, uBuilt: { value: c3(g.built) },
      uAlpine: { value: c3(t.alpine) }, uConifer: { value: c3(t.conifer) }, uRock: { value: c3(t.rock) },
      uScree: { value: c3(t.scree) }, uWater: { value: c3(style.water.deep) },
      uCanopy: { value: c3(t.canopy) },
      uMottle: { value: g.mottle }, uScale: { value: g.mottleScale },
      uDatum: { value: opts.datum }, uREff: { value: opts.rEff }, uEdge: { value: opts.edge },
      uHaze: { value: new THREE.Vector3(t.hazeBase, t.hazeRange, t.hazeDistance) },
    },
    vertexHead: "varying vec2 vCov; varying vec3 vWp; varying vec3 vNw;",
    vertexMain: "vCov = uv; vWp = (modelMatrix * vec4(transformed,1.0)).xyz; vNw = normal;",
    fragHead: `uniform sampler2D uCover; uniform vec3 uGrass, uGrassDark, uForest, uDirt, uBuilt, uAlpine, uConifer, uRock, uScree, uWater, uCanopy;
               uniform float uMottle, uScale, uDatum, uREff, uEdge; uniform vec3 uHaze;
               varying vec2 vCov; varying vec3 vWp; varying vec3 vNw;`,
    fragColor: /* glsl */ `
      {
        vec4 w = texture2D(uCover, vCov);
        // true DEM elevation: rendered height + datum + the curvature drop baked into the far levels
        float elev = vWp.y + uDatum + dot(vWp.xz, vWp.xz) / (2.0 * uREff);
        vec2 p = vWp.xz * uScale;
        float n1 = fbm(p), n2 = fbm(p * 3.1 + 7.0);
        float macro = fbm(vWp.xz * 0.0011 + 3.7);
        // valley meadows: the city core's palette and mottling, so the two meet without a colour seam
        vec3 col = mix(uGrass, uGrassDark, smoothstep(0.35, 0.75, n2) * 0.6);
        col = mix(col, col * vec3(1.06, 1.01, 0.86), smoothstep(0.5, 0.72, macro) * 0.5);
        col = mix(col, col * vec3(0.88, 0.97, 0.92), smoothstep(0.45, 0.25, macro) * 0.5);
        // above ~1 600 m meadows turn to drier, paler alpine grassland
        float alp = smoothstep(1550.0, 1950.0, elev + (n1 - 0.5) * 160.0);
        col = mix(col, uAlpine * mix(0.94, 1.06, n2), alp);
        // forest (WorldCover tree class) seen as canopy: the same dark tone the city's 3D trees give from a distance,
        // broadleaf (beech) low down, darker conifer / mixed higher up, crown-sized mottling
        vec3 forest = mix(uCanopy, uConifer, smoothstep(1150.0, 1550.0, elev));
        forest *= mix(0.8, 1.1, fbm(vWp.xz * 0.09)) * mix(0.92, 1.06, fbm(vWp.xz * 0.012 + 1.3));
        col = mix(col, forest, smoothstep(0.2, 0.75, w.r));
        // bare / sparse ground: limestone rock and scree in the mountains, village dirt in the valley
        vec3 bare = mix(mix(uDirt, uBuilt, 0.35), mix(uScree, uRock, smoothstep(0.35, 0.7, n1)), smoothstep(1150.0, 1450.0, elev));
        col = mix(col, bare, smoothstep(0.2, 0.7, w.b));
        // steep open slopes show rock (forest on steep ground stays forest: it is in the data)
        float steep = 1.0 - normalize(vNw).y;
        float rock = smoothstep(0.2, 0.42, steep) * (1.0 - smoothstep(0.3, 0.7, w.r)) * smoothstep(1000.0, 1400.0, elev);
        // high Prokletije: above ~1 900 m open ground is mostly karst limestone with thin grass; moderate slopes
        // there already show rock (elevation/slope rule, not data: WorldCover mixes these as grass or bare)
        float karst = smoothstep(1850.0, 2250.0, elev + (n1 - 0.5) * 200.0) * smoothstep(0.08, 0.25, steep) * (1.0 - smoothstep(0.3, 0.7, w.r));
        rock = max(rock, karst * 0.8);
        col = mix(col, uRock * mix(0.88, 1.06, n1) * mix(0.94, 1.04, fbm(vWp.xz * 0.004)), rock * 0.85);
        // permanent water (small glacial lakes) — snow/ice is classified into the same channel but is absent here
        col = mix(col, uWater, smoothstep(0.35, 0.7, w.a));
        diffuseColor.rgb = col;
      }
    `,
    fragFog: /* glsl */ `
      #ifdef USE_FOG
      {
        float dist = length(vWp - cameraPosition);
        float fLin = smoothstep(fogNear, fogFar, vFogDepth);
        float cap = uHaze.x + uHaze.y * (1.0 - exp(-dist / uHaze.z));
        float f = min(fLin, cap);
        f = max(f, smoothstep(uEdge * 0.84, uEdge, max(abs(vWp.x), abs(vWp.z))));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, f);
      }
      #endif
    `,
  }, "terrain-far-v1");
}

/**
 * Sky dome: horizon in the scene's haze colour (so fully hazed terrain melts into it), a slightly deeper tone towards
 * the zenith. Follows the haze colour through day, sunset and night.
 */
export function skyMaterial(zenith: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { uFog: { value: new THREE.Color() }, uZenith: { value: zenith } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }",
    fragmentShader: `uniform vec3 uFog, uZenith; varying vec3 vDir;
      void main(){ float t = smoothstep(0.0, 0.55, vDir.y); gl_FragColor = vec4(mix(uFog, uFog * uZenith, t), 1.0); }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
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
        float nearJ = smoothstep(4.0, 9.0, vEnd);           // fade markings out before junctions
        float keep = 1.0;
        if (k > 5.5) {
          // unioned carriageway surface: asphalt with large-scale patching (repairs) and fine grain
          float big = fbm(vWp2.xz * 0.045);
          col = uAsphalt * mix(0.92, 1.06, n) * mix(1.0, 0.9, smoothstep(0.62, 0.68, big)) * mix(1.04, 1.0, smoothstep(0.3, 0.36, big));
        } else if (k > 3.5) {
          // markings / light-pool overlay on the carriageway surface; everything else is discarded
          col = uAsphalt * mix(0.93, 1.05, n);
          float m = 0.0;
          if (k < 4.5) {
            float dash = step(0.5, fract(vRd.x / 6.0));
            float centre = 1.0 - smoothstep(0.012, 0.03, abs(vRd.y - 0.5));
            float side = 1.0 - smoothstep(0.012, 0.026, abs(min(vRd.y, 1.0 - vRd.y) - 0.1));
            m = max(centre * dash, side * 0.85) * nearJ;
            col = mix(col, uMark, m);
          }
          keep = m;
        } else if (k < 1.5) {
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
        gPool = lit * exp(-d * d / 32.0) * (0.75 + 0.25 * (1.0 - abs(vRd.y - 0.5) * 2.0));
        if (k > 3.5 && k < 5.5 && keep < 0.05 && (uNight < 0.01 || gPool < 0.04)) discard;
      }
    `,
    fragEmissive: /* glsl */ `
      if (uNight > 0.001) totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * (gPool * 0.3 + 0.006) * uNight;
    `,
  }, "roads-v3");
}

/** Planar lake reflection shared by every water mesh (filled by LakeReflection in World.tsx; off on the low tier). */
export const REFLECT = {
  map: { value: null as THREE.Texture | null },
  matrix: { value: new THREE.Matrix4() },
  on: { value: 0 },
  level: { value: 0 },
};

/**
 * Water v2. Lit like before (palette colour, deep-water mottling), then after lighting:
 *  - a Fresnel reflection: the planar lake reflection where it exists (lakes, medium/high tiers), otherwise the sky
 *    colour; rippled by two scrolling noise normals, weaker in the reed belt and on rivers,
 *  - lighter shallows within a few metres of the mapped shore and a faint wet rim at the bank,
 *  - rivers: ripples stretched and moving along the profile's flow direction.
 * Lake grid (pipeline/water.py): uMarsh r = vegetation cover, g = shore distance / 64 m.
 */
export function waterMaterial(style: StyleConfig, marsh: THREE.Texture | null, box: THREE.Vector4) {
  const m = new THREE.MeshStandardMaterial({
    color: style.water.color, roughness: style.water.roughness, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const U = {
    uDeep: { value: c3(style.water.deep) }, uShallow: { value: c3(style.water.shore) }, uReed: { value: c3(style.water.reed) },
    uSkyCol: { value: c3(style.sky.fog) }, uTime: { value: 0 },
    uMarsh: { value: marsh }, uMarshOn: { value: marsh ? 1 : 0 }, uBox: { value: box },
    uRefl: REFLECT.map, uReflM: REFLECT.matrix, uReflOn: REFLECT.on,
  };
  m.userData.u = U; // Water updates uSkyCol (follows the haze: day / sunset / night) and uTime
  return patch(m, {
    uniforms: U,
    vertexHead: "attribute float aShore; attribute vec2 aFlow; varying vec3 vWw; varying float vShore; varying vec2 vFlow; uniform mat4 uReflM; varying vec4 vRefl;",
    vertexMain: "vWw = (modelMatrix * vec4(transformed,1.0)).xyz; vShore = aShore; vFlow = aFlow; vRefl = uReflM * vec4(vWw, 1.0);",
    fragHead: `uniform vec3 uDeep, uShallow, uReed, uSkyCol; uniform float uTime, uMarshOn, uReflOn; uniform sampler2D uMarsh, uRefl;
      uniform vec4 uBox; varying vec3 vWw; varying float vShore; varying vec2 vFlow; varying vec4 vRefl;
      vec2 gMarsh() {
        if (uMarshOn < 0.5 || vShore >= 0.0) return vec2(0.0, clamp(vShore, 0.0, 64.0) / 64.0);
        vec2 uv = vec2((vWw.x - uBox.x) / uBox.z, (-vWw.z - uBox.y) / uBox.w);
        vec4 t = texture2D(uMarsh, uv);
        return vec2(t.r, t.g);
      }`,
    fragColor: /* glsl */ `
      vec2 gm = gMarsh();
      float shoreM = gm.y * 64.0;
      bool river = vShore >= 0.0;
      {
        float n = fbm(vWw.xz * 0.04 + vec2(uTime * 0.01, 0.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, uDeep, smoothstep(0.35, 0.8, n) * 0.55);
        // shallows: lighter, slightly green-brown water near the bank (lake: within ~25 m; river: ~3 m)
        float sh = river ? 1.0 - smoothstep(0.3, 2.0, shoreM) : 1.0 - smoothstep(2.0, 25.0, shoreM);
        diffuseColor.rgb = mix(diffuseColor.rgb, uShallow * vec3(0.92, 0.95, 0.85), sh * (river ? 0.2 : 0.35));
        // under / between the reeds the water is darker and olive
        diffuseColor.rgb = mix(diffuseColor.rgb, uReed * 0.55, smoothstep(0.1, 0.6, gm.x) * 0.6);
      }
    `,
    fragOut: /* glsl */ `
      {
        vec3 V = normalize(cameraPosition - vWw);
        vec2 fl = length(vFlow) > 0.1 ? normalize(vFlow) : vec2(1.0, 0.0);
        vec2 p = vWw.xz;
        // ripples: two scrolling noise layers; on rivers stretched along the flow
        vec2 q = river ? vec2(dot(p, fl), dot(p, vec2(-fl.y, fl.x)) * 2.5) - vec2(uTime * 0.8, 0.0) : p;
        // gradient of one noise layer by forward differences (3 lookups) + a finer layer's value as a tilt (1 lookup)
        float e = 0.6;
        vec2 o = vec2(uTime * 0.02, uTime * 0.013);
        float a0 = fbm(q * 0.11 + o);
        float ax = fbm((q + vec2(e, 0.0)) * 0.11 + o);
        float az = fbm((q + vec2(0.0, e)) * 0.11 + o);
        float b0 = fbm(q * 0.37 - vec2(uTime * 0.03, 0.0)) - 0.5;
        vec2 g = vec2(ax - a0, az - a0) * 1.2 + vec2(b0, -b0) * 0.05;
        float amp = river ? 0.9 : 0.55;
        vec3 N = normalize(vec3(-g.x * amp, 1.0, -g.y * amp));
        float cosT = clamp(dot(V, N), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        vec3 refl = uSkyCol * 0.85;
        if (uReflOn > 0.5 && !river) {
          vec4 rc = vRefl; rc.xy += N.xz * 0.9 * rc.w * 0.06;
          refl = texture2DProj(uRefl, rc).rgb * vec3(0.8, 0.88, 0.92); // water absorbs some: reflections a touch darker and cooler
        }
        float k = mix(0.8, 0.3, smoothstep(0.1, 0.6, gm.x)) * (river ? 0.35 : 1.0);
        k *= 1.0 - uNight * 0.35;
        // planar reflection: a faint mirror even looking down (calm lake), Fresnel-strong at grazing angles
        float base = uReflOn > 0.5 && !river ? 0.07 : 0.0;
        outgoingLight = mix(outgoingLight, refl, clamp(F * k + base * (1.0 - smoothstep(0.1, 0.6, gm.x)), 0.0, 0.55));
        // wet rim along the bank (a thin darker line)
        outgoingLight *= mix(1.0, 0.8, (1.0 - smoothstep(0.0, river ? 0.8 : 2.5, shoreM)) * (river ? 0.6 : 1.0) * (uMarshOn > 0.5 || river ? 1.0 : 0.0));
      }
    `,
  }, "water-v2");
}

/**
 * Reed belt canopy (Sentinel-2 vegetated lake cells): vertex colours, matte, with fine vertical blade striping from
 * noise so it reads as reeds rather than lawn at street-level distances.
 */
export function reedMaterial(marsh: THREE.Texture, box: THREE.Vector4) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  return patch(m, {
    uniforms: { uMarsh: { value: marsh }, uBox: { value: box } },
    vertexHead: "varying vec3 vWr;",
    vertexMain: "vWr = (modelMatrix * vec4(transformed,1.0)).xyz;",
    fragHead: "uniform sampler2D uMarsh; uniform vec4 uBox; varying vec3 vWr;",
    fragColor: /* glsl */ `
      {
        // clumps: sparse cover leaves open water between stands (the Sentinel-2 cover decides how much)
        float veg = texture2D(uMarsh, vec2((vWr.x - uBox.x) / uBox.z, (-vWr.z - uBox.y) / uBox.w)).r;
        float cl = fbm(vWr.xz * 0.07) * 0.55 + fbm(vWr.xz * 0.45) * 0.45;
        if (cl < 1.12 - veg * 1.0) discard;
        float n = fbm(vWr.xz * 1.7);
        float c = fbm(vWr.xz * 0.05 + 3.1);
        diffuseColor.rgb *= 0.7 + 0.45 * n;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.05, 0.72), smoothstep(0.4, 0.75, c) * 0.6);
        // darker stems near the water line
        diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(0.0, 0.5, cl - (1.12 - veg * 1.0)));
      }
    `,
  }, "reed-v2");
}

export function tuftMaterial(style: StyleConfig) {
  void style;
  return new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
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
        float sv = floor(vSt + 0.001);
        float kind = mod(sv, 4.0);
        bool shop = mod(floor(sv / 4.0), 2.0) > 0.5;
        bool trad = mod(floor(sv / 8.0), 2.0) > 0.5;
        bool outb = mod(floor(sv / 16.0), 2.0) > 0.5;
        bool brick = mod(floor(sv / 32.0), 2.0) > 0.5;   // estimate: unfinished facade, exposed brick
        bool blockw = mod(floor(sv / 64.0), 2.0) > 0.5;  // estimate: unfinished facade, grey concrete block
        bool barn = mod(floor(sv / 128.0), 2.0) > 0.5;   // estimate: timber barn / shed
        bool stoneG = mod(floor(sv / 256.0), 2.0) > 0.5; // Phase 4 estimate: rubble-stone ground floor
        bool p4 = mod(floor(sv / 2048.0), 2.0) > 0.5;    // Phase 4 detailed facade (pilot districts)
        vec3 frameC = mod(floor(sv / 512.0), 2.0) > 0.5 ? vec3(0.42, 0.29, 0.2) : mod(floor(sv / 1024.0), 2.0) > 0.5 ? vec3(0.25, 0.27, 0.28) : vec3(0.95, 0.94, 0.9);
        bool ground = fl > nFl - 1.5;
        // per-building window size variation (from the quantised seed)
        float js = h21(vec2(nSeed, 7.0)) - 0.5;
        // window rectangle per layout: x half-margin, y range (y runs downward from the eave)
        float wx = 0.33 + js * 0.08, wy0 = 0.30 + js * 0.06, wy1 = 0.76;
        float cx = c.x;
        if (kind > 2.5) { wx = 0.10 + js * 0.06; wy0 = 0.36; wy1 = 0.72; }          // band: wide windows (blocks)
        else if (kind > 1.5) { cx = fract(c.x * 2.0); wx = 0.24; wy0 = 0.28; }       // paired windows
        else if (kind > 0.5) { wx = 0.36 + js * 0.04; wy0 = 0.20; wy1 = 0.80; }     // tall windows
        if (trad) { wx = 0.36; wy0 = 0.30; wy1 = 0.70; }                             // traditional: small square windows
        if (ground) { wy0 = trad ? 0.34 : 0.16; if (shop) { wx = 0.08; wy0 = 0.10; wy1 = 0.84; cx = c.x; } }
        float fx = kind > 1.5 && kind < 2.5 && !(ground && shop) ? fw.x * 2.0 : fw.x;
        float inX = smoothstep(wx - fx, wx + fx, cx) * (1.0 - smoothstep(1.0 - wx - fx, 1.0 - wx + fx, cx));
        float inY = smoothstep(wy0 - fw.y, wy0 + fw.y, c.y) * (1.0 - smoothstep(wy1 - fw.y, wy1 + fw.y, c.y));
        float fade = 1.0 - smoothstep(0.12, 0.3, fx);
        inX *= fade;
        float valid = step(0.0, vW.y) * step(fl, nFl - 1.0) * (outb ? 0.0 : 1.0);
        // light window surround (frame) just outside the glass
        float fr = 0.035;
        float oX = smoothstep(wx - fr - fx, wx - fr + fx, cx) * (1.0 - smoothstep(1.0 - wx + fr - fx, 1.0 - wx + fr + fx, cx));
        float oY = smoothstep(wy0 - fr * 1.4 - fw.y, wy0 - fr * 1.4 + fw.y, c.y) * (1.0 - smoothstep(wy1 + fr * 2.2 - fw.y, wy1 + fr * 2.2 + fw.y, c.y));
        float frame = oX * oY * valid * fade * (shop && ground ? 0.0 : 1.0);
        // shutters beside the windows: traditional houses and ~30% of other houses (not blocks, not shopfronts)
        bool shut = (trad || (kind < 2.5 && h21(vec2(nSeed, 3.0)) < (p4 ? 0.45 : 0.3))) && !(shop && ground) && kind < 1.5;
        float sw = (wx - fr) * 0.75;
        float sX = (smoothstep(wx - fr - sw - fx, wx - fr - sw + fx, cx) * (1.0 - smoothstep(wx - fr - fx, wx - fr + fx, cx)))
                 + (smoothstep(1.0 - wx + fr - fx, 1.0 - wx + fr + fx, cx) * (1.0 - smoothstep(1.0 - wx + fr + sw - fx, 1.0 - wx + fr + sw + fx, cx)));
        float shutter = shut ? sX * oY * valid * fade : 0.0;
        float shPick = h21(vec2(nSeed, 5.0));
        vec3 shutC = shPick < 0.45 ? vec3(0.36, 0.25, 0.17) : shPick < 0.75 ? vec3(0.3, 0.39, 0.32) : shPick < 0.9 ? vec3(0.47, 0.5, 0.5) : vec3(0.55, 0.3, 0.24);
        if (p4) shutC *= mix(0.78, 1.0, smoothstep(0.25, 0.55, fract(c.y * 26.0)));   // louvres
        // traditional houses: rubble-stone ground floor up to the first-floor line
        // Phase 4: soft plaster mottling and a light belt course at the first-floor line and under the eaves
        if (p4 && vW.y >= 0.0 && !brick && !blockw && !barn) {
          diffuseColor.rgb *= mix(0.93, 1.04, fbm(vW * vec2(0.9, 1.3) + nSeed * 0.37));
          float belt = (1.0 - smoothstep(0.03, 0.05, abs(vW.y - (nFl - 1.0)))) * step(1.5, nFl) * step(h21(vec2(nSeed, 9.0)), 0.55);
          float cornice = 1.0 - smoothstep(0.05, 0.08, vW.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.91, 0.86), max(belt, cornice * 0.8));
        }
        // Phase 4: stone plinth below the ground floor on every detailed house
        if (p4 && vW.y > nFl) {
          vec2 sp = vec2(vW.x * 6.0, vW.y * 11.0);
          float row = floor(sp.y);
          float sn = h21(vec2(floor(sp.x + 0.5 * row), row));
          vec2 f2 = fract(vec2(sp.x + 0.5 * row, sp.y));
          diffuseColor.rgb = mix(vec3(0.5, 0.48, 0.44), vec3(0.66, 0.63, 0.57), sn) * mix(0.75, 1.0, smoothstep(0.0, 0.1, f2.x) * smoothstep(0.0, 0.14, f2.y));
        }
        if ((trad || stoneG) && vW.y >= 0.0 && fl > nFl - 1.5) {
          vec2 sp = vec2(vW.x * 5.0, vW.y * 9.0);
          float row = floor(sp.y);
          float n = h21(vec2(floor(sp.x + 0.5 * row + h21(vec2(row, 1.0))), row));
          vec2 f2 = fract(vec2(sp.x + 0.5 * row, sp.y));
          float joint = smoothstep(0.0, 0.12, f2.x) * smoothstep(0.0, 0.16, f2.y);
          diffuseColor.rgb = mix(vec3(0.55, 0.52, 0.47), vec3(0.74, 0.7, 0.63), n) * mix(0.72, 1.0, joint);
        }
        // masonry / timber patterns in metres (bays ~3.1 m wide, floors 2.9 m high); faded out when sub-pixel
        if (vW.y >= 0.0 && (brick || blockw || barn)) {
          vec2 m = vec2(vW.x * 3.1, vW.y * 2.9);
          vec2 mw = max(fwidth(m), vec2(1e-4));
          if (barn) {
            float p = fract(m.x / 0.24);
            float plank = smoothstep(0.0, 0.1 + mw.x * 4.0, p) * mix(0.9, 1.08, h21(vec2(floor(m.x / 0.24), nSeed)));
            diffuseColor.rgb *= mix(1.0, mix(0.7, 1.0, plank), 1.0 - smoothstep(0.08, 0.2, mw.x));
          } else {
            vec2 u = brick ? vec2(0.25, 0.075) : vec2(0.4, 0.2);
            float row = floor(m.y / u.y);
            vec2 f = fract(vec2(m.x / u.x + 0.5 * mod(row, 2.0), m.y / u.y));
            float mortar = (1.0 - smoothstep(0.0, 0.12, f.x)) + (1.0 - smoothstep(0.0, 0.18, f.y));
            float vis = 1.0 - smoothstep(u.y * 0.25, u.y * 0.6, max(mw.x, mw.y));
            vec3 mc = brick ? vec3(0.78, 0.74, 0.68) : vec3(0.52, 0.51, 0.5);
            float jit = h21(vec2(floor(m.x / u.x + 0.5 * mod(row, 2.0)), row));
            diffuseColor.rgb *= mix(1.0, mix(0.9, 1.08, jit), vis);
            diffuseColor.rgb = mix(diffuseColor.rgb, mc, clamp(mortar, 0.0, 1.0) * 0.55 * vis);
            // exposed concrete floor slabs and frame at every storey line (typical of unfinished houses)
            float slab = 1.0 - smoothstep(0.035, 0.05, fract(vW.y));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.61, 0.58), slab * step(0.5, vW.y) * step(vW.y, nFl - 0.1));
          }
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, p4 ? frameC : vec3(0.95, 0.94, 0.9), clamp(frame - inX * inY, 0.0, 1.0) * (p4 ? 0.95 : 0.85));
        // Phase 4: stone sill under each window with a soft drop shadow beneath it
        if (p4 && !(shop && ground)) {
          float sy0 = wy1 + fr * 2.2, sx = wx - fr - 0.05;
          float sX2 = smoothstep(sx - fx, sx + fx, cx) * (1.0 - smoothstep(1.0 - sx - fx, 1.0 - sx + fx, cx));
          float sill = sX2 * smoothstep(sy0 - fw.y, sy0 + fw.y, c.y) * (1.0 - smoothstep(sy0 + 0.045 - fw.y, sy0 + 0.045 + fw.y, c.y)) * valid * fade;
          float drop = sX2 * smoothstep(sy0 + 0.04, sy0 + 0.05, c.y) * (1.0 - smoothstep(sy0 + 0.05, sy0 + 0.13, c.y)) * valid * fade;
          diffuseColor.rgb *= 1.0 - 0.22 * drop;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.84, 0.8), sill);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, shutC, shutter);
        float win = inX * inY * valid;
        vec3 glassC = uGlass;
        if (p4) {
          float gy = (c.y - wy0) / max(wy1 - wy0, 0.01), gx = (cx - wx) / max(1.0 - 2.0 * wx, 0.01);
          // sky reflection: lighter towards the top and in a diagonal band, darker in the reveal shadow (top and left)
          glassC = uGlass * mix(1.55, 0.85, gy) + vec3(0.05, 0.06, 0.07) * smoothstep(0.35, 0.0, abs(gx - gy * 0.6 - 0.2));
          float rev = max(1.0 - smoothstep(0.0, 0.12, gy), 1.0 - smoothstep(0.0, 0.1, gx));
          glassC *= 1.0 - 0.45 * rev;
          // mullion and transom (casement windows), frame colour
          float mw = fw.x * 1.5 + 0.012, mh = fw.y * 1.5 + 0.012;
          float mull = (1.0 - smoothstep(mw, mw + fw.x, abs(gx - 0.5) * (1.0 - 2.0 * wx))) * step(0.42, 1.0 - 2.0 * wx);
          float tran = 1.0 - smoothstep(mh, mh + fw.y, abs(gy - 0.32) * (wy1 - wy0));
          float bars = clamp(mull + tran, 0.0, 1.0) * (shop && ground ? 0.0 : 1.0) * fade;
          glassC = mix(glassC, frameC * 0.92, bars);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, glassC, win * 0.92);
        // subtle weathering: rising damp near the ground and faint streaks below window sills (estimate, procedural)
        if (vW.y >= 0.0) {
          float damp = smoothstep(nFl - 0.45, nFl, vW.y) * 0.08 * (0.6 + 0.4 * h21(vec2(floor(vW.x * 3.0), nSeed)));
          float streak = step(0.0, wy1 + 0.04 - c.y) * 0.0 + (1.0 - smoothstep(0.0, 0.25, c.y - wy1)) * step(wy1, c.y) * inX * 0.06;
          diffuseColor.rgb *= 1.0 - damp - streak;
        }
        // soft occlusion: darker under the eaves and towards the ground (contact shadow of the street / yard)
        float eaveAo = 1.0 - smoothstep(0.0, 0.22, vW.y);
        float baseAo = smoothstep(nFl - 0.55, nFl + 0.05, vW.y);
        diffuseColor.rgb *= 1.0 - 0.16 * eaveAo * step(0.0, vW.y) - 0.12 * baseAo;
        // plinth: darker base course below the ground-floor windows
        diffuseColor.rgb *= mix(1.0, 0.82, step(nFl, vW.y));
        diffuseColor.rgb *= mix(1.0, 0.9, step(0.0, vW.y) * step(nFl - 0.12, vW.y) * (1.0 - step(nFl, vW.y)));
        // night: about 45% of windows lit, chosen per window from the building seed
        float r = h21(vec2(floor(vW.x * (kind > 1.5 && kind < 2.5 ? 2.0 : 1.0)) + nSeed * 0.19, fl + nSeed * 0.11));
        gWin = win * step(r, 0.36 + (shop && ground ? 0.25 : 0.0)) * (0.7 + 0.45 * fract(r * 13.0)) * (shop && ground ? 0.7 : 1.0);
      } else {
        float rm = floor(vSt + 0.5); // roof material: 0 clay tile, 1 sheet metal, 2 concrete tile (estimates)
        vec2 rw = max(fwidth(vW), vec2(1e-4));
        if (rm > 0.5 && rm < 1.5) {
          // standing-seam sheet metal: raised seams every 0.5 m running down the slope, faint sheen
          float sp = fract(vW.x / 0.5);
          float seam = 1.0 - smoothstep(0.0, 0.08 + rw.x * 3.0, min(sp, 1.0 - sp));
          float vis = 1.0 - smoothstep(0.12, 0.3, rw.x);
          diffuseColor.rgb *= mix(1.0, mix(1.0, 1.25, seam), vis) * mix(0.97, 1.03, fbm(vW * 0.3));
        } else {
          float sc = rm > 1.5 ? 1.35 : 1.0;
          float row = fract(vW.y / (uSpacing * sc));
          float line = smoothstep(0.0, 0.18, row) * (1.0 - smoothstep(0.82, 1.0, row) * 0.4);
          float n = h21(floor(vec2(vW.x / (uSpacing * sc * 0.85), vW.y / (uSpacing * sc))));
          diffuseColor.rgb *= mix(1.0 - uContrast * (rm > 1.5 ? 0.6 : 1.0), 1.0, line) * mix(0.95, 1.05, n);
          // weathering: soft darker patches and a faint lichen tint on older tile roofs
          float wth = fbm(vW * 0.35 + 3.7);
          diffuseColor.rgb *= mix(0.9, 1.04, wth);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.45, 0.33), smoothstep(0.62, 0.85, fbm(vW * 0.9 + 11.0)) * 0.18);
        }
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
        // night grading: roofs go to a neutral blue-grey (red tiles under blue moonlight read as magenta otherwise)
        // (graded only after sunset: at dusk the roofs keep their warm colour)
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(0.82, 0.86, 1.0), smoothstep(0.3, 1.0, uNight) * (vPart > 0.5 ? 0.95 : 0.6));
        vec3 warm = mix(vec3(1.0, 0.7, 0.36), vec3(0.75, 0.85, 1.0), step(0.88, fract(gWin * 7.31)));
        totalEmissiveRadiance += warm * gWin * uNight * 1.25;
      }
    `,
  }, detail ? "building-near-v8" : "building-far-v7");
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

/**
 * Street details (sidewalks, bridges, piers, pitch lines): vertex colours; on up-facing surfaces a 0.5 m paving-slab
 * joint pattern in world space (fades out with distance so it never shimmers).
 */
export function pavingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  return patch(m, {
    vertexHead: "varying vec3 vPw; varying float vUp;",
    vertexMain: "vPw = (modelMatrix * vec4(transformed, 1.0)).xyz; vUp = normal.y;",
    fragHead: "varying vec3 vPw; varying float vUp;",
    fragColor: /* glsl */ `
      {
        vec2 q = vPw.xz / 0.5;
        vec2 fw = max(fwidth(q), vec2(1e-4));
        vec2 g = abs(fract(q) - 0.5);
        float joint = (1.0 - smoothstep(0.47 - fw.x, 0.5, g.x)) * (1.0 - smoothstep(0.47 - fw.y, 0.5, g.y));
        float fade = 1.0 - smoothstep(0.25, 0.5, max(fw.x, fw.y));
        float up = smoothstep(0.8, 0.95, abs(vUp));
        diffuseColor.rgb *= mix(1.0, mix(0.86, 1.0, joint) * mix(0.96, 1.04, h21(floor(q))), up * fade);
      }
    `,
  }, "paving-v1");
}

/**
 * Estimated garden fences: one vertical strip per segment; pickets (wood) or posts + wire mesh (wire) are cut out
 * with discard. aF = (metres along, 0..1 height, kind 0 wood / 1 wire). Far away the strip turns into a faint band.
 */
export function fenceMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, side: THREE.DoubleSide });
  return patch(m, {
    vertexHead: "attribute vec3 aF; varying vec3 vF;",
    vertexMain: "vF = aF;",
    fragHead: "varying vec3 vF;",
    fragColor: /* glsl */ `
      {
        float fw = max(fwidth(vF.x), 1e-4);
        float far = smoothstep(0.05, 0.14, fw);
        if (vF.z < 0.5) {
          float pick = step(fract(vF.x / 0.16), 0.55);
          float rail = step(abs(vF.y - 0.3), 0.05) + step(abs(vF.y - 0.8), 0.05);
          float top = 1.0 - step(0.92 + 0.08 * abs(fract(vF.x / 0.16) - 0.27) * 3.0, vF.y);
          float keep = max(pick * top, rail);
          if (far < 0.5 && keep < 0.5) discard;
          if (far >= 0.5 && vF.y > 0.85) discard;
          diffuseColor.rgb = vec3(0.55, 0.41, 0.28) * mix(0.9, 1.08, h21(vec2(floor(vF.x / 0.16), 2.0)));
        } else {
          float post = step(fract(vF.x / 2.5), 0.04);
          float mesh = max(step(fract(vF.x / 0.12), 0.14), step(fract(vF.y * 9.0), 0.14));
          float topw = step(0.96, vF.y);
          if (far < 0.5 && max(post, max(mesh * 0.0 + step(0.5, mesh) * step(fw, 0.03), topw)) < 0.5) discard;
          if (far >= 0.5 && post < 0.5 && topw < 0.5) discard;
          diffuseColor.rgb = post > 0.5 ? vec3(0.35, 0.37, 0.38) : vec3(0.55, 0.58, 0.58);
        }
      }
    `,
  }, "fence-v1");
}
