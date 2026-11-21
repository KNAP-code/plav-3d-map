"""Phase 2 water: lake vegetation belt, shoreline distance and a water audit for one area.

Runs after build.py and streets.py (reads public/data/<area>/vectors.json and streets.json).

Evidence (all open):
  * OpenStreetMap water polygons / waterways via Overture 2026-11-18.0 (ODbL): the shoreline and river courses.
  * Copernicus Sentinel-2 L2A, median of three cloud-free summer 2025 scenes (pipeline/fetch_s2.py --water): where
    inside the mapped lake there is open water (NDWI > 0) and where the surface is covered by emergent or floating
    vegetation (NDVI). Never used to move a shoreline; only to colour the surface and place the reed belt.
  * Copernicus DEM GLO-30: lake level and river profiles (build.py).

Writes
  public/data/<area>/water.json   marsh grid (10 m cells over the lakes: vegetation 0-255, S2 colour, shore distance)
  docs/water/audit.json           every number quoted in docs/WATER.md
Usage: python pipeline/water.py [area]
"""
import base64
import json
import math
import sys

import numpy as np
import rasterio
import shapely
from scipy import ndimage
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT, TO_UTM, local_to_ll, sample_raster  # noqa: E402

STEP = 10.0  # marsh grid = Sentinel-2 pixel size


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.uint8).tobytes()).decode()


def main(area_id="plav-town"):
    out = ROOT / "public" / "data" / area_id
    cache = HERE / "cache" / area_id
    vec = json.loads((out / "vectors.json").read_text())
    st = json.loads((out / "streets.json").read_text())
    meta = json.loads((out / "meta.json").read_text())
    origin = np.array(meta["origin"], float)

    with rasterio.open(cache / "s2_water.tif") as r:
        a = r.read(); T = r.transform
    b02, b03, b04, b08, b11 = a[0], a[1], a[2], a[3], a[4]
    ndvi = (b08 - b04) / np.maximum(b08 + b04, 1e-4)
    ndwi = (b03 - b08) / np.maximum(b03 + b08, 1e-4)
    x0s, y1s = T.c - origin[0], T.f - origin[1]

    def s2(arr, x, y):
        c = np.clip(((np.asarray(x) - x0s) / 10).astype(int), 0, arr.shape[1] - 1)
        rr = np.clip(((y1s - np.asarray(y)) / 10).astype(int), 0, arr.shape[0] - 1)
        return arr[rr, c]

    poly = lambda w: Polygon(w["outer"], w["holes"])
    lakes = [(w, poly(w)) for w in vec["water"] if w["kind"] == "lake" and w["level"] is not None]
    # the valley-floor lakes (Plavsko jezero, Malo blato and the mapped ponds next to them); mountain tarns stay plain
    valley = [(w, p) for w, p in lakes if w["level"] < 920 and p.intersects(box(x0s, y1s - 10 * a.shape[1], x0s + 10 * a.shape[2], y1s))]
    U = unary_union([p for _, p in valley])
    minx, miny, maxx, maxy = U.buffer(STEP * 2).bounds
    gx0, gy0 = math.floor(minx / STEP) * STEP, math.floor(miny / STEP) * STEP
    nx, ny = int(math.ceil((maxx - gx0) / STEP)), int(math.ceil((maxy - gy0) / STEP))
    cx = gx0 + (np.arange(nx) + 0.5) * STEP
    cy = gy0 + (np.arange(ny) + 0.5) * STEP
    X, Y = np.meshgrid(cx, cy)  # row 0 = south
    inside = shapely.contains_xy(U, X, Y)

    # vegetation cover: NDVI of the summer median; open water < 0.05, dense reed / sedge > 0.55
    nd = s2(ndvi, X, Y)
    veg = np.clip((nd - 0.05) / 0.5, 0, 1) * inside
    veg = ndimage.median_filter(veg, 3) * inside  # single mixed pixels at the open-water edge
    # S2 natural colour of the vegetated cells (for a data-true tint, blended with the palette in the viewer)
    rgb = np.stack([s2(b04, X, Y), s2(b03, X, Y), s2(b02, X, Y)], -1)
    rgb = np.clip((rgb / 0.12) ** 0.8, 0, 1)
    # distance from the shore (inside water), metres
    dist = ndimage.distance_transform_edt(inside) * STEP

    marsh = {"x0": gx0, "y0": gy0, "nx": nx, "ny": ny, "step": STEP,
             "veg": b64(np.round(veg * 255)), "rgb": b64(np.round(rgb * 255).reshape(-1, 3)),
             "shore": b64(np.clip(dist, 0, 255))}

    # ---------------------------------------------------------------- audit
    pj = next(p for w, p in lakes if w["name"] == "Plavsko jezero")
    lvl = next(w["level"] for w, p in lakes if w["name"] == "Plavsko jezero")
    gxx, gyy = np.meshgrid(np.arange(pj.bounds[0], pj.bounds[2], 5.0), np.arange(pj.bounds[1], pj.bounds[3], 5.0))
    m = shapely.contains_xy(pj, gxx, gyy)
    px, py = gxx[m], gyy[m]
    w_open = s2(ndwi, px, py) > 0
    v_ = s2(ndvi, px, py)
    cell = 25.0
    # S2 open water outside the OSM outline (within 300 m)
    ring = shapely.contains_xy(pj.buffer(300), gxx, gyy) & ~m
    outside_open = int((s2(ndwi, gxx[ring], gyy[ring]) > 0).sum())
    # how far the summer open water lies from the mapped shoreline, per compass sector
    lab, n = ndimage.label(s2(ndwi, X, Y) > 0)
    k = np.bincount(lab[inside & (lab > 0)]).argmax() if n else 0
    open_mask = lab == k
    edge = open_mask & ~ndimage.binary_erosion(open_mask)
    ex, ey = X[edge], Y[edge]
    d_edge = shapely.distance(pj.exterior, shapely.points(ex, ey))
    c = pj.centroid
    ang = (np.degrees(np.arctan2(ex - c.x, ey - c.y)) + 360) % 360
    sectors = {}
    for nm, lo in (("N", 315), ("E", 45), ("S", 135), ("W", 225)):
        sel = ((ang - lo) % 360) < 90
        if sel.any():
            sectors[nm] = {"median_m": round(float(np.median(d_edge[sel])), 0), "p90_m": round(float(np.percentile(d_edge[sel], 90)), 0)}
    dem = cache / "dem.tif"
    zz = sample_raster(dem, *local_to_ll(px[::4], py[::4], origin), order=0)
    sh = pj.exterior
    ring_pts = [sh.interpolate(t) for t in np.arange(0, sh.length, 20)]
    nrm = []
    for p in ring_pts:  # 20 m outward from the shoreline
        q = shapely.ops.nearest_points(pj.centroid, p)[1]
        dx, dy = q.x - c.x, q.y - c.y; L = math.hypot(dx, dy) or 1
        nrm.append((p.x + dx / L * 20, p.y + dy / L * 20))
    nrm = np.array(nrm)
    zshore = sample_raster(dem, *local_to_ll(nrm[:, 0], nrm[:, 1], origin), order=1)

    # rivers: length inside the town box and mean fall, from the levelled profiles
    rivers = []
    for rv in vec["rivers"]:
        p = np.array(rv["pts"])
        L = float(np.hypot(*np.diff(p[:, :2], axis=0).T).sum())
        rivers.append({"name": rv["n"], "length_m": round(L), "z_start": p[0, 2], "z_end": p[-1, 2],
                       "fall_m_per_km": round(float((p[0, 2] - p[-1, 2]) / max(L, 1) * 1000), 2)})
    rpolys = [(w, poly(w)) for w in vec["water"] if w["kind"] == "river"]
    widths = {}
    for w, p in rpolys:
        if "axis" in w:
            nm = vec["rivers"][w["axis"]]["n"] or "unnamed"
            ax = LineString([q[:2] for q in vec["rivers"][w["axis"]]["pts"]]).intersection(p)
            if ax.length > 50:
                widths.setdefault(nm, []).append((p.area, ax.length))
    widths = {k: round(sum(a for a, _ in v) / sum(l for _, l in v), 1) for k, v in widths.items()}

    # bridges: which water each mapped bridge crosses, and its span length
    streams = [(s["n"] or s["c"], LineString(s["pts"])) for s in vec["streams"] if len(s["pts"]) > 1]
    bridges = []
    for b in st["bridges"]:
        g = LineString(b["pts"])
        over = sorted({n for n, s in streams if g.intersects(s)} | {(w["name"] or (vec["rivers"][w["axis"]]["n"] if "axis" in w else "river area")) for w, p in rpolys if g.intersects(p)}
                      | {w["name"] or "lake" for w, p in lakes if g.intersects(p)})
        cen = g.interpolate(0.5, normalized=True)
        ll = local_to_ll([cen.x], [cen.y], origin)
        bridges.append({"name": b["n"], "class": b["c"], "length_m": round(g.length, 1), "deck_w_m": b["w"],
                        "over": over or ["(no mapped water: dry gully or the waterway is not mapped)"],
                        "lon": round(float(ll[0][0]), 5), "lat": round(float(ll[1][0]), 5)})

    # rafts / piers: mapped structures only, with a Sentinel-2 check (bright deck vs dark water around it)
    piers = []
    for p in st["piers"]:
        g = Polygon(p["outer"], p["holes"])
        gx2, gy2 = np.meshgrid(np.arange(g.bounds[0], g.bounds[2], 1.0), np.arange(g.bounds[1], g.bounds[3], 1.0))
        mm = shapely.contains_xy(g, gx2, gy2)
        bright = lambda xs, ys: float(np.mean(s2(b02, xs, ys) + s2(b03, xs, ys) + s2(b04, xs, ys)))
        on = bright(gx2[mm], gy2[mm]) if mm.any() else None
        rg = shapely.contains_xy(g.buffer(30), gx2, gy2) & ~shapely.contains_xy(g.buffer(8), gx2, gy2)
        gx3, gy3 = np.meshgrid(np.arange(g.bounds[0] - 30, g.bounds[2] + 30, 2.0), np.arange(g.bounds[1] - 30, g.bounds[3] + 30, 2.0))
        rg = shapely.contains_xy(g.buffer(30), gx3, gy3) & ~shapely.contains_xy(g.buffer(8), gx3, gy3)
        off = bright(gx3[rg], gy3[rg])
        cen = g.centroid; ll = local_to_ll([cen.x], [cen.y], origin)
        in_lake = max((g.intersection(lp).area / g.area for _, lp in lakes), default=0)
        piers.append({"area_m2": round(g.area), "extent_m": round(max(g.bounds[2] - g.bounds[0], g.bounds[3] - g.bounds[1])),
                      "share_over_lake": round(in_lake, 2), "s2_brightness_on": round(on, 3) if on else None,
                      "s2_brightness_around": round(off, 3), "lon": round(float(ll[0][0]), 5), "lat": round(float(ll[1][0]), 5)})

    audit = {
        "lake": {
            "name": "Plavsko jezero", "osm_area_km2": round(pj.area / 1e6, 3),
            "osm_perimeter_km": round(pj.exterior.length / 1000, 2),
            "osm_extent_m": [round(pj.bounds[2] - pj.bounds[0]), round(pj.bounds[3] - pj.bounds[1])],
            "s2_open_water_km2": round(w_open.sum() * cell / 1e6, 3),
            "s2_vegetated_km2": round(((v_ > 0.3) & ~w_open).sum() * cell / 1e6, 3),
            "s2_open_water_outside_osm_m2": outside_open * cell,
            "open_water_edge_to_mapped_shore_m": sectors,
            "level_glo30_m": lvl,
            "glo30_in_lake_percentiles": dict(zip(["p5", "p50", "p95"], [round(float(v), 2) for v in np.percentile(zz, [5, 50, 95])])),
            "ground_20m_outside_shore_percentiles": dict(zip(["p5", "p50", "p95"], [round(float(v), 2) for v in np.percentile(zshore, [5, 50, 95])])),
            "published": {"area_km2": 2, "elevation_m": 907, "mean_depth_m": 3, "max_depth_m": 9, "source": "https://www.plavto.me/turisticka-ponuda/plavsko-jezero"},
        },
        "marsh_grid": {"cells": int(inside.sum()), "vegetated_cells_gt_0_3": int((veg > 0.3).sum())},
        "rivers": rivers, "river_area_mean_width_m": widths,
        "culverts_dropped": meta["stats"].get("culverts_dropped"), "culvert_m": meta["stats"].get("culvert_m"),
        "bridges": bridges, "piers": piers,
    }
    (out / "water.json").write_text(json.dumps({"marsh": marsh}, separators=(",", ":")))
    d = ROOT / "docs" / "water"; d.mkdir(parents=True, exist_ok=True)
    (d / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=1))
    print(json.dumps(audit["lake"], ensure_ascii=False, indent=1))
    print("marsh", audit["marsh_grid"], "widths", widths)
    for b in bridges: print("bridge", b["name"], b["class"], b["length_m"], b["over"])
    for p in piers: print("pier", p)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
