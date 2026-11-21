"use client";
import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type CameraControlsImpl from "camera-controls";
import type { AreaData } from "@/data/load";
import { WALK } from "./Rig";

const DEG = Math.PI / 180;

/** Shared between the in-canvas driver and the DOM panel (no React state per frame). */
export type WalkState = { active: boolean; playing: boolean; s: number; speed: number; dirty: boolean; kick?: () => void };
export const newWalkState = (s = 0, active = false): WalkState => ({ active, playing: false, s, speed: 1.4, dirty: true });

/** Arc-length parametrised walk path (local metres). */
export function walkPath(data: AreaData) {
  const pts = data.route?.walk.pts ?? [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1] ?? 0;
  const at = (s: number): [number, number] => {
    s = Math.min(Math.max(s, 0), L);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const t = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
  };
  return { L, at };
}

/**
 * Pedestrian camera on the centre route: eye 1.65 m above the terrain, walking speed 1.4 m/s (x4 on demand), looking
 * along the path (direction averaged over the next 14 m so corners are turned smoothly). While paused the normal
 * controls look around from the current spot; play snaps back to the path.
 */
export function WalkDriver({ data, controls, st }: { data: AreaData; controls: React.RefObject<CameraControlsImpl | null>; st: WalkState }) {
  const { camera, invalidate } = useThree();
  const path = useMemo(() => walkPath(data), [data]);
  const eye = data.route?.meta.walk.eye_m ?? 1.65;
  const saved = useMemo(() => ({ min: 40, maxPol: 78 * DEG, near: 5 }), []);
  useEffect(() => { st.kick = invalidate; invalidate(); return () => { WALK.on = false; st.kick = undefined; }; }, [st, invalidate]);
  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    if (st.active !== WALK.on) {
      WALK.on = st.active;
      const cam = camera as THREE.PerspectiveCamera;
      if (st.active) {
        saved.min = c.minDistance; saved.maxPol = c.maxPolarAngle; saved.near = cam.near;
        c.minDistance = 0.5; c.maxPolarAngle = 115 * DEG; cam.near = 0.5;
      } else {
        c.minDistance = saved.min; c.maxPolarAngle = saved.maxPol; cam.near = saved.near;
      }
      cam.updateProjectionMatrix();
      st.dirty = true;
    }
    if (!st.active) return;
    if (st.playing) { st.s = Math.min(path.L, st.s + Math.min(dt, 0.1) * st.speed); if (st.s >= path.L) st.playing = false; st.dirty = true; }
    if (!st.dirty) return;
    st.dirty = false;
    const [x, y] = path.at(st.s);
    let dx = 0, dy = 0;
    for (let k = 1; k <= 7; k++) { const [ax, ay] = path.at(st.s + k * 2); dx += ax - x; dy += ay - y; }
    if (st.s >= path.L - 1) { const [px, py] = path.at(st.s - 4); dx = x - px; dy = y - py; }
    // the last metres turn towards the destination (the stadium pitch)
    const end = data.route?.walk.endLook;
    if (end) {
      const w = Math.min(Math.max((st.s - (path.L - 20)) / 20, 0), 1), n0 = Math.hypot(dx, dy) || 1;
      const ex = end[0] - x, ey = end[1] - y, ne = Math.hypot(ex, ey) || 1;
      dx = (dx / n0) * (1 - w) + (ex / ne) * w; dy = (dy / n0) * (1 - w) + (ey / ne) * w;
    }
    const n = Math.hypot(dx, dy) || 1;
    const g = (data.core.contains(x, y) ? data.core.atTri(x, y) : data.context.atTri(x, y)) - data.datum + eye;
    const D = 20, p = -2 * DEG;
    c.setLookAt(x, g, -y, x + (dx / n) * Math.cos(p) * D, g + Math.sin(p) * D, -y - (dy / n) * Math.cos(p) * D, false);
    invalidate();
  });
  return null;
}
