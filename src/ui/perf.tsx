"use client";
/**
 * Profiling tools: #stats overlay (written straight to the DOM, no React state per frame),
 * #bench (deterministic camera flight that reports frame-time percentiles), subsystem toggles
 * (?off=ao,tilt,post,shadows,trees,...) and counters for React renders and shadow-map updates.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type CameraControlsImpl from "camera-controls";
import type { AreaData } from "@/data/load";

export const counters = { reactRenders: 0, shadowUpdates: 0, geometryBuilds: 0 };
export const bump = (k: keyof typeof counters) => { counters[k]++; };

type Win = Window & { __plavBench?: BenchResult; __plavPerf?: unknown[]; __plavFirstFrame?: number; __plavCounters?: typeof counters };
const win = () => window as unknown as Win;

export type BenchResult = {
  frames: number; avgFps: number; p50: number; p95: number; p99: number; worst: number;
  jsP50: number; jsP95: number; calls: number; tris: number; dpr: number; px: string;
  shadowUpdates: number; reactRenders: number; tier: string; renderer: string;
};

function pct(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

export function gpuName(gl: THREE.WebGLRenderer) {
  const ctx = gl.getContext();
  const ext = ctx.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
}

/** Rough GPU memory estimate: geometry buffers + render targets + shadow map. */
export function gpuMemoryMB(scene: THREE.Scene, gl: THREE.WebGLRenderer) {
  let bytes = 0;
  const seen = new Set<THREE.BufferGeometry>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !seen.has(m.geometry)) {
      seen.add(m.geometry);
      for (const a of Object.values(m.geometry.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
      if (m.geometry.index) bytes += m.geometry.index.array.byteLength;
    }
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh) bytes += im.instanceMatrix.array.byteLength + (im.instanceColor?.array.byteLength ?? 0);
    const l = o as THREE.DirectionalLight;
    if (l.isDirectionalLight && l.castShadow) bytes += l.shadow.mapSize.x * l.shadow.mapSize.y * 4;
  });
  const s = gl.getDrawingBufferSize(new THREE.Vector2());
  bytes += s.x * s.y * 4 * 2; // default framebuffer colour + depth
  return bytes / 1e6;
}

/** Frame timing: total frame interval and main-thread time spent inside the render loop. */
export function useFrameTimes() {
  const ref = useRef({ t: 0, start: 0, frames: [] as number[], js: [] as number[] });
  useFrame(() => {
    const r = ref.current;
    const now = performance.now();
    if (r.t) r.frames.push(now - r.t);
    r.t = now;
    r.start = now;
  }, -100);
  useFrame(() => {
    const r = ref.current;
    r.js.push(performance.now() - r.start);
    if (r.frames.length > 600) { r.frames.splice(0, 300); r.js.splice(0, 300); }
  }, 100);
  return ref;
}

/** Stats overlay. Updates a DOM node twice a second; never touches React state. */
export function StatsProbe({ el, tier }: { el: React.RefObject<HTMLDivElement | null>; tier: string }) {
  const { gl, scene } = useThree();
  const times = useFrameTimes();
  const renderer = useMemo(() => gpuName(gl), [gl]);
  const last = useRef(performance.now());
  const frames = useRef(0);
  useEffect(() => {
    gl.info.autoReset = false;
    win().__plavCounters = counters;
  }, [gl]);
  useFrame(() => gl.info.reset(), -101);
  useFrame(() => {
    frames.current++;
    const now = performance.now();
    if (now - last.current < 500 || !el.current) return;
    const dt = now - last.current;
    const f = times.current.frames.slice(-frames.current);
    const js = times.current.js.slice(-frames.current);
    // with on-demand rendering the canvas is idle when nothing moves, so fps comes from frame intervals
    const moving = f.filter((x) => x < 250);
    const fps = moving.length ? 1000 / Math.max(pct(moving, 50), 1e-3) : 0;
    void dt;
    frames.current = 0;
    last.current = now;
    const s = gl.getDrawingBufferSize(new THREE.Vector2());
    const sample = {
      fps, p95: pct(f, 95), js: pct(js, 50), calls: gl.info.render.calls, tris: gl.info.render.triangles,
      dpr: gl.getPixelRatio(), px: `${s.x}×${s.y}`, mem: gpuMemoryMB(scene, gl), tier, renderer,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0,
      ...counters,
    };
    const w = win();
    w.__plavPerf = [...(w.__plavPerf ?? []), sample].slice(-120);
    el.current.textContent =
      (fps ? `${fps.toFixed(0)} fps (while moving)` : "idle (nothing to redraw)") + ` · p95 ${sample.p95.toFixed(1)} ms · js ${sample.js.toFixed(1)} ms\n` +
      `${sample.calls} calls · ${(sample.tris / 1000).toFixed(0)}k tris · ${sample.programs} programs\n` +
      `${sample.px} @ dpr ${sample.dpr.toFixed(2)} · tier ${tier}\n` +
      `~${sample.mem.toFixed(0)} MB GPU buffers · ${sample.geometries} geo · ${sample.textures} tex\n` +
      `renders ${counters.reactRenders} · shadow updates ${counters.shadowUpdates}\n` +
      renderer;
  }, 101);
  return null;
}

/**
 * Deterministic benchmark: drives the camera along a fixed pan / orbit / zoom path for N frames
 * (independent of time, so slow and fast devices see the same views) and reports percentiles.
 */
export function Bench({ frames, data, controls, tier, onDone }: {
  frames: number; data: AreaData; controls: React.RefObject<CameraControlsImpl | null>; tier: string;
  onDone: (r: BenchResult) => void;
}) {
  const { gl, invalidate } = useThree();
  const times = useFrameTimes();
  const i = useRef(-30); // 30 warm-up frames
  const done = useRef(false);
  const calls = useRef(0), tris = useRef(0);
  const c0 = useRef({ ...counters });
  useEffect(() => { gl.info.autoReset = false; }, [gl]);
  useFrame(() => gl.info.reset(), -101);
  useFrame(() => {
    const c = controls.current;
    if (!c || done.current) return;
    const k = i.current++;
    if (k === 0) { times.current.frames.length = 0; times.current.js.length = 0; c0.current = { ...counters }; }
    const t = Math.max(k, 0) / frames;
    const { halfW, halfH } = data.meta.extent;
    // pan diagonally across the town, orbit 200°, zoom between 250 m and 1100 m
    const tx = -halfW * 0.45 + t * halfW * 0.9, ty = -halfH * 0.35 + t * halfH * 0.6;
    const az = (60 + t * 200) * (Math.PI / 180);
    const pol = (40 + 12 * Math.sin(t * Math.PI * 2)) * (Math.PI / 180);
    const d = 675 + 425 * Math.cos(t * Math.PI * 3);
    const h = data.core.at(tx, ty) - data.datum;
    c.setLookAt(tx + d * Math.sin(pol) * Math.sin(az), h + d * Math.cos(pol), -ty + d * Math.sin(pol) * Math.cos(az), tx, h, -ty, false);
    if (k >= frames) {
      done.current = true;
      const f = times.current.frames, js = times.current.js;
      const s = gl.getDrawingBufferSize(new THREE.Vector2());
      const r: BenchResult = {
        frames: f.length, avgFps: 1000 / (f.reduce((a, b) => a + b, 0) / f.length),
        p50: pct(f, 50), p95: pct(f, 95), p99: pct(f, 99), worst: Math.max(...f),
        jsP50: pct(js, 50), jsP95: pct(js, 95),
        calls: Math.round(calls.current / frames), tris: Math.round(tris.current / frames),
        dpr: gl.getPixelRatio(), px: `${s.x}×${s.y}`,
        shadowUpdates: counters.shadowUpdates - c0.current.shadowUpdates,
        reactRenders: counters.reactRenders - c0.current.reactRenders,
        tier, renderer: gpuName(gl),
      };
      win().__plavBench = r;
      onDone(r);
    }
    invalidate();
  }, -50);
  // read renderer counters after every pass of this frame has been drawn
  useFrame(() => {
    if (i.current > 0 && !done.current) { calls.current += gl.info.render.calls; tris.current += gl.info.render.triangles; }
  }, 200);
  return null;
}

export function formatBench(r: BenchResult) {
  return `BENCH ${r.frames} frames · tier ${r.tier}\n` +
    `avg ${r.avgFps.toFixed(1)} fps · p50 ${r.p50.toFixed(1)} ms · p95 ${r.p95.toFixed(1)} ms · worst ${r.worst.toFixed(0)} ms\n` +
    `js p50 ${r.jsP50.toFixed(1)} ms · p95 ${r.jsP95.toFixed(1)} ms\n` +
    `${r.calls} calls · ${(r.tris / 1000).toFixed(0)}k tris · ${r.px} @ ${r.dpr.toFixed(2)}\n` +
    `shadow updates ${r.shadowUpdates} · React renders ${r.reactRenders}\n${r.renderer}`;
}

/**
 * Adaptive quality: watches frame intervals while the view is moving (idle gaps ignored) and steps
 * the tier down when the median stays too slow. Never steps up on its own (avoids flip-flopping and
 * repeated shader compiles); the user can still pick a tier from the HUD.
 */
export function AdaptiveQuality({ tier, onStepDown }: { tier: string; onStepDown: () => void }) {
  const st = useRef({ t: 0, buf: new Float32Array(90), n: 0, skip: 60 });
  useEffect(() => { st.current.n = 0; st.current.skip = 60; st.current.t = 0; }, [tier]); // ignore frames right after a switch (shader compiles)
  useFrame(() => {
    const s = st.current, now = performance.now();
    const dt = s.t ? now - s.t : 0;
    s.t = now;
    if (!dt || dt > 250) return; // first frame after idle
    if (s.skip > 0) { s.skip--; return; }
    s.buf[s.n++] = dt;
    if (s.n < s.buf.length) return;
    s.n = 0;
    const med = pct(Array.from(s.buf), 50);
    const limit = tier === "high" ? 22 : tier === "medium" ? 36 : Infinity;
    if (med > limit) onStepDown();
  }, -99);
  return null;
}
