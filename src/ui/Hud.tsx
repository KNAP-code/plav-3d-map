"use client";
import { memo, useState } from "react";
import type { AreaData } from "@/data/load";
import type { Quality } from "@/scene/World";
import { T, type Lang } from "./i18n";

export type Chip = { label: string; x: number; y: number; distance?: number; azimuth?: number };

const I = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  home: <path d="M4 11.5 12 5l8 6.5V20h-5v-5h-6v5H4z" />,
  rotate: <><path d="M19 12a7 7 0 1 1-2.05-4.95" /><path d="M19 4v4h-4" /></>,
  layers: <><path d="m12 4 8 4-8 4-8-4z" /><path d="m4 12 8 4 8-4" /><path d="m4 16 8 4 8-4" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
};
const Icon = ({ d }: { d: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

export const Hud = memo(function Hud(props: {
  data: AreaData; lang: Lang; setLang: (l: Lang) => void; quality: Quality; setQuality: (q: Quality) => void;
  northRef: React.RefObject<SVGSVGElement | null>; elevRef: React.RefObject<HTMLSpanElement | null>; chips: Chip[];
  onZoom: (f: number) => void; onHome: () => void; onRotate: () => void; onNorth: () => void; onChip: (c: Chip) => void;
}) {
  const { data, lang, setLang, quality, setQuality, chips } = props;
  const L = T[lang];
  const [open, setOpen] = useState(false);
  const s = data.meta.stats;
  const nextQ: Record<Quality, Quality> = { high: "medium", medium: "low", low: "high" };
  const qLabel: Record<Quality, string> = { high: "HQ", medium: "MQ", low: "LQ" };
  return (
    <>
      <button className="panel title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <span className="title-main">Plav</span>
          <span className="title-sub">{L.subtitle}</span>
        </span>
        <span className={`chev ${open ? "open" : ""}`}><Icon d={I.chevron} /></span>
      </button>

      {open && (
        <div className="panel sheet">
          <h2>{L.about}</h2>
          <p>{L.aboutText}</p>
          <h3>{L.stats}</h3>
          <p className="mono">
            {s.total} {L.buildings} (OSM {s.OpenStreetMap} · Microsoft ML {s["Microsoft ML Buildings"]}) · {s.height_estimated} {L.estimated} · {s.trees} {L.trees}
          </p>
          <h3>{L.data}</h3>
          <ul>{data.meta.sources.attribution.map((a) => <li key={a}>{a}</li>)}</ul>
          <p className="mono small">Overture {data.meta.sources.overture_release} · {data.meta.generated.slice(0, 10)}</p>
          <button className="close" onClick={() => setOpen(false)}>{L.close}</button>
        </div>
      )}

      <nav className="panel bar" aria-label="map controls">
        <button title={L.zoomIn} onClick={() => props.onZoom(1.5)}><Icon d={I.plus} /></button>
        <button title={L.zoomOut} onClick={() => props.onZoom(0.66)}><Icon d={I.minus} /></button>
        <button title={L.home} onClick={props.onHome}><Icon d={I.home} /></button>
        <button title={L.rotate} onClick={props.onRotate}><Icon d={I.rotate} /></button>
        <button title={L.quality} onClick={() => setQuality(nextQ[quality])} className="txt">{qLabel[quality]}</button>
        <button onClick={() => setLang(lang === "bs" ? "en" : "bs")} className="txt">{lang === "bs" ? "EN" : "BS"}</button>
      </nav>

      <div className="panel foot">
        <button className="north" title={L.north} onClick={props.onNorth}>
          <svg ref={props.northRef} viewBox="0 0 24 24" width="16" height="16">
            <path d="M12 2 18 20 12 16 6 20z" fill="currentColor" />
          </svg>
          N
        </button>
        <span>≈ <span ref={props.elevRef}>{Math.round(data.datum)}</span> {L.masl}</span>
        <button className="link" onClick={() => setOpen(true)}>© OpenStreetMap</button>
      </div>

      <div className="chips">
        {chips.map((c) => (
          <button key={c.label} className="chip" onClick={() => props.onChip(c)}>{c.label}</button>
        ))}
      </div>
    </>
  );
});
