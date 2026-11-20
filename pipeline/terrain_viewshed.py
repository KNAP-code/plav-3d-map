"""Visibility analysis that decides how far the terrain must extend (Phase 1: terrain & mountains).

For several real observer points in and around Plav we sweep rays every 0.25° of azimuth over the
Copernicus GLO-30 DEM (resampled to a 60 m grid in the scene's own UTM 34N local frame) and record, per
azimuth, the skyline point (the terrain point with the largest elevation angle) and the farthest
visible point. Earth curvature and standard refraction (k = 0.13) are included.

The terrain boundary is then the extent that contains every skyline point seen from the ground
observers plus a margin, instead of an arbitrary radius.

    python terrain_viewshed.py            -> cache/terrain/viewshed.json, prints a summary

Input: cache/terrain/glo30.tif (see terrain.py fetch).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy import ndimage

from terrain import CACHE, ORIGIN, local_grid_heights, ll_to_local

R_EFF = 6_371_000 / (1 - 0.13)

# Observer points (lon, lat, eye height above ground in m). Ground observers are real public places.
OBSERVERS = {
    "čaršija (Redžepagića kula)": (19.945963, 42.595724, 1.7),
    "lake north shore": (19.9352, 42.5963, 1.7),
    "lake south end": (19.9204, 42.5886, 1.7),
    "Lim valley north of town": (19.9468, 42.6164, 1.7),
    "slope NE of town (~1 180 m)": (19.9560, 42.6045, 1.7),
    # aerial: the oblique map camera typically sits a few hundred m to ~2 km above the town
    "aerial 1000 m above čaršija": (19.945963, 42.595724, 1000.0),
}


def sweep(H, x0, y0, step, ox, oy, eye, max_r=65_000, daz=0.25, dr=None):
    dr = dr or step * 0.75
    oh = float(ndimage.map_coordinates(H, [[(oy - y0) / step], [(ox - x0) / step]], order=1)[0]) + eye
    az = np.deg2rad(np.arange(0, 360, daz))
    r = np.arange(dr, max_r, dr)
    X = ox + np.sin(az)[:, None] * r[None, :]
    Y = oy + np.cos(az)[:, None] * r[None, :]
    fx, fy = (X - x0) / step, (Y - y0) / step
    inside = (fx >= 0) & (fy >= 0) & (fx <= H.shape[1] - 1) & (fy <= H.shape[0] - 1)
    h = ndimage.map_coordinates(H, [fy.ravel(), fx.ravel()], order=1, mode="nearest").reshape(X.shape)
    drop = r[None, :] ** 2 / (2 * R_EFF)
    ang = np.arctan2(h - drop - oh, r[None, :])
    ang = np.where(inside, ang, -np.inf)
    runmax = np.maximum.accumulate(ang, axis=1)
    prev = np.concatenate([np.full((len(az), 1), -np.inf), runmax[:, :-1]], axis=1)
    visible = ang >= prev
    sky_i = np.argmax(ang, axis=1)
    far_i = np.array([np.nonzero(v)[0].max() for v in visible])
    out = []
    for k in range(len(az)):
        i, j = sky_i[k], far_i[k]
        out.append({
            "az": round(float(np.rad2deg(az[k])), 2),
            "sky_r": round(float(r[i])), "sky_x": round(float(X[k, i])), "sky_y": round(float(Y[k, i])),
            "sky_h": round(float(h[k, i])), "sky_deg": round(float(np.rad2deg(ang[k, i])), 3),
            "far_r": round(float(r[j])),
        })
    return oh, out, visible, X, Y


def main():
    step = 60.0
    half = 66_000.0
    H, x0, y0 = local_grid_heights(-half, -half, step, int(2 * half / step) + 1, int(2 * half / step) + 1)
    res = {"grid_step_m": step, "half_extent_m": half, "refraction_k": 0.13, "observers": {}}
    for name, (lon, lat, eye) in OBSERVERS.items():
        ox, oy = ll_to_local(lon, lat)
        oh, rays, *_ = sweep(H, x0, y0, step, ox, oy, eye)
        sk = np.array([[r["sky_x"], r["sky_y"], r["sky_r"]] for r in rays])
        fr = np.array([r["far_r"] for r in rays])
        res["observers"][name] = {
            "lon": lon, "lat": lat, "x": round(ox), "y": round(oy), "eye_h": round(oh, 1),
            "skyline_r_p50": float(np.percentile(sk[:, 2], 50)), "skyline_r_p95": float(np.percentile(sk[:, 2], 95)),
            "skyline_r_max": float(sk[:, 2].max()),
            "skyline_bbox": [float(sk[:, 0].min()), float(sk[:, 1].min()), float(sk[:, 0].max()), float(sk[:, 1].max())],
            "far_visible_r_p95": float(np.percentile(fr, 95)),
            "rays": rays[::4],  # every 1°
        }
        o = res["observers"][name]
        print(f"{name:38s} eye {oh:7.1f} m  skyline r p50 {o['skyline_r_p50']/1000:5.1f} km  p95 {o['skyline_r_p95']/1000:5.1f} km "
              f"max {o['skyline_r_max']/1000:5.1f} km  bbox {[round(v/1000,1) for v in o['skyline_bbox']]}")
    (CACHE / "viewshed.json").write_text(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
