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
import type { Quality } from "./World";

const DEG = Math.PI / 180;

/** Sun with a shadow frustum that follows the camera target (shadows re-render only when the view changes). */
export function Sun({ style, quality, controls }: { style: StyleConfig; quality: Quality; controls: React.RefObject<CameraControlsImpl | null> }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const { gl, scene } = useThree();
  const last = useRef({ x: NaN, z: NaN, d: NaN });
  const dir = useMemo(() => {
    const az = style.sun.azimuthDeg * DEG, el = style.sun.elevationDeg * DEG;
    // azimuth measured clockwise from north; scene north = -Z
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }, [style.sun.azimuthDeg, style.sun.elevationDeg]);
  const size = quality === "high" ? 4096 : quality === "medium" ? 2048 : 1024;

  useEffect(() => {
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
  }, [gl]);

  useEffect(() => {
    const l = light.current;
    if (!l) return;
    scene.add(l.target);
    l.shadow.map?.dispose();
    (l.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
    l.shadow.mapSize.set(size, size);
    last.current.d = NaN;
    return () => { scene.remove(l.target); };
  }, [scene, size]);

  useFrame(() => {
    const l = light.current, c = controls.current;
    if (!l || !c) return;
    const t = c.getTarget(new THREE.Vector3());
    const dist = c.distance;
    const L = last.current;
    if (Math.abs(t.x - L.x) < 8 && Math.abs(t.z - L.z) < 8 && Math.abs(dist - L.d) / (L.d || 1) < 0.08) return;
    L.x = t.x; L.z = t.z; L.d = dist;
    const half = THREE.MathUtils.clamp(dist * 0.95, 110, 1500);
    l.position.copy(t).addScaledVector(dir, 2500);
    l.target.position.copy(t);
    l.target.updateMatrixWorld();
    const cam = l.shadow.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 1500; cam.far = 3600;
    cam.updateProjectionMatrix();
    l.shadow.radius = style.sun.shadowSoftness;
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = Math.max(0.25, half / size * 1.5);
    gl.shadowMap.needsUpdate = true;
  });

  return (
    <>
      <directionalLight ref={light} color={style.sun.color} intensity={style.sun.intensity} castShadow />
      <hemisphereLight args={[style.ambient.sky, style.ambient.ground, style.ambient.intensity]} />
    </>
  );
}

/** Post-processing: N8AO ambient occlusion, tilt-shift blur, SMAA, neutral tone mapping. */
export function Effects({ style, quality }: { style: StyleConfig; quality: Quality }) {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    const comp = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType });
    comp.addPass(new RenderPass(scene, camera));
    if (style.post.ao) {
      const ao = new N8AOPostPass(scene, camera, size.width, size.height);
      ao.configuration.aoRadius = style.post.aoRadius;
      ao.configuration.distanceFalloff = 1.0;
      ao.configuration.intensity = style.post.aoIntensity;
      ao.configuration.gammaCorrection = false;
      ao.configuration.halfRes = quality !== "high";
      ao.setQualityMode(quality === "high" ? "Medium" : "Performance");
      comp.addPass(ao);
    }
    const effects = [];
    if (style.post.tiltShift)
      effects.push(new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: style.post.tiltFocus, feather: style.post.tiltFeather, kernelSize: quality === "high" ? KernelSize.MEDIUM : KernelSize.SMALL, resolutionScale: 0.5 }));
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }));
    effects.push(new SMAAEffect());
    comp.addPass(new EffectPass(camera, ...effects));
    return comp;
  }, [gl, scene, camera, style.post, quality]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const prev = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping;
    return () => { gl.toneMapping = prev; composer.dispose(); };
  }, [gl, composer]);
  useEffect(() => composer.setSize(size.width, size.height), [composer, size]);
  useFrame((_, dt) => composer.render(dt), 1);
  return null;
}

export type Rig = {
  flyTo: (x: number, y: number, opts?: { distance?: number; polarDeg?: number; azimuthDeg?: number }) => void;
};

/** Map-style camera: one finger pans on the ground, two fingers pinch/rotate, three tilt. */
export function Controls({ data, style, controlsRef, onChange, onReady }: {
  data: AreaData; style: StyleConfig; controlsRef: React.RefObject<CameraControlsImpl | null>;
  onReady?: () => void;
  onChange?: (info: { azimuth: number; polar: number; elevation: number; distance: number }) => void;
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
    c.smoothTime = 0.35;
    c.draggingSmoothTime = 0.12;
    c.minDistance = 70;
    c.maxDistance = Math.max(halfW, halfH) * 3.2;
    c.minPolarAngle = 12 * DEG;
    c.maxPolarAngle = 66 * DEG;
    c.setBoundary(new THREE.Box3(new THREE.Vector3(-halfW, -200, -halfH), new THREE.Vector3(halfW, 800, halfH)));
    c.boundaryEnclosesCamera = false;
    onReady?.();
  }, [controlsRef, halfW, halfH, onReady]);

  useFrame(() => {
    const c = controlsRef.current;
    if (!c) return;
    const t = c.getTarget(new THREE.Vector3());
    const ground = data.core.at(t.x, -t.z) - data.datum;
    if (Math.abs(ground - t.y) > 0.5 && !c.active) c.setTarget(t.x, t.y + (ground - t.y) * 0.15, t.z, false);
    onChange?.({ azimuth: c.azimuthAngle, polar: c.polarAngle, elevation: ground + data.datum, distance: c.distance });
  });

  return <CameraControls ref={controlsRef} makeDefault />;
}

export function flyTo(c: CameraControlsImpl, data: AreaData, style: StyleConfig, x: number, y: number, opts: { distance?: number; polarDeg?: number; azimuthDeg?: number } = {}, smooth = true) {
  const h = data.core.at(x, y) - data.datum;
  const az = (opts.azimuthDeg ?? style.camera.startAzimuthDeg) * DEG;
  const pol = (opts.polarDeg ?? style.camera.startPolarDeg) * DEG;
  const d = opts.distance ?? style.camera.startDistance;
  const tx = x, ty = h, tz = -y;
  const px = tx + d * Math.sin(pol) * Math.sin(az);
  const py = ty + d * Math.cos(pol);
  const pz = tz + d * Math.sin(pol) * Math.cos(az);
  return c.setLookAt(px, py, pz, tx, ty, tz, smooth);
}
