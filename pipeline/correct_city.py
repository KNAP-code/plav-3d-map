"""Phase 3b: measure, then apply, evidence-backed corrections to the city geometry.

Stage 1 (measure, cached in pipeline/cache/<area>/correct-measure.json): for every shown footprint, every
GlobalBuildingAtlas (Microsoft 2024) footprint missing from the model, and every alternative outline of a building,
measure the 1 m imagery signal in BOTH Satellogic passes:

  pass A  2022-08-31, newsat20, 3.9 deg off-nadir, whole area (cloud in the south-west)
  pass B  2022-08-29, newsat23, 17.5 deg off-nadir, east third of the area only

Each pass is registered to the footprint layer independently (verify_city.Sat), so the two are independent looks.

Stage 2 (rules, written to docs/city/corrections.json and applied by build.py through pipeline/corrections.json):

  R1 shift      a footprint's roof sits beyond the measured tolerance from it in pass A, AND a second independent
                source puts it at the same place within 2 m: pass B, or the Microsoft 2024 outline of the same
                building. Shift = mean of the agreeing offsets. Never for OSM footprints that Microsoft confirms.
  R2 add        a Microsoft 2024 footprint missing from Microsoft 2026 and OSM, whose roof the 1 m image shows at that
                position (contrast above the calibrated threshold, within tolerance), confirmed by a second source
                (pass B roof, or Sentinel-2 built signal), not on a mapped road and not overlapping a shown building.
  R3 outline    where two producers disagree on a building's outline (OSM vs Microsoft, or Microsoft 2026 vs 2024 with
                IoU < 0.6 or > 10 deg), keep the outline the imagery prefers, but only if the preference is clear in
                every pass that sees it. The test's error rate is measured first on known-good buildings (gold set:
                OSM and Microsoft agree) against a rotated / shifted decoy; R3 is used only if it picks the true
                outline >= 90 % of the time.
  Every rule is also run on the gold set to measure how often it would "correct" a building that is already right.

Usage: python pipeline/correct_city.py [area] [--measure]
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
import shapely.affinity
import shapely.prepared
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT  # noqa: E402
from verify_city import CAR, Sat, adiff, areas_of, best_offset, contrast, load_ms, obb_angle, r1  # noqa: E402

RNG = np.random.default_rng(11)


def calibrate(sat, P, B, ring_of, core, road_buf, allfp, src="osm"):
    """Presence threshold (5 % of open-ground shapes pass) for one pass. Shapes: OSM footprints (or all, for pass B,
    which sees almost no OSM buildings) moved 30-150 m onto open ground."""
    og = shapely.prepared.prep(core.buffer(-60).difference(allfp.buffer(10)).difference(road_buf.buffer(4)))
    null, pos = [], []
    for i, b in enumerate(B):
        if src and b["src"] != src:
            continue
        g = P[i]
        if g.area < 25 or sat.is_obscured(g.centroid.x, g.centroid.y):
            continue
        v, nd = contrast(sat, g, ring_of(g), sat.shift_at(g.centroid.x, g.centroid.y))
        if np.isfinite(v):
            pos.append((g.area, v, nd))
        for _ in range(12):
            an, d = RNG.uniform(0, 2 * math.pi), RNG.uniform(30, 150)
            gg = shapely.affinity.translate(g, d * math.cos(an), d * math.sin(an))
            if og.contains(gg) and not sat.is_obscured(gg.centroid.x, gg.centroid.y):
                v, nd = contrast(sat, gg, gg.buffer(5.0).difference(gg.buffer(1.5)), sat.shift_at(gg.centroid.x, gg.centroid.y))
                if np.isfinite(v):
                    null.append((gg.area, v, nd))
                break
    null, pos = np.array(null), np.array(pos)
    t = float(np.quantile(null[:, 1], 0.95))
    return {"t_presence": t, "null_n": len(null), "osm_n": len(pos), "osm_detected_pct": r1(100 * (pos[:, 1] > t).mean()) if len(pos) else None}


def look(sat, g, ring_of, with_offset=True):
    """Imagery measurement of one outline in one pass: contrast at the mapped place, best offset, contrast there."""
    c = g.centroid
    if g.area < 12 or sat.is_obscured(c.x, c.y):
        return None
    sh = sat.shift_at(c.x, c.y)
    ring = ring_of(g)
    v, nd = contrast(sat, g, ring, sh)
    if not np.isfinite(v):
        return None
    out = {"v": r1(v), "nd": r1(nd)}
    if with_offset:
        bo = best_offset(sat, g, ring, sh)
        if bo:
            dx, dy, edge = bo
            v2, _ = contrast(sat, g, ring, sh, dx, dy)
            out.update(dx=r1(dx), dy=r1(dy), edge=bool(edge), vb=r1(v2))
    return out


def setup(area_id):
    cache = HERE / "cache" / area_id
    out_dir = ROOT / "public" / "data" / area_id
    meta = json.loads((out_dir / "meta.json").read_text())
    origin = np.array(meta["origin"], float)
    ext = meta["extent"]
    core = shapely.box(-ext["halfW"], -ext["halfH"], ext["halfW"], ext["halfH"])
    B = json.loads((out_dir / "buildings.json").read_text())["buildings"]
    P = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in B]
    vec = json.loads((out_dir / "vectors.json").read_text())
    return cache, out_dir, origin, core, B, P, vec


def measure(area_id):
    cache, out_dir, origin, core, B, P, vec = setup(area_id)
    allfp = shapely.union_all(P); shapely.prepare(allfp)
    tree = STRtree(P)
    Pb = [p.buffer(0.5) for p in P]

    def ring_of(g, exclude=None):
        rg = g.buffer(5.0).difference(g.buffer(1.5))
        near = [Pb[j] for j in tree.query(rg) if j != exclude]
        return rg.difference(shapely.union_all(near)) if near else rg

    car = [(LineString(r["pts"]), r) for r in vec["roads"] if len(r["pts"]) >= 2 and r["c"] in CAR and not r.get("bridge") and not r.get("tunnel")]
    road_buf = shapely.union_all([l.buffer(4.0) for l, _ in car])
    ms = load_ms(cache / "evidence" / "ms2023.parquet", origin)
    gba_t = pq.read_table(cache / "evidence" / "gba.parquet")
    gba = load_ms(cache / "evidence" / "gba.parquet", origin)
    gsrc = gba_t["source"].to_pylist()
    mtree, gtree = STRtree(ms), STRtree(gba)

    passes = {}
    for key, fn in (("A", "satellogic_toa.tif"), ("B", "satellogic_toa_0829.tif")):
        s = Sat(cache / "evidence" / fn, origin)
        reg = s.register(P, min_clear=0.9, min_mask=1500) if key == "A" else s.register(P, min_clear=0.6, min_mask=400)
        cal = calibrate(s, P, B, ring_of, core, road_buf, allfp, "osm" if key == "A" else None)
        passes[key] = (s, reg, cal)
        print(key, reg, cal)

    def best_match(g, polys, t):
        best = None
        for j in t.query(g, predicate="intersects"):
            q = polys[j]
            iou = g.intersection(q).area / g.union(q).area
            if best is None or iou > best[0]:
                best = (iou, j)
        return best

    rows = []
    for i, (b, g) in enumerate(zip(B, P)):
        rec = {"i": i, "id": b["id"], "src": b["src"], "a": round(g.area, 1)}
        for k, (s, _, _) in passes.items():
            m = look(s, g, lambda gg: ring_of(gg, i))
            if m:
                rec[k] = m
        if b["src"] == "osm":
            bm = best_match(g, ms, mtree)
            if bm:
                rec["ms_iou"] = r1(bm[0]); rec["ms_j"] = int(bm[1])
        gm = best_match(g, gba, gtree)
        if gm:
            q = gba[gm[1]]
            d = np.array(q.centroid.coords[0]) - np.array(g.centroid.coords[0])
            a1, e1 = obb_angle(g); a2, e2 = obb_angle(q)
            rec.update(gba_iou=r1(gm[0]), gba_j=int(gm[1]), gba_src=gsrc[gm[1]], gba_dx=r1(d[0]), gba_dy=r1(d[1]),
                       gba_dang=r1(adiff(a2, a1, 90)) if min(e1, e2) > 1.15 else None)
        # alternative outlines: measure them in both passes at zero offset (binary choice later)
        alts = {}
        if b["src"] == "osm" and rec.get("ms_j") is not None and (rec["ms_iou"] < 0.6):
            alts["ms"] = ms[rec["ms_j"]]
        if rec.get("gba_j") is not None and rec["gba_iou"] < 0.6 and gsrc[rec["gba_j"]] == "ms":
            alts["gba"] = gba[rec["gba_j"]]
        if rec.get("gba_dang") is not None and abs(rec["gba_dang"]) > 10 and gsrc[rec["gba_j"]] == "ms":
            alts["gba"] = gba[rec["gba_j"]]
        for name, q in alts.items():
            for k, (s, _, _) in passes.items():
                m = look(s, q, lambda gg: ring_of(gg, i), with_offset=False)
                if m:
                    rec[f"alt_{name}_{k}"] = m["v"]
        # decoys for the gold set: same outline rotated 12 deg and shifted 3 m (to calibrate R3)
        if b["src"] == "osm" and (rec.get("ms_iou") or 0) >= 0.5:
            dec = shapely.affinity.translate(shapely.affinity.rotate(g, RNG.choice([-12, 12]), origin=g.centroid), *RNG.normal(0, 2.0, 2))
            for k, (s, _, _) in passes.items():
                m = look(s, dec, lambda gg: ring_of(gg, i), with_offset=False)
                if m:
                    rec[f"decoy_{k}"] = m["v"]
        rows.append(rec)
        if i % 500 == 0:
            print(f"  {i}/{len(B)}", flush=True)

    # Microsoft 2024 footprints that are not in the model
    extra = []
    for j, q in enumerate(gba):
        if gsrc[j] != "ms" or not core.contains(q.centroid) or len(tree.query(q, predicate="intersects")):
            continue
        rec = {"j": j, "a": round(q.area, 1), "x": round(q.centroid.x, 1), "y": round(q.centroid.y, 1),
               "road_d": r1(min((l.distance(q) for l, _ in car), default=99.0)),
               "road_c": min(car, key=lambda lr: lr[0].distance(q))[1]["c"] if car else None}
        for k, (s, _, _) in passes.items():
            m = look(s, q, ring_of)
            if m:
                rec[k] = m
        extra.append(rec)

    res = {"passes": {k: {"registration": v[1], "calibration": v[2]} for k, v in passes.items()}, "buildings": rows, "extra": extra}
    (cache / "correct-measure.json").write_text(json.dumps(res))
    print("measured", len(rows), "buildings,", len(extra), "Microsoft 2024 extras")


HALF_W = {"primary": 4.0, "secondary": 3.75, "tertiary": 3.25, "residential": 2.6, "unclassified": 2.4,
          "living_street": 2.25, "service": 1.8}


def vec(m):
    return np.array([m["dx"], m["dy"]]) if m and m.get("dx") is not None else None


def decide(area_id):
    """Stage 2: calibrate each rule on the gold set, then decide corrections. Writes pipeline/corrections/<area>.json."""
    cache, out_dir, origin, core, B, P, vecs = setup(area_id)
    M = json.loads((cache / "correct-measure.json").read_text())
    rows, extra = M["buildings"], M["extra"]
    tA = M["passes"]["A"]["calibration"]["t_presence"]; tB = M["passes"]["B"]["calibration"]["t_presence"]
    gold = [r for r in rows if r["src"] == "osm" and (r.get("ms_iou") or 0) >= 0.5]
    gres = np.array([np.hypot(r["A"]["dx"], r["A"]["dy"]) for r in gold if r.get("A") and r["A"].get("vb") is not None and r["A"]["vb"] > tA and not r["A"]["edge"]])
    TOL = float(np.percentile(gres, 90))
    gB = np.array([np.hypot(r["B"]["dx"], r["B"]["dy"]) for r in rows if r.get("B") and r["B"].get("vb") is not None and r["B"]["vb"] > tB and not r["B"]["edge"]])
    cal = {"tA": r1(tA), "tB": r1(tB), "tol_m": r1(TOL), "gold_n": len(gold), "gold_res_n": int(len(gres))}

    def roof_offset(m, t):
        if not m or m.get("vb") is None or m["vb"] <= t or m.get("edge"):
            return None
        return vec(m)

    # ---- R1 shift -------------------------------------------------------------------------------------------
    def r1_rule(r):
        a = roof_offset(r.get("A"), tA)
        if a is None or np.hypot(*a) <= TOL:
            return None
        votes, why = [a], ["pass A roof %.1f m away" % np.hypot(*a)]
        b = roof_offset(r.get("B"), tB)
        if b is not None and np.hypot(*(b - a)) <= 2.0:
            votes.append(b); why.append("pass B agrees (%.1f m)" % np.hypot(*(b - a)))
        if r.get("gba_src") == "ms" and (r.get("gba_iou") or 0) >= 0.3 and r.get("gba_dx") is not None:
            g = np.array([r["gba_dx"], r["gba_dy"]])
            if np.hypot(*g) > 1.5 and np.hypot(*(g - a)) <= 2.0:
                votes.append(g); why.append("Microsoft 2024 outline agrees (%.1f m)" % np.hypot(*(g - a)))
        if len(votes) < 2:
            return None
        d = np.mean(votes, axis=0)
        return d, why
    gold_fp = sum(1 for r in gold if r1_rule(r))
    cal["R1_gold_false_shift_pct"] = r1(100 * gold_fp / len(gold))

    # ---- R3 outline choice: margin from decoys --------------------------------------------------------------
    dd = np.array([r["decoy_A"] - r["A"]["v"] for r in gold if r.get("decoy_A") is not None and r.get("A")])
    margin = float(np.quantile(dd, 0.98))      # a decoy beats the true outline by more than this only 2 % of the time
    acc = float((dd < 0).mean())
    cal.update(R3_decoy_n=int(len(dd)), R3_pick_true_pct=r1(100 * acc), R3_margin=r1(margin))

    tree = STRtree(P)
    corrections = []
    used = set()
    for r in rows:
        if r["src"] == "osm" and (r.get("ms_iou") or 0) >= 0.5:
            continue                       # verified by two producers: never touched
        g = P[r["i"]]
        res = r1_rule(r)
        if res:
            d, why = res
            moved = shapely.affinity.translate(g, *d)
            clash = [j for j in tree.query(moved, predicate="intersects") if j != r["i"] and moved.intersection(P[j]).area > 1.0]
            if not clash:
                corrections.append({"kind": "shift", "id": r["id"], "src": r["src"], "dx": r1(d[0]), "dy": r1(d[1]), "evidence": why,
                                    "confidence": "high" if len(why) >= 3 else "medium"})
                used.add(r["id"]); continue
        # R3: alternative outline clearly preferred in every pass that sees it
        if acc >= 0.9:
            for alt in ("ms", "gba"):
                vals = [(r.get(f"alt_{alt}_{k}"), (r.get(k) or {}).get("v"), t) for k, t in (("A", tA), ("B", tB))]
                vals = [(a, c, t) for a, c, t in vals if a is not None and c is not None]
                if vals and all(a > c + margin and a > t for a, c, t in vals):
                    corrections.append({"kind": "outline", "id": r["id"], "src": r["src"], "use": alt,
                                        "evidence": ["imagery prefers the %s outline: %s" % ("Microsoft" if alt == "ms" else "Microsoft 2024",
                                                     ", ".join("%.1f vs %.1f" % (a, c) for a, c, _ in vals))],
                                        "confidence": "medium"})
                    used.add(r["id"]); break

    # ---- R2 additions --------------------------------------------------------------------------------------
    import rasterio  # noqa: F401
    from audit_geo import S2
    s2 = S2(cache / "s2_median.tif", origin)
    s2t = json.loads((out_dir / "audit_geo.json").read_text())["summary"]["s2_thresholds"]["supported_ndbi_gt"]
    gba = load_ms(cache / "evidence" / "gba.parquet", origin)
    # roof detector (roof_detector.py): two tests at 5 % null each; "both" fires on empty ground 0.9 % of the time
    RD = json.loads((cache / "roof-detector.json").read_text())
    cal["roof_detector"] = {k: RD["calibration"][k] for k in ("null_rate", "heldout_detect", "t_contrast", "t_absolute")}
    added, skipped = [], Counter()
    cars = [LineString(r["pts"]) for r in vecs["roads"] if len(r["pts"]) >= 2 and r["c"] in CAR and not r.get("bridge") and not r.get("tunnel")]
    ctree = STRtree(cars)
    for e in extra:
        q = gba[e["j"]]
        d = RD["extras"].get(str(e["j"]))
        a = roof_offset(e.get("A"), tA)
        old_ok = a is not None and e["a"] >= 20 and np.hypot(*a) <= TOL and e.get("A", {}).get("v", -9) > tA
        if e["a"] < 12:
            skipped["tiny"] += 1; continue
        if d is None:
            skipped["no clear imagery"] += 1; continue
        # OSM centrelines here are drawn loosely (verify_city: 82 % within 3 m), so a centreline clipping the edge of
        # an outline is not evidence against it; one running through its interior (1 m inset) is: those stay listed.
        inner = q.buffer(-1.0)
        if not inner.is_empty and any(l.intersects(inner) for l in (cars[k] for k in ctree.query(inner))):
            skipped["road centreline through it"] += 1; continue
        why = ["Microsoft 2024 footprint (GlobalBuildingAtlas)"]
        if d[2] >= 2:
            why.append("roof detector: both tests fire at the outline (%.1f / %.2f; 0.9 %% false rate on empty ground)" % (d[0], d[1]))
        if old_ok:
            why.append("pass A roof contrast at its position (%.1f, %.1f m)" % (e["A"]["v"], np.hypot(*a)))
        if roof_offset(e.get("B"), tB) is not None:
            why.append("pass B roof")
        nb = s2.mean_in(q, s2.ndbi)
        if nb > s2t:
            why.append("Sentinel-2 built signal")
        # Checked by eye on chip sheets: outlines with only the single-number contrast + Sentinel-2 were mostly dark,
        # roofless patches, while every outline where both detector tests fire showed a roof. So the detector is required.
        indep = any(w.startswith(("pass B", "Sentinel-2")) for w in why)
        if not (d[2] >= 2 and (indep or old_ok)):
            skipped["evidence below rule"] += 1; continue
        if any(q.intersection(o).area > 1.0 for o in added):
            continue
        added.append(q)
        conf = "medium" if indep else "low"
        corrections.append({"kind": "add", "id": f"ms2024-{e['j']}", "src": "ms2024", "fp": [[r1(x), r1(y)] for x, y in list(q.exterior.coords)[:-1]],
                            "evidence": why, "confidence": conf})
    cal["R2_skipped"] = dict(skipped)

    out = {"area": area_id, "calibration": cal, "counts": dict(Counter(c["kind"] for c in corrections)), "corrections": corrections}
    (HERE / "corrections").mkdir(exist_ok=True)
    (HERE / "corrections" / f"{area_id}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps({k: out[k] for k in ("calibration", "counts")}, indent=1))


def apply(area_id):
    """Apply pipeline/corrections/<area>.json to public/data/<area>/buildings.json (run after build.py; idempotent)."""
    from build import Grid, estimate_building, estimate_roof, h32, obb
    cache, out_dir, origin, core, B, P, vecs = setup(area_id)
    path = out_dir / "buildings.json"
    backup = cache / "buildings.pre-corrections.json"
    bj = json.loads((backup if backup.exists() else path).read_text())
    if not backup.exists():
        backup.write_text(json.dumps(bj, ensure_ascii=False, separators=(",", ":")))
    C = json.loads((HERE / "corrections" / f"{area_id}.json").read_text())
    meta = json.loads((out_dir / "meta.json").read_text())["core"]
    H = np.fromfile(out_dir / meta["file"].replace(".wasm", ".bin"), "<u2").reshape(meta["ny"], meta["nx"]) / meta["scale"] + meta["base"]
    grid = Grid(meta["x0"], meta["y0"], meta["nx"], meta["ny"], meta["step"])
    cache_ms = load_ms(cache / "evidence" / "ms2023.parquet", origin)
    gba = load_ms(cache / "evidence" / "gba.parquet", origin)
    M = {r["id"]: r for r in json.loads((cache / "correct-measure.json").read_text())["buildings"]}
    byid = {b["id"]: b for b in bj["buildings"]}

    def set_geom(b, poly):
        ring = np.array(poly.exterior.coords)[:-1]
        ctr, ang, L, Wd, _ = obb(poly)
        g = grid.sample(H, ring[:, 0], ring[:, 1]); gm = float(grid.sample(H, [poly.centroid.x], [poly.centroid.y])[0])
        b.update(fp=[[r1(x), r1(y)] for x, y in ring], obb=[r1(ctr[0]), r1(ctr[1]), round(ang, 4), r1(L), r1(Wd)],
                 g0=r1(min(g.min(), gm)), g1=r1(max(g.max(), gm)))

    n = Counter()
    for c in C["corrections"]:
        if c["kind"] == "shift":
            b = byid[c["id"]]
            set_geom(b, shapely.affinity.translate(Polygon(b["fp"]), c["dx"], c["dy"]))
        elif c["kind"] == "outline":
            b = byid[c["id"]]; r = M[c["id"]]
            q = cache_ms[r["ms_j"]] if c["use"] == "ms" else gba[r["gba_j"]]
            from shapely.geometry.polygon import orient
            set_geom(b, orient(Polygon(q.exterior).simplify(0.2), 1.0))
        elif c["kind"] == "add":
            from shapely.geometry.polygon import orient
            poly = orient(Polygon(c["fp"]).simplify(0.2), 1.0)
            ctr, ang, L, Wd, oarea = obb(poly)
            floors, eave, hsrc = estimate_building(c["id"], poly.area, L / max(Wd, 0.1), None, None, None)
            b = {"id": c["id"], "src": "ms", "cls": None, "name": None, "eave": round(eave, 1), "floors": floors, "hSrc": hsrc,
                 "roof": estimate_roof(c["id"], poly.area, L / max(Wd, 0.1), poly.area / oarea, None), "roofSrc": "estimated",
                 "v": h32(c["id"]) % 997, "onStreet": 0.0}
            if poly.area < 30:
                b.update(kind="outbuilding", floors=1, eave=2.6, roof="gable" if b["roof"] != "flat" else "flat")
            set_geom(b, poly)
            bj["buildings"].append(b); byid[b["id"]] = b
        byid[c["id"]]["corr"] = {"kind": c["kind"], "confidence": c["confidence"], "evidence": c["evidence"]}
        n[c["kind"]] += 1
    bj.setdefault("rules", {})
    if isinstance(bj["rules"], dict):
        bj["rules"]["corrections"] = "Phase 3b evidence-backed corrections, pipeline/corrections/%s.json" % area_id
    path.write_text(json.dumps(bj, ensure_ascii=False, separators=(",", ":")))
    print("applied", dict(n), "->", path)


if __name__ == "__main__":
    area = next((a for a in sys.argv[1:] if not a.startswith("--")), "plav-town")
    if "--measure" in sys.argv:
        measure(area)
    if "--decide" in sys.argv:
        decide(area)
    if "--apply" in sys.argv:
        apply(area)
