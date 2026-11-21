"""Photo batch 1: per-building attributes read from Am's reference photographs, matched to map footprints.

Workflow per photograph (docs/PHOTO_RECONSTRUCTION.md):
  1. Solve the camera (position, height, heading, tilt, vertical field of view) by least squares from features with
     known 3D positions: the Sultanija minaret tip (41.5 m, adrialine.me), the Opština and Stara džamija roofs, the
     summit direction, then four nearer roofs. Residuals are ~5 px on a 1000 px photo.
  2. Project every footprint into the photo at roof height and assign buildings only where the projected outline
     lands on one building unambiguously.
  3. Read what the photo shows: storeys (window rows), roof shape and ridge direction, roof and facade colour (median
     of a hand-placed box in the photo, desaturated x0.85 because the photo is HDR-processed), balconies, flat roofs.

Confidence: V = clearly visible in the photo; E = partly hidden or inferred (e.g. a ground floor behind another
building); attributes not listed keep their Phase 5.1 value and confidence.

Photos are not stored in the repository: pass the folder that holds them (default /mnt/project-files/plav-3d/photos).
Output: public/data/<area>/photo.json
Usage:  python pipeline/photo_recon.py plav-town [photo_dir]
"""
from __future__ import annotations

import colorsys
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import LineString, Polygon
from shapely.ops import split

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import FLOOR_H, ROOT, obb  # noqa: E402

PHOTOS = {
    "p01": {
        "file": "p01-main-street-aerial.jpg",
        "title": "Aerial view west along Čaršija / Racina towards the lake (Am, 2026-11-21)",
        # x, y, height above ground (m), heading (deg from north), tilt (deg), vertical field of view (deg)
        "camera": [218.69, -145.37, 35.53, 279.98, -10.42, 65.82],
        "size": [1000, 666],
    },
}

# boxes are in photo pixels (1000 x 666): roof = where the roof colour is sampled, wall = facade colour
P01 = [
    dict(id="93bc9e4b", mat="red sheet metal", matC="V", name="Opština Plav", roof_box=(673, 360, 840, 377), wall_box=(780, 392, 852, 436),
         fl=4, flC="E", flNote="3 window rows above a ground floor hidden by the buildings in front; OSM says 3 levels",
         roof="hip", roofC="V", roofNote="red sheet hip roof with a cross wing towards the street"),
    dict(id="4674a8c3", mat="red sheet metal", matC="V", name="Pošta Plav", roof_box=(420, 392, 498, 412), wall_box=(362, 442, 382, 468),
         fl=2, flC="E", roof="hip", roofC="V", roofNote="red sheet roof, hipped with several facets"),
    dict(id="2923", part="far", mat="dark grey sheet / slate", matC="V", label="grey house on the street (north part of OSM outline 2923)",
         roof_box=(395, 418, 480, 438), wall_box=(400, 462, 478, 515), wallRaw=True, fl=4, flC="E",
         flNote="attic row plus 3 window rows; lowest floor hidden by the house in front",
         roof="gable", roofC="V", roofNote="dark grey roof, gable end with attic windows facing the street"),
    dict(id="2923", part="near", mat="clay tile", matC="V", label="old ochre house with shop awning (south part of OSM outline 2923)",
         roof_box=(372, 520, 478, 610), wall_box=(352, 600, 440, 650), fl=2, flC="E",
         roof="hip", roofC="E", roofNote="clay tile roof, hipped with a gable"),
    dict(id="c8f1", mat="green-grey sheet metal", matC="V", label="long building with green sheet roof (east side of the street)",
         roof_box=(660, 500, 760, 640), roof="gable", roofC="V", pitch=48,
         roofNote="steep green-grey sheet gable roof with roof windows and cut-in balconies along the street"),
    dict(id="bc5f", mat="flat membrane", matC="V", label="white block with flat roof and stacked balconies", roof_box=(840, 432, 900, 446),
         wall_box=(840, 470, 915, 560), fl=4, flC="V", flNote="4 window rows visible on the south-east face",
         roof="flat", roofC="V", roofNote="flat roof with light membrane and roof plant", bal=True, balC="V",
         balNote="three stacked balconies on the south-east face"),
    dict(id="ebd9", label="grey annex between the Opština and the white block", wall_box=(725, 476, 790, 500),
         fl=3, flC="E", roof="flat", roofC="V", roofNote="flat roof terrace"),
    dict(id="67d9", mat="red tile or sheet", matC="E", name="Osnovni sud", roof_box=(570, 340, 648, 356), wall_box=(570, 362, 608, 392),
         fl=2, flC="E", roof="hip", roofC="V"),
    dict(id="d06b", mat="clay tile (orange)", matC="V", label="house with orange tile roof behind the court", roof_box=(650, 338, 698, 352),
         roof="hip", roofC="V"),
    dict(id="37e2", mat="clay tile (orange)", matC="V", label="house with orange tile roof west of Sultanija", roof_box=(695, 325, 738, 345),
         roof="hip", roofC="V"),
    dict(id="628a", mat="clay tile", matC="V", label="pink house (south of the street, near the camera)", roof_box=(40, 560, 230, 640),
         wall_box=(5, 625, 40, 666), fl=2, flC="E", roof="hip", roofC="V"),
    dict(id="cce2", mat="dark brown sheet or tile", matC="E", label="house with dark brown roof west of Stara džamija", roof_box=(90, 368, 155, 398),
         roof="hip", roofC="E"),
    dict(id="2417", mat="red sheet", matC="V", label="small garage with red door", roof_box=(15, 452, 75, 470), wall_box=(16, 478, 28, 494),
         fl=1, flC="V", roof="gable", roofC="V"),
]
MINARETS = [dict(near=(126.2, -64.4), height=41.5, src="adrialine.me (41.5 m) and photo p01 (minaret tip fits the camera within 5 px)")]


def median_rgb(im, box, wall=False, raw=False):
    """Median colour in a box. For walls only the brightest 40 % of pixels count (skips windows and shadow)."""
    x0, y0, x1, y1 = box
    a = (np.asarray(im.crop((x0, y0, x1, y1)), float) / 255).reshape(-1, 3)
    if wall:
        lum = a @ [0.2126, 0.7152, 0.0722]
        a = a[lum >= np.quantile(lum, 0.6)]
    rgb = np.median(a, axis=0)
    h, l, s = colorsys.rgb_to_hls(*rgb)
    s *= 0.85  # the photo is HDR-processed and oversaturated
    if wall and not raw and s < 0.12 and 0.5 < l < 0.82:
        # near-neutral plaster reads grey in this photo's tone curve (the lit court facade reads #d2d1cb, the same
        # white plaster on the Opština #8d8a85): normalise neutral walls to the lit-white level
        l = 0.82
    rgb = colorsys.hls_to_rgb(h, l, s)
    return "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in rgb)


def project_fn(cam, size):
    x, y, h, az, pt, fov = cam
    W, H = size
    a, p = math.radians(az), math.radians(pt)
    f = np.array([math.sin(a) * math.cos(p), math.cos(a) * math.cos(p), math.sin(p)])
    r = np.cross(f, [0, 0, 1]); r /= np.linalg.norm(r); u = np.cross(r, f)
    fy = (H / 2) / math.tan(math.radians(fov) / 2)
    def P(X, C):
        d = np.asarray(X, float) - C; z = d @ f
        return np.column_stack([W / 2 + fy * (d @ r) / z, H / 2 - fy * (d @ u) / z]), z
    return P


def auto_roofs(im, B, cam, size, manual_ids, dmax=260.0):
    """Roof colour for every other building whose roof is visible in the photo: project each roof (outline at eave
    height) with the solved camera, remove the parts hidden behind nearer buildings (their full silhouettes), and
    take the median colour of what is left. Rejected: small visible areas, mixed colours, green (trees)."""
    from shapely.geometry import MultiPoint
    from shapely.ops import unary_union
    import shapely
    P = project_fn(cam, size)
    W, H = size
    # camera ground height: mean of the three nearest buildings' ground levels
    near3 = sorted(B, key=lambda b: (b["obb"][0] - cam[0]) ** 2 + (b["obb"][1] - cam[1]) ** 2)[:3]
    C = np.array([cam[0], cam[1], np.mean([(b["g0"] + b["g1"]) / 2 for b in near3]) + cam[2]])
    frame = shapely.box(0, 0, W, H)
    items = []
    for b in B:
        d = math.hypot(b["obb"][0] - cam[0], b["obb"][1] - cam[1])
        if d > dmax + 60 or d < 8:
            continue
        g = (b["g0"] + b["g1"]) / 2
        fp = np.array(b["fp"], float)
        top = g + b["eave"] + (0 if b["roof"] == "flat" else 0.25 * min(b["obb"][3], b["obb"][4]))
        base = np.column_stack([fp, np.full(len(fp), g)]); eave = np.column_stack([fp, np.full(len(fp), g + b["eave"])])
        ridge = np.array([[b["obb"][0], b["obb"][1], top]])
        q, z = P(np.vstack([base, eave, ridge]), C)
        if (z < 2).any():
            continue
        sil = MultiPoint(q).convex_hull  # silhouette of the whole building
        roof = Polygon(q[len(fp):2 * len(fp)]).union(MultiPoint(q[len(fp):]).convex_hull).buffer(0)
        items.append((float(np.mean(z)), b, sil, roof, d))
    items.sort(key=lambda t: t[0])
    occl = Polygon()
    out = {}
    for z, b, sil, roof, d in items:
        if b["id"] in manual_ids or d > dmax:
            occl = unary_union([occl, sil]); continue
        vis = roof.intersection(frame).difference(occl).buffer(-1.0)
        occl = unary_union([occl, sil])
        if vis.is_empty or vis.area < 80:
            continue
        from rasterio.features import rasterize
        m = rasterize([(vis, 1)], out_shape=(H, W)).astype(bool)
        px = np.asarray(im, float)[m] / 255
        if len(px) < 60:
            continue
        hls = np.array([colorsys.rgb_to_hls(*c) for c in px[:: max(1, len(px) // 400)]])
        med = np.median(px, axis=0); h, l, s = colorsys.rgb_to_hls(*med)
        spread = float(np.std(px @ [0.2126, 0.7152, 0.0722]))
        if 70 / 360 < h < 170 / 360 and s > 0.12:
            continue  # trees or grass in front
        if spread > 0.16:
            continue  # mixed: probably not one roof
        rgb = colorsys.hls_to_rgb(h, l, s * 0.85)
        out[b["id"]] = {"photo": "p01", "rc": "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in rgb),
                        "rcC": "V" if vis.area >= 300 and d < 200 else "E",
                        "rcSrc": f"photo p01, automatic: roof projected with the solved camera, {int(vis.area)} px visible, {int(d)} m away"}
    return out


def split_far_near(fp, obb, cam):
    """Split an outline across its long axis at the middle; 'far' is the half away from the camera."""
    cx, cy, ang, L, _ = obb
    ux, uy = math.cos(ang), math.sin(ang)
    nx, ny = -uy, ux
    cut = LineString([(cx - nx * 100, cy - ny * 100), (cx + nx * 100, cy + ny * 100)])
    parts = sorted(split(Polygon(fp), cut).geoms, key=lambda p: -p.area)[:2]
    d = lambda p: math.hypot(p.centroid.x - cam[0], p.centroid.y - cam[1])
    near, far = sorted(parts, key=d)
    return {"far": far, "near": near}


def main(area_id="plav-town", photo_dir="/mnt/project-files/plav-3d/photos"):
    out_dir = ROOT / "public" / "data" / area_id
    B = json.loads((out_dir / "buildings.json").read_text())["buildings"]
    byid = lambda k: [b for b in B if b["id"].startswith(k)]
    p = PHOTOS["p01"]
    im = Image.open(Path(photo_dir) / p["file"]).convert("RGB")
    rows, splits = {}, {}
    for e in P01:
        m = byid(e["id"])
        assert len(m) == 1 or e.get("name"), (e["id"], len(m))
        m = [b for b in m if not e.get("name") or b.get("name") == e["name"]] or m
        b = m[0]
        r = {"photo": "p01", "label": e.get("name") or e.get("label")}
        if "roof_box" in e:
            r["rc"] = median_rgb(im, e["roof_box"]); r["rcC"] = "V"; r["rcSrc"] = "photo p01"
        if "wall_box" in e:
            r["fc"] = median_rgb(im, e["wall_box"], wall=True, raw=e.get("wallRaw", False)); r["facC"] = "V"; r["facSrc"] = "photo p01"
        for k in ("mat", "matC", "fl", "flC", "flNote", "roof", "roofC", "roofNote", "pitch", "bal", "balC", "balNote"):
            if k in e:
                r[k] = e[k]
        key = b["id"]
        if e.get("part"):
            if b["id"] not in splits:
                parts = split_far_near(b["fp"], b["obb"], p["camera"])
                splits[b["id"]] = {}
                for k, v in parts.items():
                    c, a, L_, W_, _ = obb(v)
                    splits[b["id"]][k] = {"fp": [[round(x, 2), round(y, 2)] for x, y in list(v.exterior.coords)[:-1]],
                                          "obb": [round(float(c[0]), 2), round(float(c[1]), 2), round(a, 4), round(L_, 2), round(W_, 2)]}
            key = f'{b["id"]}#{e["part"]}'
            r["splitNote"] = "OSM outline covers two buildings seen in photo p01; split at the middle of its long axis (split position ESTIMATED)"
        if "fl" in r:
            r["eave"] = round(r["fl"] * FLOOR_H + 0.6, 1)
        rows[key] = r
    auto = auto_roofs(im, B, p["camera"], p["size"], {b["id"] for b in B for e in P01 if b["id"].startswith(e["id"])})
    for k, v in auto.items():
        rows.setdefault(k, v)
    print("automatic roof colours", len(auto), "verified", sum(v["rcC"] == "V" for v in auto.values()))
    out = {"photos": {k: {kk: v[kk] for kk in ("title", "camera", "size")} for k, v in PHOTOS.items()},
           "b": rows, "splits": splits, "minarets": MINARETS}
    (out_dir / "photo.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for k, r in rows.items():
        print(k[:14], r.get("label"), r.get("rc"), r.get("fc"), r.get("fl"), r.get("roof"))


if __name__ == "__main__":
    main(*(sys.argv[1:] or ["plav-town"]))
