"use client";
import { useEffect } from "react";
import { useControls, button } from "leva";
import type { StyleConfig } from "@/style/presets";

/** Live style tuning panel (open with ?tune=1) for side-by-side comparison with reference screenshots. */
export function Tune({ style, setStyle }: { style: StyleConfig; setStyle: (s: StyleConfig) => void }) {
  const v = useControls({
    sunAzimuth: { value: style.sun.azimuthDeg, min: 0, max: 360, step: 1 },
    sunElevation: { value: style.sun.elevationDeg, min: 10, max: 85, step: 1 },
    sunIntensity: { value: style.sun.intensity, min: 0, max: 6, step: 0.05 },
    ambient: { value: style.ambient.intensity, min: 0, max: 3, step: 0.05 },
    roofPitch: { value: style.roof.pitchDeg, min: 10, max: 50, step: 1 },
    overhang: { value: style.roof.overhang, min: 0, max: 1.5, step: 0.05 },
    grass: style.ground.grass,
    dirt: style.ground.dirt,
    mottle: { value: style.ground.mottle, min: 0, max: 1, step: 0.01 },
    asphalt: style.roads.asphalt,
    water: style.water.color,
    ao: style.post.ao,
    aoIntensity: { value: style.post.aoIntensity, min: 0, max: 6, step: 0.1 },
    tiltShift: style.post.tiltShift,
    tiltFocus: { value: style.post.tiltFocus, min: 0.05, max: 1, step: 0.01 },
    treeSize: { value: style.trees.size, min: 0.5, max: 2, step: 0.05 },
    "copy JSON": button(() => navigator.clipboard?.writeText(JSON.stringify(style, null, 2))),
  });
  useEffect(() => {
    setStyle({
      ...style,
      sun: { ...style.sun, azimuthDeg: v.sunAzimuth, elevationDeg: v.sunElevation, intensity: v.sunIntensity },
      ambient: { ...style.ambient, intensity: v.ambient },
      roof: { ...style.roof, pitchDeg: v.roofPitch, overhang: v.overhang },
      ground: { ...style.ground, grass: v.grass, dirt: v.dirt, mottle: v.mottle },
      roads: { ...style.roads, asphalt: v.asphalt },
      water: { ...style.water, color: v.water },
      post: { ...style.post, ao: v.ao, aoIntensity: v.aoIntensity, tiltShift: v.tiltShift, tiltFocus: v.tiltFocus },
      trees: { ...style.trees, size: v.treeSize },
    });
  }, [v.sunAzimuth, v.sunElevation, v.sunIntensity, v.ambient, v.roofPitch, v.overhang, v.grass, v.dirt, v.mottle, v.asphalt, v.water, v.ao, v.aoIntensity, v.tiltShift, v.tiltFocus, v.treeSize]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
