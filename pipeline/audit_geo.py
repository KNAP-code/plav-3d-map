"""Independent geographic accuracy audit of every building footprint in an area.

The building set is Overture 2026-11-18.0 (OpenStreetMap + Microsoft ML footprints). This audit checks it against
evidence that is legally usable and independent of those two datasets:

  * Copernicus Sentinel-2 L2A, median of three cloud-free summer 2025 scenes (pipeline/fetch_s2.py, free and open
    licence). A roof lowers NDVI where it stands compared with the ground around it. The test is calibrated on
    the 764 OSM footprints (mapped by people) against the same shapes moved onto open ground, so the reported
    detection rates are measured, not assumed.
  * ESA WorldCover 2021 v200 (CC BY 4.0), built-up class.
  * The OSM street, rail and water network, which is a separate data layer from the footprints.

It never creates or moves geometry. Checks:
  overlap     two shown footprints share >= 2 m² and >= 5 % of the smaller one
  duplicate   two shown footprints share >= 50 % of the smaller one
  road        an OSM carriageway centreline (not bridge or tunnel) runs >= 1 m inside a footprint
  water       >= 25 % of a footprint lies in a mapped water polygon
  density     50 m cells with building cover above the densest OSM-mapped centre cell
  imagery     Sentinel-2 NDVI contrast (ring minus footprint), per footprint, classified as
              detected / not resolvable (too small for 10 m pixels) / not detected
  offset      whole-layer shift of OSM and ML footprints against Sentinel-2 (cross-correlation, 1 m steps)

A footprint is only called a demonstrable error when two independent sources agree (for example OSM water + an
open-water Sentinel-2 signal, or an OSM road through it + a Sentinel-2 road signal and no roof signal).
Writes pipeline/cache/<area>/audit-geo.json and public/data/<area>/audit_geo.json (per-building verdicts).
Usage: python pipeline/audit_geo.py [area]
"""
import json
import math
import sys
from collections import Counter

import numpy as np
import rasterio
import shapely
import shapely.affinity
import shapely.prepared
from shapely.geometry import Polygon, box
from shapely.strtree import STRtree

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT, TO_LL, TO_UTM  # noqa: E402

CAR = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service"}


def setup(area_id):
    W, S, E, N = CONFIG["areas"][area_id]["bbox"]
    ox, oy = TO_UTM.transform((W + E) / 2, (S + N) / 2)
    hw = (E - W) / 2 * 111_320 * math.cos(math.radians((S + N) / 2)); hh = (N - S) / 2 * 110_950
    return np.array([round(ox), round(oy)], float), box(-hw, -hh, hw, hh)


class S2:
    def __init__(self, path, origin):
        with rasterio.open(path) as r:
            a = r.read(); self.T = r.transform
        b04, b08, b11, b03 = a[2], a[3], a[4], a[1]
        self.ndvi = (b08 - b04) / np.maximum(b08 + b04, 1e-4)
        self.ndwi = (b03 - b08) / np.maximum(b03 + b08, 1e-4)
        self.ndbi = (b11 - b08) / np.maximum(b11 + b08, 1e-4)
        self.o = origin
        self.x0, self.y1 = self.T.c - origin[0], self.T.f - origin[1]

    def idx(self, x, y):
        c = ((np.asarray(x) - self.x0) / 10).astype(int); r = ((self.y1 - np.asarray(y)) / 10).astype(int)
        return np.clip(r, 0, self.ndvi.shape[0] - 1), np.clip(c, 0, self.ndvi.shape[1] - 1)

    def mean_in(self, g, arr, step=1.0):
        """Area-weighted mean of a 10 m raster over a polygon (1 m point sampling)."""
        minx, miny, maxx, maxy = g.bounds
        xs, ys = np.meshgrid(np.arange(minx + step / 2, maxx, step), np.arange(miny + step / 2, maxy, step))
        pts = shapely.points(xs.ravel(), ys.ravel())
        m = shapely.contains(g, pts)
        if not m.any():
            c = g.representative_point(); r, cc = self.idx([c.x], [c.y]); return float(arr[r, cc][0])
        r, cc = self.idx(xs.ravel()[m], ys.ravel()[m])
        return float(arr[r, cc].mean())


def ncc_shift(fp_geoms, s2, core, rng=12):
    """Shift (dx, dy) in metres of a footprint layer that best matches the Sentinel-2 non-vegetation signal."""
    minx, miny, maxx, maxy = core.bounds
    W, H = int((maxx - minx) / 2), int((maxy - miny) / 2)
    from rasterio.features import rasterize
    from affine import Affine
    tr = Affine(2, 0, minx, 0, -2, maxy)
    fine = rasterize([(g, 1) for g in fp_geoms], out_shape=(H, W), transform=tr, fill=0, dtype="uint8").astype(np.float32)
    # target: 1 - NDVI on the 10 m grid covering core
    r0, c0 = s2.idx([minx], [maxy]); r0, c0 = int(r0[0]), int(c0[0])
    gx0 = s2.x0 + c0 * 10; gy1 = s2.y1 - r0 * 10
    nR, nC = int((maxy - miny) / 10) - 2, int((maxx - minx) / 10) - 2
    tgt = 1 - s2.ndvi[r0 + 1:r0 + 1 + nR, c0 + 1:c0 + 1 + nC]
    tgt = (tgt - tgt.mean()) / tgt.std()
    best = None
    res = {}
    for dx in range(-rng, rng + 1, 2):
        for dy in range(-rng, rng + 1, 2):
            # cell (i,j) of the target covers x in [gx0+10(j+1), +10], y in [gy1-10(i+1)-10, gy1-10(i+1)]
            ox = gx0 + 10 - dx - minx; oy = maxy - (gy1 - 10 - dy)
            ci, ri = int(round(ox / 2)), int(round(oy / 2))
            sub = fine[ri:ri + nR * 5, ci:ci + nC * 5]
            if sub.shape != (nR * 5, nC * 5):
                continue
            agg = sub.reshape(nR, 5, nC, 5).mean(axis=(1, 3))
            a = (agg - agg.mean()) / (agg.std() + 1e-9)
            v = float((a * tgt).mean())
            res[(dx, dy)] = v
            if best is None or v > best[0]:
                best = (v, dx, dy)
    return {"dx": best[1], "dy": best[2], "ncc": round(best[0], 4), "ncc_at_0": round(res.get((0, 0), float("nan")), 4)}


def main(area_id="plav-town"):
    origin, core = setup(area_id)
    out_dir = ROOT / "public" / "data" / area_id
    cache = HERE / "cache" / area_id
    bj = json.loads((out_dir / "buildings.json").read_text())
    shown = bj["buildings"]
    removed = bj.get("removed", [])
    old = {b["id"]: b for b in json.loads((out_dir / "audit.json").read_text())["buildings"]}
    vec = json.loads((out_dir / "vectors.json").read_text())
    s2 = S2(cache / "s2_median.tif", origin)

    allb = [dict(b, shown=True) for b in shown] + [dict(b, shown=False) for b in removed]
    G = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in allb]
    tree = STRtree(G)
    shown_idx = [i for i, b in enumerate(allb) if b["shown"]]
    allfp = shapely.union_all([G[i] for i in shown_idx])

    # ---- Sentinel-2 test, calibrated ------------------------------------------------------------------------
    # Features over the footprint (area-weighted, 10 m pixels): NDVI and NDBI. Calibration: the OSM footprints
    # (positives) against the same shapes moved 40-120 m onto open ground with no footprint within 15 m (null).
    # On that set NDBI separates best (AUC ~0.89); NDVI ~0.88; ring contrast and brightness are weaker.
    def feats(g):
        return s2.mean_in(g, s2.ndvi), s2.mean_in(g, s2.ndbi)
    rng = np.random.default_rng(3)
    sc = [feats(g) for g in G]
    osm_i = [i for i, b in enumerate(allb) if b["src"] == "osm" and b["shown"]]
    clear = shapely.prepared.prep(core.buffer(-40).difference(allfp.buffer(15)))
    null = []
    for i in osm_i * 2:
        for _ in range(10):
            an, d = rng.uniform(0, 2 * math.pi), rng.uniform(40, 120)
            g = shapely.affinity.translate(G[i], d * math.cos(an), d * math.sin(an))
            if clear.contains(g):
                null.append((g.area, *feats(g))); break
    null = np.array(null)
    osm = np.array([(G[i].area, *sc[i]) for i in osm_i])
    t_sup = float(np.quantile(null[:, 2], 0.95))        # NDBI above this: built signal (5 % of open ground passes)
    t_veg_ndvi = float(np.quantile(osm[:, 1], 0.98))    # NDVI higher than 98 % of OSM houses
    t_veg_ndbi = float(np.quantile(osm[:, 2], 0.02))    # and NDBI lower than 98 % of OSM houses

    def size_class(a):
        return "<40" if a < 40 else "40-80" if a < 80 else "80-150" if a < 150 else ">=150"

    def img_class(a, nd, nb):
        if nb > t_sup:
            return "supported"
        if nd > t_veg_ndvi and nb < t_veg_ndbi:
            return "disagrees"
        return "not_resolved"
    calib = {}
    for cls in ("<40", "40-80", "80-150", ">=150"):
        o = [img_class(*r) for r in osm if size_class(r[0]) == cls]
        n = [img_class(*r) for r in null if size_class(r[0]) == cls]
        calib[cls] = {"osm_n": len(o), "osm_supported_pct": round(100 * o.count("supported") / len(o), 1) if o else None,
                      "osm_disagrees_pct": round(100 * o.count("disagrees") / len(o), 1) if o else None,
                      "null_n": len(n), "null_supported_pct": round(100 * n.count("supported") / len(n), 1) if n else None,
                      "null_disagrees_pct": round(100 * n.count("disagrees") / len(n), 1) if n else None}

    # ---- vector checks ----------------------------------------------------------------------------------------
    roads = [(shapely.LineString(r["pts"]), r) for r in vec["roads"] if r["c"] in CAR and len(r["pts"]) >= 2 and not r.get("bridge") and not r.get("tunnel")]
    rtree = STRtree([l for l, _ in roads])
    water = shapely.union_all([shapely.make_valid(Polygon(w["outer"], w["holes"])) for w in vec["water"]]) if vec["water"] else Polygon()

    per, pairs = [], []
    for i, (b, g) in enumerate(zip(allb, G)):
        f = []
        a = g.area
        if b["shown"]:
            for j in tree.query(g):
                if j <= i or not allb[j]["shown"]:
                    continue
                inter = g.intersection(G[j]).area
                if inter <= 0:
                    continue
                frac = inter / min(a, G[j].area)
                if frac >= 0.5:
                    pairs.append((i, j, "duplicate", round(frac, 2), round(inter, 1)))
                elif frac >= 0.05 and inter >= 2:
                    pairs.append((i, j, "overlap", round(frac, 2), round(inter, 1)))
        inner = g.buffer(-1.0)
        road_hit = None
        if not inner.is_empty:
            for k in rtree.query(inner):
                l, r = roads[k]
                if l.intersects(inner):
                    road_hit = r["c"]; break
        if road_hit:
            f.append("road_through")
        wfrac = g.intersection(water).area / a if a else 0
        if wfrac >= 0.25:
            f.append("in_water")
        fn, nb = sc[i]
        ndwi = s2.mean_in(g, s2.ndwi)
        img = img_class(a, fn, nb)
        per.append({"id": b["id"], "src": b["src"], "shown": b["shown"], "area": round(a, 1), "flags": f,
                    "img": img, "ndbi": round(nb, 3), "ndvi": round(fn, 3), "ndwi": round(ndwi, 3),
                    "road": road_hit, "water": round(wfrac, 2), "old": old.get(b["id"], {}).get("flags", []),
                    "x": round(g.centroid.x, 1), "y": round(g.centroid.y, 1)})
    for i, j, kind, frac, inter in pairs:
        for k, o in ((i, j), (j, i)):
            per[k]["flags"].append(kind)
            per[k].setdefault("pairs", []).append({"with": allb[o]["id"], "src": allb[o]["src"], "frac": frac, "m2": inter})

    # ---- density ----------------------------------------------------------------------------------------------
    cell = 50.0
    minx, miny, maxx, maxy = core.bounds
    dens = []
    osm_union = shapely.union_all([G[i] for i in osm_i])
    for x0 in np.arange(minx, maxx, cell):
        for y0 in np.arange(miny, maxy, cell):
            c = box(x0, y0, x0 + cell, y0 + cell)
            cov = allfp.intersection(c).area / c.area
            if cov > 0:
                dens.append((cov, osm_union.intersection(c).area / c.area, x0, y0))
    dens.sort(reverse=True)
    osm_max = max(o for _, o, _, _ in dens)
    dense_cells = [{"x": round(x0 + 25), "y": round(y0 + 25), "cover": round(c, 2)} for c, o, x0, y0 in dens if c > osm_max]

    # ---- possible unmapped buildings: WorldCover built-up 50 m cells with no footprint (audit.json gaps) --------
    gaps = json.loads((out_dir / "audit.json").read_text()).get("gaps", [])
    for gp in gaps:
        c = box(gp["x"] - 25, gp["y"] - 25, gp["x"] + 25, gp["y"] + 25)
        xs, ys = np.meshgrid(np.arange(gp["x"] - 20, gp["x"] + 21, 10), np.arange(gp["y"] - 20, gp["y"] + 21, 10))
        r_, c_ = s2.idx(xs.ravel(), ys.ravel())
        nb = s2.ndbi[r_, c_]; nd = s2.ndvi[r_, c_]
        gp["s2_built_px"] = int(((nb > t_sup) & (nd < 0.4)).sum())
        gp["road_in_cell"] = bool(any(l.intersects(c) for l, _ in roads))
    gap_summary = {"cells": len(gaps), "with_s2_built_pixels": sum(1 for g in gaps if g["s2_built_px"] >= 3),
                   "of_which_no_road": sum(1 for g in gaps if g["s2_built_px"] >= 3 and not g["road_in_cell"]),
                   "list": [g for g in gaps if g["s2_built_px"] >= 3]}

    # ---- whole-layer offsets ----------------------------------------------------------------------------------
    offs = {"osm": ncc_shift([G[i] for i in osm_i], s2, core),
            "ms": ncc_shift([G[i] for i, b in enumerate(allb) if b["src"] == "ms" and b["shown"]], s2, core)}

    # ---- verdicts ---------------------------------------------------------------------------------------------
    # demonstrable error = two independent sources agree. Only these may be hidden.
    for p in per:
        v = "ok"
        if "in_water" in p["flags"] and p["ndwi"] > 0 and p["img"] != "supported":
            v = "error_in_water"
        elif "duplicate" in p["flags"] and p["src"] == "ms":
            other = p["pairs"][0]
            # the ML copy of a footprint already present (the OSM one, or the larger ML one) is the error
            if other["src"] == "osm":
                v = "error_duplicate"
        elif "road_through" in p["flags"]:
            v = "review_road"            # an OSM road centreline crosses it: review (could be a passage or a road error)
        elif p["img"] == "disagrees" and p["src"] == "ms":
            v = "review_imagery"         # imagery looks like vegetation; 2 % of real OSM houses look like that too
        p["verdict"] = v

    shownp = [p for p in per if p["shown"]]
    flagged = [p for p in shownp if p["old"]]
    summary = {
        "sources": {"footprints": "Overture 2026-11-18.0 (OSM, Microsoft ML Buildings 2026-08-11)",
                    "imagery": "Copernicus Sentinel-2 L2A 2025-07-21, 2025-08-10, 2025-08-21 (median)",
                    "landcover": "ESA WorldCover 2021 v200", "vectors": "OSM via Overture transportation and base themes"},
        "shown": len(shownp), "shown_by_src": dict(Counter(p["src"] for p in shownp)),
        "s2_thresholds": {"supported_ndbi_gt": round(t_sup, 3), "disagrees_ndvi_gt": round(t_veg_ndvi, 3), "disagrees_ndbi_lt": round(t_veg_ndbi, 3)},
        "s2_calibration": calib, "s2_null_n": len(null),
        "imagery_shown": {s: dict(Counter(p["img"] for p in shownp if p["src"] == s)) for s in ("osm", "ms")},
        "imagery_shown_ms_by_size": {c: dict(Counter(p["img"] for p in shownp if p["src"] == "ms" and size_class(p["area"]) == c)) for c in ("<40", "40-80", "80-150", ">=150")},
        "overlap_pairs": dict(Counter((k, "-".join(sorted((allb[i]["src"], allb[j]["src"])))) .__str__() for i, j, k, _, _ in pairs)),
        "road_through_shown": dict(Counter(p["src"] for p in shownp if "road_through" in p["flags"])),
        "in_water_shown": dict(Counter(p["src"] for p in shownp if "in_water" in p["flags"])),
        "density": {"osm_centre_max_cover": round(osm_max, 2), "cells_above": len(dense_cells), "top": [round(c, 2) for c, *_ in dens[:5]]},
        "layer_offset_m": offs,
        "possible_unmapped": gap_summary,
        "verdicts_shown": dict(Counter(p["verdict"] for p in shownp)),
        "verdicts_removed_before": dict(Counter(p["verdict"] for p in per if not p["shown"])),
        "flagged_917": {
            "n": len(flagged),
            "by_flag": {fl: {"n": sum(1 for p in flagged if fl in p["old"]), "img": dict(Counter(p["img"] for p in flagged if fl in p["old"]))}
                        for fl in sorted({f for p in flagged for f in p["old"]})},
            "verdicts": dict(Counter(p["verdict"] for p in flagged)),
        },
        "removed_before_img": dict(Counter(p["img"] for p in per if not p["shown"])),
    }
    (cache / "audit-geo.json").write_text(json.dumps(summary, indent=1))
    (out_dir / "audit_geo.json").write_text(json.dumps({"summary": summary, "buildings": [
        {k: p[k] for k in ("id", "src", "shown", "img", "verdict", "flags", "ndvi", "ndbi")} for p in per], "dense": dense_cells}, separators=(",", ":")))
    # merge into audit.json (read by the #audit view): imagery class per building, new flags, and the Sentinel-2
    # result replaces the WorldCover-only "isolated_ml" flag where the 10 m imagery does show a built surface.
    aj = json.loads((out_dir / "audit.json").read_text())
    by = {p["id"]: p for p in per}
    resolved = 0
    for e in aj["buildings"]:
        p = by.get(e["id"])
        if not p:
            continue
        e["img"] = p["img"]
        fl = list(e.setdefault("flags0", list(e["flags"])))  # heuristic flags from audit_buildings.py, kept for reruns
        if p["img"] == "supported" and "isolated_ml" in fl:
            fl.remove("isolated_ml"); resolved += e["shown"]
        if p["verdict"] == "review_imagery":
            fl.append("s2_vegetation")
        if "road_through" in p["flags"]:
            fl.append("road_through")
        e["flags"] = sorted(set(fl))
    REVIEW = {"overlap", "odd_shape", "large_ml", "isolated_ml", "skewed_to_street", "on_street", "duplicate", "duplicate_ml_of_osm", "s2_vegetation", "road_through"}
    sh = [e for e in aj["buildings"] if e["shown"]]
    aj["summary"].setdefault("review_shown_before_s2", aj["summary"]["review_shown"])
    aj["summary"]["review_shown"] = sum(1 for e in sh if REVIEW & set(e["flags"]))
    aj["summary"]["flags_shown"] = dict(Counter(f for e in sh for f in e["flags"]))
    aj["summary"]["s2"] = {"scenes": summary["sources"]["imagery"], "shown": dict(Counter(e["img"] for e in sh)),
                           "isolated_resolved": resolved, "thresholds": summary["s2_thresholds"]}
    (out_dir / "audit.json").write_text(json.dumps(aj, separators=(",", ":")))
    summary["review_after_s2"] = aj["summary"]["review_shown"]
    summary["isolated_resolved_by_s2"] = resolved
    (cache / "audit-geo.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
