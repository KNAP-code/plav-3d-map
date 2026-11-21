"""Centre route reconstruction (Am's brief of 2026-11-21): Plato, Caffe TIMM, the two schools and the stadium.

What this step establishes, and from what:
  landmark positions   Overture Maps places (name, confidence) and OSM objects (school / pitch / pedestrian area)
  paved area (Plato?)  OSM way 1198743606: area=yes, highway=pedestrian, surface=paving_stones (outline VERIFIED).
                       Its surface colour is measured in the 1 m Satellogic image (ESTIMATED: colour calibration).
                       Whether this is the place locals call "Plato" is ESTIMATED; events of the town are announced on the
                       "Gradski trg" (plavto.me), which may be the paved square at the Dom kulture fountain instead.
  trees on the route   tree crowns in the 1 m image (haze-corrected NDVI > 0.33, darker than the stadium lawn), one tree per
                       crown, size from the crown area (position VERIFIED to ~2 m, species and height ESTIMATED).
                       WorldCover (10 m) misses these single trees, so the paved area was drawn bare.
  walk route           an eye-level path along Racina beside the paved area and the schools, past Caffe TIMM and up
                       the service road to the stadium (OSM centrelines offset to the street side; offset ESTIMATED)
Output: public/data/<area>/route.json
Usage:  python pipeline/route_recon.py plav-town
"""
from __future__ import annotations

import json
import sys

import numpy as np
import rasterio
import shapely
from affine import Affine
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import HERE, ROOT  # noqa: E402
from reconstruct import display_colour, srgb  # noqa: E402
from roof_detector import resample  # noqa: E402
from verify_city import Sat  # noqa: E402

PAVED = [(-305, 19), (-218, -44), (-179, -70), (-172, -62), (-157, -45), (-280, 43)]  # OSM w1198743606 (local m)

LANDMARKS = [
    {"id": "plato", "label": "Paved pedestrian area (Plato?)", "x": -232, "y": -8,
     "src": "OSM way 1198743606 (highway=pedestrian, area, paving_stones)", "posC": "V", "idC": "E",
     "note": "outline and surface are mapped; that this is the place called Plato is not confirmed"},
    {"id": "trg", "label": "Gradski trg (fountain)", "x": 0, "y": -70,
     "src": "Overture: fountain, footways, Tourist Organisation Plav", "posC": "V", "idC": "E",
     "note": "town events are announced on the Gradski trg; the second candidate for Plato"},
    {"id": "timm", "label": "Caffe & Restoran Timm", "x": -174, "y": -14,
     "src": "Overture place, confidence 0.94, address Racina", "posC": "E", "idC": "E", "building": "0a7635b8",
     "note": "the place point lies 3 m from footprint 0a7635b8 and 6 m from 43747d8b; which one is the cafe is not confirmed"},
    {"id": "high", "label": "Srednja škola Bećo Bašić", "x": -217, "y": -76,
     "src": "Overture place + OSM school building 98460503", "posC": "V", "idC": "V", "building": "98460503"},
    {"id": "primary", "label": "OŠ Hajro Šahmanović", "x": -279, "y": -24,
     "src": "OSM building 'Hajro Sahmanovic' (school) + Overture place", "posC": "V", "idC": "V", "building": "6aa65c9f"},
    {"id": "hala", "label": "Hala sportova", "x": -282, "y": -66, "src": "OSM building 'Hala Sportova'", "posC": "V",
     "idC": "V", "building": "808847eb"},
    {"id": "stadium", "label": "Stadion Pod Racinom", "x": -186, "y": 88,
     "src": "OSM stadium 'Stadion Racina' + pitch 97 x 65 m; Overture 'Stadion Pod Racinom'", "posC": "V", "idC": "V"},
]

# Walk (Am's order): the paved area by the schools -> Racina eastwards past both schools -> Caffe TIMM -> the service
# road north to the stadium. Waypoints are OSM centreline vertices; each leg is offset to the side of the street given
# (m, + = left of travel). The way into the stadium grounds is not mapped: the walk ends on the service road beside it.
LEGS = [
    ([(-276, 49), (-257, 35), (-159, -33)], -4.8),
    ([(-159, -33), (-145, -14), (-141, 8), (-148, 19), (-151, 28), (-155, 48)], 0.0),
]
END_LOOK = (-186, 88)  # the last metres turn towards the pitch centre


def path():
    pts = []
    for line, off in LEGS:
        ls = LineString(line)
        if off:
            ls = ls.offset_curve(off, join_style="round")
        seg = list(ls.coords)
        if pts and np.hypot(pts[-1][0] - seg[0][0], pts[-1][1] - seg[0][1]) < 0.5:
            seg = seg[1:]
        pts += seg
    ls = LineString(pts).simplify(0.4)
    L = ls.length
    dense = [ls.interpolate(s) for s in np.arange(0, L, 2.0)] + [Point(ls.coords[-1])]
    xy = [(round(p.x, 1), round(p.y, 1)) for p in dense]
    stops = []
    for lm in LANDMARKS:
        if lm["id"] in ("hala",):
            continue
        if ls.distance(Point(lm["x"], lm["y"])) > 80:
            continue
        s = ls.project(Point(lm["x"], lm["y"]))
        stops.append({"s": round(float(s), 1), "label": lm["label"], "id": lm["id"], "x": lm["x"], "y": lm["y"]})
    return xy, round(L, 1), sorted(stops, key=lambda t: t["s"])


def main(area_id="plav-town"):
    out_dir = ROOT / "public" / "data" / area_id
    cache = HERE / "cache" / area_id
    meta = json.loads((out_dir / "meta.json").read_text()); O = np.array(meta["origin"], float); E = meta["extent"]
    fixed = cache / "evidence" / "satellogic_toa_coreg.tif"  # written by reconstruct.py
    with rasterio.open(fixed) as f:
        A = f.read().astype(np.float32)
    sat = Sat(fixed, O)
    pre = json.loads((cache / "buildings.pre-corrections.json").read_text())["buildings"]
    sat.register([shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in pre if not b.get("corr")])
    Lr, Vm, (x0, y1, nx, ny) = resample(sat, A, E)
    T = Affine(1, 0, x0, 0, -1, y1)
    st = json.loads((out_dir / "streets.json").read_text())
    lin, ndvi, _ = display_colour(Lr, Vm, T, [Polygon(c["outer"]).buffer(-1.5) for c in st["carriage"]])
    # ground surfaces keep the asphalt white balance (roads are the neutral reference for the paving beside them); the
    # photo calibration in reconstruct.PHOTO_GAIN was fitted on roofs only

    B = json.loads((out_dir / "buildings.json").read_text())["buildings"]
    bpolys = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in B]
    roads = [Polygon(c["outer"]) for c in st["carriage"]]
    paved = Polygon(PAVED)
    xy, L, stops = path()
    corridor = LineString(xy).buffer(22).union(paved.buffer(4))
    blocked = shapely.unary_union([p.buffer(1.0) for p in bpolys if p.intersects(corridor.buffer(30))] +
                                  [r.buffer(-0.5) for r in roads if r.intersects(corridor)] + [LineString(xy).buffer(2.0)])

    from rasterio.features import rasterize
    inside = rasterize([(corridor, 1)], out_shape=(ny, nx), transform=T).astype(bool)
    pav = rasterize([(paved.buffer(-1.5), 1)], out_shape=(ny, nx), transform=T).astype(bool)

    # paved-surface colour: median of the non-vegetated pixels of the paved area
    m = pav & Vm & (ndvi < 0.15)
    pc = np.median(lin[:, m], axis=1)
    paving = {"rgb": "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in srgb(np.clip(pc, 0, 1))), "px": int(m.sum()),
              "conf": "E", "src": "Satellogic 1 m, median of the paved area where NDVI < 0.15 (no trees or grass)"}

    # tree crowns: vegetated (NDVI > 0.5) and darker than lawn in the visible bands, smoothed; one tree per crown,
    # crowns that touch are split at local maxima of the distance to the crown edge
    lum = lin.mean(0)
    veg = Vm & inside & (ndimage.gaussian_filter(ndvi, 0.8) > 0.33)
    # lawn is brighter than tree crowns in the visible bands (crowns shade themselves): reference = open grass of the
    # stadium pitch
    pitch = st["pitches"][0]
    pr = rasterize([(Point(pitch["x"], pitch["y"]).buffer(20), 1)], out_shape=(ny, nx), transform=T).astype(bool)
    lawn_lum = float(np.median(lum[pr & Vm & (ndvi > 0.25)]))
    crown = veg & (ndimage.gaussian_filter(lum, 1.0) < lawn_lum * 0.88)
    crown = ndimage.binary_opening(crown, iterations=1)
    lab, n = ndimage.label(crown)
    dist = ndimage.distance_transform_edt(crown)
    peaks = (dist == ndimage.maximum_filter(dist, size=7)) & (dist >= 2.0)
    trees = []
    have = np.fromfile(out_dir / "trees.bin", dtype=np.float32).reshape(-1, 4)
    have = have[(np.abs(have[:, 0] + 150) < 400) & (np.abs(have[:, 1]) < 300)]
    for r, c in zip(*np.nonzero(peaks)):
        x, y = x0 + c + 0.5, y1 - r - 0.5
        rad = float(dist[r, c]) + 0.5
        if blocked.contains(Point(x, y)):
            continue
        if any(np.hypot(t[0] - x, t[1] - y) < max(rad, 3.0) for t in trees):
            continue
        if len(have) and np.min(np.hypot(have[:, 0] - x, have[:, 1] - y)) < 4.0:
            continue
        trees.append([round(x, 1), round(y, 1), round(float(np.clip(rad / 2.9, 0.55, 2.4)), 2), 0.0])

    print("crown px", int(crown.sum()), "veg px", int(veg.sum()), "peaks", int(peaks.sum()), "lawn", round(lawn_lum, 4),
          "crown lum p50", round(float(np.median(lum[veg])), 4))
    out = {"meta": {"brief": "Am 2026-11-21: Plato, Caffe TIMM, schools, stadium",
                    "imagery": "Satellogic EarthView 2022-08-31 1 m (CC BY 4.0)",
                    "trees": {"n": len(trees), "rule": "1 m crowns: NDVI > 0.33 and 12 % darker than the stadium lawn; size from crown radius",
                              "conf": {"position": "V", "size": "E", "species": "U"}},
                    "walk": {"length_m": L, "eye_m": 1.65}},
           "landmarks": LANDMARKS, "paved": {"outer": [list(p) for p in PAVED], **paving},
           "walk": {"pts": xy, "stops": stops, "endLook": list(END_LOOK)}, "trees": trees}
    (out_dir / "route.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(out["meta"], indent=1, ensure_ascii=False), paving, len(trees))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
