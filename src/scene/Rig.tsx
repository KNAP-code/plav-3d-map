"use client";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import CameraControlsImpl from "camera-controls";
import { BrightnessContrastEffect, EffectComposer, EffectPass, HueSaturationEffect, RenderPass, SMAAEffect, TiltShiftEffect, ToneMappingEffect, ToneMappingMode, KernelSize, VignetteEffect } from "postprocessing";
import { N8AOPostPass } from "n8ao";
import type { AreaData } from "@/data/load";
import type { StyleConfig } from "@/style/presets";
import { shadowSync, type Quality } from "./World";
import { SCENE } from "./materials";
import { bump } from "@/ui/perf";

const DEG = Math.PI / 180;

/**
 * Sun + shadows. The shadow map is never re-rendered while the camera moves:
 * - low / medium: one 2048² map fitted to the whole area, rendered once (and again only if the style changes);
 * - high: a 4096² map fitted around the view, re-rendered once each time the camera comes to rest.
 * Measured: the old follow-the-target map re-rendered on ~95% of moving frames.
 */
/** Light direction from azimuth (clockwise from north; scene north = -Z) and elevation, in degrees. */
const sunDir = (azDeg: number, elDeg: number, out = new THREE.Vector3()) => {
  const az = azDeg * DEG, el = elDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
};

/** Time of day: 0 = day (afternoon), 1 = sunset, 2 = night. */
export type TimeOfDay = 0 | 1 | 2;

export function Sun({ data, style, quality, controls, follow = true, enabled = true, tod = 0 }: { data: AreaData; style: StyleConfig; quality: Quality; controls: React.RefObject<CameraControlsImpl | null>; follow?: boolean; enabled?: boolean; tod?: TimeOfDay }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const { gl, scene, invalidate } = useThree();
  // current light direction; DayNight moves it between the day, sunset and (moon) night directions
  const dir = useMemo(() => sunDir(style.sun.azimuthDeg, style.sun.elevationDeg), [style.sun.azimuthDeg, style.sun.elevationDeg]);
  const lastFit = useRef<[number, number, number, number] | null>(null);
  const size = quality === "high" ? 4096 : 2048;
  const tracking = quality === "high" && follow;
  // height range of everything that can cast a shadow (terrain + tallest buildings / minarets)
  const hRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const v of data.core.h) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo - data.datum - 5, hi - data.datum + 60];
  }, [data]);
  const fit = useMemo(() => {
    const pts = Array.from({ length: 8 }, () => new THREE.Vector3());
    /** Fit the light camera tightly around the box [cx±hx] × [cz±hz] in light space and request one shadow render. */
    return (l: THREE.DirectionalLight, cx: number, cz: number, hx: number, hz: number) => {
      lastFit.current = [cx, cz, hx, hz];
      const cy = (hRange[0] + hRange[1]) / 2;
      l.position.set(cx, cy, cz).addScaledVector(dir, 3000);
      l.target.position.set(cx, cy, cz);
      l.updateMatrixWorld(); l.target.updateMatrixWorld();
      const cam = l.shadow.camera;
      cam.position.copy(l.position); cam.lookAt(l.target.position); cam.updateMatrixWorld();
      let k = 0;
      for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1])
        pts[k++].set(cx + sx * hx, hRange[sy], cz + sz * hz).applyMatrix4(cam.matrixWorldInverse);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, -p.z); z1 = Math.max(z1, -p.z); }
      cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1; cam.near = Math.max(1, z0 - 50); cam.far = z1 + 50;
      cam.updateProjectionMatrix();
      const texel = Math.max(x1 - x0, y1 - y0) / size;
      l.shadow.radius = style.sun.shadowSoftness;
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = Math.max(0.25, texel * 1.5);
      shadowSync.full = true;
      gl.shadowMap.needsUpdate = true;
      bump("shadowUpdates");
      invalidate();
    };
  }, [dir, hRange, size, gl, invalidate, style.sun.shadowSoftness]);

  useEffect(() => {
    gl.shadowMap.enabled = enabled;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
  }, [gl, enabled]);

  useEffect(() => {
    const l = light.current;
    if (!l) return;
    scene.add(l.target);
    l.shadow.map?.dispose();
    (l.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
    l.shadow.mapSize.set(size, size);
    const { halfW, halfH } = data.meta.extent;
    const whole = () => fit(l, 0, 0, halfW + 10, halfH + 10);
    if (!tracking) { whole(); return () => { scene.remove(l.target); }; }
    // high: refit around the view whenever the camera settles
    const t = new THREE.Vector3();
    let c: CameraControlsImpl | null = null;
    const onRest = () => {
      if (!c) return;
      c.getTarget(t);
      const half = THREE.MathUtils.clamp(c.distance * 1.3, 250, Math.max(halfW, halfH) + 10);
      fit(l, t.x, t.z, Math.min(half, halfW + 10), Math.min(half, halfH + 10));
    };
    const attach = () => {
      c = controls.current;
      if (!c) { raf = requestAnimationFrame(attach); return; }
      c.addEventListener("rest", onRest);
      onRest();
    };
    let raf = requestAnimationFrame(attach);
    return () => { cancelAnimationFrame(raf); c?.removeEventListener("rest", onRest); scene.remove(l.target); };
  }, [scene, size, fit, tracking, controls, data]);

  return (
    <>
      <directionalLight ref={light} color={style.sun.color} intensity={style.sun.intensity} castShadow={enabled} />
      <hemisphereLight ref={hemi} args={[style.ambient.sky, style.ambient.ground, style.ambient.intensity]} />
      <DayNight style={style} tod={tod} light={light} hemi={hemi} dir={dir}
        refit={() => { const l = light.current, f = lastFit.current; if (l && f && enabled) fit(l, ...f); }} />
    </>
  );
}

/**
 * Post-processing per tier (all keep the tilt-shift miniature look and the colour grade):
 * - high: N8AO ambient occlusion + tilt-shift + tone mapping + SMAA
 * - medium: tilt-shift + tone mapping, 2× MSAA on the scene pass (no AO, no SMAA)
 * - low: tilt-shift (smaller kernel) + tone mapping, no anti-aliasing pass
 */
export function Effects({ style, quality, ao = true, tilt = true }: { style: StyleConfig; quality: Quality; ao?: boolean; tilt?: boolean }) {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    const comp = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: quality === "medium" ? 2 : 0 });
    comp.addPass(new RenderPass(scene, camera));
    if (style.post.ao && ao && quality === "high") {
      const pass = new N8AOPostPass(scene, camera, size.width, size.height);
      pass.configuration.aoRadius = style.post.aoRadius;
      pass.configuration.distanceFalloff = 1.0;
      pass.configuration.intensity = style.post.aoIntensity;
      pass.configuration.gammaCorrection = false;
      pass.configuration.halfRes = true;
      pass.setQualityMode("Medium");
      comp.addPass(pass);
    }
    const effects = [];
    if (style.post.tiltShift && tilt)
      effects.push(new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: style.post.tiltFocus, feather: style.post.tiltFeather, kernelSize: quality === "high" ? KernelSize.SMALL : KernelSize.VERY_SMALL, resolutionScale: quality === "low" ? 0.35 : 0.5 }));
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }));
    // gentle grade (same merged pass, all tiers): a touch less saturation, a touch more contrast, soft vignette
    const g = style.grade;
    if (g.saturation) effects.push(new HueSaturationEffect({ saturation: g.saturation }));
    if (g.contrast || g.brightness) effects.push(new BrightnessContrastEffect({ contrast: g.contrast, brightness: g.brightness }));
    if (g.vignette > 0) effects.push(new VignetteEffect({ offset: 0.32, darkness: g.vignette }));
    if (quality === "high") effects.push(new SMAAEffect());
    comp.addPass(new EffectPass(camera, ...effects));
    return comp;
  }, [gl, scene, camera, style.post, style.grade, quality, ao, tilt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const prev = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping;
    return () => { gl.toneMapping = prev; composer.dispose(); };
  }, [gl, composer]);
  useEffect(() => composer.setSize(size.width, size.height), [composer, size]);
  useFrame((_, dt) => composer.render(dt), 1);
  return null;
}

/** Plain render (used when post-processing is switched off for profiling). */
export function PlainRender() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const prev = gl.toneMapping;
    gl.toneMapping = THREE.NeutralToneMapping;
    return () => { gl.toneMapping = prev; };
  }, [gl]);
  useFrame(() => gl.render(scene, camera), 1);
  return null;
}

export type Rig = {
  flyTo: (x: number, y: number, opts?: { distance?: number; polarDeg?: number; azimuthDeg?: number }) => void;
};

export type HudRefs = { north: React.RefObject<SVGSVGElement | null>; elev: React.RefObject<HTMLSpanElement | null> };

/** Map-style camera: one finger pans on the ground, two fingers pinch/rotate, three tilt. HUD is written to the DOM, not React state. */
export function Controls({ data, controlsRef, hud, onReady }: {
  data: AreaData; controlsRef: React.RefObject<CameraControlsImpl | null>; hud?: HudRefs; onReady?: () => void;
}) {
  const ready = useRef(false);
  const { halfW, halfH } = data.meta.extent;
  useEffect(() => {
    const c = controlsRef.current;
    if (!c || ready.current) return;
    ready.current = true;
    const A = CameraControlsImpl.ACTION;
    c.mouseButtons.left = A.TRUCK;
    c.mouseButtons.right = A.ROTATE;
    c.mouseButtons.wheel = A.DOLLY;
    c.touches.one = A.TOUCH_TRUCK;
    c.touches.two = A.TOUCH_DOLLY_ROTATE;
    c.touches.three = A.TOUCH_ROTATE;
    c.dollyToCursor = true;
    c.smoothTime = 0.28;
    c.draggingSmoothTime = 0.08;
    // ?closeup=1 (render scripts only): allow close, low cameras for landmark close-ups; normal controls are unchanged
    const closeup = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("closeup") === "1";
    // ?eye=… (render scripts only): a standing observer looking at the skyline (ground-level panoramas)
    const eye = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("eye");
    c.minDistance = eye ? 1 : closeup ? 12 : 40;
    // far enough out for a wide aerial of the town with its mountains (the real terrain reaches ±39 km)
    c.maxDistance = Math.max(halfW, halfH) * (data.levels.length ? 5 : 3.2);
    c.minPolarAngle = 12 * DEG;
    c.maxPolarAngle = (eye ? 110 : closeup ? 84 : data.levels.length ? 78 : 72) * DEG;
    c.setBoundary(new THREE.Box3(new THREE.Vector3(-halfW, -200, -halfH), new THREE.Vector3(halfW, 800, halfH)));
    c.boundaryEnclosesCamera = false;
    onReady?.();
  }, [controlsRef, halfW, halfH, onReady]);

  const t = useMemo(() => new THREE.Vector3(), []);
  const cp = useMemo(() => new THREE.Vector3(), []);
  const last = useRef({ az: NaN, el: NaN });
  useFrame(() => {
    const c = controlsRef.current;
    if (!c) return;
    // the real mountains rise right at the edge of the town: never let the camera sink into a hillside
    if (data.levels.length && !EYE) {
      c.getPosition(cp);
      const x = cp.x, y = -cp.z;
      const g = (data.core.contains(x, y) ? data.core.at(x, y) : data.context.at(x, y)) - data.datum + 25;
      if (cp.y < g) c.setPosition(cp.x, g, cp.z, false);
    }
    c.getTarget(t);
    const ground = data.core.at(t.x, -t.z) - data.datum;
    if (Math.abs(ground - t.y) > 0.5 && !c.active && !EYE) c.setTarget(t.x, t.y + (ground - t.y) * 0.15, t.z, false);
    if (!hud) return;
    const az = Math.round((c.azimuthAngle * 180) / Math.PI), el = Math.round(ground + data.datum);
    const L = last.current;
    if (az !== L.az && hud.north.current) { hud.north.current.style.transform = `rotate(${az}deg)`; L.az = az; }
    if (el !== L.el && hud.elev.current) { hud.elev.current.textContent = String(el); L.el = el; }
  });

  return <CameraControls ref={controlsRef} makeDefault />;
}

const EYE = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("eye");

/** Standing observer: eye h m above the ground at (x, y), looking towards azimuth az (deg from grid north), pitch deg. */
export function eyeAt(c: CameraControlsImpl, data: AreaData, x: number, y: number, h: number, azDeg: number, pitchDeg: number) {
  const g = (data.core.contains(x, y) ? data.core.atTri(x, y) : data.context.atTri(x, y)) - data.datum + h;
  const a = azDeg * DEG, p = pitchDeg * DEG, D = 25;
  return c.setLookAt(x, g, -y, x + Math.sin(a) * Math.cos(p) * D, g + Math.sin(p) * D, -y - Math.cos(a) * Math.cos(p) * D, false);
}

export function flyTo(c: CameraControlsImpl, data: AreaData, style: StyleConfig, x: number, y: number, opts: { distance?: number; polarDeg?: number; azimuthDeg?: number; lift?: number } = {}, smooth = true) {
  const h = data.core.at(x, y) - data.datum + (opts.lift ?? 0);
  const az = (opts.azimuthDeg ?? style.camera.startAzimuthDeg) * DEG;
  const pol = (opts.polarDeg ?? style.camera.startPolarDeg) * DEG;
  const d = opts.distance ?? style.camera.startDistance;
  const tx = x, ty = h, tz = -y;
  const px = tx + d * Math.sin(pol) * Math.sin(az);
  const py = ty + d * Math.cos(pol);
  const pz = tz + d * Math.sin(pol) * Math.cos(az);
  return c.setLookAt(px, py, pz, tx, ty, tz, smooth);
}

/**
 * Day → sunset → night blend. One value s (0 day, 1 sunset, 2 night) eases towards the chosen time of day over
 * ~2 s per step. It drives SCENE.uNight (lit windows, road light pools, lamps, car lights: a few lights already at
 * sunset), the sun / moon colour, intensity and direction (low western sun at sunset, long shadows), the ambient
 * light and the haze. Frames are rendered only while blending; the shadow map is refitted on each of those frames.
 */
function DayNight({ style, tod, light, hemi, dir, refit }: { style: StyleConfig; tod: TimeOfDay; light: React.RefObject<THREE.DirectionalLight | null>; hemi: React.RefObject<THREE.HemisphereLight | null>; dir: THREE.Vector3; refit: () => void }) {
  const { scene, invalidate, camera, controls } = useThree();
  // haze is measured from the camera's own distance to what it looks at: a close-up stays clear, the whole-town
  // aerial gets only a gentle depth haze at the far edge instead of a uniform veil
  const fogBase = useRef<[number, number]>([style.sky.fogNear, style.sky.fogFar]);
  useFrame(() => {
    if (!(scene.fog instanceof THREE.Fog)) return;
    const cc = controls as unknown as CameraControlsImpl | null;
    const d = cc && typeof cc.distance === "number" ? cc.distance : camera.position.length();
    scene.fog.near = fogBase.current[0] + d * 0.9;
    scene.fog.far = fogBase.current[1] + d * 1.8;
  }, -1);
  const c = useMemo(() => ({
    sun: [new THREE.Color(style.sun.color), new THREE.Color(style.dusk.sun), new THREE.Color(style.night.moon)],
    sky: [new THREE.Color(style.ambient.sky), new THREE.Color(style.dusk.sky), new THREE.Color(style.night.sky)],
    gnd: [new THREE.Color(style.ambient.ground), new THREE.Color(style.dusk.ground), new THREE.Color(style.night.ground)],
    fog: [new THREE.Color(style.sky.fog), new THREE.Color(style.dusk.fog), new THREE.Color(style.night.fog)],
    dirs: [sunDir(style.sun.azimuthDeg, style.sun.elevationDeg), sunDir(style.dusk.azimuthDeg, style.dusk.elevationDeg),
      // moonlight keeps a high direction so night shadows stay short and soft
      sunDir(style.sun.azimuthDeg - 40, 52)],
  }), [style]);
  // a page opened at sunset or night starts there (no fade on load)
  const t = useRef<number>(tod);
  useEffect(() => { invalidate(); }, [tod, invalidate]);
  const lerp3 = (a: number, b: number, d: number, s: number) => (s <= 1 ? THREE.MathUtils.lerp(a, b, s) : THREE.MathUtils.lerp(b, d, s - 1));
  const col3 = (out: THREE.Color, k: THREE.Color[], s: number) => (s <= 1 ? out.lerpColors(k[0], k[1], s) : out.lerpColors(k[1], k[2], s - 1));
  const apply = (s: number) => {
    SCENE.uNight.value = s <= 1 ? style.dusk.lights * s : THREE.MathUtils.lerp(style.dusk.lights, 1, s - 1);
    const l = light.current, h = hemi.current;
    if (l) {
      col3(l.color, c.sun, s);
      l.intensity = lerp3(style.sun.intensity, style.dusk.intensity, style.night.moonIntensity, s);
      if (s <= 1) dir.lerpVectors(c.dirs[0], c.dirs[1], s).normalize(); else dir.lerpVectors(c.dirs[1], c.dirs[2], s - 1).normalize();
    }
    if (h) { col3(h.color, c.sky, s); col3(h.groundColor, c.gnd, s); h.intensity = lerp3(style.ambient.intensity, style.dusk.ambient, style.night.ambient, s); }
    if (scene.background instanceof THREE.Color) col3(scene.background, c.fog, s);
    if (scene.fog instanceof THREE.Fog) {
      col3(scene.fog.color, c.fog, s);
      fogBase.current = [lerp3(style.sky.fogNear, style.dusk.fogNear, style.night.fogNear, s), lerp3(style.sky.fogFar, style.dusk.fogFar, style.night.fogFar, s)];
    }
  };
  // ease within each step (smoothstep on the fractional part) so day→sunset→night has no visible kinks
  const eased = (v: number) => { const i = Math.min(Math.floor(v), 1), f = v - i; return i + f * f * (3 - 2 * f); };
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    if (t.current === tod) return;
    t.current = tod > t.current ? Math.min(tod, t.current + dt / 2.0) : Math.max(tod, t.current - dt / 1.2);
    apply(eased(t.current));
    refit();
    invalidate();
  });
  useEffect(() => { apply(eased(t.current)); refit(); }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
