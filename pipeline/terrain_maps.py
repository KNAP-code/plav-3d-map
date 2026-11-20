"""Report figures for Phase 1 (not used by the app):
  docs/terrain/coverage-map.png      nested terrain levels, city core, observers, ground skylines, key peaks
  docs/terrain/elevation-map.png     GLO-30 elevation (hypsometric + hillshade, 100 m contours) over the L2 extent
  docs/terrain/skyline-profile.png   skyline from the lakeside viewpoint: 30 m DEM vs rendered mesh

    python terrain_maps.py   (needs matplotlib; run terrain_viewshed.py and terrain_validate.py first)
"""
from __future__ import annotations

import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LightSource, LinearSegmentedColormap  # noqa: E402

from terrain import CACHE, ROOT, ll_to_local, local_grid_heights  # noqa: E402
from terrain_validate import KEY, OUT  # noqa: E402

HYPSO = LinearSegmentedColormap.from_list("hypso", [
    (0.0, "#5f8f5a"), (0.18, "#8fb06a"), (0.32, "#c9c98a"), (0.48, "#d2b48a"), (0.64, "#b49478"),
    (0.8, "#a8a29a"), (1.0, "#f4f2ee")])


def hill(H, step, vmin, vmax):
    ls = LightSource(azdeg=315, altdeg=40)
    return ls.shade(H[::-1], cmap=HYPSO, vert_exag=1.0, dx=step, dy=step, blend_mode="soft", vmin=vmin, vmax=vmax)


def main():
    tj = json.loads((ROOT / "public" / "data" / "plav-town" / "terrain" / "terrain.json").read_text())
    meta = json.loads((ROOT / "public" / "data" / "plav-town" / "meta.json").read_text())
    vs = json.loads((CACHE / "viewshed.json").read_text())
    val = json.loads((OUT / "validation.json").read_text())
    L3 = tj["levels"][-1]["half"]

    # ---------------- coverage map
    step = 180.0
    n = int(2 * L3 / step) + 1
    H, *_ = local_grid_heights(-L3, -L3, step, n, n)
    fig, ax = plt.subplots(figsize=(11, 11), dpi=110)
    ax.imshow(hill(H, step, 500, 2700), extent=[-L3 / 1000, L3 / 1000, -L3 / 1000, L3 / 1000])
    c = meta["core"]
    rects = [("City core 8 m (unchanged)", c["x0"], c["y0"], (c["nx"] - 1) * c["step"], "#d1495b")]
    for l in tj["levels"]:
        rects.append((f"{l['name']} {l['step']:.0f} m  ±{l['half'] / 1000:.1f} km", -l["half"], -l["half"], 2 * l["half"], {"L1": "#edae49", "L2": "#00798c", "L3": "#30638e"}[l["name"]]))
    for lab, x0, y0, w, col in rects:
        ax.add_patch(plt.Rectangle((x0 / 1000, y0 / 1000), w / 1000, w / 1000, fill=False, lw=2.2, ec=col, label=lab))
    first = True
    for name, o in vs["observers"].items():
        if name.startswith("aerial"):
            continue
        sx = np.array([r["sky_x"] for r in o["rays"]]) / 1000; sy = np.array([r["sky_y"] for r in o["rays"]]) / 1000
        ax.scatter(sx, sy, s=3, c="#222", alpha=0.55, label="skyline points seen from the valley (5 observers, every 1°)" if first else None)
        ax.plot(o["x"] / 1000, o["y"] / 1000, "o", ms=5, mfc="white", mec="black")
        first = False
    for p in val["key_peaks"]:
        lon_lat = [q for q in json.loads((CACHE / "osm_peaks.json").read_text()) if q["name"] == p["name"]][0]
        x, y = ll_to_local(lon_lat["lon"], lon_lat["lat"])
        ax.plot(x / 1000, y / 1000, "^", ms=7, mfc="#111", mec="white")
        ax.annotate(f"{p['name'].split(' / ')[0].split(' (')[0]} {p['osm_ele']}", (x / 1000, y / 1000), xytext=(4, 4), textcoords="offset points", fontsize=7.5,
                    bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.75))
    ax.set_xlabel("km east of the Plav scene origin (UTM 34N grid)"); ax.set_ylabel("km north (grid)")
    ax.set_title("PLAV 3D terrain coverage — chosen from the valley's real skylines (GLO-30 hillshade)")
    ax.legend(loc="lower left", fontsize=8, framealpha=0.9)
    fig.tight_layout(); fig.savefig(OUT / "coverage-map.png"); plt.close(fig)

    # ---------------- elevation map (L2 extent)
    h2 = 18000.0; st = 60.0; n2 = int(2 * h2 / st) + 1
    H2, *_ = local_grid_heights(-h2, -h2, st, n2, n2)
    fig, ax = plt.subplots(figsize=(11, 10), dpi=110)
    ax.imshow(hill(H2, st, 850, 2650), extent=[-h2 / 1000, h2 / 1000, -h2 / 1000, h2 / 1000])
    xs = np.linspace(-h2, h2, n2) / 1000
    cs = ax.contour(xs, xs, H2, levels=np.arange(900, 2700, 100), colors="#3a3a3a", linewidths=0.25, alpha=0.6)
    ax.contour(xs, xs, H2, levels=np.arange(1000, 2700, 500), colors="#1a1a1a", linewidths=0.7, alpha=0.7)
    ax.add_patch(plt.Rectangle((c["x0"] / 1000, c["y0"] / 1000), (c["nx"] - 1) * c["step"] / 1000, (c["ny"] - 1) * c["step"] / 1000, fill=False, lw=2, ec="#d1495b", label="city core"))
    sm = plt.cm.ScalarMappable(cmap=HYPSO, norm=plt.Normalize(850, 2650)); sm.set_array([])
    fig.colorbar(sm, ax=ax, shrink=0.75, label="elevation (m, EGM2008)")
    ax.set_title("Copernicus GLO-30 elevation around Plav (±18 km), 100 m contours")
    ax.set_xlabel("km east"); ax.set_ylabel("km north"); ax.legend(loc="lower left")
    fig.tight_layout(); fig.savefig(OUT / "elevation-map.png"); plt.close(fig)

    # ---------------- skyline profile
    sk = val["skyline"]
    az = np.arange(0, 360, 0.5)
    fig, ax = plt.subplots(figsize=(14, 4.2), dpi=110)
    ax.fill_between(az, -2, sk["skyline_dem_deg"], color="#cfd8c4")
    ax.plot(az, sk["skyline_dem_deg"], color="#222", lw=1.2, label="skyline from the 30 m DEM (curvature + refraction)")
    ax.plot(az, sk["skyline_mesh_deg"], color="#d1495b", lw=1.0, ls="--", label="skyline of the rendered terrain (as baked)")
    for p in val["key_peaks"]:
        pass
    ax.set_xlim(0, 360); ax.set_xticks(range(0, 361, 30)); ax.set_xlabel("azimuth (° from grid north)"); ax.set_ylabel("elevation angle (°)")
    ax.set_title(f"Skyline from the east shore of Plavsko jezero — rendered vs data: mean |Δ| {sk['mean_abs_err_deg']}°, p95 {sk['p95_abs_err_deg']}°")
    ax.legend(loc="upper right", fontsize=8); ax.grid(alpha=0.3)
    fig.tight_layout(); fig.savefig(OUT / "skyline-profile.png"); plt.close(fig)
    print("figures written to", OUT)


if __name__ == "__main__":
    main()
