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
};

/** Default look: warm tabletop miniature, tuned against the Sarajevo.mapa.ba phone screenshots. */
export const plavWarm: StyleConfig = {
  name: "plav-warm",
  sky: { top: "#bcd3e6", horizon: "#eef0ea", fog: "#e6ebe8", fogNear: 1800, fogFar: 9000 },
  sun: { color: "#fff1dc", intensity: 3.1, azimuthDeg: 215, elevationDeg: 48, shadowSoftness: 2.5 },
  ambient: { sky: "#e6eef7", ground: "#b8ad94", intensity: 1.35 },
  ground: {
    grass: "#84b84e", grassDark: "#6ea545", forestFloor: "#4f8a39", dirt: "#c6b08a", built: "#b9a98c",
    mottle: 0.5, mottleScale: 0.075,
    context: "#93ae74", contextForest: "#5d8547", contextRock: "#b5ad9e",
  },
  walls: ["#efe7d9", "#ecd9a8", "#e9c9a5", "#e5d6be", "#d6c9ba", "#c9b9ab", "#b4a69c", "#e9dcc2", "#f1e3b5", "#d9bfb6", "#cdbfb5", "#a59a92", "#e3d3b8", "#c2b4a8", "#f3eee6", "#d8d2c8"],
  roofs: ["#e8937b", "#de8068", "#efa08a", "#d47462", "#c86d5f", "#f0b29c", "#b98478", "#9b8f94", "#8d939e", "#e48f72", "#d9876f", "#a97a72"],
  window: { glass: "#474b55", frame: "#f3efe6", bayWidth: 3.1, floorHeight: 2.9 },
  roof: { pitchDeg: 30, overhang: 0.55, tileSpacing: 0.45, tileContrast: 0.26 },
  roads: {
    asphalt: "#5d6068", edge: "#8d8f92", marking: "#e9e6dc", path: "#c9bba0", track: "#b8a68a",
    widths: { secondary: 7.5, tertiary: 6.5, residential: 5.2, unclassified: 4.8, living_street: 4.5, service: 3.6, pedestrian: 4.0, track: 3.0, path: 1.6, footway: 1.8, cycleway: 2.0, steps: 1.8, bridleway: 1.6, unknown: 3.5 },
  },
  overlays: { pitch: "#6fa84a", cemetery: "#93b466", paving: "#b9b3a9", playground: "#c9a97c", park: "#86b65a" },
  water: { color: "#5b9aa6", deep: "#3f7c8c", shore: "#9cc3c2", roughness: 0.18 },
  trees: { leaf: ["#6ea94a", "#5f9b3f", "#80b552", "#4f8a3a", "#8cbd5c"], conifer: ["#3f7a3f", "#356e3b", "#4a8545"], trunk: "#7a5b43", size: 1.0 },
  minaret: { color: "#f4f1ea", cap: "#7f8c95" },
  post: { ao: true, aoRadius: 4.5, aoIntensity: 2.2, tiltShift: true, tiltFocus: 0.62, tiltFeather: 0.3, tiltBlur: 1, exposure: 1.0 },
  camera: { fov: 28, startPolarDeg: 40, startAzimuthDeg: 28, startDistance: 420 },
  night: { fog: "#0e1626", fogNear: 1200, fogFar: 6500, moon: "#9db2e6", moonIntensity: 0.22, sky: "#22314f", ground: "#12151c", ambient: 0.38 },
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
