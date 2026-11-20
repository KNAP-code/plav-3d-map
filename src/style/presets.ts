/**
 * Visual style tokens. Everything that affects the look lives here so presets can be
 * compared side by side with reference screenshots (open the app with ?tune=1).
 */
export type StyleConfig = {
  name: string;
  sky: { top: string; horizon: string; fog: string; fogNear: number; fogFar: number };
  sun: { color: string; intensity: number; azimuthDeg: number; elevationDeg: number; shadowSoftness: number };
  ambient: { sky: string; ground: string; intensity: number };
  ground: {
    grass: string; grassDark: string; forestFloor: string; dirt: string; built: string;
    mottle: number; mottleScale: number;
    context: string; contextForest: string; contextRock: string;
  };
  walls: string[];
  roofs: string[];
  window: { glass: string; frame: string; bayWidth: number; floorHeight: number };
  roof: { pitchDeg: number; overhang: number; tileSpacing: number; tileContrast: number };
  roads: {
    asphalt: string; edge: string; marking: string; path: string; track: string;
    widths: Record<string, number>;
  };
  overlays: Record<string, string>;
  water: { color: string; deep: string; shore: string; roughness: number };
  trees: { leaf: string[]; conifer: string[]; trunk: string; size: number };
  minaret: { color: string; cap: string };
  post: { ao: boolean; aoRadius: number; aoIntensity: number; tiltShift: boolean; tiltFocus: number; tiltFeather: number; tiltBlur: number; exposure: number };
  camera: { fov: number; startPolarDeg: number; startAzimuthDeg: number; startDistance: number };
  /** Night mode targets (moonlight from the sun's direction, dark-blue ambient); lights come from emissive materials. */
  night: { fog: string; fogNear: number; fogFar: number; moon: string; moonIntensity: number; sky: string; ground: string; ambient: number };
  /** Sunset targets (the middle of the day → sunset → night cycle): low warm sun, rosy haze, the first lights on. */
  dusk: { sun: string; intensity: number; azimuthDeg: number; elevationDeg: number; sky: string; ground: string; ambient: number; fog: string; fogNear: number; fogFar: number; lights: number };
  /** Real surrounding terrain (L1–L3): alpine/rock tones and the aerial-perspective cap (see farTerrainMaterial). */
  terrain: { alpine: string; canopy: string; conifer: string; rock: string; scree: string; hazeBase: number; hazeRange: number; hazeDistance: number; zenith: string };
  /** Final colour grade (post): saturation and contrast offsets, vignette darkness (0 = off). */
  grade: { saturation: number; contrast: number; brightness: number; vignette: number };
};

/** Default look: warm tabletop miniature, tuned against the Sarajevo.mapa.ba phone screenshots. */
export const plavWarm: StyleConfig = {
  name: "plav-warm",
  // warm, soft late-afternoon light from the south-west; pale warm haze that thickens with distance
  sky: { top: "#bcd3e6", horizon: "#efeee6", fog: "#e3e7e6", fogNear: 1400, fogFar: 8200 },
  sun: { color: "#ffe6c4", intensity: 2.95, azimuthDeg: 232, elevationDeg: 33, shadowSoftness: 3.0 },
  ambient: { sky: "#d8e1ea", ground: "#bcac90", intensity: 1.5 },
  ground: {
    // mountain-meadow greens (less lime than before), warmer dry patches
    grass: "#8eab62", grassDark: "#6f9150", forestFloor: "#4f7542", dirt: "#c4ab82", built: "#b8a688",
    mottle: 0.5, mottleScale: 0.075,
    context: "#9aab80", contextForest: "#5a7a4b", contextRock: "#b3aa98",
  },
  walls: ["#efe7d9", "#ecd9a8", "#e9c9a5", "#e5d6be", "#d6c9ba", "#c9b9ab", "#b4a69c", "#e9dcc2", "#f1e3b5", "#d9bfb6", "#cdbfb5", "#a59a92", "#e3d3b8", "#c2b4a8", "#f3eee6", "#d8d2c8"],
  // terracotta clay tile (warmer, less pink) with some brown and grey painted sheet roofs
  roofs: ["#cf7a58", "#c56d4e", "#d88a64", "#bb6448", "#b8604a", "#e0987a", "#a8705e", "#8f8a88", "#7f8590", "#cc7e5c", "#c47658", "#94695a"],
  window: { glass: "#474b55", frame: "#f3efe6", bayWidth: 3.1, floorHeight: 2.9 },
  roof: { pitchDeg: 30, overhang: 0.55, tileSpacing: 0.45, tileContrast: 0.26 },
  roads: {
    asphalt: "#5d6068", edge: "#8d8f92", marking: "#e9e6dc", path: "#c9bba0", track: "#b8a68a",
    widths: { secondary: 7.5, tertiary: 6.5, residential: 5.2, unclassified: 4.8, living_street: 4.5, service: 3.6, pedestrian: 4.0, track: 3.0, path: 1.6, footway: 1.8, cycleway: 2.0, steps: 1.8, bridleway: 1.6, unknown: 3.5 },
  },
  overlays: { pitch: "#6fa84a", cemetery: "#93b466", paving: "#b9b3a9", playground: "#c9a97c", park: "#86b65a" },
  water: { color: "#5b9aa6", deep: "#3f7c8c", shore: "#9cc3c2", roughness: 0.18 },
  trees: { leaf: ["#6c9a4c", "#5c8a43", "#7ba456", "#4f7d3f", "#87ab5f"], conifer: ["#3e6e40", "#35643c", "#497a47"], trunk: "#7a5b43", size: 1.0 },
  minaret: { color: "#f4f1ea", cap: "#7f8c95" },
  post: { ao: true, aoRadius: 4.5, aoIntensity: 2.2, tiltShift: true, tiltFocus: 0.62, tiltFeather: 0.3, tiltBlur: 1, exposure: 1.0 },
  camera: { fov: 28, startPolarDeg: 40, startAzimuthDeg: 28, startDistance: 420 },
  night: { fog: "#0e1626", fogNear: 1200, fogFar: 6500, moon: "#9db2e6", moonIntensity: 0.3, sky: "#26365a", ground: "#14171f", ambient: 0.46 },
  dusk: { sun: "#ffb47a", intensity: 2.8, azimuthDeg: 258, elevationDeg: 14, sky: "#cfcadc", ground: "#9a8774", ambient: 1.2, fog: "#ecc9a8", fogNear: 1000, fogFar: 7000, lights: 0.22 },
  grade: { saturation: -0.2, contrast: 0.06, brightness: 0.02, vignette: 0.28 },
  // Prokletije: pale grey limestone, olive-tan alpine grass, dark spruce/fir/beech forest
  terrain: { alpine: "#a3a578", canopy: "#557a42", conifer: "#44663f", rock: "#bdb8ac", scree: "#a9a395", hazeBase: 0.07, hazeRange: 0.55, hazeDistance: 26000, zenith: "#c4d2e6" },
};

/** Alternative for comparison: cooler alpine light, more slate roofs. */
export const plavAlpine: StyleConfig = {
  ...plavWarm,
  name: "plav-alpine",
  sky: { ...plavWarm.sky, top: "#a9c4dc", horizon: "#e4ebee", fog: "#dde5ea" },
  sun: { ...plavWarm.sun, color: "#fffaf0", intensity: 2.5, elevationDeg: 42 },
  roofs: ["#8a8f99", "#7b808a", "#9a9ea6", "#c46e58", "#6f747d", "#a7584a", "#8f8a88"],
  ground: { ...plavWarm.ground, grass: "#76a54e", grassDark: "#5a8a42" },
};

export const PRESETS: Record<string, StyleConfig> = { warm: plavWarm, alpine: plavAlpine };
