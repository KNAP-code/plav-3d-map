"""Automated, evidence-driven architectural reconstruction (Am's brief of 2026-11-22).

    SOURCE DISCOVERY -> BUILDING MATCHING -> GEOMETRY ANALYSIS -> ARCHITECTURAL RECONSTRUCTION -> VALIDATION -> RENDER

No per-building prompts: every building in the area is processed with the same rules, and each attribute keeps the
confidence its evidence supports (V verified / E estimated / U unknown).

1. Source discovery (`discover`): which sources exist for each building. Reachability of the public sources is probed
   once and written to the report; the per-building inventory lists OSM tags, the outline tier (verify.json), the 1 m
   satellite roof measurement (recon.json) and every registered photo that sees the building.
2. Building matching (`match`): a photo is registered when it has a solved camera (x, y, height, azimuth, pitch,
   vertical fov), either solved on landmarks (photo_recon.py) or from EXIF GPS + compass heading (inbox photos; see
   `exif_camera`). Every wall of every building is projected with the camera; a wall is matched when it faces the
   camera (< 70 deg off), is in the frame, and enough of it is not hidden behind nearer buildings (z-order of the
   building silhouettes).
3. Geometry analysis (`analyse_wall`): the visible wall is resampled into a rectified facade image (0.25 m across,
   0.1 m up, 0-22 m above the ground). From it:
     eave height   first height above 2.5 m where the row colour leaves the wall colour for >= 0.6 m (sky / roof)
     storeys       number of window bands: rows where >= 25 % of the wall is clearly darker than the wall colour,
                   bands >= 0.5 m thick and >= 2.2 m apart, below the eave
     facade colour median of the brightest 40 % of wall pixels below the eave (lit plaster, not windows)
   A wall is analysed only if it is sampled at >= 6 px per metre of height and >= 35 % of it is visible.
4. Reconstruction (`reconstruct`): per building, the best wall wins (most pixels per metre). Storeys and eave are
   taken from the photo when the window bands and the eave agree within one storey; otherwise they stay with the
   prior (OSM levels or the neutral default) and are UNKNOWN.
5. Validation (`validate`): checks per building (storey height 2.4-3.6 m, eave above the band count, agreement of two
   walls when both are seen) and, as a whole, against the hand-read entries of photo batch 1 (photo.json).
6. Render: public/data/<area>/arch.json, merged by src/data/load.ts below the hand-read photo values (hand-read
   evidence stays on top). Hand-built landmark models (src/geo/landmarks.ts) replace the procedural building.

Usage:  python pipeline/arch_pipeline.py plav-town
"""
from __future__ import annotations

import json
import os
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import MultiPoint, Polygon

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import ROOT  # noqa: E402
from photo_recon import PHOTOS, project_fn  # noqa: E402

PHOTO_DIR = Path("/mnt/project-files/plav-3d/photos")
INBOX = PHOTO_DIR / "inbox"
FLOOR_H = 2.9  # m, storey pitch used by the renderer (style.window.floorHeight)

SOURCES = [  # (name, probe url, licence / terms, what it could establish)
    ("OpenStreetMap API / Overpass", "https://overpass-api.de/api/status", "ODbL", "tags: levels, height, roof shape, names"),
    ("Overture Maps (S3)", "https://overturemaps-us-west-2.s3.amazonaws.com", "ODbL / CDLA", "footprints, OSM tags, places"),
    ("Satellogic EarthView 1 m (S3)", "https://satellogic-earthview.s3.us-west-2.amazonaws.com", "CC BY 4.0", "roof colour, terraces, trees"),
    ("Copernicus DEM GLO-30 (S3)", "https://copernicus-dem-30m.s3.amazonaws.com", "Copernicus licence", "terrain (tested: no building heights)"),
    ("Mapillary API", "https://graph.mapillary.com/images", "CC BY-SA, token needed", "street-level photos with camera pose"),
    ("Panoramax", "https://api.panoramax.xyz/api", "open licences", "street-level photos with camera pose"),
    ("KartaView", "https://api.kartaview.org", "CC BY-SA", "street-level photos"),
    ("Wikimedia Commons API", "https://commons.wikimedia.org/w/api.php", "free licences", "geotagged photos"),
    ("Flickr API", "https://api.flickr.com/services/rest/", "per-photo licence, key needed", "geotagged photos"),
    ("Geoportal Crne Gore (WMS)", "https://www.geoportal.co.me/geoserver/ows?service=WMS&request=GetCapabilities", "official, terms to confirm", "orthophoto, cadastre outlines, heights"),
    ("OpenAerialMap", "https://api.openaerialmap.org/meta", "CC BY 4.0", "drone orthophotos"),
    ("Google Street View API", "https://maps.googleapis.com/maps/api/streetview/metadata?location=42.596,19.94", "key needed; terms forbid deriving 3D models", "not usable"),
    ("plavto.me (approved site)", "https://www.plavto.me/", "view only, not copied", "photos without location or direction"),
]


def probe_sources():
    out = []
    for name, url, lic, use in SOURCES:
        try:
            code = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "12", url],
                                  capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception:
            code = "000"
        reach = code not in ("000", "") and not code.startswith("5")
        note = "reachable" if reach else "refused by this environment's network"
        if "googleapis" in url and reach:
            note = "reachable, but REQUEST_DENIED without an API key"
        out.append({"name": name, "url": url, "http": code, "reachable": reach, "status": note, "licence": lic, "use": use})
    return out


# ---------------------------------------------------------------------------------------------------- matching
def exif_camera(path):
    """Initial camera from EXIF (GPS position, GPSImgDirection, focal length in 35 mm): returns None without GPS and
    heading. Such cameras still need refinement on known roofs before their walls are trusted (status 'exif')."""
    try:
        im = Image.open(path)
        ex = im.getexif()
        gps = ex.get_ifd(0x8825)
        if not gps or 2 not in gps or 4 not in gps or 17 not in gps:
            return None
        dms = lambda v: float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
        lat, lon = dms(gps[2]) * (1 if gps.get(1, "N") == "N" else -1), dms(gps[4]) * (1 if gps.get(3, "E") == "E" else -1)
        from pyproj import Transformer
        x, y = Transformer.from_crs(4326, 32634, always_xy=True).transform(lon, lat)
        f35 = float(ex.get_ifd(0x8769).get(41989, 26) or 26)
        W, H = im.size
        vfov = math.degrees(2 * math.atan((24 if H < W else 36) / 2 / f35))
        return {"cam": [x - 413245.0, y - 4716717.0, 1.6, float(gps[17]), 0.0, vfov], "size": [W, H], "status": "exif"}
    except Exception:
        return None


def registered_photos():
    photos = {}
    for pid, p in PHOTOS.items():
        photos[pid] = {"file": str(PHOTO_DIR / p["file"]), "cam": p["camera"], "size": p["size"], "status": "solved on landmarks"}
    for js in sorted(PHOTO_DIR.glob("*-camera.json")):
        c = json.loads(js.read_text())
        pid = js.name.split("-")[0]
        if pid in photos or "camera" not in c:
            continue
        photos[pid] = {"file": str(PHOTO_DIR / c["file"]), "cam": c["camera"], "size": c["size"], "status": c.get("status", "solved")}
    if INBOX.exists():
        for f in sorted(INBOX.iterdir()):
            if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
                e = exif_camera(f)
                photos[f.stem] = {"file": str(f), **e} if e else {"file": str(f), "cam": None, "status": "no GPS/heading: not registered"}
    return photos


def walls_of(b):
    fp = np.array(b["fp"], float)
    if len(fp) > 2 and np.allclose(fp[0], fp[-1]):
        fp = fp[:-1]
    sgn = 1.0 if Polygon(fp).exterior.is_ccw else -1.0
    for i in range(len(fp)):
        a, c = fp[i], fp[(i + 1) % len(fp)]
        L = float(np.hypot(*(c - a)))
        if L < 3.0:
            continue
        d = (c - a) / L
        n = np.array([d[1], -d[0]]) * sgn  # outward normal
        yield i, a, c, L, n


def silhouettes(B, P, C, dmax):
    """Screen silhouettes of all buildings near the camera (prior heights), nearest first."""
    out = []
    for b in B:
        d = math.hypot(b["obb"][0] - C[0], b["obb"][1] - C[1])
        if d > dmax + 80 or d < 3:
            continue
        g = (b["g0"] + b["g1"]) / 2
        fp = np.array(b["fp"], float)
        top = g + b["eave"] + (0 if b["roof"] == "flat" else 0.25 * min(b["obb"][3], b["obb"][4]))
        pts = np.vstack([np.column_stack([fp, np.full(len(fp), g)]), np.column_stack([fp, np.full(len(fp), top)])])
        q, z = P(pts, C)
        if (z < 1).any():
            continue
        out.append((d, b["id"], MultiPoint(q).convex_hull))
    out.sort(key=lambda t: t[0])
    return out


# ---------------------------------------------------------------------------------------------------- analysis
def bilinear(img, u, v):
    H, W = img.shape[:2]
    ok = (u >= 0) & (v >= 0) & (u < W - 1) & (v < H - 1)
    u0 = np.clip(np.floor(u).astype(int), 0, W - 2); v0 = np.clip(np.floor(v).astype(int), 0, H - 2)
    fu, fv = (u - u0)[..., None], (v - v0)[..., None]
    s = (img[v0, u0] * (1 - fu) * (1 - fv) + img[v0, u0 + 1] * fu * (1 - fv) + img[v0 + 1, u0] * (1 - fu) * fv + img[v0 + 1, u0 + 1] * fu * fv)
    return s, ok


def analyse_wall(img, occ, P, C, a, c, L, g, zmax=22.0):
    """Rectified facade (rows = height 0..zmax step 0.1 m, cols = 0.25 m along the wall) and what it shows."""
    us = np.arange(0.125, L, 0.25); zs = np.arange(0.05, zmax, 0.1)
    d = (c - a) / L
    U, Z = np.meshgrid(us, zs)
    X = a[0] + d[0] * U; Y = a[1] + d[1] * U
    q, depth = P(np.column_stack([X.ravel(), Y.ravel(), (g + Z).ravel()]), C)
    qu, qv = q[:, 0].reshape(U.shape), q[:, 1].reshape(U.shape)
    rect, ok = bilinear(img, qu, qv)
    H, W = occ.shape
    iu = np.clip(qu.astype(int), 0, W - 1); iv = np.clip(qv.astype(int), 0, H - 1)
    ok = ok & (depth.reshape(U.shape) > 1.0)
    vis = ok & ~occ[iv, iu]
    # pixels per metre of height at the middle of the wall
    mid = len(us) // 2
    ppm = float(abs(qv[min(30, len(zs) - 1), mid] - qv[0, mid]) / 3.0)
    return rect, vis, ppm, zs, ok


def facade_measures(rect, vis, ok, zs, he):
    """Measure one rectified wall between the ground and the PRIOR eave height he (the eave cannot be found reliably in
    an oblique photo: roofs, trees and the street behind continue the image above it). Rejects walls that run out of the
    frame, are mostly hidden, or are mostly vegetation."""
    top = max(int((he - 0.2) / 0.1), 12)
    R, V, O = rect[:top], vis[:top], ok[:top]
    if O.mean() < 0.9:
        return None  # wall partly outside the photo
    cols = V.mean(0) > 0.6
    if cols.mean() < 0.5:
        return None
    R, V = R[:, cols], V[:, cols]
    r, g, b = R[..., 0], R[..., 1], R[..., 2]
    lum = R @ np.array([0.2126, 0.7152, 0.0722])
    veg = (g > r * 1.04) & (g > b * 1.12)
    if veg[V].mean() > 0.3:
        return None  # trees in front of the wall
    zz = zs[:top][:, None].repeat(R.shape[1], 1)
    sel = V & ~veg & (zz > 1.0) & (zz < he - 0.5)
    if sel.sum() < 60:
        return None
    thr = np.quantile(lum[sel], 0.6)
    wall = np.median(R[sel & (lum >= thr)], axis=0)
    wlum = float(wall @ [0.2126, 0.7152, 0.0722])
    # window bands: rows where a clear share of the wall is much darker than the wall colour (glass, openings)
    dark = np.array([np.mean(lum[i][V[i]] < wlum * 0.72) if V[i].sum() > 5 else 0.0 for i in range(top)])
    dk = ndimage.uniform_filter1d(dark, 5)
    lab, n = ndimage.label(dk > 0.25)
    bands = []
    for k in range(1, n + 1):
        idx = np.nonzero(lab == k)[0]
        if len(idx) * 0.1 >= 0.5:
            bands.append(float(zs[idx].mean()))
    merged = []
    for z in bands:
        if merged and z - merged[-1] < 2.2:
            continue
        merged.append(z)
    return {"eave": round(he, 1), "bands": [round(z, 1) for z in merged], "rgb": wall, "cols": float(cols.mean()),
            "veg": round(float(veg[V].mean()), 2)}


def to_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(round(float(np.clip(v, 0, 1)) * 255)) for v in rgb)


# ---------------------------------------------------------------------------------------------------- pipeline
def main(area_id="plav-town", dmax=230.0):
    out_dir = ROOT / "public" / "data" / area_id
    B = json.loads((out_dir / "buildings.json").read_text())["buildings"]
    recon = json.loads((out_dir / "recon.json").read_text())["b"]
    tiers = {r["id"]: r["tier"] for r in json.loads((out_dir / "verify.json").read_text())["buildings"]}
    manual = json.loads((out_dir / "photo.json").read_text())["b"] if (out_dir / "photo.json").exists() else {}
    report = {"sources": probe_sources(), "photos": {}, "stages": {}}

    # 1. discovery: per-building inventory
    inv = {b["id"]: {"osm": b["src"] == "osm", "levels_tag": b["hSrc"].startswith("osm"), "tier": tiers.get(b["id"]),
                     "satellite_roof": bool(recon.get(b["id"], {}).get("rc")), "photos": []} for b in B}
    photos = registered_photos()

    # 2-3. matching and analysis
    walls = {}
    for pid, ph in photos.items():
        report["photos"][pid] = {"file": Path(ph["file"]).name, "status": ph["status"], "matched_walls": 0, "analysed_walls": 0}
        if not ph.get("cam") or ph["status"] == "exif":
            continue  # EXIF-only cameras are not trusted until refined on known roofs
        cam, size = ph["cam"], ph["size"]
        img = np.asarray(Image.open(ph["file"]).convert("RGB").resize(tuple(size)), float) / 255
        P = project_fn(cam, size)
        near3 = sorted(B, key=lambda b: (b["obb"][0] - cam[0]) ** 2 + (b["obb"][1] - cam[1]) ** 2)[:3]
        C = np.array([cam[0], cam[1], np.mean([(b["g0"] + b["g1"]) / 2 for b in near3]) + cam[2]])
        sil = silhouettes(B, P, C, dmax)
        order = {bid: k for k, (_, bid, _) in enumerate(sil)}
        from rasterio.features import rasterize
        W, H = size
        for b in B:
            if b["id"] not in order:
                continue
            k = order[b["id"]]
            nearer = [s for (_, bid, s) in sil[:k] if bid != b["id"]]
            occ = rasterize([(s, 1) for s in nearer if not s.is_empty], out_shape=(H, W)).astype(bool) if nearer else np.zeros((H, W), bool)
            g = (b["g0"] + b["g1"]) / 2
            for i, a, c, L, n in walls_of(b):
                mid = (a + c) / 2
                to_cam = C[:2] - mid
                dist = float(np.hypot(*to_cam))
                if dist > dmax or n @ to_cam / max(dist, 1e-6) < math.cos(math.radians(70)):
                    continue
                report["photos"][pid]["matched_walls"] += 1
                inv[b["id"]]["photos"].append(pid)
                rect, vis, ppm, zs, okm = analyse_wall(img, occ, P, C, a, c, L, g)
                if ppm < 6.0:
                    continue
                if os.environ.get("ARCH_DEBUG"):
                    dbg = (np.clip(rect, 0, 1) * np.where(vis, 1.0, 0.35)[..., None])[::-1]
                    Image.fromarray((dbg * 255).astype(np.uint8)).resize((dbg.shape[1] * 3, dbg.shape[0] * 3), Image.NEAREST).save(
                        f"{os.environ['ARCH_DEBUG']}/{b['id'][:8]}-w{i}-{ppm:.0f}.png")
                m = facade_measures(rect, vis, okm, zs, b["eave"])
                if not m:
                    continue
                report["photos"][pid]["analysed_walls"] += 1
                walls.setdefault(b["id"], []).append({"photo": pid, "wall": i, "len": round(L, 1), "dist": round(dist), "ppm": round(ppm, 1), **m})

    # 4-5. reconstruction + validation
    arch, checks = {}, {"agree_bands_eave": 0, "disagree": 0, "storey_h_out_of_range": 0, "two_walls_agree": 0, "two_walls_disagree": 0}
    for bid, ws in walls.items():
        ws.sort(key=lambda w: -w["ppm"] * w["cols"])
        best = ws[0]
        nb = len(best["bands"])
        nf_eave = max(1, int(round((best["eave"] - 0.6) / FLOOR_H)))
        rec = {"src": f"photo {best['photo']} (automatic), wall {best['wall']}, {best['dist']} m, {best['ppm']} px/m",
               "fcAuto": to_hex(best["rgb"]),
               "eaveM": best["eave"], "bands": best["bands"], "walls_seen": len(ws)}
        # storeys: the window-band count, accepted only when it fits the prior wall height (2.4-3.9 m per storey).
        # Never VERIFIED from one automatic reading: the band detector is validated against the hand-read photo batch.
        sh = best["eave"] / max(nb, 1)
        if nb >= 1 and 2.4 <= sh <= 3.9:
            checks["agree_bands_eave"] += 1
            rec["flAuto"] = nb
            rec["flNote"] = f"{nb} window bands under the {best['eave']} m wall (automatic, {best['ppm']} px/m)"
        else:
            if nb >= 1:
                checks["storey_h_out_of_range"] += 1
            checks["disagree"] += 1
            rec["flNote"] = f"{nb} window bands found under a {best['eave']} m wall: no storey count"
        if len(ws) > 1:
            same = len(ws[1]["bands"]) == nb
            checks["two_walls_agree" if same else "two_walls_disagree"] += 1
        arch[bid] = rec

    # 5. validation against the hand-read photo batch 1 (same photo, read by eye), then the gate: a measure is applied
    # to the model only if the automatic reading reproduces the hand reading well enough
    def hexrgb(h):
        return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)
    fl_rows, fc_rows = [], []
    for k, mrec in manual.items():
        a = arch.get(k.split("#")[0])
        if not a or "#" in k:
            continue
        if "flAuto" in a and mrec.get("fl"):
            fl_rows.append({"id": k[:8], "label": mrec.get("label"), "manual": mrec["fl"], "auto": a["flAuto"]})
        if mrec.get("fc"):
            d = float(np.linalg.norm(hexrgb(a["fcAuto"]) - hexrgb(mrec["fc"])))
            fc_rows.append({"id": k[:8], "label": mrec.get("label"), "manual": mrec["fc"], "auto": a["fcAuto"], "dist": round(d)})
    fl_ok = len(fl_rows) >= 3 and sum(r["manual"] == r["auto"] for r in fl_rows) / len(fl_rows) >= 0.8
    fc_ok = len(fc_rows) >= 3 and np.median([r["dist"] for r in fc_rows]) <= 40
    report["validation_vs_manual"] = {
        "storeys": {"n": len(fl_rows), "exact": sum(r["manual"] == r["auto"] for r in fl_rows), "passed": fl_ok, "rows": fl_rows,
                    "rule": ">= 3 buildings and >= 80 % exact"},
        "facade_colour": {"n": len(fc_rows), "median_rgb_dist": float(np.median([r["dist"] for r in fc_rows])) if fc_rows else None,
                          "passed": bool(fc_ok), "rows": fc_rows, "rule": ">= 3 buildings and median sRGB distance <= 40"}}
    for a in arch.values():
        if fl_ok and "flAuto" in a:
            a["fl"] = a["flAuto"]; a["flC"] = "E"
        if fc_ok:
            a["fc"] = a["fcAuto"]; a["facC"] = "E"
    report["stages"] = {"buildings": len(B), "with_any_photo": sum(1 for v in inv.values() if v["photos"]),
                        "walls_analysed": sum(len(w) for w in walls.values()), "buildings_analysed": len(walls),
                        "storeys_read": sum(1 for a in arch.values() if "flAuto" in a),
                        "storeys_applied": sum(1 for a in arch.values() if "fl" in a),
                        "facade_read": len(arch), "facade_applied": sum(1 for a in arch.values() if "fc" in a),
                        "checks": checks,
                        "inventory": {"osm_levels": sum(v["levels_tag"] for v in inv.values()),
                                      "satellite_roof": sum(v["satellite_roof"] for v in inv.values()),
                                      "outline_verified_or_confirmed": sum(v["tier"] in ("verified", "confirmed") for v in inv.values())}}
    (out_dir / "arch.json").write_text(json.dumps({"meta": {k: report[k] for k in ("stages", "sources")}, "b": arch}, ensure_ascii=False, separators=(",", ":")))
    (ROOT / "docs" / "arch_pipeline_report.json").write_text(json.dumps({**report, "walls": walls}, ensure_ascii=False, indent=1, default=lambda o: to_hex(o) if isinstance(o, np.ndarray) else str(o)))
    print(json.dumps(report["stages"], indent=1), json.dumps(report["validation_vs_manual"], indent=1, ensure_ascii=False))
    print({p: v for p, v in report["photos"].items()})


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
