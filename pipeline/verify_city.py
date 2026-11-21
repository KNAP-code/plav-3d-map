"""Phase 3: area-by-area verification of city geometry against independent evidence.

The shown city geometry is Overture 2026-11-18.0: OpenStreetMap footprints and streets (mapped by people) plus
Microsoft ML footprints (machine-detected) where OSM has none. The earlier audit (audit_geo.py) only had 10 m
Sentinel-2, which cannot see a single house. This pass adds evidence that was produced separately from that layer
(fetch_evidence.py):

  ms2023    raw Microsoft footprints, including the ones *under* OSM buildings -> OSM vs Microsoft, outline by outline
  sat       Satellogic EarthView 1 m RGB+NIR, 2022-08-31, 3.9 deg off-nadir (L1, not survey-orthorectified)
  chm       Meta/WRI canopy height v2, 1.19 m, from Maxar imagery 2011-2019 (buildings are 0 m, trees have height)
  s2        Sentinel-2 2025 result from audit_geo.py

How the 1 m imagery is used. As delivered the L1 mosaic is displaced ~38 m north and a few metres east of OSM and
Sentinel-2, with a smooth variation across the town (relief and the uncorrected sensor model). We estimate that
displacement in overlapping 448 m windows by correlating the image's non-vegetation signal (-NDVI) with the whole
footprint layer, and interpolate it smoothly (Gaussian, sigma 250 m). This uses the footprints only *as a block*:
it fixes the imagery to the layer's mean position, so the imagery cannot judge the absolute position of the town
(Sentinel-2 does that: audit_geo.py found the layer within ~2 m). What it can judge, building by building:

  presence      roof contrast: NDVI in a 1.5-5 m ring around the footprint minus NDVI inside it, in units of the
                pixel noise, calibrated on OSM footprints (positives) vs. the same shapes moved onto open ground
  residual      the local shift (search +-6 m, 1 m steps, sub-metre peak) that maximises the roof contrast:
                how far the footprint sits from its own roof *relative to the buildings around it*
  orientation   rotation (+-20 deg) that maximises contrast, for elongated footprints >= 80 m2

Tiers (per building, written to public/data/<area>/verify.json, also used by #audit):

  verified      two independent producers agree on outline and position: OSM and Microsoft outlines overlap
                with IoU >= 0.5, or the 1 m imagery shows the roof (presence) with a residual <= 2.5 m
  present       independent evidence that a building stands there (1 m roof or Sentinel-2 built signal), but the
                outline or relative position is not confirmed (residual > 2.5 m, or IoU < 0.5 with no roof match)
  unconfirmed   no independent source confirms or contradicts it (small, shaded, under trees, or built after 2022)
  disputed      Microsoft ML only, and two independent sources say "no building": the 1 m image is vegetation
                inside the footprint (NDVI above 95 % of OSM houses) AND either Meta canopy >= 3 m over >= 40 % of
                it or Sentinel-2 vegetation. OSM buildings are never disputed by imagery alone.

Areas are the Voronoi cells of the OSM locality points (Overture divisions), i.e. "nearest named place", not
official boundaries.

Usage: python pipeline/verify_city.py [area]
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict

import numpy as np
import pyarrow.parquet as pq
import rasterio
import shapely
import shapely.affinity
from pyproj import Transformer
from rasterio.features import rasterize
from scipy.signal import fftconvolve
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT  # noqa: E402

TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32634", always_xy=True)
UTM_TO_3857 = Transformer.from_crs("EPSG:32634", "EPSG:3857", always_xy=True)
CAR = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service"}
RESID_OK = 2.5
RNG = np.random.default_rng(7)


def r1(v):
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else round(float(v), 2)


def obb_angle(p):
    r = p.minimum_rotated_rectangle
    c = np.array(r.exterior.coords)
    e = [c[1] - c[0], c[2] - c[1]]
    lens = [float(np.hypot(*v)) for v in e]
    v = e[int(np.argmax(lens))]
    return math.degrees(math.atan2(v[1], v[0])) % 180, max(lens) / max(min(lens), 0.1)


def adiff(a, b, period=180):
    return ((a - b + period / 2) % period) - period / 2


class Sat:
    """1 m Satellogic mosaic in UTM34N, with a smooth registration field to the footprint layer."""

    def __init__(self, path, origin):
        with rasterio.open(path) as s:
            a = s.read().astype(np.float32)
            self.T = s.transform
        self.valid = (a[0] > 0) & (a[3] > 0)
        red, nir = a[0], a[3]
        self.ndvi = np.where(self.valid, (nir - red) / np.maximum(nir + red, 1), np.nan).astype(np.float32)
        self.bright = np.where(self.valid, a[:3].mean(axis=0), np.nan).astype(np.float32)
        self.o = origin
        self.H, self.W = self.ndvi.shape
        self.field = None
        # Clouds and cloud shadows. The 2022-08-31 pass has cumulus over the south-west of the area. Cloud: smoothed
        # blue reflectance well above the clear-sky median; shadow: smoothed total reflectance in the darkest 3 % of
        # clear land. Both grown by 60 m. Imagery tests are skipped there ("obscured"), never counted as evidence.
        from scipy import ndimage
        blue = ndimage.uniform_filter(np.where(self.valid, a[2], 0), 25)
        tot = ndimage.uniform_filter(np.where(self.valid, a.sum(0), 0), 25)
        med_b = float(np.median(a[2][self.valid]))
        cloud = blue > 1.25 * med_b
        clear = self.valid & ~cloud
        shadow = (tot < np.percentile(tot[clear], 3)) & self.valid
        ob = ndimage.binary_dilation(cloud | shadow, iterations=60) | ~ndimage.binary_erosion(self.valid, iterations=10)
        self.obscured = ob
        self.cloud_stats = {"cloud_pct": r1(100 * cloud[self.valid].mean()), "shadow_pct": r1(100 * shadow[self.valid].mean()),
                            "obscured_pct": r1(100 * ob[self.valid].mean()), "blue_threshold": r1(1.25 * med_b)}

    def is_obscured(self, x, y):
        sh = self.shift_at(x, y)
        r, c = self.rc(x, y)
        r, c = int(round(float(r) + sh[0])), int(round(float(c) + sh[1]))
        return not (0 <= r < self.H and 0 <= c < self.W) or bool(self.obscured[r, c])

    def rc(self, x, y):
        """Fractional (row, col) of local coordinates (no registration)."""
        X = np.asarray(x) + self.o[0]; Y = np.asarray(y) + self.o[1]
        return (self.T.f - Y) / -self.T.e, (X - self.T.c) / self.T.a

    def register(self, polys, win=448, step=128, S=60):
        mask = rasterize([(shapely.affinity.translate(p, *self.o), 1) for p in polys], out_shape=self.ndvi.shape,
                         transform=self.T, dtype="uint8").astype(np.float32)
        z = -np.nan_to_num(np.where(self.obscured, np.nan, self.ndvi), nan=float(np.nanmean(self.ndvi[~self.obscured])))
        z = (z - z.mean()) / z.std()
        pts = []
        for r0 in range(0, self.H - win + 1, step):
            for c0 in range(0, self.W - win + 1, step):
                if not (self.valid[r0:r0 + win, c0:c0 + win] & ~self.obscured[r0:r0 + win, c0:c0 + win]).mean() > 0.9:
                    continue
                mm = mask[r0 + S:r0 + win - S, c0 + S:c0 + win - S]
                if mm.sum() < 1500:
                    continue
                g = fftconvolve(z[r0:r0 + win, c0:c0 + win], mm[::-1, ::-1], mode="valid") / mm.sum()
                iy, ix = np.unravel_index(np.argmax(g), g.shape)
                if not (0 < ix < 2 * S and 0 < iy < 2 * S):
                    continue

                def sp(a, b, c):
                    d = a - 2 * b + c
                    return 0.0 if d == 0 else 0.5 * (a - c) / d
                fx = ix + sp(g[iy, ix - 1], g[iy, ix], g[iy, ix + 1]) - S
                fy = iy + sp(g[iy - 1, ix], g[iy, ix], g[iy + 1, ix]) - S
                q = float((g.max() - np.median(g)) / (g.std() + 1e-6))
                pts.append((r0 + win / 2, c0 + win / 2, fy, fx, q))
        P = np.array(pts)
        good = P[P[:, 4] > 3.0]
        med = np.median(good[:, 2:4], axis=0)
        good = good[np.hypot(*(good[:, 2:4] - med).T) < 8]
        self.reg_pts = good
        # leave-one-out error of the smooth field = how well a building's neighbourhood predicts its shift
        loo = []
        for i in range(len(good)):
            m = np.ones(len(good), bool); m[i] = False
            loo.append(np.hypot(*(self._interp(good[i, 0], good[i, 1], good[m]) - good[i, 2:4])))
        self.reg = {"windows": int(len(P)), "used": int(len(good)), "median_shift_m": {"north": r1(-med[0]), "east": r1(med[1])},
                    "range_north_m": [r1(-good[:, 2].max()), r1(-good[:, 2].min())], "range_east_m": [r1(good[:, 3].min()), r1(good[:, 3].max())],
                    "loo_err_m": {"p50": r1(np.median(loo)), "p90": r1(np.percentile(loo, 90))}}
        self.reg["clouds"] = self.cloud_stats
        return self.reg

    def _interp(self, r, c, pts, sigma=250.0):
        d2 = (pts[:, 0] - r) ** 2 + (pts[:, 1] - c) ** 2
        w = np.exp(-d2 / (2 * sigma ** 2)) * pts[:, 4]
        if w.sum() < 1e-6:
            w = pts[:, 4]
        return (w[:, None] * pts[:, 2:4]).sum(0) / w.sum()

    def shift_at(self, x, y):
        r, c = self.rc(x, y)
        return self._interp(float(r), float(c), self.reg_pts)

    def sample(self, arr, x, y, sh):
        r, c = self.rc(x, y)
        r = np.round(r + sh[0]).astype(int); c = np.round(c + sh[1]).astype(int)
        ok = (r >= 0) & (r < self.H) & (c >= 0) & (c < self.W)
        out = np.full(len(r), np.nan, np.float32)
        out[ok] = arr[r[ok], c[ok]]
        return out


def grid_pts(g, step=1.0):
    minx, miny, maxx, maxy = g.bounds
    xs, ys = np.meshgrid(np.arange(minx + step / 2, maxx, step), np.arange(miny + step / 2, maxy, step))
    xs, ys = xs.ravel(), ys.ravel()
    m = shapely.contains_xy(g, xs, ys)
    return xs[m], ys[m]


def contrast(sat, g, ring, sh, dx=0.0, dy=0.0):
    """(ring NDVI - inside NDVI) / pooled noise. Positive = the footprint is less green than its surroundings."""
    xi, yi = grid_pts(g)
    xr, yr = grid_pts(ring)
    if len(xi) < 6 or len(xr) < 10:
        return np.nan, np.nan
    a = sat.sample(sat.ndvi, xi + dx, yi + dy, sh); b = sat.sample(sat.ndvi, xr + dx, yr + dy, sh)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 6 or len(b) < 10:
        return np.nan, np.nan
    s = math.sqrt((a.var() / len(a)) + (b.var() / len(b))) + 1e-6
    return float((b.mean() - a.mean()) / s), float(a.mean())


def best_offset(sat, g, ring, sh, R=6):
    best = (-1e9, 0, 0)
    xi, yi = grid_pts(g); xr, yr = grid_pts(ring)
    if len(xi) < 6 or len(xr) < 10:
        return None
    res = np.full((2 * R + 1, 2 * R + 1), np.nan)
    for i, dy in enumerate(range(-R, R + 1)):
        for j, dx in enumerate(range(-R, R + 1)):
            a = sat.sample(sat.ndvi, xi + dx, yi + dy, sh); b = sat.sample(sat.ndvi, xr + dx, yr + dy, sh)
            a, b = a[np.isfinite(a)], b[np.isfinite(b)]
            if len(a) < 6 or len(b) < 10:
                continue
            v = float(b.mean() - a.mean())
            res[i, j] = v
            if v > best[0]:
                best = (v, dx, dy)
    v, dx, dy = best
    i, j = dy + R, dx + R
    if 0 < i < 2 * R and 0 < j < 2 * R and np.isfinite(res[i - 1:i + 2, j - 1:j + 2]).all():
        def sp(a, b, c):
            d = a - 2 * b + c
            return 0.0 if d == 0 else 0.5 * (a - c) / d
        dx += sp(res[i, j - 1], res[i, j], res[i, j + 1]); dy += sp(res[i - 1, j], res[i, j], res[i + 1, j])
    edge = abs(best[1]) == R or abs(best[2]) == R
    return dx, dy, edge


class CHM:
    def __init__(self, path, origin):
        with rasterio.open(path) as s:
            self.a = s.read(1); self.T = s.transform
        self.o = origin

    def frac_ge(self, g, h=3.0):
        xs, ys = grid_pts(g)
        if len(xs) == 0:
            return np.nan
        X, Y = UTM_TO_3857.transform(xs + self.o[0], ys + self.o[1])
        c = ((np.asarray(X) - self.T.c) / self.T.a).astype(int); r = ((np.asarray(Y) - self.T.f) / self.T.e).astype(int)
        ok = (r >= 0) & (r < self.a.shape[0]) & (c >= 0) & (c < self.a.shape[1])
        if not ok.any():
            return np.nan
        return float((self.a[r[ok], c[ok]] >= h).mean())


def load_ms(path, origin):
    t = pq.read_table(path)
    out = []
    for g in shapely.from_wkb(t["geometry"].to_numpy(zero_copy_only=False)):
        g = shapely.transform(g, lambda c: np.column_stack(TO_UTM.transform(c[:, 0], c[:, 1])) - origin)
        g = g if g.geom_type == "Polygon" else max(g.geoms, key=lambda p: p.area)
        out.append(shapely.make_valid(g).buffer(0))
    return out


def areas_of(cache, origin, core):
    t = pq.read_table(cache / "evidence" / "divisions.parquet").to_pylist()
    pts = []
    for r in t:
        if r["subtype"] != "locality":
            continue
        g = shapely.from_wkb(r["geometry"])
        x, y = TO_UTM.transform(g.x, g.y)
        pts.append(((r["names"] or {}).get("primary"), x - origin[0], y - origin[1]))
    return pts


def main(area_id="plav-town"):
    area = CONFIG["areas"][area_id]
    cache = HERE / "cache" / area_id
    out_dir = ROOT / "public" / "data" / area_id
    meta = json.loads((out_dir / "meta.json").read_text())
    origin = np.array(meta["origin"], float)
    ext = meta["extent"]
    core = shapely.box(-ext["halfW"], -ext["halfH"], ext["halfW"], ext["halfH"])
    bj = json.loads((out_dir / "buildings.json").read_text())
    B = bj["buildings"]
    removed = bj.get("removed", [])
    s2 = {b["id"]: b for b in json.loads((out_dir / "audit_geo.json").read_text())["buildings"]}
    vec = json.loads((out_dir / "vectors.json").read_text())
    P = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in B]
    allfp = shapely.union_all(P)
    shapely.prepare(allfp)
    tree = STRtree(P)

    print(f"[{area_id}] {len(B)} buildings; loading evidence")
    ms = load_ms(cache / "evidence" / "ms2023.parquet", origin)
    mtree = STRtree(ms)
    sat = Sat(cache / "evidence" / "satellogic_toa.tif", origin)
    reg = sat.register(P)
    print("  registration", reg)
    chm = CHM(cache / "evidence" / "chm.tif", origin)
    roads = [(LineString(r["pts"]), r) for r in vec["roads"] if len(r["pts"]) >= 2]
    car = [(l, r) for l, r in roads if r["c"] in CAR and not r.get("bridge") and not r.get("tunnel")]
    road_buf = shapely.union_all([l.buffer(4.0) for l, _ in car])

    Pb = [p.buffer(0.5) for p in P]

    def ring_of(g):
        rg = g.buffer(5.0).difference(g.buffer(1.5))
        near = [Pb[j] for j in tree.query(rg)]
        return rg.difference(shapely.union_all(near)) if near else rg

    # ---- calibration: OSM footprints in place vs the same shapes on open ground ------------------------------
    open_ground = core.buffer(-60).difference(allfp.buffer(10)).difference(road_buf.buffer(4))
    og = shapely.prepared.prep(open_ground)
    osm_i = [i for i, b in enumerate(B) if b["src"] == "osm"]
    null, pos = [], []
    for i in osm_i:
        g = P[i]
        if g.area < 25 or sat.is_obscured(g.centroid.x, g.centroid.y):
            continue
        sh = sat.shift_at(g.centroid.x, g.centroid.y)
        v, nd = contrast(sat, g, ring_of(g), sh)
        if np.isfinite(v):
            pos.append((g.area, v, nd))
        for _ in range(12):
            an, d = RNG.uniform(0, 2 * math.pi), RNG.uniform(30, 150)
            gg = shapely.affinity.translate(g, d * math.cos(an), d * math.sin(an))
            if og.contains(gg) and not sat.is_obscured(gg.centroid.x, gg.centroid.y):
                sh2 = sat.shift_at(gg.centroid.x, gg.centroid.y)
                rg = gg.buffer(5.0).difference(gg.buffer(1.5))
                v, nd = contrast(sat, gg, rg, sh2)
                if np.isfinite(v):
                    null.append((gg.area, v, nd))
                break
    null, pos = np.array(null), np.array(pos)
    T_PRES = float(np.quantile(null[:, 1], 0.95))        # 5 % of open-ground shapes pass
    T_VEG = float(np.quantile(pos[:, 2], 0.95))          # inside NDVI greener than 95 % of OSM houses
    calib = {"null_n": len(null), "osm_n": len(pos), "t_presence": r1(T_PRES), "t_veg_ndvi": r1(T_VEG), "by_size": {}}
    for lo, hi in ((25, 60), (60, 120), (120, 250), (250, 1e9)):
        a = pos[(pos[:, 0] >= lo) & (pos[:, 0] < hi)]; n = null[(null[:, 0] >= lo) & (null[:, 0] < hi)]
        calib["by_size"][f"{lo}-{int(hi) if hi < 1e9 else ''}"] = {
            "osm_n": len(a), "osm_detected_pct": r1(100 * (a[:, 1] > T_PRES).mean()) if len(a) else None,
            "null_n": len(n), "null_detected_pct": r1(100 * (n[:, 1] > T_PRES).mean()) if len(n) else None}
    print("  calibration", calib)

    # ---- per building ----------------------------------------------------------------------------------------
    locs = areas_of(cache, origin, core)
    lp = np.array([(x, y) for _, x, y in locs])
    per = []
    for i, (b, g) in enumerate(zip(B, P)):
        c = g.centroid
        rec = {"id": b["id"], "src": b["src"], "a": round(g.area, 1)}
        rec["area"] = locs[int(np.argmin(((lp - [c.x, c.y]) ** 2).sum(1)))][0]
        # OSM vs raw Microsoft
        if b["src"] == "osm":
            best = None
            for j in mtree.query(g, predicate="intersects"):
                q = ms[j]
                iou = g.intersection(q).area / g.union(q).area
                if best is None or iou > best[0]:
                    best = (iou, j)
            if best:
                q = ms[best[1]]
                d = np.array(q.centroid.coords[0]) - np.array(c.coords[0])
                a1, e1 = obb_angle(g); a2, e2 = obb_angle(q)
                rec.update(ms_iou=r1(best[0]), ms_d=r1(float(np.hypot(*d))), ms_dang=r1(adiff(a2, a1, 90)) if min(e1, e2) > 1.15 else None)
            else:
                rec.update(ms_iou=0.0)
        # imagery
        sh = sat.shift_at(c.x, c.y)
        ring = ring_of(g)
        obsc = sat.is_obscured(c.x, c.y)
        v, nd = (np.nan, np.nan) if obsc else contrast(sat, g, ring, sh)
        rec.update(img=r1(v), ndvi=r1(nd), obsc=obsc)
        if g.area >= 12 and np.isfinite(v):
            bo = best_offset(sat, g, ring, sh)
            if bo:
                dx, dy, edge = bo
                v2, _ = contrast(sat, g, ring, sh, dx, dy)
                rec.update(res=r1(math.hypot(dx, dy)), res_dx=r1(dx), res_dy=r1(dy), res_edge=bool(edge), img_best=r1(v2))
        rec["chm"] = r1(chm.frac_ge(g))
        s = s2.get(b["id"], {})
        rec["s2"] = s.get("img")
        per.append(rec)
        if i % 500 == 0:
            print(f"  {i}/{len(B)}")

    # ---- tiers -----------------------------------------------------------------------------------------------
    # Position tolerance comes from the gold set: buildings whose OSM and Microsoft outlines agree (two independent
    # producers) and whose roof the 1 m image shows. Their residual is pure measurement noise of this test
    # (1 m noisy pixels, overhangs, registration), so its 90th percentile is the honest tolerance.
    gold = np.array([r["res"] for r in per if r["src"] == "osm" and (r.get("ms_iou") or 0) >= 0.5 and r.get("res") is not None
                     and (r["img"] or -9) > T_PRES and not r.get("res_edge")])
    RES_TOL = float(np.percentile(gold, 90))
    calib["position_tolerance_m"] = {"gold_n": int(len(gold)), "p50": r1(np.median(gold)), "p90": r1(RES_TOL), "p95": r1(np.percentile(gold, 95))}
    for r in per:
        img_present = r["img"] is not None and r["img"] > T_PRES
        img_best_present = r.get("img_best") is not None and r["img_best"] > T_PRES
        pos_ok = r.get("res") is not None and r["res"] <= RES_TOL and not r.get("res_edge")
        ms_ok = r["src"] == "osm" and (r.get("ms_iou") or 0) >= 0.5
        veg = r["ndvi"] is not None and r["ndvi"] > T_VEG and not img_present
        canopy = r["chm"] is not None and r["chm"] >= 0.4
        s2veg = r["s2"] == "disagrees"
        if ms_ok:
            t = "verified"
        elif img_present and (pos_ok or r.get("res") is None):
            t = "confirmed"
        elif img_present or img_best_present or r["s2"] == "supported" or (r["src"] == "osm" and (r.get("ms_iou") or 0) > 0):
            t = "present"
        elif r["src"] == "ms" and not r["obsc"] and veg and (canopy or s2veg):
            t = "disputed"
        else:
            t = "unconfirmed"
        r["tier"] = t
        why = []
        if ms_ok:
            why.append(f"OSM and Microsoft outlines agree (IoU {r['ms_iou']})")
        elif r["src"] == "osm" and r.get("ms_iou"):
            why.append(f"Microsoft outline differs (IoU {r['ms_iou']})")
        if r["obsc"]:
            why.append("1 m imagery obscured by cloud/shadow")
        elif img_present:
            why.append("roof visible in 1 m imagery" + (f", fits {r['res']} m from mapped position" if r.get("res") is not None else ""))
        elif img_best_present:
            why.append(f"roof-like signal in 1 m imagery {r['res']} m away")
        if r["s2"] == "supported":
            why.append("Sentinel-2 built signal")
        if t == "disputed":
            why.append("1 m imagery shows vegetation inside" + (", Meta canopy >= 3 m over " + str(int(100 * r["chm"])) + " %" if canopy else "") + (", Sentinel-2 vegetation" if s2veg else ""))
        r["why"] = "; ".join(why)

    # ---- missing-building candidates: non-vegetated roof-sized blobs with no footprint ------------------------
    # (listed only; nothing is added)
    cand = missing_candidates(sat, allfp, road_buf, core, T_VEG, vec)
    # does another dataset vintage (GBA: OSM 2025 + Microsoft 2024) have a footprint at the candidate?
    gba = pq.read_table(cache / "evidence" / "gba.parquet")
    gpolys = load_ms(cache / "evidence" / "gba.parquet", origin)
    gsrc = gba["source"].to_pylist()
    gtree = STRtree(gpolys)
    extra = [i for i, g in enumerate(gpolys) if core.contains(g.centroid) and not len(tree.query(g, predicate="intersects"))]
    for pt in cand["points"]:
        hit = [j for j in gtree.query(Point(pt[0], pt[1]).buffer(5), predicate="intersects")]
        pt.append(gsrc[hit[0]] if hit else None)
    cand["with_gba_footprint"] = sum(1 for pt in cand["points"] if pt[3])
    ev = []
    for i in extra:
        g = gpolys[i]; c = g.centroid
        if g.area < 12 or sat.is_obscured(c.x, c.y):
            ev.append((i, None, None)); continue
        sh = sat.shift_at(c.x, c.y)
        v, _ = contrast(sat, g, ring_of(g), sh)
        bo = best_offset(sat, g, ring_of(g), sh) if np.isfinite(v) else None
        ev.append((i, r1(v), r1(math.hypot(bo[0], bo[1])) if bo and not bo[2] else None))
    roof = [e for e in ev if e[1] is not None and e[1] > T_PRES and e[2] is not None and e[2] <= RES_TOL]
    cand["gba_not_in_model"] = {"n": len(extra), "by_source": dict(Counter(gsrc[i] for i in extra)),
                                "roof_confirmed_in_1m": len(roof), "obscured_or_tiny": sum(1 for e in ev if e[1] is None),
                                "points": [[round(gpolys[i].centroid.x, 1), round(gpolys[i].centroid.y, 1), round(gpolys[i].area), gsrc[i], img, res]
                                           for i, img, res in ev],
                                "note": "Microsoft 2024 footprints (via GlobalBuildingAtlas) absent from Microsoft 2026 / OSM; not added"}

    # ---- streets ---------------------------------------------------------------------------------------------
    streets = street_check(sat, car, P, tree, allfp)

    # ---- public spaces: OSM land-use polygons in the area, with the 1 m imagery signal inside --------------------
    publics = []
    for r in pq.read_table(cache / "land_use.parquet").to_pylist():
        if r["class"] in ("meadow", "farmland", "national_park", "residential"):
            continue
        g = shapely.from_wkb(r["geometry"])
        if g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        g = shapely.make_valid(shapely.transform(g, lambda c: np.column_stack(TO_UTM.transform(c[:, 0], c[:, 1])) - origin)).buffer(0)
        if not core.intersects(g):
            continue
        c = g.representative_point()
        obsc = sat.is_obscured(c.x, c.y)
        nd = None
        if not obsc:
            xs, ys = grid_pts(g, 2.0)
            vv = sat.sample(sat.ndvi, xs, ys, sat.shift_at(c.x, c.y))
            nd = r1(np.nanmean(vv)) if np.isfinite(vv).any() else None
        bld = sum(1 for j in tree.query(g, predicate="intersects") if P[j].intersection(g).area > 0.5 * P[j].area)
        publics.append({"class": r["class"], "name": (r["names"] or {}).get("primary"), "area_m2": round(g.area),
                        "x": round(c.x, 1), "y": round(c.y, 1), "buildings_inside": bld, "ndvi_1m": nd, "obscured": obsc,
                        "osm": next((x.get("record_id") for x in (r["sources"] or []) if x.get("dataset") == "OpenStreetMap"), None)})

    # ---- spacing (model vs raw Microsoft, independent of OSM) -----------------------------------------------
    spacing = spacing_check(P, B, ms, core)

    # ---- summaries -------------------------------------------------------------------------------------------
    def summ(rows):
        tc = Counter(r["tier"] for r in rows)
        osm = [r for r in rows if r["src"] == "osm"]
        res = np.array([r["res"] for r in rows if r.get("res") is not None and (r.get("img_best") or -9) > T_PRES and not r.get("res_edge")])
        return {"n": len(rows), "osm": len(osm), "ms": len(rows) - len(osm), "tiers": dict(tc),
                "osm_ms_iou_ge_0_5": sum(1 for r in osm if (r.get("ms_iou") or 0) >= 0.5),
                "resid_p50": r1(np.median(res)) if len(res) else None, "resid_p90": r1(np.percentile(res, 90)) if len(res) else None,
                "resid_n": int(len(res)), "obscured": sum(1 for r in rows if r["obsc"])}
    by_area = defaultdict(list)
    for r in per:
        by_area[r["area"]].append(r)
    areas = {k: summ(v) for k, v in sorted(by_area.items(), key=lambda kv: -len(kv[1]))}
    osm = [r for r in per if r["src"] == "osm" and r.get("ms_d") is not None and r["ms_iou"] >= 0.5]
    dang = [abs(r["ms_dang"]) for r in osm if r.get("ms_dang") is not None]
    report = {
        "generated_by": "pipeline/verify_city.py",
        "sources": {
            "footprints": "Overture 2026-11-18.0 (OSM + Microsoft ML Buildings)",
            "ms2023": "Microsoft Global ML Building Footprints via VIDA google-microsoft-open-buildings (ODbL)",
            "imagery_1m": "Satellogic EarthView 2022-08-31, newsat20, 3.9 deg off-nadir, L1 (CC BY 4.0)",
            "chm": "Meta/WRI DINOv3 Global Canopy Height Map v2, Maxar 2011-11-02..2019-08-07 (CC BY 4.0)",
            "s2": "Copernicus Sentinel-2 L2A summer 2025 median (audit_geo.py)"},
        "registration": reg, "calibration": calib, "total": summ(per), "areas": areas,
        "osm_vs_ms": {"n_matched": len(osm), "centroid_d_p50": r1(np.median([r["ms_d"] for r in osm])),
                      "centroid_d_p90": r1(np.percentile([r["ms_d"] for r in osm], 90)),
                      "angle_p50": r1(np.median(dang)), "angle_p90": r1(np.percentile(dang, 90)), "angle_gt10_pct": r1(100 * np.mean(np.array(dang) > 10))},
        "rotation": "not tested: a rotation search on the 1 m imagery gave a median 8 deg even on the OSM+Microsoft gold set, i.e. noise; orientation is checked only OSM vs Microsoft",
        "orientation_disagreements": [{"id": r["id"], "area": r["area"], "dang": r["ms_dang"]} for r in per if r.get("ms_dang") is not None and abs(r["ms_dang"]) > 10],
        "obscured": int(sum(1 for r in per if r["obsc"])),        "missing_candidates": cand, "streets": streets, "spacing": spacing, "public_spaces": publics,
        "removed_check": removed_check(sat, removed, ring_of, T_PRES, chm),
    }
    (cache / "verify-city.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    slim = [{k: r[k] for k in ("id", "tier", "why", "area") if k in r} | {k: r[k] for k in ("ms_iou", "res", "img", "chm", "obsc") if r.get(k)} for r in per]
    (out_dir / "verify.json").write_text(json.dumps({"summary": {k: report[k] for k in ("sources", "registration", "calibration", "total", "areas", "osm_vs_ms", "obscured")},
                                                      "buildings": slim, "missing": [p[:3] for p in cand["gba_not_in_model"]["points"] if p[4] is not None and p[4] > T_PRES and p[5] is not None and p[5] <= RES_TOL], "streets": streets["flagged"]},
                                                     separators=(",", ":"), ensure_ascii=False))
    print(json.dumps({k: report[k] for k in ("total", "osm_vs_ms", "obscured", "calibration")}, indent=1, ensure_ascii=False))
    for k, v in areas.items():
        print(f"  {k:16s} {v}")
    print("  streets", {k: v for k, v in streets.items() if k != "flagged"})
    print("  spacing", spacing)
    print("  missing", {k: v for k, v in cand.items() if k != "points"})


def missing_candidates(sat, allfp, road_buf, core, t_veg, vec):
    """Roof-sized (>= 40 m2) connected regions with low NDVI in the 1 m imagery, >= 4 m from any footprint and road."""
    from scipy import ndimage
    from rasterio.features import shapes
    lo = np.nanpercentile(sat.ndvi, 50)
    # registration-corrected grid: shift the image by the field at the centre of each 384 px block
    excl = shapely.union_all([allfp.buffer(4), road_buf.buffer(3)] +
                             [shapely.make_valid(Polygon(w["outer"], w.get("holes") or [])).buffer(0) for w in vec.get("water", [])])
    pts, n_cells = [], 0
    smooth = ndimage.uniform_filter(np.nan_to_num(sat.ndvi, nan=1.0), 3)
    thr = min(0.12, lo - 0.1)
    lab, n = ndimage.label(smooth < thr)
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    cms = ndimage.center_of_mass(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    for k, (sz, (r, c)) in enumerate(zip(sizes, cms)):
        if sz < 40 or sz > 600:
            continue
        # back to local coordinates through the registration field at that spot
        X = sat.T.c + c * sat.T.a - sat.o[0]; Y = sat.T.f + r * sat.T.e - sat.o[1]
        for _ in range(3):
            sh = sat.shift_at(X, Y)
            X = sat.T.c + (c - sh[1]) * sat.T.a - sat.o[0]; Y = sat.T.f + (r - sh[0]) * sat.T.e - sat.o[1]
        p = Point(X, Y)
        if not core.buffer(-20).contains(p) or excl.contains(p) or sat.obscured[int(r), int(c)]:
            continue
        pts.append([round(X, 1), round(Y, 1), int(sz)])
    return {"threshold_ndvi": r1(thr), "n": len(pts), "points": pts,
            "note": "low-NDVI blobs 40-600 m2 >= 4 m from any footprint, road or water; may be roofs, bare soil, gravel or construction sites; nothing added"}


def street_check(sat, car, P, tree, allfp):
    """Cross-profile of the 1 m image across each car road: offset of the least-green line from the OSM centreline."""
    rows, flagged = [], []
    for l, r in car:
        if l.length < 60 or r["c"] == "service":
            continue
        prof = np.zeros(41); cnt = np.zeros(41)
        for s in np.arange(5, l.length - 5, 4.0):
            p = l.interpolate(s); q = l.interpolate(min(s + 1, l.length))
            t = np.array([q.x - p.x, q.y - p.y]); t /= (np.hypot(*t) + 1e-9); nrm = np.array([-t[1], t[0]])
            offs = np.arange(-20, 21)
            xs = p.x + nrm[0] * offs; ys = p.y + nrm[1] * offs
            if sat.is_obscured(p.x, p.y):
                continue
            sh = sat.shift_at(p.x, p.y)
            v = sat.sample(sat.ndvi, xs, ys, sh)
            # skip cross-sections that run into a footprint (roofs also have low NDVI)
            inside = shapely.contains_xy(allfp, xs, ys)
            v[inside] = np.nan
            m = np.isfinite(v)
            prof[m] += v[m]; cnt[m] += 1
        if cnt[15:26].min() < 5:
            continue
        pr = prof / np.maximum(cnt, 1)
        from scipy.ndimage import uniform_filter1d
        sm = uniform_filter1d(pr, 3)
        k = int(np.argmin(sm[8:33])) + 8
        depth = float(np.median(sm[[0, 1, 2, 3, 37, 38, 39, 40]]) - sm[k])
        off = k - 20
        rec = {"c": r["c"], "n": r.get("n"), "len": round(l.length), "off": off, "depth": r1(depth)}
        rows.append(rec)
        if depth > 0.08 and abs(off) >= 5:
            mid = l.interpolate(0.5, normalized=True)
            flagged.append(rec | {"x": round(mid.x, 1), "y": round(mid.y, 1)})
    good = [r for r in rows if r["depth"] and r["depth"] > 0.08]
    offs = np.array([abs(r["off"]) for r in good])
    return {"segments_tested": len(rows), "with_clear_road_signal": len(good),
            "abs_off_p50": r1(np.median(offs)) if len(offs) else None, "abs_off_p90": r1(np.percentile(offs, 90)) if len(offs) else None,
            "within_3m_pct": r1(100 * (offs <= 3).mean()) if len(offs) else None, "flagged": flagged,
            "note": "offset of the least-green line across the road (1 m imagery, registration-corrected) from the OSM centreline; flagged when >= 5 m with a clear road signal"}


def spacing_check(P, B, ms, core):
    """Nearest-neighbour gap between buildings: shown layer vs raw Microsoft (a separate producer)."""
    def gaps(polys):
        t = STRtree(polys)
        out = []
        for i, g in enumerate(polys):
            if g.area < 25 or not core.contains(g.centroid):
                continue
            best = 1e9
            for j in t.query(g.buffer(30)):
                if j != i and polys[j].area >= 25:
                    best = min(best, g.distance(polys[j]))
            if best < 1e9:
                out.append(best)
        return np.array(out)
    a = gaps(P); b = gaps([m for m in ms if core.contains(m.centroid)])
    q = lambda v, p: r1(np.percentile(v, p))  # noqa: E731
    return {"shown": {"n": len(a), "p10": q(a, 10), "p50": q(a, 50), "p90": q(a, 90), "touching_pct": r1(100 * (a < 0.3).mean())},
            "ms2023": {"n": len(b), "p10": q(b, 10), "p50": q(b, 50), "p90": q(b, 90), "touching_pct": r1(100 * (b < 0.3).mean())}}


def removed_check(sat, removed, ring_of, t_pres, chm):
    out = Counter()
    for b in removed:
        g = shapely.make_valid(Polygon(b["fp"])).buffer(0)
        sh = sat.shift_at(g.centroid.x, g.centroid.y)
        v, _ = contrast(sat, g, g.buffer(5).difference(g.buffer(1.5)), sh)
        out[(b["reason"], "roof" if np.isfinite(v) and v > t_pres else "no_roof")] += 1
    return {f"{k[0]}:{k[1]}": v for k, v in out.items()}


if __name__ == "__main__":
    import shapely.prepared  # noqa: F401
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
