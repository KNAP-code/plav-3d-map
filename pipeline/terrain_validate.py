"""Validate the baked Phase 1 terrain against its sources and independent references.

    python terrain_validate.py      -> docs/terrain/validation.json (+ printed summary)

Checks
  1. GLO-30 vs SRTM 1″ (independent sensor and epoch) on a 300 m sample grid, split by WorldCover forest / open.
  2. Named OSM peaks (Overture base/land, OSM `ele` tags, mostly from topographic maps): OSM ele vs GLO-30 summit vs
     SRTM summit vs the rendered mesh summit; distance and bearing from the čaršija geodesically vs in the scene.
  3. Skyline from a real lakeside viewpoint: elevation angle per azimuth from the full 30 m DEM (with curvature and
     refraction) vs from the rendered level stack (core + L1..L3 as baked, stride 1).
  4. Seams: height gap where each level meets the next and where L1 meets the city core.
  5. City alignment: terrain_core.bin / buildings.json byte-identical to the committed files; L1 vs core at the
     core border.
  6. Orientation: UTM 34N grid convergence and scale factor at Plav.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess

import numpy as np
from pyproj import Geod, Proj

from terrain import (AREA, CACHE, R_EFF, ROOT, core_heights, curvature_drop, dem_at, ll_to_local, local_to_ll,
                     sample_grid, srtm_at, worldcover_at)

OUT = ROOT / "docs" / "terrain"
GEOD = Geod(ellps="WGS84")
KULA = (19.945963, 42.595724)  # Redžepagića kula, čaršija (confirmed position)
PANO = (-703.0, -508.0, 1.7)   # east shore of Plavsko jezero, open ground (no building within 60 m)
KEY = ["Bandera (Krivi smet)", "Hridski krš", "Krš Bogićevica (Hridski)", "Maja e Ropës", "Starac",
       "Bandera od Starca (Crni krš)", "Maja e Rosit / Rosni vrh", "Dobra Kolata / Kollate e Mires",
       "Zla Kolata / Kollate e Keqe", "Maja Kollatës", "Maja e Jezercës", "Gjeravicë", "Kom Kučki",
       "Kom vasojevićki (Božićki Kom)", "Hajla / Hajlë", "Karanfil Ljuljaševića", "Maja e Qenit / Pasji vrh", "Bogiçevica"]


def load_levels():
    tj = json.loads((ROOT / "public" / "data" / AREA / "terrain" / "terrain.json").read_text())
    out = []
    for l in tj["levels"]:
        q = np.fromfile(ROOT / "public" / "data" / AREA / "terrain" / l["file"], dtype="<u2").reshape(l["ny"], l["nx"])
        out.append((l, l["base"] + q.astype(np.float64) / l["scale"]))
    return tj, out


def rendered(levels, cg, CH, x, y):
    """Rendered surface height (with the baked curvature drop) — what the viewer draws at stride 1."""
    x, y = np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(y, float))
    out = np.full(x.shape, np.nan)
    cx1 = cg["x0"] + (cg["nx"] - 1) * cg["step"]; cy1 = cg["y0"] + (cg["ny"] - 1) * cg["step"]
    inc = (x >= cg["x0"]) & (x <= cx1) & (y >= cg["y0"]) & (y <= cy1)
    out[inc] = sample_grid(CH, cg, x[inc], y[inc])
    for l, H in levels:
        m = np.isnan(out) & (np.maximum(np.abs(x), np.abs(y)) <= l["half"])
        if m.any():
            out[m] = sample_grid(H, l, x[m], y[m])
    return out


def summit(fn, lon, lat, r=120.0, s=15.0):
    x, y = ll_to_local(lon, lat)
    g = np.mgrid[-r:r + 1:s, -r:r + 1:s].reshape(2, -1).T
    g = g[np.hypot(g[:, 0], g[:, 1]) <= r]
    return float(np.nanmax(fn(x + g[:, 0], y + g[:, 1])))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tj, levels = load_levels()
    cg, CH = core_heights()
    res = {}

    # 1. GLO-30 vs SRTM
    xs = np.arange(-18000, 18001, 300.0)
    X, Y = np.meshgrid(xs, xs)
    lon, lat = local_to_ll(X.ravel(), Y.ravel())
    glo, srt = dem_at(lon, lat), srtm_at(lon, lat)
    wc = worldcover_at(lon, lat)
    d = srt - glo
    ok = np.isfinite(d) & (srt > 0)
    def st(m):
        v = d[ok & m]
        return {"n": int(v.size), "median": round(float(np.median(v)), 1), "mean": round(float(v.mean()), 1),
                "mad": round(float(np.median(np.abs(v - np.median(v)))), 1), "p95_abs": round(float(np.percentile(np.abs(v), 95)), 1)}
    res["glo30_vs_srtm"] = {"all": st(np.ones_like(ok)), "forest": st(wc == 10), "open": st(wc != 10),
                            "note": "SRTM minus GLO-30 (m), 300 m grid over ±18 km; SRTM (EGM96, 2000) vs GLO-30 (EGM2008, 2011-15)"}

    # 2. peaks
    peaks = [p for p in json.loads((CACHE / "osm_peaks.json").read_text()) if p["cls"] == "peak" and p["ele"] and p["name"]]
    L3 = levels[-1][0]["half"]
    rows = []
    for p in peaks:
        x, y = ll_to_local(p["lon"], p["lat"])
        if max(abs(x), abs(y)) > L3 - 1000:
            continue
        g = summit(lambda a, b: dem_at(*local_to_ll(a, b)), p["lon"], p["lat"])
        s_ = summit(lambda a, b: srtm_at(*local_to_ll(a, b)), p["lon"], p["lat"])
        r_ = summit(lambda a, b: rendered(levels, cg, CH, a, b) + curvature_drop(a, b), p["lon"], p["lat"], r=200)
        az, _, dist = GEOD.inv(KULA[0], KULA[1], p["lon"], p["lat"])
        kx, ky = ll_to_local(*KULA)
        sdist = math.hypot(x - kx, y - ky)
        saz = math.degrees(math.atan2(x - kx, y - ky)) % 360
        lvl = "core" if max(abs(x), abs(y)) < 2000 else next(l["name"] for l, _ in levels if max(abs(x), abs(y)) <= l["half"])
        rows.append({"name": p["name"], "osm_ele": p["ele"], "glo30": round(g, 1), "srtm": round(s_, 1), "mesh": round(r_, 1),
                     "level": lvl, "dist_km": round(dist / 1000, 2), "scene_dist_km": round(sdist / 1000, 2),
                     "bearing": round(az % 360, 2), "scene_grid_bearing": round(saz, 2), "osm_id": p["src"]})
    a = np.array([[r["osm_ele"], r["glo30"], r["srtm"], r["mesh"]] for r in rows])
    res["peaks_summary"] = {
        "n": len(rows),
        "glo30_minus_osm": {"median": round(float(np.median(a[:, 1] - a[:, 0])), 1), "p90_abs": round(float(np.percentile(np.abs(a[:, 1] - a[:, 0]), 90)), 1)},
        "srtm_minus_osm": {"median": round(float(np.nanmedian(a[:, 2] - a[:, 0])), 1), "p90_abs": round(float(np.nanpercentile(np.abs(a[:, 2] - a[:, 0]), 90)), 1)},
        "mesh_minus_glo30_by_level": {lv: {"n": int(sum(1 for r in rows if r["level"] == lv)),
                                           "median": round(float(np.median([r["mesh"] - r["glo30"] for r in rows if r["level"] == lv])), 1),
                                           "p10": round(float(np.percentile([r["mesh"] - r["glo30"] for r in rows if r["level"] == lv], 10)), 1)}
                                      for lv in sorted({r["level"] for r in rows})},
    }
    res["key_peaks"] = [r for k in KEY for r in rows if r["name"] == k]

    # 3. skyline from the lakeside viewpoint
    ox, oy, eye = PANO
    oh = float(rendered(levels, cg, CH, ox, oy)[0]) + eye
    oh_dem = float(dem_at(*local_to_ll(ox, oy))) + eye
    az = np.deg2rad(np.arange(0, 360, 0.5))
    r = np.concatenate([np.arange(15, 6000, 15.0), np.arange(6000, 40000, 30.0)])
    PX = ox + np.sin(az)[:, None] * r[None, :]
    PY = oy + np.cos(az)[:, None] * r[None, :]
    inside = np.maximum(np.abs(PX), np.abs(PY)) < L3
    hd = dem_at(*local_to_ll(PX.ravel(), PY.ravel())).reshape(PX.shape)
    hm = rendered(levels, cg, CH, PX.ravel(), PY.ravel()).reshape(PX.shape)
    dist = np.hypot(PX, PY)
    ang_d = np.where(inside, np.degrees(np.arctan2(hd - r[None, :] ** 2 / (2 * R_EFF) - oh_dem, r[None, :])), -90)
    # rendered heights already carry the curvature drop measured from (0,0); correct to the observer
    corr = (dist ** 2 - r[None, :] ** 2 - (ox ** 2 + oy ** 2)) / (2 * R_EFF)  # ≈ drop(origin) - drop(observer) terms
    # as displayed: the viewer drops heights from the scene origin, not from the observer (≤ a few m at 40 km here)
    ang_m = np.where(inside, np.degrees(np.arctan2(hm - oh, r[None, :])), -90)
    ang_c = np.where(inside, np.degrees(np.arctan2(hm + corr - oh, r[None, :])), -90)
    sd, sm = ang_d.max(axis=1), ang_m.max(axis=1)
    origin_effect = float(np.abs(ang_c.max(axis=1) - sm).max())
    err = sm - sd
    fov_v = 28.0
    px_per_deg = 800 / fov_v
    res["skyline"] = {
        "observer": {"x": ox, "y": oy, "lonlat": [round(float(v), 6) for v in local_to_ll(ox, oy)], "eye_m": eye,
                     "ground_rendered": round(oh - eye, 1), "ground_glo30": round(oh_dem - eye, 1)},
        "azimuth_step_deg": 0.5, "max_origin_vs_observer_curvature_deg": round(origin_effect, 4),
        "max_abs_err_deg": round(float(np.abs(err).max()), 3), "mean_abs_err_deg": round(float(np.abs(err).mean()), 3),
        "p95_abs_err_deg": round(float(np.percentile(np.abs(err), 95)), 3),
        "p95_abs_err_px_default_view": round(float(np.percentile(np.abs(err), 95) * px_per_deg), 2),
        "skyline_dem_deg": [round(float(v), 3) for v in sd], "skyline_mesh_deg": [round(float(v), 3) for v in sm],
        "skyline_dist_km": [round(float(r[i]) / 1000, 2) for i in ang_d.argmax(axis=1)],
    }

    # 4. seams
    seams = {}
    for (l1, H1), (l2, H2) in zip(levels[:-1], levels[1:]):
        n = l1["nx"]
        xs1 = l1["x0"] + np.arange(n) * l1["step"]
        bx = np.concatenate([xs1, xs1, np.full(n, xs1[0]), np.full(n, xs1[-1])])
        by = np.concatenate([np.full(n, xs1[0]), np.full(n, xs1[-1]), xs1, xs1])
        ring = np.concatenate([H1[0, :], H1[-1, :], H1[:, 0], H1[:, -1]])
        seams[f"{l1['name']}-{l2['name']}"] = round(float(np.abs(ring - sample_grid(H2, l2, bx, by)).max()), 3)
    l1, H1 = levels[0]
    cx1 = cg["x0"] + (cg["nx"] - 1) * cg["step"]; cy1 = cg["y0"] + (cg["ny"] - 1) * cg["step"]
    t = np.linspace(0, 1, 2000)
    ex = np.concatenate([cg["x0"] + t * (cx1 - cg["x0"]), cg["x0"] + t * (cx1 - cg["x0"]), np.full_like(t, cg["x0"]), np.full_like(t, cx1)])
    ey = np.concatenate([np.full_like(t, cg["y0"]), np.full_like(t, cy1), cg["y0"] + t * (cy1 - cg["y0"]), cg["y0"] + t * (cy1 - cg["y0"])])
    gap = sample_grid(H1, l1, ex, ey) - sample_grid(CH, cg, ex, ey)
    seams["core-L1 (L1 minus core along the core border)"] = {"median": round(float(np.median(gap)), 2), "p95_abs": round(float(np.percentile(np.abs(gap), 95)), 2),
                                                               "max_abs": round(float(np.abs(gap).max()), 2),
                                                               "note": "hidden by the core's 25 m skirt; L1 draws behind the core (polygon offset)"}
    res["seams_m"] = seams

    # 5. city alignment: files identical to the committed ones
    def sha(p):
        return hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    same = {}
    for f in ("terrain_core.bin", "buildings.json", "vectors.json", "streets.json", "trees.bin"):
        p = ROOT / "public" / "data" / AREA / f
        head = subprocess.run(["git", "show", f"HEAD:public/data/{AREA}/{f}"], cwd=ROOT, capture_output=True).stdout
        same[f] = hashlib.sha256(head).hexdigest()[:16] == sha(p)
    b = json.loads((ROOT / "public" / "data" / AREA / "buildings.json").read_text())["buildings"]
    g0 = np.array([x["g0"] for x in b]); fx = np.array([np.mean([p[0] for p in x["fp"]]) for x in b]); fy = np.array([np.mean([p[1] for p in x["fp"]]) for x in b])
    gs = sample_grid(CH, cg, fx, fy)
    res["city_alignment"] = {"unchanged_vs_HEAD": same, "buildings": len(b),
                             "building_base_minus_ground_centroid": {"median": round(float(np.median(g0 - gs)), 2),
                                                                     "p95_abs": round(float(np.percentile(np.abs(g0 - gs), 95)), 2)},
                             "note": "building bases (g0 = lowest footprint corner) on the unchanged 8 m core grid"}

    # 6. orientation
    lon0, lat0 = local_to_ll(0, 0)
    f = Proj("EPSG:32634").get_factors(float(lon0), float(lat0))
    res["orientation"] = {"grid_convergence_deg": round(f.meridian_convergence, 3), "scale_factor": round(f.meridional_scale, 6),
                          "note": "scene +y = UTM 34N grid north; true north is rotated by the convergence angle"}
    (OUT / "validation.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k not in ("skyline",)} | {"skyline": {k: v for k, v in res["skyline"].items() if not k.startswith("skyline_")}}, ensure_ascii=False, indent=1)[:6000])


if __name__ == "__main__":
    main()
