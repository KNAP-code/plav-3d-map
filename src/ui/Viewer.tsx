"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import type CameraControlsImpl from "camera-controls";
import { loadArea, type AreaData } from "@/data/load";
import { PRESETS, type StyleConfig } from "@/style/presets";
import { Buildings, Minarets, Roads, Terrain, Trees, Water, type Quality } from "@/scene/World";
import { Controls, Effects, Sun, flyTo } from "@/scene/Rig";
import { Hud, type Chip } from "./Hud";
import { T, type Lang } from "./i18n";
import dynamic from "next/dynamic";
const Tune = dynamic(() => import("./Tune").then((m) => m.Tune), { ssr: false });

const DEG = Math.PI / 180;

function params() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export type PerfSample = { fps: number; ms: number; calls: number; tris: number; dpr: number; quality: Quality; renderer: string };

function Perf({ onSample }: { onSample: (s: PerfSample) => void }) {
  const { gl } = useThree();
  const acc = useRef({ frames: 0, t0: performance.now(), calls: 0, tris: 0 });
  const renderer = useMemo(() => {
    const ctx = gl.getContext();
    const ext = ctx.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  }, [gl]);
  useEffect(() => { gl.info.autoReset = false; }, [gl]);
  useFrame(() => gl.info.reset(), -10);
  useFrame(() => {
    const a = acc.current;
    a.frames++;
    a.calls = gl.info.render.calls;
    a.tris = gl.info.render.triangles;
    const now = performance.now();
    if (now - a.t0 > 1000) {
      const fps = (a.frames * 1000) / (now - a.t0);
      onSample({ fps, ms: 1000 / fps, calls: a.calls, tris: a.tris, dpr: gl.getPixelRatio(), quality: "high", renderer });
      a.frames = 0; a.t0 = now;
    }
  }, 2);
  return null;
}

export default function Viewer() {
  const q = useMemo(params, []);
  const areaId = q.get("area") || "plav-centre";
  const [style, setStyle] = useState<StyleConfig>(PRESETS[q.get("style") || "warm"] ?? PRESETS.warm);
  const [data, setData] = useState<AreaData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const initialQ: Quality = (q.get("q") as Quality) || (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? "medium" : "high");
  const [quality, setQuality] = useState<Quality>(initialQ);
  const [lang, setLang] = useState<Lang>((q.get("lang") as Lang) || "bs");
  const [view, setView] = useState({ azimuth: 0, elevation: 0 });
  const [perf, setPerf] = useState<PerfSample | null>(null);
  const controls = useRef<CameraControlsImpl | null>(null);
  const showStats = q.has("stats");
  const t0 = useRef(performance.now());
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null);

  useEffect(() => {
    loadArea(`./data/${areaId}`, setProgress).then(setData).catch((e) => setError(String(e)));
  }, [areaId]);

  const chips: Chip[] = useMemo(() => {
    if (!data) return [];
    const L = T[lang];
    const out: Chip[] = [{ label: L.centre, x: home(data).x, y: home(data).y }];
    const lake = data.water.find((w) => w.kind === "lake" && w.name && /plav/i.test(w.name));
    if (lake) {
      const { halfW, halfH } = data.meta.extent;
      const pts = lake.outer.filter(([x, y]) => Math.abs(x) < halfW && Math.abs(y) < halfH);
      if (pts.length) {
        const x = pts.reduce((s, p) => s + p[0], 0) / pts.length, y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        out.push({ label: L.lake, x, y, distance: 650, azimuth: 95 });
      }
    }
    const seen = new Set<string>();
    for (const m of data.meta.landmarks) {
      if (seen.has(m.name) || out.length > 8) continue;
      if (!/džamija|Opština|Dom kulture|Pijaca|Sultanija|Pošta|sud/i.test(m.name)) continue;
      seen.add(m.name);
      out.push({ label: m.name, x: m.x, y: m.y, distance: 220 });
    }
    return out;
  }, [data, lang]);

  const goHome = useCallback((smooth = true) => {
    if (!controls.current || !data) return;
    const h = home(data);
    // ?cam=x,y,distance,azimuthDeg,polarDeg (local metres) — handy for reproducible screenshots
    const cam = q.get("cam")?.split(",").map(Number);
    if (cam && cam.length >= 2) {
      flyTo(controls.current, data, style, cam[0], cam[1], { distance: cam[2], azimuthDeg: cam[3], polarDeg: cam[4] }, smooth);
      return;
    }
    flyTo(controls.current, data, style, h.x, h.y, { azimuthDeg: h.azimuth, distance: h.distance, polarDeg: h.polar }, smooth);
  }, [data, style, q]);

  const onControlsReady = useCallback(() => goHome(false), [goHome]);

  const onPerf = useCallback((s: PerfSample) => {
    const v = { ...s, quality };
    setPerf(v);
    (window as unknown as { __plavPerf?: PerfSample[] }).__plavPerf = [...((window as unknown as { __plavPerf?: PerfSample[] }).__plavPerf ?? []), v].slice(-120);
  }, [quality]);

  const dpr: [number, number] = quality === "high" ? [1, 2] : quality === "medium" ? [1, 1.6] : [1, 1.2];
  const L = T[lang];

  return (
    <div className="stage">
      {error && <div className="loading">Error: {error}</div>}
      {!data && !error && (
        <div className="loading">
          <div className="loading-title">Plav</div>
          <div>{L.loading}</div>
          <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        </div>
      )}
      {data && (
        <Canvas
          dpr={dpr}
          camera={{ fov: style.camera.fov, near: 5, far: 30000, position: [0, 400, 400] }}
          gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
          shadows
          onCreated={({ gl, scene }) => {
            gl.outputColorSpace = THREE.SRGBColorSpace;
            scene.background = new THREE.Color(style.sky.fog);
            scene.fog = new THREE.Fog(style.sky.fog, style.sky.fogNear, style.sky.fogFar);
          }}
        >
          <PerformanceMonitor
            onDecline={() => setQuality((qq) => (q.get("q") ? qq : qq === "high" ? "medium" : "low"))}
            flipflops={2}
          />
          <SceneFog style={style} />
          <Suspense fallback={null}>
            <Terrain data={data} style={style} />
            <Water data={data} style={style} />
            <Roads data={data} style={style} />
            <Buildings data={data} style={style} />
            <Minarets data={data} style={style} />
            <Trees data={data} style={style} quality={quality} />
          </Suspense>
          <Sun style={style} quality={quality} controls={controls} />
          <Controls data={data} style={style} controlsRef={controls} onReady={onControlsReady} onChange={(v) => setViewThrottled(v, setView)} />
          <Effects style={quality === "low" ? { ...style, post: { ...style.post, ao: false, tiltShift: false } } : style} quality={quality} />
          {showStats && <Perf onSample={onPerf} />}
          <FirstFrame onFirst={(ms) => setFirstFrameMs(ms - t0.current)} />
        </Canvas>
      )}
      {data && (
        <Hud
          data={data} lang={lang} setLang={setLang} quality={quality} setQuality={setQuality}
          view={view} chips={chips}
          onZoom={(f) => controls.current?.dolly(f > 1 ? -controls.current.distance * 0.35 : controls.current.distance * 0.5, true)}
          onHome={() => goHome(true)}
          onRotate={() => controls.current?.rotate(45 * DEG, 0, true)}
          onNorth={() => controls.current?.rotateAzimuthTo(0, true)}
          onChip={(c) => controls.current && flyTo(controls.current, data, style, c.x, c.y, { distance: c.distance ?? 260, azimuthDeg: c.azimuth })}
        />
      )}
      {showStats && perf && (
        <div className="stats">
          <div>{perf.fps.toFixed(0)} fps · {perf.ms.toFixed(1)} ms</div>
          <div>{perf.calls} draw calls · {(perf.tris / 1000).toFixed(0)}k tris</div>
          <div>q={quality} · dpr {perf.dpr.toFixed(2)}</div>
          <div>first frame {firstFrameMs ? (firstFrameMs / 1000).toFixed(1) + " s" : "…"} · data {data ? (data.bytes / 1e6).toFixed(1) : "?"} MB</div>
          <div className="gpu">{perf.renderer}</div>
        </div>
      )}
      {q.has("tune") && <Tune style={style} setStyle={setStyle} />}
    </div>
  );
}

/** Records when the first frame with the full scene has been rendered (for perf measurements). */
function FirstFrame({ onFirst }: { onFirst: (ms: number) => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    const ms = performance.now();
    (window as unknown as { __plavFirstFrame?: number }).__plavFirstFrame = ms;
    onFirst(ms);
  }, 3);
  return null;
}

function SceneFog({ style }: { style: StyleConfig }) {
  const { scene } = useThree();
  useEffect(() => {
    scene.background = new THREE.Color(style.sky.fog);
    scene.fog = new THREE.Fog(style.sky.fog, style.sky.fogNear, style.sky.fogFar);
  }, [scene, style.sky]);
  return null;
}

let lastView = 0;
function setViewThrottled(v: { azimuth: number; elevation: number }, set: (v: { azimuth: number; elevation: number }) => void) {
  const now = performance.now();
  if (now - lastView < 120) return;
  lastView = now;
  set({ azimuth: v.azimuth, elevation: v.elevation });
}

/** Default view: the old mosque in the čaršija if present, otherwise the area centre. */
function home(d: AreaData) {
  const lm = d.meta.landmarks.find((l) => /stara džamija/i.test(l.name));
  const small = d.meta.extent.halfW < 400;
  const portrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
  if (small) return { x: lm?.x ?? 0, y: lm?.y ?? 0, azimuth: 70, distance: 330, polar: 42 };
  // Landing view: čaršija in front, the lake shore and the far bank behind it (looking west).
  return { x: (lm?.x ?? 0) - 140, y: (lm?.y ?? 0) + 60, azimuth: 78, distance: portrait ? 1050 : 820, polar: 52 };
}
