"use client";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import CameraControlsImpl from "camera-controls";
import { EffectComposer, EffectPass, RenderPass, SMAAEffect, TiltShiftEffect, ToneMappingEffect, ToneMappingMode, KernelSize } from "postprocessing";
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
export function Sun({ data, style, quality, controls, follow = true, enabled = true, night = false }: { data: AreaData; style: StyleConfig; quality: Quality; controls: React.RefObject<CameraControlsImpl | null>; follow?: boolean; enabled?: boolean; night?: boolean }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const { gl, scene, invalidate } = useThree();
  const dir = useMemo(() => {
    const az = style.sun.azimuthDeg * DEG, el = style.sun.elevationDeg * DEG;
    // azimuth measured clockwise from north; scene north = -Z
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }, [style.sun.azimuthDeg, style.sun.elevationDeg]);
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
      <DayNight style={style} night={night} light={light} hemi={hemi} />
    </>
  );
}

/**
 * Post-processing per tier (all keep the tilt-shift miniature look):
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
    if (quality === "high") effects.push(new SMAAEffect());
    comp.addPass(new EffectPass(camera, ...effects));
    return comp;
  }, [gl, scene, camera, style.post, quality, ao, tilt]); // eslint-disable-line react-hooks/exhaustive-deps

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
    c.minDistance = 40;
    c.maxDistance = Math.max(halfW, halfH) * 3.2;
    c.minPolarAngle = 12 * DEG;
    c.maxPolarAngle = 72 * DEG;
    c.setBoundary(new THREE.Box3(new THREE.Vector3(-halfW, -200, -halfH), new THREE.Vector3(halfW, 800, halfH)));
    c.boundaryEnclosesCamera = false;
    onReady?.();
  }, [controlsRef, halfW, halfH, onReady]);

  const t = useMemo(() => new THREE.Vector3(), []);
  const last = useRef({ az: NaN, el: NaN });
  useFrame(() => {
    const c = controlsRef.current;
    if (!c) return;
    c.getTarget(t);
    const ground = data.core.at(t.x, -t.z) - data.datum;
    if (Math.abs(ground - t.y) > 0.5 && !c.active) c.setTarget(t.x, t.y + (ground - t.y) * 0.15, t.z, false);
    if (!hud) return;
    const az = Math.round((c.azimuthAngle * 180) / Math.PI), el = Math.round(ground + data.datum);
    const L = last.current;
    if (az !== L.az && hud.north.current) { hud.north.current.style.transform = `rotate(${az}deg)`; L.az = az; }
    if (el !== L.el && hud.elev.current) { hud.elev.current.textContent = String(el); L.el = el; }
  });

  return <CameraControls ref={controlsRef} makeDefault />;
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
 * Day/night blend: eases SCENE.uNight (read by every patched material: lit windows, road light pools,
 * lamps, car lights) and the sun/ambient/fog colours over ~1.6 s. Only renders frames while blending.
 */
function DayNight({ style, night, light, hemi }: { style: StyleConfig; night: boolean; light: React.RefObject<THREE.DirectionalLight | null>; hemi: React.RefObject<THREE.HemisphereLight | null> }) {
  const { scene, invalidate } = useThree();
  const c = useMemo(() => ({
    sunD: new THREE.Color(style.sun.color), sunN: new THREE.Color(style.night.moon),
    skyD: new THREE.Color(style.ambient.sky), skyN: new THREE.Color(style.night.sky),
    gndD: new THREE.Color(style.ambient.ground), gndN: new THREE.Color(style.night.ground),
    fogD: new THREE.Color(style.sky.fog), fogN: new THREE.Color(style.night.fog),
  }), [style]);
  // a page opened in night mode starts at night (no fade on load)
  const t = useRef(night ? 1 : SCENE.uNight.value);
  useEffect(() => { invalidate(); }, [night, invalidate]);
  const apply = (k: number) => {
    SCENE.uNight.value = k;
    const l = light.current, h = hemi.current;
    if (l) { l.color.lerpColors(c.sunD, c.sunN, k); l.intensity = THREE.MathUtils.lerp(style.sun.intensity, style.night.moonIntensity, k); }
    if (h) { h.color.lerpColors(c.skyD, c.skyN, k); h.groundColor.lerpColors(c.gndD, c.gndN, k); h.intensity = THREE.MathUtils.lerp(style.ambient.intensity, style.night.ambient, k); }
    if (scene.background instanceof THREE.Color) scene.background.lerpColors(c.fogD, c.fogN, k);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.lerpColors(c.fogD, c.fogN, k);
      scene.fog.near = THREE.MathUtils.lerp(style.sky.fogNear, style.night.fogNear, k);
      scene.fog.far = THREE.MathUtils.lerp(style.sky.fogFar, style.night.fogFar, k);
    }
  };
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const target = night ? 1 : 0;
    if (t.current === target) return;
    t.current = target > t.current ? Math.min(target, t.current + dt / 1.6) : Math.max(target, t.current - dt / 1.6);
    const k = t.current * t.current * (3 - 2 * t.current); // smoothstep easing
    apply(k);
    invalidate();
  });
  useEffect(() => { apply(t.current * t.current * (3 - 2 * t.current)); }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
