"""Street surfaces and mapped infrastructure for an area -> public/data/<area>/streets.json.

What is DATA (Overture / OpenStreetMap) and what is ESTIMATE:
  carriage   DATA centrelines + ESTIMATED widths (by road class, as in build.py). The carriageways of all car roads are
             unioned and closed with a 2.5 m radius so junctions get kerb fillets instead of overlapping ribbons.
             Bridge and tunnel spans are left out (bridges are drawn as decks).
  sidewalks  ESTIMATE. OSM has no sidewalk tagging here. 1.8 m footways along secondary/tertiary streets where the
             street is lined with buildings (>= 6 footprints within 45 m of the street piece), cut by every crossing
             carriageway and kept off building footprints.
  bridges    DATA: only the exact bridge ranges of the segments (Overture road_flags "between"), deck width by class.
  power      DATA: mapped power towers / poles and power lines; pylon height is an ESTIMATE (by line type).
  piers      DATA: mapped piers (polygons, or lines buffered 1.5 m).
  pitches    DATA: mapped sports pitches; line markings and goals follow the standard football layout (ESTIMATE of the
             painted lines, scaled to the mapped pitch).
  cemeteries DATA polygons; headstone rows inside them are an ESTIMATE (no grave survey exists) and are flagged in the UI.
Usage: python pipeline/streets.py [area]
"""
import json
import math
import sys

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.ops import orient, unary_union

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT, TO_UTM, coords_list, lines_of, polys_of, to_local  # noqa: E402

WIDTH = {"secondary": 7.5, "tertiary": 6.5, "primary": 8.0, "residential": 5.2, "unclassified": 4.8,
         "living_street": 4.5, "service": 3.6, "unknown": 3.5}
SIDEWALK_CLASSES = {"secondary", "tertiary", "primary"}
SW = 1.8
FILLET = 2.5
TILE = 250.0


def ring(p, simp=0.15):
    p = orient(p.simplify(simp), 1.0)
    return {"outer": coords_list(p.exterior)[:-1], "holes": [coords_list(i)[:-1] for i in p.interiors if Polygon(i).area > 1.0]}


def tiled(geom, core):
    """Cut a (multi)polygon into TILE-sized pieces: smaller triangulation jobs and frustum-cullable meshes."""
    out = []
    minx, miny, maxx, maxy = core.bounds
    for x in np.arange(minx, maxx, TILE):
        for y in np.arange(miny, maxy, TILE):
            cell = box(x, y, x + TILE, y + TILE)
            part = geom.intersection(cell)
            for p in polys_of(part):
                if p.area > 0.5:
                    out.append(ring(p))
    return out


def main(area_id="plav-town"):
    area = CONFIG["areas"][area_id]
    W, S, E, N = area["bbox"]
    clon, clat = (W + E) / 2, (S + N) / 2
    ox, oy = TO_UTM.transform(clon, clat)
    origin = np.array([round(ox), round(oy)], dtype=float)
    hw = (E - W) / 2 * 111_320 * math.cos(math.radians(clat)); hh = (N - S) / 2 * 110_950
    core = box(-hw, -hh, hw, hh)
    out_dir = ROOT / "public" / "data" / area_id
    v = json.loads((out_dir / "vectors.json").read_text())
    b = json.loads((out_dir / "buildings.json").read_text())

    # ---------------- carriageways
    car = [r for r in v["roads"] if r["c"] in WIDTH and not r["bridge"] and not r["tunnel"] and len(r["pts"]) >= 2]
    bufs = []
    for r in car:
        w = WIDTH[r["c"]]
        if r.get("sc") == "driveway":
            w = 3.0
        ls = LineString(r["pts"])
        bufs.append(ls.buffer(w / 2, cap_style="flat", join_style="round"))
        # round the dead ends and the piece ends a little so pieces join without notches
        for pt in (r["pts"][0], r["pts"][-1]):
            bufs.append(shapely.Point(pt).buffer(w / 2, 12))
    carriage = unary_union(bufs)
    carriage = carriage.buffer(FILLET, join_style="round", quad_segs=4).buffer(-FILLET, join_style="round", quad_segs=4)
    carriage = carriage.intersection(core)

    fps = [Polygon(x["fp"]) for x in b["buildings"]]
    fps = [p if p.is_valid else p.buffer(0) for p in fps]
    tree = shapely.STRtree(fps)

    # Phase 3: the ESTIMATED width yields to footprints. Where a road ribbon of estimated width runs under a building,
    # the width (or the footprint) is wrong, and the footprint is data; 275 footprints were overlapped (1,678 m2).
    # The asphalt is cut back to 0.3 m from every footprint, except buildings that a car-road centreline really runs
    # through (canopies/roofs over a road, OSM building=roof), where the road is data too.
    lines = [LineString(r["pts"]) for r in car]
    ltree = shapely.STRtree(lines)
    cut, kept_over = [], 0
    for x, p in zip(b["buildings"], fps):
        if not p.intersects(carriage):
            continue
        inner = p.buffer(-1.0)
        if x.get("cls") == "roof" or (not inner.is_empty and any(lines[k].intersects(inner) for k in ltree.query(inner))):
            kept_over += 1
            continue
        cut.append(p.buffer(0.3, join_style="mitre"))
    before = carriage.area
    if cut:
        carriage = carriage.difference(unary_union(cut))
        carriage = unary_union([q for q in polys_of(carriage) if q.area > 4])
    width_cut = {"footprints": len(cut), "m2": round(before - carriage.area), "kept_roof_over_road": kept_over}

    # ---------------- sidewalks (estimate)
    zone = []
    lined = 0
    for r in car:
        if r["c"] not in SIDEWALK_CLASSES:
            continue
        ls = LineString(r["pts"])
        near = len(tree.query(ls.buffer(45)))
        if near < 6:
            continue
        lined += 1
        w = WIDTH[r["c"]]
        zone.append(ls.buffer(w / 2 + SW, cap_style="flat", join_style="round"))
    sidewalk = unary_union(zone) if zone else Polygon()
    if not sidewalk.is_empty:
        sidewalk = sidewalk.buffer(FILLET, quad_segs=4).buffer(-FILLET, quad_segs=4)
        sidewalk = sidewalk.difference(carriage).difference(unary_union([p.buffer(0.1) for p in fps]))
        sidewalk = sidewalk.intersection(core)
        # drop slivers left between close carriageways
        sidewalk = unary_union([p for p in polys_of(sidewalk) if p.area > 6 and p.minimum_rotated_rectangle.length > 0])
        sidewalk = sidewalk.buffer(-0.3).buffer(0.3)

    # ---------------- bridges (exact flagged ranges)
    bridges = []
    for r in v["roads"]:
        if not r["bridge"] or len(r["pts"]) < 2:
            continue
        w = WIDTH.get(r["c"], 2.2 if r["c"] in ("footway", "path", "cycleway", "pedestrian") else 3.2)
        bridges.append({"c": r["c"], "n": r["n"], "w": w, "pts": r["pts"]})

    # ---------------- mapped infrastructure
    rows = pq.read_table(HERE / "cache" / area_id / "infrastructure.parquet").to_pylist()
    towers, lines, piers = [], [], []
    for r in rows:
        g = to_local(shapely.from_wkb(r["geometry"]), origin)
        c = r["class"]
        if c in ("power_tower", "power_pole") and core.buffer(300).contains(g):
            towers.append({"k": "tower" if c == "power_tower" else "pole", "x": round(g.x, 1), "y": round(g.y, 1)})
        elif c in ("power_line", "minor_line"):
            for ln in lines_of(g.intersection(core.buffer(300))):
                lines.append({"k": "line" if c == "power_line" else "minor", "pts": coords_list(ln)})
        elif c == "pier":
            p = g if g.geom_type == "Polygon" else g.buffer(1.5, cap_style="flat")
            for q in polys_of(p.intersection(core)):
                piers.append(ring(q, 0.1))

    lu = pq.read_table(HERE / "cache" / area_id / "land_use.parquet").to_pylist()
    pitches, cemeteries = [], []
    for r in lu:
        g = to_local(shapely.from_wkb(r["geometry"]), origin)
        if g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        for p in polys_of(g.intersection(core)):
            if r["class"] == "pitch":
                rect = p.minimum_rotated_rectangle
                c = np.array(rect.exterior.coords)[:4]
                e1, e2 = c[1] - c[0], c[2] - c[1]
                l1, l2 = np.linalg.norm(e1), np.linalg.norm(e2)
                ang = math.atan2(*(e1[::-1])) if l1 >= l2 else math.atan2(*(e2[::-1]))
                L, Wd = max(l1, l2), min(l1, l2)
                ctr = c.mean(axis=0)
                pitches.append({"x": round(ctr[0], 1), "y": round(ctr[1], 1), "ang": round(ang, 4), "L": round(L, 1), "W": round(Wd, 1)})
            elif r["class"] in ("cemetery", "grave_yard"):
                cemeteries.append({**ring(p, 0.3), "name": (r["names"] or {}).get("primary")})

    data = {
        "source": "Overture 2026-11-18.0 transportation/infrastructure/land_use (OSM); widths, sidewalks, pylon heights, pitch lines and headstones are estimates",
        "carriage": tiled(carriage, core),
        "sidewalks": tiled(sidewalk, core) if not sidewalk.is_empty else [],
        "bridges": bridges, "towers": towers, "lines": lines, "piers": piers, "pitches": pitches, "cemeteries": cemeteries,
        "stats": {"carriage_m2": round(carriage.area), "sidewalk_m2": round(sidewalk.area) if not sidewalk.is_empty else 0,
                  "sidewalk_streets": lined, "bridges": len(bridges), "towers": len(towers), "lines": len(lines),
                  "piers": len(piers), "pitches": len(pitches), "cemeteries": len(cemeteries), "width_cut_by_footprints": width_cut},
    }
    (out_dir / "streets.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(area_id, data["stats"], f"{(out_dir / 'streets.json').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
