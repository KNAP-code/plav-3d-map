"""Turn the cached raw data for one area into compact web assets in public/data/<area>/.

Usage:  python build.py plav-centre

Coordinate system: UTM zone 34N (EPSG:32634), shifted to a local origin at the centre
of the area. Units are metres; +x = east, +y = north. The web client maps (x, y, h) to
Three.js (x, h, -y).

Everything here is real data except the values explicitly marked as estimates:
building heights (when OSM has none), roof shapes, tree species/size and road widths.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import rasterio
import shapely
import shapely.ops
from PIL import Image
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import LineString, MultiLineString, Polygon, box, mapping
from shapely.ops import orient, unary_union

HERE = Path(__file__).parent
ROOT = HERE.parent
CONFIG = json.loads((HERE / "areas.json").read_text())
RULES_VERSION = "estimate-rules-v1"

TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32634", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:32634", "EPSG:4326", always_xy=True)


def h32(s: str) -> int:
    return int.from_bytes(hashlib.blake2b(s.encode(), digest_size=4).digest(), "little")


def rnd(s: str) -> float:
    return h32(s) / 2**32


class Grid:
    """Regular local-metre grid with bilinear sampling."""

    def __init__(self, x0, y0, nx, ny, step):
        self.x0, self.y0, self.nx, self.ny, self.step = x0, y0, nx, ny, step
        xs = x0 + np.arange(nx) * step
        ys = y0 + np.arange(ny) * step
        self.X, self.Y = np.meshgrid(xs, ys)  # row = y index (south -> north)

    def sample(self, arr, x, y):
        fx = np.clip((np.asarray(x) - self.x0) / self.step, 0, self.nx - 1.001)
        fy = np.clip((np.asarray(y) - self.y0) / self.step, 0, self.ny - 1.001)
        return ndimage.map_coordinates(arr, [fy, fx], order=1, mode="nearest")


def local_to_ll(x, y, origin):
    lon, lat = TO_LL.transform(np.asarray(x) + origin[0], np.asarray(y) + origin[1])
    return lon, lat


def sample_raster(path, lon, lat, order=1, smooth_sigma=0.0):
    with rasterio.open(path) as src:
        arr = src.read(1).astype(np.float32)
        inv = ~src.transform
    if smooth_sigma > 0:
        arr = ndimage.gaussian_filter(arr, smooth_sigma)
    col, row = inv * (np.asarray(lon), np.asarray(lat))
    return ndimage.map_coordinates(arr, [np.asarray(row) - 0.5, np.asarray(col) - 0.5], order=order, mode="nearest")


def to_local(geom, origin):
    return shapely.transform(geom, lambda c: np.column_stack(TO_UTM.transform(c[:, 0], c[:, 1])) - origin)


def r1(v):
    return round(float(v), 1)


def coords_list(ls):
    return [[r1(x), r1(y)] for x, y in ls.coords]


def lines_of(g):
    if g.is_empty:
        return []
    if isinstance(g, LineString):
        return [g]
    if isinstance(g, MultiLineString):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, LineString)]


def polys_of(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def poly_json(p: Polygon, simplify=0.5):
    p = orient(p.simplify(simplify), 1.0)
    return {"outer": coords_list(p.exterior)[:-1], "holes": [coords_list(i)[:-1] for i in p.interiors]}


# ---------------------------------------------------------------- estimates (rules v1)
FLOOR_H = 2.9
FLAT_CLASSES = {"industrial", "warehouse", "garage", "garages", "carport", "roof", "parking", "service", "transformer_tower"}


def estimate_building(bid, area, aspect, cls, osm_h, osm_floors):
    """Return (floors, eave_height_m, height_source). Documented in DATA_SOURCES.md."""
    if osm_h:
        return max(1, round(osm_h / FLOOR_H)), float(osm_h), "osm:height"
    if osm_floors:
        return int(osm_floors), osm_floors * FLOOR_H + 0.6, "osm:levels"
    r = rnd(bid + "floors")
    if cls in ("garage", "garages", "shed", "hut", "carport", "roof"):
        floors = 1
    elif area < 35:
        floors = 1
    elif area < 80:
        floors = 2 if r < 0.6 else 1
    elif area < 220:
        floors = 2 if r < 0.7 else 3
    elif area < 500:
        floors = 3 if r < 0.6 else 4
    else:
        floors = 3 if r < 0.7 else 2
    if cls in ("mosque", "church"):
        floors = max(floors, 2)
    return floors, floors * FLOOR_H + 0.6, "estimated"


def estimate_roof(bid, area, aspect, rectangularity, cls):
    if cls in FLAT_CLASSES or area > 1500:
        return "flat"
    if cls in ("mosque",):
        return "hip"
    if rectangularity < 0.55:
        return "flat"
    if aspect >= 1.6:
        return "gable" if rnd(bid + "roof") < 0.6 else "hip"
    return "hip"


def obb(poly: Polygon):
    rect = poly.minimum_rotated_rectangle
    c = np.array(rect.exterior.coords)[:4]
    e1, e2 = c[1] - c[0], c[2] - c[1]
    l1, l2 = np.linalg.norm(e1), np.linalg.norm(e2)
    if l1 >= l2:
        ang, L, W = math.atan2(e1[1], e1[0]), l1, l2
    else:
        ang, L, W = math.atan2(e2[1], e2[0]), l2, l1
    ctr = c.mean(axis=0)
    return ctr, ang, L, W, rect.area


# ---------------------------------------------------------------- main build
def build(area_id: str):
    area = CONFIG["areas"][area_id]
    cache = HERE / "cache" / area_id
    out = ROOT / "public" / "data" / area_id
    out.mkdir(parents=True, exist_ok=True)
    W, S, E, N = area["bbox"]
    clon, clat = (W + E) / 2, (S + N) / 2
    ox, oy = TO_UTM.transform(clon, clat)
    origin = np.array([round(ox), round(oy)], dtype=float)
    half_w = (E - W) / 2 * 111_320 * math.cos(math.radians(clat))
    half_h = (N - S) / 2 * 110_950
    core_rect = box(-half_w, -half_h, half_w, half_h)
    R = area["context_radius_m"]
    print(f"[{area_id}] core {2*half_w:.0f} x {2*half_h:.0f} m, origin UTM34N {origin.tolist()}")

    # ---------- terrain grids
    g = area["core_grid_m"]
    nx, ny = int(math.ceil(2 * half_w / g)) + 1, int(math.ceil(2 * half_h / g)) + 1
    core = Grid(-half_w, -half_h, nx, ny, g)
    lon, lat = local_to_ll(core.X, core.Y, origin)
    dem = cache / "dem.tif"
    core_h = sample_raster(dem, lon, lat, order=3, smooth_sigma=0.8).astype(np.float64)

    cg = area["context_grid_m"]
    cn = int(2 * R / cg) + 1
    ctx = Grid(-R, -R, cn, cn, cg)
    clon_, clat_ = local_to_ll(ctx.X, ctx.Y, origin)
    ctx_h = sample_raster(dem, clon_, clat_, order=1, smooth_sigma=0.6).astype(np.float64)
    raw_lake_sample = (dem, core, ctx)

    # ---------- water
    wt = pq.read_table(cache / "water.parquet").to_pylist()
    ctx_rect = box(-R, -R, R, R)
    water_polys, water_lines = [], []
    for r in wt:
        geom = to_local(shapely.from_wkb(r["geometry"]), origin)
        name = (r["names"] or {}).get("primary")
        if geom.geom_type in ("Polygon", "MultiPolygon"):
            gclip = geom.intersection(ctx_rect)
            for p in polys_of(gclip):
                if p.area < 30:
                    continue
                water_polys.append({"geom": p, "kind": r["subtype"] or r["class"], "class": r["class"], "name": name})
        elif geom.geom_type in ("LineString", "MultiLineString"):
            for ls in lines_of(geom.intersection(core_rect.buffer(150))):
                water_lines.append({"geom": ls, "class": r["class"], "name": name})

    # Lakes are flat: level from the DEM inside the polygon (GLO-30 flattens water bodies).
    def level_of(p):
        minx, miny, maxx, maxy = p.bounds
        gx, gy = np.meshgrid(np.arange(minx, maxx, 20.0), np.arange(miny, maxy, 20.0))
        m = shapely.contains_xy(p.buffer(-10), gx, gy)
        xs, ys = gx[m], gy[m]
        if len(xs) == 0:
            rp = p.representative_point(); xs, ys = np.array([rp.x]), np.array([rp.y])
        llon, llat = local_to_ll(xs, ys, origin)
        v = sample_raster(dem, llon, llat, order=0)
        return float(np.percentile(v, 20))

    def carve(grid: Grid, H):
        for w in water_polys:
            p = w["geom"]
            minx, miny, maxx, maxy = p.buffer(30).bounds
            sel = (grid.X >= minx) & (grid.X <= maxx) & (grid.Y >= miny) & (grid.Y <= maxy)
            if not sel.any():
                continue
            xs, ys = grid.X[sel], grid.Y[sel]
            inside = shapely.contains_xy(p, xs, ys)
            hs = H[sel]
            if w["flat"]:
                lvl = w["level"]
                bank = shapely.contains_xy(p.buffer(25), xs, ys) & ~inside
                hs = np.where(inside, np.minimum(hs, lvl - 2.0), hs)
                hs = np.where(bank, np.maximum(hs, lvl + 0.35), hs)
            else:
                hs = np.where(inside, hs - 1.6, hs)
            H[sel] = hs

    for w in water_polys:
        w["flat"] = w["class"] in ("lake", "reservoir", "pond", "basin", "lagoon") or w["kind"] in ("lake", "reservoir", "pond")
        w["level"] = level_of(w["geom"]) if w["flat"] else None
    carve(core, core_h)
    carve(ctx, ctx_h)
    # streams: shallow channel in the core grid
    for wl in water_lines:
        width = {"river": 7.0, "stream": 2.5, "canal": 3.0}.get(wl["class"], 1.5)
        ch = wl["geom"].buffer(width / 2 + 1.0)
        minx, miny, maxx, maxy = ch.bounds
        sel = (core.X >= minx) & (core.X <= maxx) & (core.Y >= miny) & (core.Y <= maxy)
        if sel.any():
            inside = shapely.contains_xy(ch, core.X[sel], core.Y[sel])
            core_h[sel] = np.where(inside, core_h[sel] - 0.6, core_h[sel])

    # Context grid: sink the part under the detailed core so the two meshes never z-fight.
    inner = (np.abs(ctx.X) < half_w - cg) & (np.abs(ctx.Y) < half_h - cg)
    ctx_h[inner] -= 4.0

    # ---------- land cover (ESA WorldCover) -> blended RGB weights
    wc = cache / "worldcover.tif"

    def cover_texture(grid: Grid, sigma):
        llon, llat = local_to_ll(grid.X, grid.Y, origin)
        cls = sample_raster(wc, llon, llat, order=0).astype(np.int32)
        r_ = (cls == 10).astype(np.float32)
        g_ = np.isin(cls, [20, 30, 40, 90, 100]).astype(np.float32)
        b_ = np.isin(cls, [50, 60]).astype(np.float32)
        img = np.stack([ndimage.gaussian_filter(c, sigma) for c in (r_, g_, b_)], axis=-1)
        return (np.clip(img, 0, 1) * 255).astype(np.uint8)[::-1]  # top row = north

    Image.fromarray(cover_texture(core, 1.0)).save(out / "cover_core.png", optimize=True)
    Image.fromarray(cover_texture(ctx, 0.8)).save(out / "cover_context.png", optimize=True)

    # ---------- buildings
    bt = pq.read_table(cache / "buildings.parquet").to_pylist()
    buildings, bpolys = [], []
    stats = {"total": 0, "OpenStreetMap": 0, "Microsoft ML Buildings": 0, "other": 0,
             "height_from_osm": 0, "height_estimated": 0, "roof_estimated": 0}
    for r in bt:
        poly = to_local(shapely.from_wkb(r["geometry"]), origin)
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda p: p.area)
        if poly.geom_type != "Polygon" or not core_rect.contains(poly.centroid):
            continue
        poly = orient(Polygon(poly.exterior).simplify(0.2), 1.0)
        if poly.area < 8 or not poly.is_valid:
            continue
        bid = r["id"]
        ds = r["sources"][0]["dataset"] if r["sources"] else "unknown"
        cls = r["class"]
        name = (r["names"] or {}).get("primary")
        ctr, ang, L, Wd, oarea = obb(poly)
        rect = poly.area / oarea if oarea else 1
        aspect = L / max(Wd, 0.1)
        floors, eave, hsrc = estimate_building(bid, poly.area, aspect, cls, r["height"], r["num_floors"])
        roof = estimate_roof(bid, poly.area, aspect, rect, cls)
        ring = np.array(poly.exterior.coords)[:-1]
        ground = core.sample(core_h, ring[:, 0], ring[:, 1])
        gmid = float(core.sample(core_h, [poly.centroid.x], [poly.centroid.y])[0])
        stats["total"] += 1
        stats[ds if ds in stats else "other"] += 1
        stats["height_from_osm" if hsrc != "estimated" else "height_estimated"] += 1
        stats["roof_estimated"] += 1
        buildings.append({
            "id": bid,
            "src": "osm" if ds == "OpenStreetMap" else ("ms" if ds.startswith("Microsoft") else ds),
            "cls": cls, "name": name,
            "fp": [[r1(x), r1(y)] for x, y in ring],
            "g0": r1(min(ground.min(), gmid)), "g1": r1(max(ground.max(), gmid)),
            "eave": r1(eave), "floors": floors, "hSrc": hsrc,
            "roof": roof, "roofSrc": "estimated",
            "obb": [r1(ctr[0]), r1(ctr[1]), round(ang, 4), r1(L), r1(Wd)],
            "v": h32(bid) % 997,
        })
        bpolys.append(poly)
    print(f"  buildings: {stats}")

    # ---------- minarets (OSM tower:type=minaret via Overture infrastructure)
    minarets = []
    it = pq.read_table(cache / "infrastructure.parquet").to_pylist()
    for r in it:
        if r["class"] == "minaret":
            p = to_local(shapely.from_wkb(r["geometry"]), origin)
            p = p.centroid
            if core_rect.contains(p):
                minarets.append({"x": r1(p.x), "y": r1(p.y), "g": r1(core.sample(core_h, [p.x], [p.y])[0]),
                                 "height": 24.0, "hSrc": "estimated"})

    # ---------- roads
    # Segments are split at every Overture connector so each road piece is a graph edge whose
    # endpoints are junction nodes ("j0"/"j1" = connector index). The viewer uses this topology for
    # junction patches and for the decorative traffic routes.
    seg = pq.read_table(cache / "segments.parquet").to_pylist()
    roads, road_buf = [], []
    conn_idx: dict[str, int] = {}
    def node_id(cid):
        if cid not in conn_idx:
            conn_idx[cid] = len(conn_idx)
        return conn_idx[cid]
    for r in seg:
        if r["subtype"] not in ("road",):
            continue
        full = to_local(shapely.from_wkb(r["geometry"]), origin)
        flags = set()
        for f in r["road_flags"] or []:
            flags.update(f.get("values") or [])
        surf = None
        for f in r["road_surface"] or []:
            if f.get("between") is None:
                surf = f.get("value")
        spd = None
        for f in r["speed_limits"] or []:
            ms = (f.get("max_speed") or {})
            if f.get("between") is None and ms.get("value"):
                spd = ms["value"] * (1.609 if ms.get("unit") == "mph" else 1)
        cons = sorted([(c["at"], c["connector_id"]) for c in (r["connectors"] or [])])
        if not cons or cons[0][0] > 1e-6:
            cons = [(0.0, None)] + cons
        if cons[-1][0] < 1 - 1e-6:
            cons = cons + [(1.0, None)]
        for (a0, c0), (a1, c1) in zip(cons[:-1], cons[1:]):
            if a1 - a0 < 1e-6:
                continue
            piece = shapely.ops.substring(full, a0, a1, normalized=True) if (a0 > 0 or a1 < 1) else full
            clipped = piece.intersection(core_rect)
            inside = piece.within(core_rect)
            for ls in lines_of(clipped):
                if ls.length < 1:
                    continue
                ls = ls.simplify(0.3)
                rec = {"c": r["class"] or "unknown", "n": (r["names"] or {}).get("primary"),
                       "bridge": "is_bridge" in flags, "tunnel": "is_tunnel" in flags,
                       "pts": coords_list(ls)}
                if r.get("subclass"):
                    rec["sc"] = r["subclass"]
                if surf:
                    rec["surf"] = surf
                if spd:
                    rec["spd"] = round(spd)
                # graph endpoints only when the piece was not cut by the area boundary
                if inside and c0:
                    rec["j0"] = node_id(c0)
                if inside and c1:
                    rec["j1"] = node_id(c1)
                roads.append(rec)
            w = {"secondary": 7, "tertiary": 6, "residential": 5, "unclassified": 4.5, "service": 3.5,
                 "pedestrian": 4, "track": 3, "living_street": 4.5}.get(r["class"], 1.6)
            for ls in lines_of(clipped):
                if ls.length >= 1:
                    road_buf.append(ls.buffer(w / 2 + 0.8, cap_style="flat"))

    # pedestrian crossings (OSM highway=crossing nodes via Overture infrastructure)
    crossings = []
    for r in it:
        if r["class"] == "crossing":
            p = to_local(shapely.from_wkb(r["geometry"]), origin).centroid
            if core_rect.contains(p):
                crossings.append([r1(p.x), r1(p.y)])

    # ---------- land use overlays
    overlays = []
    keep = {"pitch": "pitch", "stadium": "pitch", "cemetery": "cemetery", "grave_yard": "cemetery",
            "pedestrian": "paving", "plaza": "paving", "parking": "paving", "playground": "playground",
            "park": "park", "grass": "park", "recreation_ground": "park"}
    for r in pq.read_table(cache / "land_use.parquet").to_pylist() + it:
        k = keep.get(r["class"])
        if not k:
            continue
        geom = to_local(shapely.from_wkb(r["geometry"]), origin)
        if geom.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        for p in polys_of(geom.intersection(core_rect)):
            if p.area > 40:
                overlays.append({"k": k, **poly_json(p, 0.3)})

    # ---------- trees from ESA WorldCover tree-cover pixels (positions jittered within pixel)
    with rasterio.open(wc) as src:
        arr = src.read(1)
        T = src.transform
    rows, cols = np.nonzero(arr == 10)
    plon, plat = T * (cols + 0.5, rows + 0.5)
    px, py = TO_UTM.transform(plon, plat)
    px, py = np.asarray(px) - origin[0], np.asarray(py) - origin[1]
    sel = (np.abs(px) < half_w - 2) & (np.abs(py) < half_h - 2)
    px, py, rows, cols = px[sel], py[sel], rows[sel], cols[sel]
    cand_x, cand_y, cand_k = [], [], []
    for i in range(len(px)):
        key = f"{rows[i]}:{cols[i]}"
        for j, p_keep in enumerate((0.92, 0.45)):
            if rnd(key + f"k{j}") > p_keep:
                continue
            cand_x.append(px[i] + (rnd(key + f"x{j}") - 0.5) * 9.0)
            cand_y.append(py[i] + (rnd(key + f"y{j}") - 0.5) * 9.0)
            cand_k.append(key + str(j))
    cand_x, cand_y = np.array(cand_x), np.array(cand_y)
    blocked = unary_union([p.buffer(1.5) for p in bpolys] + road_buf + [w["geom"] for w in water_polys])
    ok = ~shapely.contains_xy(blocked, cand_x, cand_y)
    th = core.sample(core_h, cand_x, cand_y)
    trees = []
    for i in np.nonzero(ok)[0]:
        k = cand_k[i]
        conifer_p = min(0.7, max(0.12, (th[i] - 950) / 300))
        kind = 1 if rnd(k + "t") < conifer_p else 0
        scale = 0.75 + rnd(k + "s") * 0.6
        trees.append((cand_x[i], cand_y[i], scale, kind + (h32(k) % 4) * 0.25 * 0))
    tree_arr = np.array(trees, dtype=np.float32).reshape(-1, 4)
    tree_arr.tofile(out / "trees.bin")
    print(f"  trees: {len(tree_arr)} (from {len(px)} WorldCover tree pixels)")

    # ---------- building reconciliation (geographic accuracy rules v2, see docs/BUILDING_AUDIT.md)
    # OpenStreetMap footprints are always kept (human-mapped). Microsoft ML footprints are machine-detected from
    # imagery: dropped when tiny (< 15 m², usually fragments) or when >= 15% of the footprint lies on a mapped street
    # carriageway (the detection conflicts with a human-mapped street). ML footprints under 30 m² are shown as
    # single-storey outbuildings. Nothing is moved, reshaped or added.
    widths = {"secondary": 7.5, "tertiary": 6.5, "residential": 5.2, "unclassified": 4.8, "living_street": 4.5,
              "service": 3.6, "pedestrian": 4.0}
    street_geoms = [shapely.LineString(rd["pts"]).buffer(widths.get(rd["c"], 3.5) / 2, cap_style="flat")
                    for rd in roads if rd["c"] in widths and not rd.get("bridge") and not rd.get("tunnel") and len(rd["pts"]) >= 2]
    st_tree = shapely.STRtree(street_geoms)
    kept, removed = [], []
    for b, poly in zip(buildings, bpolys):
        on_street = sum(poly.intersection(street_geoms[k]).area for k in st_tree.query(poly)) / max(poly.area, 1e-6)
        b["onStreet"] = round(on_street, 2)
        if b["src"] == "ms" and poly.area < 15:
            removed.append({"id": b["id"], "src": b["src"], "reason": "tiny_ml", "fp": b["fp"]}); continue
        if b["src"] == "ms" and on_street >= 0.15:
            removed.append({"id": b["id"], "src": b["src"], "reason": "ml_on_street", "fp": b["fp"]}); continue
        if b["src"] == "ms" and poly.area < 30 and b["hSrc"] == "estimated":
            b["kind"] = "outbuilding"; b["floors"] = 1; b["eave"] = 2.6
            b["roof"] = "gable" if b["roof"] != "flat" else "flat"
        kept.append(b)
    stats["removed_tiny_ml"] = sum(1 for r in removed if r["reason"] == "tiny_ml")
    stats["removed_ml_on_street"] = sum(1 for r in removed if r["reason"] == "ml_on_street")
    stats["outbuildings_ml"] = sum(1 for b in kept if b.get("kind") == "outbuilding")
    stats["osm_on_street_kept"] = sum(1 for b in kept if b["src"] == "osm" and b["onStreet"] >= 0.15)
    buildings = kept
    print(f"  reconciliation: kept {len(kept)}, removed {len(removed)}, {stats}")

    # ---------- terrain binaries
    def save_heights(H, path, scale):
        base = math.floor(H.min()) - 1
        q = np.clip(np.round((H - base) * scale), 0, 65535).astype("<u2")
        q.tofile(path)
        return base

    core_base = save_heights(core_h, out / "terrain_core.bin", 100)
    ctx_base = save_heights(ctx_h, out / "terrain_context.bin", 10)

    # ---------- vectors json
    water_out = []
    for w in water_polys:
        water_out.append({"kind": "lake" if w["flat"] else "river", "name": w["name"],
                          "level": r1(w["level"]) if w["flat"] else None, **poly_json(w["geom"], 0.8)})
    streams = [{"c": wl["class"], "n": wl["name"], "pts": coords_list(wl["geom"].simplify(0.5))}
               for wl in water_lines if wl["geom"].length > 2]

    (out / "buildings.json").write_text(json.dumps({"rules": RULES_VERSION, "buildings": buildings, "removed": removed, "minarets": minarets},
                                                   ensure_ascii=False, separators=(",", ":")))
    (out / "vectors.json").write_text(json.dumps({"roads": roads, "crossings": crossings, "water": water_out, "streams": streams,
                                                  "overlays": overlays}, ensure_ascii=False, separators=(",", ":")))

    landmarks = [{"name": b["name"], "x": r1(np.mean([p[0] for p in b["fp"]])), "y": r1(np.mean([p[1] for p in b["fp"]])),
                  "cls": b["cls"]} for b in buildings if b["name"]]
    fetch = json.loads((cache / "fetch.json").read_text())
    meta = {
        "area": area_id, "title": area["title"], "bbox": area["bbox"],
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "crs": "EPSG:32634", "origin": origin.tolist(),
        "core": {"x0": core.x0, "y0": core.y0, "nx": nx, "ny": ny, "step": g, "base": core_base, "scale": 100,
                 "file": "terrain_core.bin", "cover": "cover_core.png"},
        "context": {"x0": ctx.x0, "y0": ctx.y0, "nx": cn, "ny": cn, "step": cg, "base": ctx_base, "scale": 10,
                    "file": "terrain_context.bin", "cover": "cover_context.png", "coreSink": 4.0},
        "extent": {"halfW": r1(half_w), "halfH": r1(half_h)},
        "treesFile": "trees.bin",
        "stats": {**stats, "trees": int(len(tree_arr)), "roads": len(roads), "water": len(water_out),
                  "minarets": len(minarets)},
        "landmarks": landmarks,
        "estimates": {
            "rules": RULES_VERSION,
            "building_height": "OSM height/levels when present, otherwise floors from footprint area (see DATA_SOURCES.md)",
            "roof": "all roof shapes are estimated (no roof data in OSM for this area)",
            "trees": "positions from ESA WorldCover 10 m tree-cover pixels, jittered inside each pixel; species and size are stylised",
            "road_width": "by road class (OSM has no widths here)",
            "minaret_height": "24 m stylised",
        },
        "sources": {
            "overture_release": fetch["release"],
            "attribution": [
                "© OpenStreetMap contributors (ODbL)",
                "Microsoft Global ML Building Footprints via Overture Maps (ODbL)",
                "Overture Maps Foundation",
                "ESA WorldCover 10 m 2021 v200 (CC BY 4.0)",
                "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
            ],
        },
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    sizes = {p.name: p.stat().st_size for p in out.iterdir()}
    print(f"  wrote {out.relative_to(ROOT)}: {sizes}")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "plav-centre")
