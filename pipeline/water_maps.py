"""Figures for docs/WATER.md (needs matplotlib): Sentinel-2 summer 2025 natural colour and NDVI with the mapped water,
bridges and piers on top, and the Lim / Ljuča levelled profiles. Contains modified Copernicus Sentinel data 2025.
Usage: python pipeline/water_maps.py [area]"""
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import HERE, ROOT  # noqa: E402


def main(area="plav-town"):
    out = ROOT / "public" / "data" / area
    vec = json.loads((out / "vectors.json").read_text()); st = json.loads((out / "streets.json").read_text())
    O = np.array(json.loads((out / "meta.json").read_text())["origin"], float)
    with rasterio.open(HERE / "cache" / area / "s2_water.tif") as r:
        a = r.read(); T = r.transform
    ext = [T.c - O[0], T.c - O[0] + 10 * a.shape[2], T.f - O[1] - 10 * a.shape[1], T.f - O[1]]
    rgb = np.clip(np.dstack([a[2], a[1], a[0]]) / 0.12, 0, 1) ** 0.8
    ndvi = (a[3] - a[2]) / np.maximum(a[3] + a[2], 1e-4)
    fig, ax = plt.subplots(1, 2, figsize=(16, 11))
    for k, A in enumerate(ax):
        A.imshow(rgb if k == 0 else ndvi, extent=ext, cmap=None if k == 0 else "RdYlGn", vmin=-0.5, vmax=0.9, interpolation="nearest")
        for w in vec["water"]:
            o = np.array(w["outer"] + w["outer"][:1]); A.plot(o[:, 0], o[:, 1], c="cyan", lw=0.9)
        for s in vec["streams"]:
            p = np.array(s["pts"]); A.plot(p[:, 0], p[:, 1], c="#3060ff", lw=0.7)
        for b in st["bridges"]:
            p = np.array(b["pts"]); A.plot(p[:, 0], p[:, 1], c="magenta", lw=2.2)
        for p in st["piers"]:
            o = np.array(p["outer"] + p["outer"][:1]); A.plot(o[:, 0], o[:, 1], c="red", lw=1.4)
        A.set_xlim(-3000, 500); A.set_ylim(-2500, 2600)
        A.set_title(["Sentinel-2 L2A natural colour, summer 2025 median", "Sentinel-2 NDVI (green = vegetation, red = open water)"][k])
        A.set_xlabel("m east of the scene origin"); A.set_ylabel("m north")
    fig.suptitle("Plavsko jezero: OSM shoreline (cyan), waterways (blue), bridges (magenta), piers (red). Contains modified Copernicus Sentinel data 2025")
    plt.tight_layout(); d = ROOT / "docs" / "water"; d.mkdir(parents=True, exist_ok=True)
    plt.savefig(d / "shoreline-s2.jpg", dpi=80, pil_kwargs={"quality": 82}); plt.close()
    fig, A = plt.subplots(figsize=(11, 4.5))
    for rv in vec["rivers"]:
        if rv["n"] not in ("Lim", "Ljuča"):
            continue
        p = np.array(rv["pts"]); L = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))]) / 1000
        A.plot(L, p[:, 2], label=f"{rv['n']} (levelled water surface)")
    A.axhline(904.5, c="grey", ls="--", lw=0.8, label="Plavsko jezero, GLO-30 level 904.5 m")
    A.set_xlabel("km along the OSM centreline (flow direction)"); A.set_ylabel("m a.s.l. (GLO-30)"); A.legend(); A.grid(alpha=0.3)
    A.set_title("River profiles inside the ±9 km model (Ljuča ends at the lake, Lim starts at it)")
    plt.tight_layout(); plt.savefig(d / "river-profiles.png", dpi=80)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
