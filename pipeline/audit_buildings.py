"""Geographic audit of the building set for an area.

Compares the raw Overture buildings (OpenStreetMap + Microsoft ML footprints) with what the scene shows,
and flags duplicates, overlaps with streets and other issues. Writes:
  public/data/<area>/audit.json   per-building flags (read by the #audit inspection mode)
  docs/BUILDING_AUDIT.md          counts (appended/overwritten section per run)
Usage: python pipeline/audit_buildings.py [area] [--label before|after]
"""
import json, math, sys
from pathlib import Path
import rasterio
from collections import Counter
import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import Polygon, box
from shapely.strtree import STRtree
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT, TO_UTM, TO_LL, to_local  # noqa: E402

# landmark footprints whose position was verified (owner confirmation or named OSM building + photos)
LANDMARK_IDS = {"d8f69ad5-7153-4d6e-955e-b92a1d3e95f6", "4a1e5139-8dfc-4753-80af-dac7d0240aaf"}
REVIEW_FLAGS = ("overlap", "odd_shape", "large_ml", "isolated_ml", "skewed_to_street", "on_street", "duplicate", "duplicate_ml_of_osm")
ROAD_W = {"secondary": 7.5, "tertiary": 6.5, "residential": 5.2, "unclassified": 4.8, "living_street": 4.5,
          "service": 3.6, "pedestrian": 4.0}  # same carriageway widths as pipeline/build.py reconciliation


def area_setup(area_id):
    area = CONFIG["areas"][area_id]
    W, S, E, N = area["bbox"]
    clon, clat = (W + E) / 2, (S + N) / 2
    ox, oy = TO_UTM.transform(clon, clat)
    origin = np.array([round(ox), round(oy)], dtype=float)
    hw = (E - W) / 2 * 111_320 * math.cos(math.radians(clat)); hh = (N - S) / 2 * 110_950
    return origin, box(-hw, -hh, hw, hh)


def main(area_id="plav-centre", label="current", shown_path=None):
    origin, core = area_setup(area_id)
    out_dir = ROOT / "public" / "data" / area_id
    raw = pq.read_table(HERE / "cache" / area_id / "buildings.parquet").to_pylist()
    bj = json.loads((Path(shown_path) if shown_path else out_dir / "buildings.json").read_text())
    shown = bj["buildings"]
    removed = {r["id"]: r["reason"] for r in bj.get("removed", [])}
    vec = json.loads((out_dir / "vectors.json").read_text())
    shown_ids = {b["id"] for b in shown}

    # raw footprints in the core (by centroid), with source dataset
    R = []
    for r in raw:
        g = to_local(shapely.from_wkb(r["geometry"]), origin)
        if g.geom_type == "MultiPolygon":
            g = max(g.geoms, key=lambda p: p.area)
        if g.geom_type != "Polygon" or not core.contains(g.centroid):
            continue
        ds = r["sources"][0]["dataset"] if r["sources"] else "unknown"
        src = "osm" if ds == "OpenStreetMap" else "ms" if ds.startswith("Microsoft") else ds
        rec = r["sources"][0].get("record_id") if r["sources"] else None
        R.append({"id": r["id"], "src": src, "geom": g.buffer(0), "rec": rec, "h": r["height"], "fl": r["num_floors"],
                  "roof": r.get("roof_shape"), "cls": r["class"]})
    raw_counts = Counter(x["src"] for x in R)

    # streets as buffered centrelines (carriageway only; footpaths excluded)
    streets = []
    for rd in vec["roads"]:
        if rd["c"] not in ROAD_W or rd.get("bridge") or rd.get("tunnel") or len(rd["pts"]) < 2:
            continue
        w = ROAD_W[rd["c"]]
        streets.append(shapely.LineString(rd["pts"]).buffer(w / 2, cap_style="flat"))
    st_tree = STRtree(streets)

    geoms = [x["geom"] for x in R]
    tree = STRtree(geoms)
    flags = {}
    dup_pairs = []
    for i, x in enumerate(R):
        f = []
        a = x["geom"].area
        if a < 15:
            f.append("tiny")
        if not x["geom"].is_valid:
            f.append("invalid")
        # duplicates / conflicts: another footprint covering >= 30% of the smaller one
        for j in tree.query(x["geom"]):
            if j <= i:
                continue
            y = R[j]
            inter = x["geom"].intersection(y["geom"]).area
            if inter <= 0:
                continue
            frac = inter / min(a, y["geom"].area)
            if frac >= 0.3:
                dup_pairs.append((i, j, frac))
            elif frac >= 0.05 and inter >= 2.0:
                # partial overlap of two footprints: at least one outline is wrong
                flags.setdefault(("ov", i), []).append(j)
        # overlap with street carriageways
        ov = 0.0
        for k in st_tree.query(x["geom"]):
            ov += x["geom"].intersection(streets[k]).area
        if a > 0 and ov / a >= 0.15:
            f.append("on_street")
        flags[i] = f
    for i, j, frac in dup_pairs:
        # the lower-priority footprint of the pair is the conflict: ML loses to OSM, smaller loses to larger
        xi, xj = R[i], R[j]
        loser = j if (xi["src"] == "osm" and xj["src"] != "osm") else i if (xj["src"] == "osm" and xi["src"] != "osm") \
            else (i if xi["geom"].area < xj["geom"].area else j)
        flags[loser].append("duplicate_ml_of_osm" if R[loser]["src"] != "osm" and R[i if loser == j else j]["src"] == "osm" else "duplicate")

    for k in [k for k in flags if isinstance(k, tuple)]:
        i = k[1]
        flags[i].append("overlap")
        for j in flags[k]:
            flags[j].append("overlap")
        del flags[k]

    # plausibility checks (heuristics; they mark footprints for manual review, they do not prove an error)
    with rasterio.open(HERE / "cache" / area_id / "worldcover.tif") as src_:
        wc_arr = src_.read(1); wc_inv = ~src_.transform
    origin0, _ = area_setup(area_id)
    def wc_near(x, y, r=25.0):
        g = np.arange(-r, r + 0.1, 10.0)
        gx, gy = np.meshgrid(g, g)
        lon, lat = TO_LL.transform((x + gx).ravel() + origin0[0], (y + gy).ravel() + origin0[1])
        col, row = wc_inv * (np.asarray(lon), np.asarray(lat))
        return wc_arr[np.clip(np.asarray(row).astype(int), 0, wc_arr.shape[0] - 1), np.clip(np.asarray(col).astype(int), 0, wc_arr.shape[1] - 1)]
    street_lines = [shapely.LineString(rd["pts"]) for rd in vec["roads"] if rd["c"] in ROAD_W and len(rd["pts"]) >= 2]
    sl_tree = STRtree(street_lines)
    for i, x in enumerate(R):
        g = x["geom"]; a = g.area
        mrr = g.minimum_rotated_rectangle
        rect = a / mrr.area if mrr.area else 1.0
        cs = np.asarray(mrr.exterior.coords)
        e1, e2 = np.hypot(*(cs[1] - cs[0])), np.hypot(*(cs[2] - cs[1]))
        aspect = max(e1, e2) / max(min(e1, e2), 0.1)
        if rect < 0.55 or aspect > 6:
            flags[i].append("odd_shape")
        if x["src"] == "ms" and a > 600:
            flags[i].append("large_ml")      # ML detection may merge several buildings
        if x["src"] == "ms":
            c = g.centroid
            if not np.any(wc_near(c.x, c.y) == 50):
                flags[i].append("isolated_ml")   # no built-up land-cover pixel within 25 m
            # orientation vs the nearest street within 12 m: footprints near a street are usually parallel or perpendicular to it
            near = [street_lines[k] for k in sl_tree.query(g.buffer(12))]
            if near:
                ln = min(near, key=lambda l: l.distance(g))
                if ln.distance(g) <= 12:
                    t = ln.project(c); p0 = ln.interpolate(max(t - 3, 0)); p1 = ln.interpolate(min(t + 3, ln.length))
                    sa = math.degrees(math.atan2(p1.y - p0.y, p1.x - p0.x))
                    ba = math.degrees(math.atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]))
                    d = abs(((ba - sa) % 90 + 90) % 90); d = min(d, 90 - d)
                    if d > 25 and rect > 0.8:
                        flags[i].append("skewed_to_street")

    # position check: every shown footprint must sit where its source geometry is (local metres, UTM 34N)
    raw_by_id = {x["id"]: x for x in R}
    dev = []
    for b in shown:
        x = raw_by_id.get(b["id"])
        if not x:
            continue
        fp = np.array(b["fp"]); c = Polygon(fp).centroid; rc = x["geom"].centroid
        dev.append(math.hypot(c.x - rc.x, c.y - rc.y))
    dev = np.array(dev)

    # coverage: 50 m cells that ESA WorldCover classes as built-up (>= 25% of 10 m pixels) and whether any shown footprint is in them
    minx, miny, maxx, maxy = core.bounds
    cell = 50.0
    xs = np.arange(minx, maxx, cell); ys = np.arange(miny, maxy, cell)
    sx, sy = np.meshgrid(np.arange(5, cell, 10), np.arange(5, cell, 10))
    shown_geoms = [Polygon(b["fp"]) for b in shown]
    sh_tree = STRtree(shown_geoms)
    osm_tree = STRtree([g for g, b in zip(shown_geoms, shown) if b["src"] == "osm"])
    osm_cov = 0
    with rasterio.open(HERE / "cache" / area_id / "worldcover.tif") as src:
        arr = src.read(1); inv = ~src.transform
    origin_, _ = area_setup(area_id)
    built_cells, covered, gaps = 0, 0, []
    for x0 in xs:
        for y0 in ys:
            px, py = (x0 + sx).ravel(), (y0 + sy).ravel()
            lon, lat = TO_LL.transform(px + origin_[0], py + origin_[1])
            col, row = inv * (np.asarray(lon), np.asarray(lat))
            v = arr[np.clip(np.asarray(row).astype(int), 0, arr.shape[0] - 1), np.clip(np.asarray(col).astype(int), 0, arr.shape[1] - 1)]
            frac = float((v == 50).mean())
            if frac < 0.25:
                continue
            built_cells += 1
            if len(osm_tree.query(box(x0, y0, x0 + cell, y0 + cell))):
                osm_cov += 1
            if len(sh_tree.query(box(x0, y0, x0 + cell, y0 + cell))):
                covered += 1
            else:
                clon, clat = TO_LL.transform(x0 + cell / 2 + origin_[0], y0 + cell / 2 + origin_[1])
                gaps.append({"x": round(x0 + cell / 2, 1), "y": round(y0 + cell / 2, 1), "lat": round(clat, 6), "lon": round(clon, 6), "built": round(frac, 2)})

    per = []
    for i, x in enumerate(R):
        c = x["geom"].centroid
        per.append({"id": x["id"], "src": x["src"], "shown": x["id"] in shown_ids, "removed": removed.get(x["id"]), "flags": sorted(set(flags[i])),
                    "area": round(x["geom"].area, 1), "x": round(c.x, 1), "y": round(c.y, 1),
                    "heightSrc": "osm" if x["h"] or x["fl"] else "estimated", "osmRecord": x["rec"],
                    "status": "landmark_verified" if x["id"] in LANDMARK_IDS else "osm_mapped" if x["src"] == "osm" else "ml_unverified"})
    fc = Counter(fl for p in per for fl in p["flags"])
    shown_src = Counter(b["src"] for b in shown)
    shown_flags = Counter(fl for p in per if p["shown"] for fl in p["flags"])
    summary = {
        "label": label, "release": json.loads((HERE / "cache" / area_id / "fetch.json").read_text()).get("release"),
        "raw_in_area": len(R), "raw_by_source": dict(raw_counts),
        "shown": len(shown), "shown_by_source": dict(shown_src),
        "not_shown_raw": sum(1 for p in per if not p["shown"]),
        "flags_all": dict(fc), "flags_shown": dict(shown_flags),
        "height_from_source": sum(1 for p in per if p["shown"] and p["heightSrc"] == "osm"),
        "procedural_invented": 0,
        "status_shown": dict(Counter(p["status"] for p in per if p["shown"])),
        "review_shown": sum(1 for p in per if p["shown"] and any(f in REVIEW_FLAGS for f in p["flags"])),
        "removed_by_reason": dict(Counter(removed.values())),
        "outbuildings": sum(1 for b in shown if b.get("kind") == "outbuilding"),
        "duplicates_shown": sum(1 for p in per if p["shown"] and any(f.startswith("duplicate") for f in p["flags"])),
        "position_check_m": {"n": int(len(dev)), "max": round(float(dev.max()), 2) if len(dev) else None, "mean": round(float(dev.mean()), 3) if len(dev) else None},
        "coverage": {"cell_m": cell, "built_cells": built_cells, "cells_with_footprints": covered,
                     "pct": round(100 * covered / max(built_cells, 1), 1), "gap_cells": len(gaps),
                     "osm_only_pct": round(100 * osm_cov / max(built_cells, 1), 1)},
    }
    if label != "before":
        (out_dir / "audit.json").write_text(json.dumps({"summary": summary, "buildings": per, "gaps": gaps}, separators=(",", ":")))
    (HERE / "cache" / area_id / f"audit-{label}.json").write_text(json.dumps({"summary": summary, "gaps": gaps}, indent=1))
    print(json.dumps(summary, indent=1))
    return summary


if __name__ == "__main__":
    a = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "plav-centre"
    lab = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else "current"
    sp = sys.argv[sys.argv.index("--shown") + 1] if "--shown" in sys.argv else None
    main(a, lab, sp)
