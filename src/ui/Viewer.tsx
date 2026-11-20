"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type CameraControlsImpl from "camera-controls";
import { loadArea, type AreaData } from "@/data/load";
import { PRESETS, type StyleConfig } from "@/style/presets";
import { Buildings, Landmarks, Minarets, Roads, StreetDetails, Streetlights, Terrain, Traffic, Trees, Water, type Quality } from "@/scene/World";
import { Controls, Effects, PlainRender, Sun, flyTo } from "@/scene/Rig";
import { Hud, type Chip } from "./Hud";
import { landmarkFocus } from "@/geo/landmarks";
import { T, type Lang } from "./i18n";
import { AdaptiveQuality, Bench, StatsProbe, bump, formatBench, type BenchResult } from "./perf";
import dynamic from "next/dynamic";
const Tune = dynamic(() => import("./Tune").then((m) => m.Tune), { ssr: false });

const DEG = Math.PI / 180;

function params() {
  if (typeof window === "undefined") return new URLSearchParams();
  const p = new URLSearchParams(window.location.search);
  // Hosts that only pass a plain #name (e.g. the preview link) can use #stats, #tune, #sample, #en, #low, #medium, #high.
  const h = window.location.hash.replace(/^#/, "");
  if (h === "stats" || h === "tune") p.set(h, "1");
  else if (h === "sample") p.set("area", "plav-sample");
  else if (h === "en") p.set("lang", "en");
  else if (h === "low" || h === "medium" || h === "high") p.set("q", h);
  else if (h === "bench") p.set("bench", "300");
  else if (h === "review") p.set("review", "1");
  else if (h === "night") p.set("night", "1");
  return p;
}

export default function Viewer() {
  bump("reactRenders");
  const q = useMemo(params, []);
  const off = useMemo(() => new Set((q.get("off") ?? "").split(",").filter(Boolean)), [q]);
  const statsEl = useRef<HTMLDivElement>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const benchFrames = Number(q.get("bench") ?? 0);
  const areaId = q.get("area") || "plav-centre";
  const [style, setStyle] = useState<StyleConfig>(PRESETS[q.get("style") || "warm"] ?? PRESETS.warm);
  const [data, setData] = useState<AreaData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const forcedQ = q.get("q") as Quality | null;
  const [quality, setQualityState] = useState<Quality>(forcedQ || initialTier());
  const [adaptive, setAdaptive] = useState(!forcedQ && !benchFrames);
  // a tier picked in the HUD is the user's choice: stop adapting
  const setQuality = useCallback((qq: Quality) => { setAdaptive(false); setQualityState(qq); }, []);
  const stepDown = useCallback(() => setQualityState((qq) => (qq === "high" ? "medium" : "low")), []);
  const [lang, setLang] = useState<Lang>((q.get("lang") as Lang) || "bs");
  const controls = useRef<CameraControlsImpl | null>(null);
  const northRef = useRef<SVGSVGElement>(null);
  const elevRef = useRef<HTMLSpanElement>(null);
  const hudRefs = useMemo(() => ({ north: northRef, elev: elevRef }), []);
  const showStats = q.has("stats");
  // landmarks whose position still needs confirmation are only shown with #review / ?review=1
  const review = q.has("review");
  const [night, setNight] = useState(q.has("night"));
  const [traffic, setTraffic] = useState(!off.has("traffic"));
  const carCount = !traffic || benchFrames > 0 && !q.has("cars") ? 0 : quality === "low" ? 0 : quality === "medium" ? 24 : 40;
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
    // Redžepagića kula: position confirmed by the project owner (OSM way 221505346); camera looks at the door face
    const kula = landmarkFocus(data, "Redžepagića kula", 25);
    if (kula) out.splice(1, 0, { label: "Redžepagića kula", x: kula.x, y: kula.y, distance: 80, azimuth: kula.azimuth, polar: 72, lift: 7 });
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
      flyTo(controls.current, data, style, cam[0], cam[1], { distance: cam[2], azimuthDeg: cam[3], polarDeg: cam[4], lift: cam[5] }, smooth);
      return;
    }
    flyTo(controls.current, data, style, h.x, h.y, { azimuthDeg: h.azimuth, distance: h.distance, polarDeg: h.polar }, smooth);
  }, [data, style, q]);

  const onControlsReady = useCallback(() => goHome(false), [goHome]);

  const dpr = dprFor(quality);
  const onZoom = useCallback((f: number) => { const c = controls.current; c?.dolly(f > 1 ? -c.distance * 0.35 : c.distance * 0.5, true); }, []);
  const onHome = useCallback(() => goHome(true), [goHome]);
  const onRotate = useCallback(() => { controls.current?.rotate(45 * DEG, 0, true); }, []);
  const onNorth = useCallback(() => { controls.current?.rotateAzimuthTo(0, true); }, []);
  const onChip = useCallback((c: Chip) => { if (controls.current && data) flyTo(controls.current, data, style, c.x, c.y, { distance: c.distance ?? 260, azimuthDeg: c.azimuth, polarDeg: c.polar, lift: c.lift }); }, [data, style]);
  const onFirst = useCallback((ms: number) => setFirstFrameMs(ms - t0.current), []);
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
          frameloop="demand"
          camera={{ fov: style.camera.fov, near: 5, far: 30000, position: [0, 400, 400] }}
          gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
          shadows
          onCreated={({ gl, scene }) => {
            gl.outputColorSpace = THREE.SRGBColorSpace;
            // synchronous getProgramInfoLog after every compile showed up as seconds of main-thread time
            gl.debug.checkShaderErrors = q.has("debug");
            scene.background = new THREE.Color(style.sky.fog);
            scene.fog = new THREE.Fog(style.sky.fog, style.sky.fogNear, style.sky.fogFar);
          }}
        >
          <SceneFog style={style} />
          <Suspense fallback={null}>
            {!off.has("terrain") && <Terrain data={data} style={style} quality={quality} />}
            {!off.has("water") && <Water data={data} style={style} />}
            {!off.has("roads") && <Roads data={data} style={style} />}
            {!off.has("roads") && !off.has("lights") && <Streetlights data={data} style={style} />}
            {!off.has("roads") && !off.has("street") && <StreetDetails data={data} style={style} />}
            {!off.has("roads") && carCount > 0 && <Traffic data={data} style={style} count={carCount} />}
            {!off.has("buildings") && <Buildings data={data} style={style} quality={quality} provisional={review} />}
            {!off.has("buildings") && <Minarets data={data} style={style} provisional={review} />}
            {!off.has("buildings") && !off.has("landmarks") && <Landmarks data={data} provisional={review} />}
            {!off.has("trees") && <Trees data={data} style={style} quality={quality} />}
          </Suspense>
          <Sun data={data} style={style} quality={quality} controls={controls} follow={!off.has("shadowfollow")} enabled={!off.has("shadows")} night={night} />
          <Controls data={data} controlsRef={controls} hud={hudRefs} onReady={onControlsReady} />
          {off.has("post") ? <PlainRender /> : <Effects style={style} quality={quality} ao={!off.has("ao")} tilt={!off.has("tilt")} />}
          {adaptive && <AdaptiveQuality tier={quality} onStepDown={stepDown} controls={controls} />}
          {showStats && <StatsProbe el={statsEl} tier={quality} />}
          {benchFrames > 0 && <Bench frames={benchFrames} data={data} controls={controls} tier={quality} onDone={setBench} />}
          <FirstFrame onFirst={onFirst} />
        </Canvas>
      )}
      {data && (
        <Hud
          data={data} lang={lang} setLang={setLang} quality={quality} setQuality={setQuality}
          northRef={northRef} elevRef={elevRef} chips={chips}
          night={night} setNight={setNight} traffic={traffic} setTraffic={setTraffic}
          onZoom={onZoom} onHome={onHome} onRotate={onRotate} onNorth={onNorth} onChip={onChip}
        />
      )}
      {showStats && <div className="stats" ref={statsEl} />}
      {bench && <div className="stats bench">{formatBench(bench)}{"\n"}first frame {firstFrameMs ? (firstFrameMs / 1000).toFixed(1) : "?"} s</div>}
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

/** Starting tier: phones start at medium (low with ≤4 GB RAM), desktops at high; AdaptiveQuality steps down from there. */
function initialTier(): Quality {
  if (typeof window === "undefined") return "medium";
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (!touch) return "high";
  return mem !== undefined && mem <= 4 ? "low" : "medium";
}

/** Device pixel ratio cap per tier (phones capped lower: fill rate is the limit there). */
function dprFor(q: Quality) {
  if (typeof window === "undefined") return 1;
  const forced = Number(new URLSearchParams(window.location.search).get("dpr"));
  if (forced > 0) return forced; // ?dpr=1.6 for like-for-like benchmarks
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const cap = q === "low" ? 1 : q === "medium" ? (touch ? 1.25 : 1.5) : touch ? 1.75 : 2;
  return Math.min(window.devicePixelRatio || 1, cap);
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
