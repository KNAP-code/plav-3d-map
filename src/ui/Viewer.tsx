"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type CameraControlsImpl from "camera-controls";
import { loadArea, type AreaData, type Building } from "@/data/load";
import { PRESETS, type StyleConfig } from "@/style/presets";
import { AUDIT_COLORS, AuditLayer, Buildings, needsReview, type AuditEntry, Landmarks, Minarets, Roads, StreetDetails, Streetlights, Terrain, Traffic, Trees, Water, type Quality } from "@/scene/World";
import { Controls, Effects, PlainRender, Sun, flyTo } from "@/scene/Rig";
import { Hud, type Chip } from "./Hud";
import { LANDMARKS, landmarkFocus } from "@/geo/landmarks";
import { T, type Lang } from "./i18n";
import { AdaptiveQuality, Bench, StatsProbe, bump, formatBench, type BenchResult } from "./perf";
import dynamic from "next/dynamic";
const Tune = dynamic(() => import("./Tune").then((m) => m.Tune), { ssr: false });

const DEG = Math.PI / 180;

function params() {
  if (typeof window === "undefined") return new URLSearchParams();
  const p = new URLSearchParams(window.location.search);
  // Hosts that only pass a plain #name (e.g. the preview link) can use #stats, #tune, #sample, #en, #low, #medium, #high.
  // several flags can be combined: #audit,osm or #night&high
  for (const h of window.location.hash.replace(/^#/, "").split(/[,&+]/).filter(Boolean)) {
    if (h === "stats" || h === "tune" || h === "audit" || h === "osm") p.set(h, "1");
    else if (h === "sample") p.set("area", "plav-sample");
    else if (h === "en") p.set("lang", "en");
    else if (h === "low" || h === "medium" || h === "high") p.set("q", h);
    else if (h === "bench") p.set("bench", "300");
    else if (h === "review") p.set("review", "1");
    else if (h === "night") p.set("night", "1");
  }
  return p;
}

type AuditInfo = { summary: Record<string, any>; gaps: { x: number; y: number; lat: number; lon: number }[]; map: Map<string, AuditEntry> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const FLAG_TEXT: Record<string, string> = {
  overlap: "overlaps another footprint", odd_shape: "irregular or very elongated outline", large_ml: "large ML footprint (may merge several buildings)",
  isolated_ml: "ML footprint with no built-up land cover within 25 m", skewed_to_street: "rotated against the nearest street",
  on_street: "overlaps a mapped street", duplicate: "duplicate footprint", duplicate_ml_of_osm: "ML copy of an OSM building",
};
const STATUS_TEXT: Record<string, string> = { osm_mapped: "OpenStreetMap (human-mapped)", ml_unverified: "Microsoft ML detection: unverified", landmark_verified: "landmark: position verified" };

/** Developer audit panel: legend and counts from public/data/<area>/audit.json (pipeline/audit_buildings.py). */
function AuditPanel({ info, osmOnly, shown, picked, onNext }: { info: AuditInfo | null; osmOnly: boolean; shown: number; picked: Building | null; onNext: () => void }) {
  const s = info?.summary;
  const e = picked ? info?.map.get(picked.id) : undefined;
  const row = (c: string, t: string) => <div><span style={{ display: "inline-block", width: 12, height: 12, background: c, marginRight: 6, borderRadius: 2, verticalAlign: -1 }} />{t}</div>;
  return (
    <div className="stats" style={{ top: 96, left: 12, right: "auto", maxWidth: 330, maxHeight: "calc(100% - 200px)", overflowY: "auto", pointerEvents: "auto", whiteSpace: "normal", lineHeight: 1.45 }}>
      <b>Geographic audit</b> {osmOnly ? "(OSM only)" : ""}<br />
      {s ? <>
        Overture {s.release}: {s.raw_in_area} source footprints ({s.raw_by_source.osm} OSM, {s.raw_by_source.ms} Microsoft ML)<br />
        Shown: {shown} · removed {s.not_shown_raw} ({Object.entries(s.removed_by_reason ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")})<br />
        Duplicates shown: {s.duplicates_shown} · invented: {s.procedural_invented}<br />
        Height from source: {s.height_from_source} · position check max {s.position_check_m?.max} m<br />
        Coverage of WorldCover built-up 50 m cells: {s.coverage?.pct}% ({s.coverage?.osm_only_pct}% with OSM alone), {s.coverage?.gap_cells} gap cells<br />
        <b>To review: {s.review_shown}</b> ({Object.entries(s.flags_shown ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")})<br />
        <button onClick={onNext} style={{ marginTop: 4, pointerEvents: "auto" }}>Next building to review →</button>
      </> : "loading audit.json…"}
      {picked && (
        <div style={{ marginTop: 6, padding: 6, background: "rgba(255,255,255,0.08)", borderRadius: 4 }}>
          <b>{picked.name ?? "Building"}</b> · {STATUS_TEXT[e?.status ?? ""] ?? picked.src}<br />
          {e?.area ?? "?"} m² · {picked.floors} floor(s), height {picked.hSrc === "estimated" ? "estimated" : "from source"} · roof estimated<br />
          {e?.flags.length ? e.flags.map((f) => <div key={f}>⚠ {FLAG_TEXT[f] ?? f}</div>) : <div>no automatic flags</div>}
          {e?.osm && <a href={`https://www.openstreetmap.org/way/${e.osm.replace(/^w/, "").replace(/@.*/, "")}`} target="_blank" rel="noreferrer" style={{ color: "#9cd3ff", pointerEvents: "auto" }}>open in OpenStreetMap</a>}
          <div style={{ opacity: 0.6, fontSize: 11 }}>id {picked.id}</div>
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {row(AUDIT_COLORS.review, "flagged for manual review (tap for details)")}
        {row(AUDIT_COLORS.osm, "OpenStreetMap footprint")}
        {row(AUDIT_COLORS.ms, "Microsoft ML footprint")}
        {row(AUDIT_COLORS.outbuilding, "ML footprint < 30 m², shown as outbuilding")}
        {row(AUDIT_COLORS.osmOnStreet, "OSM footprint overlapping a street (review)")}
        {row(AUDIT_COLORS.heightSrc, "height from source data")}
        {row(AUDIT_COLORS.removed, "removed: tiny ML / ML on street")}
        {row(AUDIT_COLORS.gap, "built-up land with no footprint")}
        <div style={{ opacity: 0.75, marginTop: 4 }}>Landmarks keep their own models. All heights and roofs not marked purple are estimates.</div>
      </div>
    </div>
  );
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

  // #osm: only human-mapped OpenStreetMap footprints (Microsoft ML detections hidden); #audit: geographic audit view
  const osmOnly = q.has("osm"), audit = q.has("audit");
  const [auditInfo, setAuditInfo] = useState<AuditInfo | null>(null);
  const [picked, setPicked] = useState<Building | null>(null);
  const reviewIdx = useRef(-1);
  useEffect(() => {
    loadArea(`./data/${areaId}`, setProgress)
      .then((d) => setData(osmOnly ? { ...d, buildings: d.buildings.filter((b) => b.src === "osm") } : d))
      .catch((e) => setError(String(e)));
    if (audit) fetch(`./data/${areaId}/audit.json`).then((r) => r.json()).then((a) => setAuditInfo({ summary: a.summary, gaps: a.gaps ?? [],
      map: new Map((a.buildings as { id: string; shown: boolean; flags: string[]; status: string; osmRecord: string | null; area: number }[]).filter((b) => b.shown).map((b) => [b.id, { flags: b.flags, status: b.status, osm: b.osmRecord, area: b.area }])) })).catch(() => {});
  }, [areaId, osmOnly, audit]);

  // fly to the next building flagged for manual review (audit mode)
  const nextReview = useCallback(() => {
    if (!data || !auditInfo || !controls.current) return;
    const list = data.buildings.filter((b) => needsReview(auditInfo.map.get(b.id)));
    if (!list.length) return;
    reviewIdx.current = (reviewIdx.current + 1) % list.length;
    const b = list[reviewIdx.current];
    setPicked(b);
    flyTo(controls.current, data, style, b.obb[0], b.obb[1], { distance: 90, polarDeg: 55 });
  }, [data, auditInfo, style]);

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
    // modelled landmarks: camera looks at the entrance side
    const seen = new Set<string>();
    const models = Object.values(LANDMARKS).filter((d) => d.chip && !d.provisional);
    for (const def of models) {
      const f = landmarkFocus(data, def.name, 30);
      if (f) { out.push({ label: def.chip!.label, x: f.x, y: f.y, distance: 85, azimuth: f.azimuth, polar: 66, lift: 6 }); seen.add(def.chip!.label); }
    }
    for (const m of data.meta.landmarks) {
      if (models.some((d) => d.chip!.match.test(m.name))) continue;
      if (seen.has(m.name) || out.length > 9) continue;
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
            {!off.has("buildings") && <Buildings data={data} style={style} quality={quality} provisional={review} audit={audit && !!auditInfo} auditMap={auditInfo?.map} onPick={audit ? setPicked : undefined} />}
            {audit && auditInfo && <AuditLayer data={data} gaps={auditInfo.gaps} />}
            {!off.has("buildings") && <Minarets data={data} style={style} provisional={review} />}
            {!off.has("landmarks") && <Landmarks data={data} provisional={review} />}
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
      {audit && <AuditPanel info={auditInfo} osmOnly={osmOnly} shown={data?.buildings.length ?? 0} picked={picked} onNext={nextReview} />}
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
