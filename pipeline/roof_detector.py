"""Phase 3b: a calibrated roof detector on the 1 m Satellogic pass A, used as extra presence evidence.

verify_city.py tests presence with one number (vegetation / brightness contrast between a footprint and the ring
around it). That finds only ~59 % of known-good buildings. This script learns what roofs look like in this image:

  1. Resample the re-registered pass A (verify_city.Sat, leave-one-out error ~0.9 m) onto the local 1 m grid.
  2. Features per pixel (3x3 mean): log R, G, B, NIR, NDVI, R-G and B-R ratios, log brightness.
  3. Quadratic discriminant (one Gaussian for roof pixels, one for ground next to buildings), trained on HALF the gold
     set (OSM outline that Microsoft confirms, IoU >= 0.5). The other half is held out for testing.
  4. Score of a footprint: mean log-likelihood ratio inside (contrast = inside minus 1.5-5 m ring; absolute = inside).
  5. Null: the same outlines translated 30-150 m onto open ground (no footprint within 10 m). Thresholds are the
     95th percentile of the null, so each test fires on empty ground 5 % of the time.

What it can and cannot do (measured, see roof-detector.json):
  - presence at the mapped position: held-out gold detected well above the 5 % null rate -> usable as evidence
  - outline / rotation / few-metre shift: the true outline beats a 12 deg rotated or 3 m shifted decoy only
    53-68 % of the time -> NOT used to move or reshape anything.

Output: pipeline/cache/<area>/roof-detector.json  {calibration, buildings: {id: [contrast, absolute, det]},
        extras: {gba index: [contrast, absolute, det]}}
Usage: python pipeline/roof_detector.py plav-town
"""
from __future__ import annotations

import json
import sys

import numpy as np
import rasterio
import shapely
import shapely.affinity
import shapely.prepared
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import Polygon
from shapely.strtree import STRtree

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import HERE, ROOT  # noqa: E402
from verify_city import Sat, load_ms  # noqa: E402

RNG = np.random.default_rng(0)


def resample(sat, A, E):
    x0, x1, y0, y1 = -E["halfW"], E["halfW"], -E["halfH"], E["halfH"]
    nx, ny = int(x1 - x0), int(y1 - y0)
    cx = np.arange(x0, x1 + 32, 32); cy = np.arange(y0, y1 + 32, 32)
    SH = np.array([[sat.shift_at(x, y) for x in cx] for y in cy])
    X, Y = np.meshgrid(x0 + 0.5 + np.arange(nx), y1 - 0.5 - np.arange(ny))
    fx, fy = (X - x0) / 32, (Y - y0) / 32
    shr = ndimage.map_coordinates(SH[..., 0], [fy, fx], order=1); shc = ndimage.map_coordinates(SH[..., 1], [fy, fx], order=1)
    r, c = sat.rc(X, Y); r = r + shr; c = c + shc
    L = np.stack([ndimage.map_coordinates(A[k], [r, c], order=1, cval=0) for k in range(4)])
    ob = ndimage.map_coordinates(sat.obscured.astype(np.float32), [r, c], order=0, cval=1) > 0.5
    return L, (L[0] > 0) & ~ob, (x0, y1, nx, ny)


def features(L):
    eps = 1
    R, G, B, N = [ndimage.uniform_filter(L[k], 3) for k in range(4)]
    br = (R + G + B) / 3
    return np.stack([np.log(R + eps), np.log(G + eps), np.log(B + eps), np.log(N + eps), (N - R) / (N + R + eps),
                     (R - G) / (R + G + eps), (B - R) / (B + R + eps), np.log(br + eps)])


def fit(X):
    m = X.mean(0); C = np.cov(X.T) + 1e-4 * np.eye(X.shape[1])
    return m, np.linalg.inv(C), np.linalg.slogdet(C)[1]


def ll(X, p):
    m, Ci, ld = p; d = X - m
    return -0.5 * (np.einsum("ij,jk,ik->i", d, Ci, d) + ld)


def main(area_id="plav-town"):
    out_dir = ROOT / "public" / "data" / area_id
    cache = HERE / "cache" / area_id
    meta = json.loads((out_dir / "meta.json").read_text()); O = np.array(meta["origin"], float); E = meta["extent"]
    bj = cache / "buildings.pre-corrections.json"
    B = json.loads((bj if bj.exists() else out_dir / "buildings.json").read_text())["buildings"]
    B = [b for b in B if not b.get("corr")]
    P = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in B]
    ms = load_ms(cache / "evidence" / "ms2023.parquet", O)
    mtree = STRtree(ms)

    def ms_iou(g):
        best = 0.0
        for j in mtree.query(g, predicate="intersects"):
            u = g.union(ms[j]).area
            best = max(best, g.intersection(ms[j]).area / u if u else 0)
        return best

    sat = Sat(cache / "evidence" / "satellogic_toa.tif", O)
    sat.register(P)
    with rasterio.open(cache / "evidence" / "satellogic_toa.tif") as f:
        A = f.read().astype(np.float32)
    L, V, (x0, y1, nx, ny) = resample(sat, A, E)
    T = Affine(1, 0, x0, 0, -1, y1)
    F = features(L)
    allm = rasterize([(p, 1) for p in P], out_shape=(ny, nx), transform=T, dtype="uint8").astype(bool)

    gold = [i for i, b in enumerate(B) if b["src"] == "osm" and ms_iou(P[i]) >= 0.5]
    RNG.shuffle(gold); train, test = gold[: len(gold) // 2], set(gold[len(gold) // 2:])
    pos = rasterize([(P[i].buffer(-1.0), 1) for i in train if not P[i].buffer(-1).is_empty], out_shape=(ny, nx), transform=T, dtype="uint8").astype(bool) & V
    neg = rasterize([(P[i].buffer(6).difference(P[i].buffer(2)), 1) for i in train], out_shape=(ny, nx), transform=T, dtype="uint8").astype(bool)
    neg &= V & ~ndimage.binary_dilation(allm, iterations=2)
    pp, pn = fit(F[:, pos].T), fit(F[:, neg].T)
    S = np.clip(ll(F.reshape(8, -1).T, pp) - ll(F.reshape(8, -1).T, pn), -20, 20).reshape(ny, nx).astype(np.float32)
    S[~V] = np.nan

    def score(g, own=None):
        """(contrast, absolute) of the detector for outline g, other footprints masked out of the ring."""
        minx, miny, maxx, maxy = g.buffer(7).bounds
        c0, c1, r0, r1_ = int(minx - x0), int(maxx - x0) + 1, int(y1 - maxy), int(y1 - miny) + 1
        if c0 < 0 or r0 < 0 or c1 > nx or r1_ > ny:
            return None
        Tl = Affine(1, 0, x0 + c0, 0, -1, y1 - r0); sh = (r1_ - r0, c1 - c0)
        mi = rasterize([(g, 1)], out_shape=sh, transform=Tl, dtype="uint8").astype(bool)
        mr = rasterize([(g.buffer(5).difference(g.buffer(1.5)), 1)], out_shape=sh, transform=Tl, dtype="uint8").astype(bool) & ~allm[r0:r1_, c0:c1]
        Ss = S[r0:r1_, c0:c1]; a = Ss[mi]; b = Ss[mr]; a = a[np.isfinite(a)]; b = b[np.isfinite(b)]
        if len(a) < 6 or len(b) < 10:
            return None
        return float(a.mean() - b.mean()), float(a.mean())

    # null on open ground, from translated copies of every OSM outline
    openg = shapely.prepared.prep(shapely.box(-E["halfW"] + 50, -E["halfH"] + 50, E["halfW"] - 50, E["halfH"] - 50).difference(shapely.union_all(P).buffer(10)))
    null = []
    for i, b in enumerate(B):
        if b["src"] != "osm":
            continue
        for _ in range(10):
            a, d = RNG.uniform(0, 2 * np.pi), RNG.uniform(30, 150)
            g = shapely.affinity.translate(P[i], d * np.cos(a), d * np.sin(a))
            if openg.contains(g):
                v = score(g)
                if v:
                    null.append((g.area, *v))
                break
    null = np.array(null)
    tc, ta = float(np.quantile(null[:, 1], 0.95)), float(np.quantile(null[:, 2], 0.95))
    null_either = float(((null[:, 1] > tc) | (null[:, 2] > ta)).mean())
    null_both = float(((null[:, 1] > tc) & (null[:, 2] > ta)).mean())

    rows = {}
    for i, b in enumerate(B):
        v = score(P[i])
        rows[b["id"]] = None if v is None else [round(v[0], 2), round(v[1], 2), int(v[0] > tc) + int(v[1] > ta)]
    ht = [rows[B[i]["id"]] for i in test if rows[B[i]["id"]]]
    hd = np.array([r[2] for r in ht])

    # GBA (Microsoft 2024) footprints absent from the model
    gba = load_ms(cache / "evidence" / "gba.parquet", O)
    tree = STRtree(P)
    core = shapely.box(-E["halfW"], -E["halfH"], E["halfW"], E["halfH"])
    extras = {}
    for j, g in enumerate(gba):
        if core.contains(g.centroid) and not len(tree.query(g, predicate="intersects")) and g.area >= 12:
            v = score(g)
            extras[j] = None if v is None else [round(v[0], 2), round(v[1], 2), int(v[0] > tc) + int(v[1] > ta)]

    cal = {"pixels": {"roof": int(pos.sum()), "ground": int(neg.sum())}, "gold_train": len(train), "gold_test": len(test),
           "null_n": len(null), "t_contrast": round(tc, 3), "t_absolute": round(ta, 3),
           "null_rate": {"contrast": 0.05, "absolute": 0.05, "either": round(null_either, 3), "both": round(null_both, 3)},
           "heldout_detect": {"either": round(float((hd >= 1).mean()), 3), "both": round(float((hd >= 2).mean()), 3), "n": len(hd)},
           "not_used_for": "outline, rotation or shift: decoy tests 53-68 % (chance 50 %)"}
    out = {"calibration": cal, "buildings": rows, "extras": extras}
    (cache / "roof-detector.json").write_text(json.dumps(out))
    print(json.dumps(cal, indent=1))
    print("buildings scored", sum(1 for r in rows.values() if r), "/", len(rows), "extras", len(extras),
          "extras det>=1", sum(1 for r in extras.values() if r and r[2] >= 1), "det2", sum(1 for r in extras.values() if r and r[2] >= 2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
