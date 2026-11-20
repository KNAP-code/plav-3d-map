"""ESTIMATED gardens, courtyards and rural details -> public/data/<area>/gardens.json.

Nothing here is mapped: Plav has no parcel, garden, fence or haystack data in OSM, and the cadastre is not usable
(no licence). These are clearly flagged estimates, drawn only when the viewer's estimates (≈) are on:

  yards    the land around each house: its Voronoi cell among all footprints, at most 12 m from the house, minus
           streets (+0.8 m), other footprints, water and mapped tree cover. Drawn as a slightly mown lawn tint.
  fences   75% of yards get a low fence along the part of the yard edge that faces a street (within 2.5 m of the
           carriageway).
  plots    35% of yards larger than 250 m² get a 4 × 7 m vegetable plot on the side away from the street.
  fruit    0–3 small fruit trees per yard, at least 3 m from the house and 1.5 m from the yard edge, never within 3 m
           of a WorldCover tree that is already drawn.
  hay      haystacks (plast) on mapped meadows (OSM landuse=meadow) within 350 m of a house, about one per 0.6 ha.
Every choice is a deterministic hash, so the same yard always looks the same. Usage: python pipeline/gardens.py [area]
"""
import json
import math
import sys

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import MultiPoint, Point, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT, TO_UTM, coords_list, lines_of, polys_of, rnd, to_local  # noqa: E402


def ring(p, simp=0.3):
    p = shapely.geometry.polygon.orient(p.simplify(simp), 1.0)
    return {"outer": coords_list(p.exterior)[:-1], "holes": [coords_list(i)[:-1] for i in p.interiors if Polygon(i).area > 2]}


def main(area_id="plav-town"):
    area = CONFIG["areas"][area_id]
    W, S, E, N = area["bbox"]
    clon, clat = (W + E) / 2, (S + N) / 2
    ox, oy = TO_UTM.transform(clon, clat)
    origin = np.array([round(ox), round(oy)], dtype=float)
    hw = (E - W) / 2 * 111_320 * math.cos(math.radians(clat)); hh = (N - S) / 2 * 110_950
    core = box(-hw, -hh, hw, hh)
    out_dir = ROOT / "public" / "data" / area_id
    B = json.loads((out_dir / "buildings.json").read_text())["buildings"]
    st = json.loads((out_dir / "streets.json").read_text())
    vec = json.loads((out_dir / "vectors.json").read_text())

    carriage = unary_union([shapely.make_valid(Polygon(p["outer"], p["holes"])) for p in st["carriage"]])
    fps = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in B]
    allfp = unary_union(fps)
    water = unary_union([shapely.make_valid(Polygon(w["outer"], w["holes"])) for w in vec["water"]]) if vec["water"] else Polygon()
    paths = unary_union([shapely.LineString(r["pts"]).buffer(1.0) for r in vec["roads"] if len(r["pts"]) >= 2 and r["c"] not in ("secondary", "tertiary", "residential", "unclassified", "living_street", "service", "unknown", "primary")])
    trees = np.fromfile(out_dir / "trees.bin", dtype=np.float32).reshape(-1, 4)
    ttree = shapely.STRtree(shapely.points(trees[:, :2]))
    blocked = unary_union([carriage.buffer(0.8), water, paths])

    cents = MultiPoint([f.representative_point() for f in fps])
    cells = shapely.voronoi_polygons(cents, extend_to=core.buffer(50))
    cell_tree = shapely.STRtree(list(cells.geoms))
    fp_tree = shapely.STRtree(fps)

    yards, fences, plots, fruit = [], [], [], []
    for i, (b, f) in enumerate(zip(B, fps)):
        area = f.area
        if b.get("kind") == "outbuilding" or area < 40 or b.get("floors", 2) >= 4 or b.get("cls") in ("mosque", "church", "school", "civic", "public", "government", "hospital"):
            continue
        rp = f.representative_point()
        cell = None
        for k in cell_tree.query(rp):
            c = cells.geoms[k]
            if c.contains(rp):
                cell = c
                break
        if cell is None:
            continue
        y = cell.intersection(f.buffer(12, quad_segs=3)).difference(blocked)
        near = [fps[k] for k in fp_tree.query(y) if k != i]
        y = y.difference(unary_union(near + [f])) if near else y.difference(f)
        y = max(polys_of(y), key=lambda p: p.area) if polys_of(y) else None
        if y is None or y.area < 30:
            continue
        y = y.buffer(-0.2).buffer(0.2)
        if y.is_empty or y.geom_type != "Polygon":
            continue
        key = b["id"]
        yards.append(ring(y, 0.8))
        # fence on the street-facing edge
        if rnd(key + "fence") < 0.75:
            edge = y.exterior.intersection(carriage.buffer(2.5))
            for ln in lines_of(edge):
                if ln.length >= 3:
                    fences.append({"pts": coords_list(ln.simplify(0.3)), "k": "wood" if rnd(key + "fk") < 0.6 else "wire"})
        # vegetable plot away from the street
        if y.area > 250 and rnd(key + "plot") < 0.35:
            far = max((p for p in shapely.get_coordinates(y.exterior)), key=lambda c: carriage.distance(Point(c)))
            cx, cy = (far[0] * 0.6 + f.centroid.x * 0.4), (far[1] * 0.6 + f.centroid.y * 0.4)
            ang = b["obb"][2]
            ca, sa = math.cos(ang), math.sin(ang)
            pl = Polygon([(cx + ca * s - sa * t, cy + sa * s + ca * t) for s, t in ((-3.5, -2), (3.5, -2), (3.5, 2), (-3.5, 2))])
            if y.buffer(-0.5).contains(pl) and not pl.intersects(f.buffer(1.5)):
                plots.append({"c": [round(cx, 1), round(cy, 1)], "a": round(ang, 3)})
        # fruit trees
        n = int(rnd(key + "nf") * 3.4)
        inner = y.buffer(-1.5).difference(f.buffer(3.0))
        if n and not inner.is_empty:
            minx, miny, maxx, maxy = inner.bounds
            tries = 0
            placed = []
            while len(placed) < n and tries < 20:
                tries += 1
                px = minx + rnd(f"{key}fx{tries}") * (maxx - minx)
                py = miny + rnd(f"{key}fy{tries}") * (maxy - miny)
                p = Point(px, py)
                if not inner.contains(p) or any(math.hypot(px - q[0], py - q[1]) < 4 for q in placed):
                    continue
                if len(ttree.query(p.buffer(3.0))):
                    continue
                placed.append((px, py))
                fruit.append([round(px, 1), round(py, 1), round(0.45 + rnd(f"{key}fs{tries}") * 0.25, 2)])

    # haystacks on mapped meadows near houses
    lu = pq.read_table(HERE / "cache" / area_id / "land_use.parquet").to_pylist()
    meadows = [to_local(shapely.from_wkb(r["geometry"]), origin) for r in lu if r["class"] in ("meadow", "farmland")]
    meadow = unary_union([g.buffer(0) for g in meadows if g.geom_type in ("Polygon", "MultiPolygon")]).intersection(core)
    near_houses = allfp.buffer(350)
    zone = meadow.intersection(near_houses).difference(unary_union([allfp.buffer(15), carriage.buffer(6), water.buffer(5), paths.buffer(3)]))
    hay = []
    if not zone.is_empty:
        minx, miny, maxx, maxy = zone.bounds
        step = 77.0  # one candidate per ~0.6 ha
        prep = shapely.prepared.prep(zone)
        for gx in np.arange(minx, maxx, step):
            for gy in np.arange(miny, maxy, step):
                k = f"{gx:.0f}:{gy:.0f}"
                px, py = gx + rnd(k + "x") * step, gy + rnd(k + "y") * step
                if rnd(k + "keep") < 0.55 and prep.contains(Point(px, py)):
                    # stacks often stand in small groups
                    for j in range(1 + int(rnd(k + "n") * 2.6)):
                        qx, qy = px + (rnd(f"{k}{j}a") - 0.5) * 14 * (j > 0), py + (rnd(f"{k}{j}b") - 0.5) * 14 * (j > 0)
                        if prep.contains(Point(qx, qy)):
                            hay.append([round(qx, 1), round(qy, 1), round(0.85 + rnd(f"{k}{j}s") * 0.35, 2)])

    data = {"estimate": True,
            "rules": "pipeline/gardens.py docstring; docs/CITY_ESTIMATES.md",
            "yards": yards, "fences": fences, "plots": plots, "fruit": fruit, "hay": hay,
            "stats": {"yards": len(yards), "fences": len(fences), "fence_m": round(sum(LineLen(f["pts"]) for f in fences)),
                      "plots": len(plots), "fruit": len(fruit), "hay": len(hay), "meadow_m2": round(meadow.area)}}
    (out_dir / "gardens.json").write_text(json.dumps(data, separators=(",", ":")))
    print(area_id, data["stats"], f"{(out_dir / 'gardens.json').stat().st_size // 1024} KB")


def LineLen(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
