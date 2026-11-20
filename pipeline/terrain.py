"""Phase 1 terrain: real surrounding mountains from Copernicus GLO-30, in nested chunked LOD levels.

Writes public/data/<area>/terrain/ :
  L1.bin, L2.bin, L3.bin   uint16 heights (base + q / scale), row 0 = south, column 0 = west
  L1.png, L2.png, L3.png   land-cover weights from ESA WorldCover (r forest, g grass/shrub/crop, b bare rock / built,
                           a snow-ice + permanent water), top row = north
  terrain.json             grid metadata, datum notes, validation summary

The city core grid (terrain_core.bin, 8 m) and every building/road file are NOT rewritten: the new levels are
sampled in the same local frame (EPSG:32634 minus meta.origin) and their vertices inside the core take the core
grid's own heights, so the city keeps sitting exactly where it sat.

Nested, aligned grids (a baked geometry clipmap centred on the town, because the camera is limited to the town):
  L1  30 m  (≈ native GLO-30)  half extent  6 000 m
  L2  60 m                    half extent 18 000 m
  L3 180 m                    half extent chosen by terrain_viewshed.py (skyline coverage), multiple of 180 m
Coarse levels are peak-preserving: a vertex whose ±step/2 window holds a local summit takes the summit's real
DEM height (the summit moves ≤ step·0.7 horizontally instead of being shaved off by the coarser grid).
Each coarser level's cells that are fully covered by the finer level are dropped by the viewer; the finer
level's outermost ring of vertices takes the coarser level's surface heights so the two meet without cracks.

Vertical datum: GLO-30 heights are orthometric heights above the EGM2008 geoid (as published). They are used
unchanged (no datum conversion). Earth curvature: for the distant levels the viewer-facing heights are lowered by
d²/(2·R_eff) (R_eff = R/(1-0.13), standard refraction) measured from the town centre, which is how a real eye at
Plav sees the far ridges; the true DEM elevations are kept in terrain.json for validation and the HUD.

    python terrain.py fetch          # GLO-30 + SRTM + WorldCover + OSM peaks into cache/terrain/
    python terrain.py build [area]   # writes public/data/<area>/terrain/
"""
from __future__ import annotations

import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from scipy import ndimage

HERE = Path(__file__).parent
ROOT = HERE.parent
CACHE = HERE / "cache" / "terrain"
CACHE.mkdir(parents=True, exist_ok=True)

AREA = "plav-town"
META = json.loads((ROOT / "public" / "data" / AREA / "meta.json").read_text())
ORIGIN = np.array(META["origin"], dtype=float)  # UTM 34N metres of local (0, 0)
TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32634", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:32634", "EPSG:4326", always_xy=True)
R_EFF = 6_371_000 / (1 - 0.13)

# whole working box (lon/lat) — larger than any level so every level is fully inside real data
BOX = (19.10, 41.95, 20.80, 43.25)
GLO = "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"
WC = "/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{lat:02d}E{lon:03d}_Map.tif"
SKADI = "https://elevation-tiles-prod.s3.amazonaws.com/skadi/N{lat:02d}/N{lat:02d}E{lon:03d}.hgt.gz"

LEVELS = [  # name, step, half extent (cells * step) — L3 extent is set from the viewshed (choose_l3_half)
    ("L1", 30.0, 200 * 30.0),
    ("L2", 60.0, 300 * 60.0),
    ("L3", 180.0, None),
]


def ll_to_local(lon, lat):
    x, y = TO_UTM.transform(lon, lat)
    return np.asarray(x) - ORIGIN[0], np.asarray(y) - ORIGIN[1]


def local_to_ll(x, y):
    return TO_LL.transform(np.asarray(x) + ORIGIN[0], np.asarray(y) + ORIGIN[1])


# ------------------------------------------------------------------ fetch
def fetch():
    from rasterio.merge import merge
    W, S, E, N = BOX
    tiles = [(la, lo) for la in range(math.floor(S), math.floor(N) + 1) for lo in range(math.floor(W), math.floor(E) + 1)]
    srcs = [rasterio.open(GLO.format(lat=la, lon=lo)) for la, lo in tiles]
    arr, tr = merge(srcs, bounds=BOX)
    p = srcs[0].profile.copy()
    p.update(driver="GTiff", height=arr.shape[1], width=arr.shape[2], transform=tr, count=1, compress="deflate",
             tiled=True, blockxsize=512, blockysize=512)
    with rasterio.open(CACHE / "glo30.tif", "w", **p) as d:
        d.write(arr[0], 1)
    print("GLO-30", arr.shape)
    # WorldCover: one 3°x3° tile covers the box (N42E018: 42-45 N, 18-21 E); the south edge (41.95) needs N39E018
    wsrcs = [rasterio.open(WC.format(lat=la, lon=18)) for la in (39, 42)]
    # read at 20 m (every 2nd pixel) — the coarsest level needs far less, the finest (30 m) is still covered
    arr, tr = merge(wsrcs, bounds=BOX, res=(1 / 5400, 1 / 5400), resampling=rasterio.enums.Resampling.mode)
    p = wsrcs[0].profile.copy()
    p.update(driver="GTiff", height=arr.shape[1], width=arr.shape[2], transform=tr, count=1, compress="deflate",
             tiled=True, blockxsize=512, blockysize=512)
    with rasterio.open(CACHE / "worldcover20.tif", "w", **p) as d:
        d.write(arr[0], 1)
    print("WorldCover", arr.shape)
    import urllib.request
    (CACHE / "srtm").mkdir(exist_ok=True)
    for la, lo in tiles:
        f = CACHE / "srtm" / f"N{la:02d}E{lo:03d}.hgt.gz"
        if not f.exists():
            urllib.request.urlretrieve(SKADI.format(lat=la, lon=lo), f)
    print("SRTM tiles", len(tiles))


# ------------------------------------------------------------------ sampling
_DEM = {}


def _dem():
    if "a" not in _DEM:
        with rasterio.open(CACHE / "glo30.tif") as s:
            _DEM["a"] = s.read(1).astype(np.float32)
            _DEM["inv"] = ~s.transform
            _DEM["res"] = s.res
    return _DEM["a"], _DEM["inv"]


def dem_at(lon, lat, order=1, sigma=0.0):
    """GLO-30 elevation (EGM2008 orthometric, m). Same pixel convention as build.py (centre = index + 0.5)."""
    a, inv = _dem()
    if sigma > 0:
        key = ("s", sigma)
        if key not in _DEM:
            _DEM[key] = ndimage.gaussian_filter(a, sigma)
        a = _DEM[key]
    lon, lat = np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
    col, row = inv * (lon.ravel(), lat.ravel())
    v = ndimage.map_coordinates(a, [np.asarray(row) - 0.5, np.asarray(col) - 0.5], order=order, mode="nearest")
    return v.reshape(lon.shape)


def local_grid_heights(x0, y0, step, nx, ny, order=1):
    """Heights on a regular local grid (row 0 = south). Coarse grids are pre-filtered against aliasing."""
    xs, ys = x0 + np.arange(nx) * step, y0 + np.arange(ny) * step
    X, Y = np.meshgrid(xs, ys)
    lon, lat = local_to_ll(X, Y)
    # GLO-30 pixel ≈ 30.9 m N-S, 22.7 m E-W here; a mild Gaussian (σ ≈ ¼ of the target step, in pixels) keeps
    # peaks (σ is small) while removing sub-grid aliasing on 90 m / 270 m levels
    # L1 uses exactly the city core's resampling (cubic, σ 0.8 px) so the two agree where they meet
    if step <= 31:
        H = dem_at(lon, lat, order=3, sigma=0.8).astype(np.float64)
    else:
        H = dem_at(lon, lat, order=order, sigma=0.25 * step / 27.0).astype(np.float64)
    H = preserve_peaks(H, x0, y0, step, nx, ny)
    return H, x0, y0


def preserve_peaks(H, x0, y0, step, nx, ny):
    """Raise the vertex nearest each summit to the summit's real height (window max of the raw 30 m DEM)."""
    k = max(2, int(round(step / 15.0)))  # 15 m sub-samples
    f = step / k
    xs = x0 - step / 2 + (np.arange(nx * k) + 0.5) * f
    ys = y0 - step / 2 + (np.arange(ny * k) + 0.5) * f
    M = np.empty((ny, nx))
    for j0 in range(0, ny, 64):  # in strips to bound memory
        j1 = min(ny, j0 + 64)
        X, Y = np.meshgrid(xs, ys[j0 * k:j1 * k])
        lon, lat = local_to_ll(X, Y)
        d = dem_at(lon, lat, order=1)
        M[j0:j1] = d.reshape(j1 - j0, k, nx, k).max(axis=(1, 3))
    peak = (M == ndimage.maximum_filter(M, size=3, mode="nearest")) & (M > H)
    H = H.copy()
    H[peak] = M[peak]
    return H


def srtm_at(lon, lat):
    """SRTM 1″ (Mapzen/AWS 'skadi' tiles, EGM96) bilinear, for cross-validation only."""
    lon, lat = np.atleast_1d(lon), np.atleast_1d(lat)
    out = np.full(lon.shape, np.nan)
    for la in np.unique(np.floor(lat).astype(int)):
        for lo in np.unique(np.floor(lon).astype(int)):
            m = (np.floor(lat) == la) & (np.floor(lon) == lo)
            if not m.any():
                continue
            key = ("srtm", la, lo)
            if key not in _DEM:
                raw = gzip.decompress((CACHE / "srtm" / f"N{la:02d}E{lo:03d}.hgt.gz").read_bytes())
                n = int(round(math.sqrt(len(raw) // 2)))
                a = np.frombuffer(raw, ">i2").reshape(n, n).astype(np.float32)
                a[a < -1000] = np.nan
                _DEM[key] = a
            a = _DEM[key]
            n = a.shape[0]
            row = (la + 1 - lat[m]) * (n - 1)
            col = (lon[m] - lo) * (n - 1)
            out[m] = ndimage.map_coordinates(np.nan_to_num(a, nan=0.0), [row, col], order=1)
    return out


def worldcover_at(lon, lat):
    key = "wc"
    if key not in _DEM:
        with rasterio.open(CACHE / "worldcover20.tif") as s:
            _DEM[key] = (s.read(1), ~s.transform)
    a, inv = _DEM[key]
    col, row = inv * (np.asarray(lon), np.asarray(lat))
    return ndimage.map_coordinates(a, [np.asarray(row) - 0.5, np.asarray(col) - 0.5], order=0, mode="nearest")


# ------------------------------------------------------------------ core grid (existing city terrain)
def core_heights():
    c = META["core"]
    q = np.fromfile(ROOT / "public" / "data" / AREA / c["file"], dtype="<u2").reshape(c["ny"], c["nx"])
    return c, c["base"] + q.astype(np.float64) / c["scale"]


def sample_grid(H, g, x, y):
    """Same two-triangle interpolation as Heightfield.atTri in the viewer."""
    fx = np.clip((np.asarray(x) - g["x0"]) / g["step"], 0, g["nx"] - 1.0001)
    fy = np.clip((np.asarray(y) - g["y0"]) / g["step"], 0, g["ny"] - 1.0001)
    ix, iy = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - ix, fy - iy
    a, b = H[iy, ix], H[iy, ix + 1]
    c, d = H[iy + 1, ix], H[iy + 1, ix + 1]
    return np.where(tx >= ty, a + (b - a) * tx + (d - b) * ty, a + (c - a) * ty + (d - c) * tx)


def curvature_drop(X, Y):
    return (X ** 2 + Y ** 2) / (2 * R_EFF)


def cover_png(X, Y, sigma, path, sub=1):
    """WorldCover weights per texel; sub > 1 bakes the texture at a finer pitch than the vertex grid."""
    if sub > 1:
        st = X[0, 1] - X[0, 0]
        xs = X[0, 0] + np.arange((X.shape[1] - 1) * sub + 1) * st / sub
        ys = Y[0, 0] + np.arange((Y.shape[0] - 1) * sub + 1) * st / sub
        X, Y = np.meshgrid(xs, ys)
    lon, lat = local_to_ll(X, Y)
    cls = worldcover_at(lon, lat).astype(np.int32)
    # WorldCover classes: 10 tree, 20 shrub, 30 grass, 40 crop, 50 built, 60 bare/sparse, 70 snow/ice,
    # 80 water, 90 wetland, 95 mangrove, 100 moss/lichen
    r = (cls == 10)
    g = np.isin(cls, [20, 30, 40, 90, 100])
    b = np.isin(cls, [50, 60])
    a = np.isin(cls, [70, 80])
    img = np.stack([ndimage.gaussian_filter(c.astype(np.float32), sigma) for c in (r, g, b, a)], axis=-1)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)[::-1], "RGBA").save(path, optimize=True)
    return {int(k): int(v) for k, v in zip(*np.unique(cls, return_counts=True))}


# ------------------------------------------------------------------ build
def build(area=AREA, l3_half=None):
    out = ROOT / "public" / "data" / area / "terrain"
    out.mkdir(parents=True, exist_ok=True)
    cg, CH = core_heights()
    cx1 = cg["x0"] + (cg["nx"] - 1) * cg["step"]
    cy1 = cg["y0"] + (cg["ny"] - 1) * cg["step"]
    vs = json.loads((CACHE / "viewshed.json").read_text()) if (CACHE / "viewshed.json").exists() else None
    if l3_half is None:
        l3_half = choose_l3_half(vs)
    levels = []
    prev = None
    specs = [(n, s, h if h is not None else l3_half) for n, s, h in LEVELS]
    grids = {}
    for name, step, half in specs:
        n = int(round(2 * half / step)) + 1
        H, x0, y0 = local_grid_heights(-half, -half, step, n, n)
        grids[name] = (H, -half, -half, step, n)
    carve_water(area, grids, specs)
    # stitch: each finer level's outer ring takes the coarser level's surface (exact, cracks impossible);
    # vertices inside the city core take the core's own heights (so roads/buildings at the core edge match)
    for i, (name, step, half) in enumerate(specs):
        H, x0, y0, st, n = grids[name]
        dem = H.copy()
        xs = x0 + np.arange(n) * st
        X, Y = np.meshgrid(xs, xs)
        inc = (X >= cg["x0"]) & (X <= cx1) & (Y >= cg["y0"]) & (Y <= cy1)
        if inc.any():
            # 0.25 m below the core surface: the core (and its 25 m skirt) always draws on top in the overlap band
            H[inc] = sample_grid(CH, cg, X[inc], Y[inc]) - 0.25
        if inc.any():
            # L1 vertices one cell outside the core: never let the straddling L1 triangles rise above the core's
            # border (they would cover its edge cells or touch buildings there); the core's skirt hides the rest
            dx = np.maximum(np.maximum(cg["x0"] - X, X - cx1), 0); dy = np.maximum(np.maximum(cg["y0"] - Y, Y - cy1), 0)
            near = (~inc) & (dx < st) & (dy < st)
            ex, ey = np.clip(X[near], cg["x0"], cx1), np.clip(Y[near], cg["y0"], cy1)
            ce = sample_grid(CH, cg, ex, ey) - 0.25
            # inside neighbour towards the core along the offset direction
            ix = np.clip(X[near] - np.sign(X[near] - ex) * st, cg["x0"], cx1); iy = np.clip(Y[near] - np.sign(Y[near] - ey) * st, cg["y0"], cy1)
            vi = sample_grid(CH, cg, ix, iy) - 0.25
            t = np.clip(1.0 - np.hypot(X[near] - ex, Y[near] - ey) / st, 0.05, 1.0)  # share of the cell inside the core
            cap = vi + (ce - vi) / t
            H[near] = np.minimum(H[near], np.maximum(cap, ce - 3 * st))
        if i + 1 < len(specs):
            Hc, cx0, cy0, cst, cn = grids[specs[i + 1][0]]
            ring = np.zeros_like(H, bool)
            ring[0, :] = ring[-1, :] = ring[:, 0] = ring[:, -1] = True
            gc = {"x0": cx0, "y0": cy0, "step": cst, "nx": cn, "ny": cn}
            # the coarser level's heights near this ring are never modified (only its own far ring and core are)
            H[ring] = sample_grid(Hc, gc, X[ring], Y[ring])
        grids[name] = (H, x0, y0, st, n)
        grids[name + "_dem"] = dem
    meta_levels = []
    for i, (name, step, half) in enumerate(specs):
        H, x0, y0, st, n = grids[name]
        xs = x0 + np.arange(n) * st
        X, Y = np.meshgrid(xs, xs)
        drop = curvature_drop(X, Y)
        V = H - drop
        base = math.floor(V.min()) - 1
        scale = 10
        q = np.clip(np.round((V - base) * scale), 0, 65535).astype("<u2")
        q.tofile(out / f"{name}.bin")
        # covers at twice the vertex density on L1/L2 (15 m / 30 m texels) so forest edges stay crisp
        counts = cover_png(X, Y, 0.9, out / f"{name}.png", sub=2 if step <= 61 else 1)
        meta_levels.append({
            "name": name, "x0": x0, "y0": y0, "nx": n, "ny": n, "step": st, "base": base, "scale": scale,
            "file": f"{name}.bin", "cover": f"{name}.png", "half": half,
            "hole": None if i == 0 else specs[i - 1][2],
            "demMin": round(float(grids[name + "_dem"].min()), 1), "demMax": round(float(grids[name + "_dem"].max()), 1),
            "maxCurvatureDrop": round(float(drop.max()), 1),
            "worldcover": counts,
        })
        print(f"  {name}: {n}x{n} @ {st:.0f} m, ±{half/1000:.2f} km, DEM {meta_levels[-1]['demMin']}–{meta_levels[-1]['demMax']} m,"
              f" curvature drop ≤ {drop.max():.1f} m")
    H1, x01, y01, st1, n1 = grids["L1"]
    nb = tree_band(area, out, cg, CH, (H1 - curvature_drop(*np.meshgrid(x01 + np.arange(n1) * st1, y01 + np.arange(n1) * st1)),
                                        {"x0": x01, "y0": y01, "step": st1, "nx": n1, "ny": n1}))
    tj = {
        "treesBand": {"file": "trees_band.bin", "count": nb, "band_m": 300,
                      "note": "ESA WorldCover 10 m tree pixels just outside the core, same rule as the city trees, thinning out quadratically to none at 300 m"},
        "crs": "EPSG:32634", "origin": ORIGIN.tolist(),
        "source": "Copernicus DEM GLO-30 (DGED 2023_1 COG on AWS Open Data), 1 arc-second",
        "verticalDatum": "EGM2008 orthometric heights (as published; no conversion applied)",
        "curvature": {"applied": True, "refraction_k": 0.13, "R_eff_m": round(R_EFF),
                      "note": "rendered heights = DEM - d²/(2·R_eff), d from local (0,0); true DEM heights in validation"},
        "core": {"note": "terrain_core.bin (8 m, unchanged) is level 0; L1 vertices inside it copy its heights"},
        "levels": meta_levels,
        "coverChannels": "r WorldCover tree, g shrub/grass/crop/wetland/moss, b built + bare/sparse, a snow-ice + water",
    }
    (out / "terrain.json").write_text(json.dumps(tj, ensure_ascii=False, indent=1))
    return tj


def carve_water(area, grids, specs):
    """Same rule as build.py for the old context ring: lakes sit 2 m below their flat level with a 25 m bank just
    above it (the water mesh is flat at the level), mapped river areas 1.6 m down. Only the water polygons the city
    build exported (±9 km) are used; farther lakes are coloured from WorldCover instead."""
    import shapely
    from shapely.geometry import Polygon
    vec = json.loads((ROOT / "public" / "data" / area / "vectors.json").read_text())
    for w in vec["water"]:
        p = Polygon(w["outer"], w["holes"])
        if not p.is_valid:
            p = p.buffer(0)
        for name, step, half in specs:
            H, x0, y0, st, n = grids[name]
            minx, miny, maxx, maxy = p.buffer(30).bounds
            i0, i1 = max(1, int((minx - x0) / st)), min(n - 2, int((maxx - x0) / st) + 1)
            j0, j1 = max(1, int((miny - y0) / st)), min(n - 2, int((maxy - y0) / st) + 1)
            if i0 > i1 or j0 > j1:
                continue
            X, Y = np.meshgrid(x0 + np.arange(i0, i1 + 1) * st, y0 + np.arange(j0, j1 + 1) * st)
            sub = H[j0:j1 + 1, i0:i1 + 1]
            inside = shapely.contains_xy(p, X, Y)
            if w["kind"] == "lake" and w["level"] is not None:
                bank = shapely.contains_xy(p.buffer(25), X, Y) & ~inside
                sub[:] = np.where(inside, np.minimum(sub, w["level"] - 2.0), sub)
                sub[:] = np.where(bank, np.maximum(sub, w["level"] + 0.35), sub)
            else:
                sub[:] = np.where(inside, sub - 1.6, sub)


def tree_band(area, out, cg, CH, levels_H, band=300.0):
    """3D trees in a band just outside the city core, thinning out to none at `band` m, so the city's tree
    instances do not stop at a hard line. Same rule as build.py (ESA WorldCover 10 m tree pixels, two jittered
    candidates per pixel), kept with probability falling linearly across the band; not on mapped roads/water."""
    import hashlib
    import shapely
    from shapely.geometry import LineString, Polygon, box
    from rasterio.windows import from_bounds

    def rnd(k):
        return int.from_bytes(hashlib.md5(k.encode()).digest()[:4], "little") / 2**32

    cx1 = cg["x0"] + (cg["nx"] - 1) * cg["step"]; cy1 = cg["y0"] + (cg["ny"] - 1) * cg["step"]
    lo0, la0 = local_to_ll(cg["x0"] - band - 50, cg["y0"] - band - 50)
    lo1, la1 = local_to_ll(cx1 + band + 50, cy1 + band + 50)
    url = WC.format(lat=42, lon=18)
    with rasterio.open(url) as src:
        win = from_bounds(min(lo0, lo1), min(la0, la1), max(lo0, lo1), max(la0, la1), src.transform)
        arr = src.read(1, window=win)
        T = src.window_transform(win)
    rows, cols = np.nonzero(arr == 10)
    plon, plat = T * (cols + 0.5, rows + 0.5)
    px, py = ll_to_local(np.asarray(plon), np.asarray(plat))
    dx = np.maximum(np.maximum(cg["x0"] - px, px - cx1), 0)
    dy = np.maximum(np.maximum(cg["y0"] - py, py - cy1), 0)
    dout = np.hypot(dx, dy)
    sel = (dout > 0) & (dout < band)
    vec = json.loads((ROOT / "public" / "data" / area / "vectors.json").read_text())
    widths = {"secondary": 9, "tertiary": 8, "residential": 7, "unclassified": 6, "track": 4, "service": 5}
    blocked = shapely.union_all([LineString(r["pts"]).buffer(widths.get(r["c"], 3.0) / 2 + 2) for r in vec["roads"] if len(r["pts"]) > 1]
                                + [Polygon(w["outer"], w["holes"]).buffer(3) for w in vec["water"]])
    L1 = levels_H
    xs, ys, ks = [], [], []
    for i in np.nonzero(sel)[0]:
        key = f"band{rows[i]}:{cols[i]}"
        keep_band = (1.0 - dout[i] / band) ** 2
        for j, p_keep in enumerate((0.92, 0.45)):
            if rnd(key + f"k{j}") > p_keep * keep_band:
                continue
            xs.append(px[i] + (rnd(key + f"x{j}") - 0.5) * 9.0)
            ys.append(py[i] + (rnd(key + f"y{j}") - 0.5) * 9.0)
            ks.append(key + str(j))
    xs, ys = np.array(xs), np.array(ys)
    inside_core = (xs >= cg["x0"]) & (xs <= cx1) & (ys >= cg["y0"]) & (ys <= cy1)
    ok = ~shapely.contains_xy(blocked, xs, ys) & ~inside_core
    H, g = L1
    th = sample_grid(H, g, xs, ys)
    trees = []
    for i in np.nonzero(ok)[0]:
        k = ks[i]
        conifer_p = min(0.7, max(0.12, (th[i] - 950) / 300))
        trees.append((xs[i], ys[i], 0.75 + rnd(k + "s") * 0.6, 1 if rnd(k + "t") < conifer_p else 0))
    a = np.array(trees, dtype=np.float32).reshape(-1, 4)
    a.tofile(out / "trees_band.bin")
    print(f"  tree band ({band:.0f} m outside the core): {len(a)} trees")
    return len(a)


def choose_l3_half(vs):
    """Smallest multiple of 180 m that holds (a) every ground observer's skyline + 3 km margin and (b) the
    95th-percentile skyline distance seen from the aerial camera (1 000 m above the čaršija)."""
    need = 30_000.0
    if vs:
        ground, aerial = 0.0, 0.0
        for name, o in vs["observers"].items():
            if name.startswith("aerial"):
                aerial = max(aerial, o["skyline_r_p95"])
                continue
            x0, y0, x1, y1 = o["skyline_bbox"]
            ground = max(ground, -x0, -y0, x1, y1)
        need = max(ground + 3000, aerial)
    return math.ceil(need / 180.0) * 180.0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    if cmd == "fetch":
        fetch()
    else:
        build(sys.argv[2] if len(sys.argv) > 2 else AREA)
