"""Phase 5.1: per-building evidence for the central Plav pilot (what each building really looks like, and how sure we are).

Every attribute gets one of three confidence classes:
  V  VERIFIED   read directly from a source (an OSM tag, a measurement in the 1 m image, a confirmed outline)
  E  ESTIMATED  derived with a stated rule from indirect evidence (e.g. roof material from roof colour)
  U  UNKNOWN    no usable evidence; the model shows a neutral, marked placeholder

Sources and what they can establish (tests in docs/RECONSTRUCTION.md):
  footprint, width, length, orientation  OSM / Microsoft outline; confidence from the Phase 3 tier (verify.json)
  roof colour                            Satellogic EarthView 1 m, 2022-08-31 (CC BY 4.0), median of the footprint
                                         interior (1 m inset, tree pixels removed), dehazed and white-balanced on asphalt
  roof material                          ESTIMATED from that colour (terracotta -> clay tile; grey/white/blue -> sheet)
  storeys and height                     OSM building:levels / height only. Tested and rejected: GBA LoD1 heights
                                         (an OSM 4-storey house reads 2.0 m; median of all houses 2.8 m), shadows in
                                         the 1 m image (diffuse light: shadow side only 1 % darker), Meta canopy height
                                         (buildings masked to 0)
  roof shape / pitch / ridge             OSM roof tags (none here) or a flat-roof building class; otherwise UNKNOWN
  facade colour, balconies, extensions   UNKNOWN: overhead imagery cannot show facades and no openly licensed
                                         street-level imagery of Plav is reachable from this environment
  use                                    OSM building class where tagged, otherwise UNKNOWN

Output: public/data/<area>/recon.json  {meta, b: {id: {...}}} for buildings inside the pilot circle.
Usage:  python pipeline/reconstruct.py plav-town
"""
from __future__ import annotations

import colorsys
import json
import math
import sys

import numpy as np
import rasterio
import shapely
from affine import Affine
from scipy import ndimage
from rasterio.features import rasterize
from shapely.geometry import Polygon

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import FLAT_CLASSES, HERE, ROOT  # noqa: E402
from roof_detector import resample  # noqa: E402
from verify_city import Sat  # noqa: E402

RNG = np.random.default_rng(0)
# Satellite -> ground-photo white balance (linear R, G, B gains). Fitted on the 43 roofs measured both in the 1 m image
# and in Am's photo p01 (median log ratio, G fixed). Leave-one-out: colour family agrees for 29 / 43 roofs instead of
# 22 / 43, hue error on clearly coloured roofs 7 deg instead of 18 deg. Without it clay roofs read mauve / purple.
PHOTO_GAIN = np.array([1.485, 1.0, 0.733])
LOCAL_WB_SIGMA = 80.0  # m, local asphalt white balance window
ROOF_NDVI = 0.0  # haze-corrected NDVI of bare roofs (confirmed roofs >120 m² in the pilot: p25 0.01, median 0.07)
PILOT = (170.0, -230.0, 520.0)  # same circle as DETAIL_AREAS in src/geo/buildings.ts
TIER_CONF = {"verified": "V", "confirmed": "V", "present": "E", "unconfirmed": "U", "disputed": "U"}
USE = {
    "house": "residential", "detached": "residential", "apartments": "residential", "residential": "residential",
    "semidetached_house": "residential", "terrace": "residential", "farm": "residential",
    "commercial": "commercial", "retail": "commercial", "shop": "commercial", "kiosk": "commercial", "hotel": "commercial",
    "office": "commercial", "supermarket": "commercial", "industrial": "industrial", "warehouse": "industrial",
    "public": "public", "civic": "public", "government": "public", "school": "public", "kindergarten": "public",
    "hospital": "public", "university": "public", "college": "public", "sports_hall": "public", "fire_station": "public",
    "mosque": "religious", "church": "religious", "religious": "religious",
    "garage": "outbuilding", "garages": "outbuilding", "shed": "outbuilding", "hut": "outbuilding", "barn": "outbuilding",
    "carport": "outbuilding", "roof": "outbuilding", "service": "outbuilding", "farm_auxiliary": "outbuilding",
}


def _shift(a, b):
    """Sub-pixel (dy, dx) that moves band b onto band a, and the phase-correlation peak height."""
    F = np.fft.fft2(a) * np.conj(np.fft.fft2(b)); cc = np.real(np.fft.ifft2(F / (np.abs(F) + 1e-6)))
    i = np.unravel_index(np.argmax(cc), cc.shape); out = []
    for ax in (0, 1):
        pm, pp = list(i), list(i); n = cc.shape[ax]; pm[ax] = (i[ax] - 1) % n; pp[ax] = (i[ax] + 1) % n
        y0, ym, yp = cc[i], cc[tuple(pm)], cc[tuple(pp)]
        v = i[ax] + 0.5 * (ym - yp) / (ym - 2 * y0 + yp + 1e-12)
        out.append(float(v - n if v > n / 2 else v))
    return out, float(cc[i])


def coregister_bands(A, tile=384):
    """The L1 mosaic is stitched from 384 m scenes whose red, blue and NIR bands are offset from green by up to
    ~10 px (about 4-6 px over the pilot), differently in each scene (colour fringes on every roof). Measure the offset per scene by phase
    correlation of high-passed bands and shift each band onto green. Weak or implausible peaks fall back to the
    median offset of all scenes."""
    from scipy import ndimage
    _, H, W = A.shape
    est = {}
    for r0 in range(0, H, tile):
        for c0 in range(0, W, tile):
            blk = A[:, r0:r0 + tile, c0:c0 + tile]
            if blk.shape[1] < 64 or blk.shape[2] < 64 or (blk[1] > 0).mean() < 0.8:
                continue
            hp = [b - ndimage.gaussian_filter(b, 6) for b in blk]
            est[(r0, c0)] = {k: _shift(hp[1], hp[k]) for k in (0, 2, 3)}
    ok = lambda v: v[1] > 0.015 and max(abs(np.array(v[0]))) < 15
    med = {k: np.median([e[k][0] for e in est.values() if ok(e[k])], axis=0) for k in (0, 2, 3)}
    out = A.copy(); used = fb = 0
    for r0 in range(0, H, tile):
        for c0 in range(0, W, tile):
            e = est.get((r0, c0))
            for k in (0, 2, 3):
                if e and ok(e[k]):
                    sh = e[k][0]; used += 1
                else:
                    sh = med[k]; fb += 1
                # shift with a margin so edges of the scene are not wrapped
                r_, c_ = slice(max(r0 - 8, 0), min(r0 + tile + 8, H)), slice(max(c0 - 8, 0), min(c0 + tile + 8, W))
                sb = ndimage.shift(A[k, r_, c_], sh, order=1, mode="nearest")
                out[k, r0:r0 + tile, c0:c0 + tile] = sb[r0 - r_.start:r0 - r_.start + tile, c0 - c_.start:c0 - c_.start + tile]
    return out, {"scenes": len(est), "band_shifts_used": used, "fallback": fb,
                 "median_px": {("R", "G", "B", "NIR")[k]: np.round(med[k], 2).tolist() for k in (0, 2, 3)}}


def display_colour(L, V, T, streets):
    """TOA reflectance -> display sRGB: haze offset from the darkest pixels, white balance on asphalt."""
    R = L / 10000.0
    ny, nx = V.shape
    road = rasterize([(g, 1) for g in streets if not g.is_empty], out_shape=(ny, nx), transform=T).astype(bool)
    dark = np.array([np.percentile(R[k][V], 0.3) for k in range(4)]) * 0.9
    # NDVI after removing the haze offset (raw TOA NDVI of grass is only ~0.15 here)
    ndvi = ((R[3] - dark[3]) - (R[0] - dark[0])) / ((R[3] - dark[3]) + (R[0] - dark[0]) + 1e-4)
    rm = road & V & (ndvi < 0.3)
    Rc = np.stack([R[k] - dark[k] for k in range(3)])
    med = np.array([np.median(Rc[k][rm]) for k in range(3)]); dark = dark[:3]
    gain = 0.14 / med  # asphalt -> neutral grey, 14 % linear
    # Local white balance. Haze and thin cumulus vary across the scene: in the west of the centre (schools, stadium)
    # one global balance left a magenta-blue cast (clay roofs read hue 280-340). The asphalt colour is therefore
    # measured locally (Gaussian window, sigma 80 m, roads only) and each pixel is balanced on its own neighbourhood;
    # where fewer than ~150 road pixels fall in the window the global balance is used.
    w = rm.astype(np.float32)
    den = ndimage.gaussian_filter(w, LOCAL_WB_SIGMA)
    loc = np.stack([ndimage.gaussian_filter(np.where(rm, Rc[k], 0).astype(np.float32), LOCAL_WB_SIGMA) / np.maximum(den, 1e-6)
                    for k in range(3)])
    trust = np.clip(den * (2 * np.pi * LOCAL_WB_SIGMA ** 2) / 150.0, 0, 1)
    lg = 0.14 / np.maximum(loc, 1e-4)
    g = trust * lg + (1 - trust) * gain[:, None, None]
    lin = np.clip(Rc * g, 0, 1)
    dev = np.abs(np.log(lg / gain[:, None, None]))[:, trust > 0.5]
    return lin, ndvi, {"haze": dark.round(4).tolist(), "gain": gain.round(3).tolist(), "road_px": int(rm.sum()),
                       "local_wb_sigma_m": LOCAL_WB_SIGMA, "local_gain_dev_p90": np.percentile(dev, 90, axis=1).round(3).tolist()}


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def material(rgb):
    """ESTIMATED roof covering from its overhead colour (sRGB 0..1)."""
    h, l, s = colorsys.rgb_to_hls(*rgb)
    hd = h * 360
    if s > 0.12 and (hd < 35 or hd > 330) and rgb[0] > rgb[2] * 1.12:
        return "clay tile (terracotta)"
    if s > 0.12 and 180 < hd < 260:
        return "painted sheet (blue)"
    if s > 0.12 and 70 < hd < 170:
        return "painted sheet (green)"
    if l > 0.62:
        return "light sheet / membrane"
    if l < 0.30:
        return "dark sheet / slate"
    return "grey sheet / concrete"


def main(area_id="plav-town"):
    out_dir = ROOT / "public" / "data" / area_id
    cache = HERE / "cache" / area_id
    meta = json.loads((out_dir / "meta.json").read_text()); O = np.array(meta["origin"], float); E = meta["extent"]
    B = json.loads((out_dir / "buildings.json").read_text())["buildings"]
    tiers = {r["id"]: r["tier"] for r in json.loads((out_dir / "verify.json").read_text())["buildings"]}
    det = json.loads((cache / "roof-detector.json").read_text())["buildings"]
    P = [shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in B]

    # co-register the bands first, then register the corrected image to the footprints (verify_city.Sat)
    src = cache / "evidence" / "satellogic_toa.tif"; fixed = cache / "evidence" / "satellogic_toa_coreg.tif"
    with rasterio.open(src) as f:
        A = f.read().astype(np.float32); prof = f.profile
    A, coreg = coregister_bands(A)
    with rasterio.open(fixed, "w", **{**prof, "dtype": "uint16", "compress": "deflate"}) as f:
        f.write(np.clip(A, 0, 65535).astype(np.uint16))
    sat = Sat(fixed, O)
    pre = json.loads((cache / "buildings.pre-corrections.json").read_text())["buildings"]
    sat.register([shapely.make_valid(Polygon(b["fp"])).buffer(0) for b in pre if not b.get("corr")])
    Lr, Vm, (x0, y1, nx, ny) = resample(sat, A, E)
    T = Affine(1, 0, x0, 0, -1, y1)
    st = json.loads((out_dir / "streets.json").read_text())
    lin, ndvi, cal = display_colour(Lr, Vm, T, [Polygon(c["outer"]).buffer(-1.5) for c in st["carriage"]])

    cx, cy, cr = PILOT
    vm = Vm & (ndvi > 0.55)  # town-wide vegetation endmember, used where a building's ring has too little vegetation
    veg_g, vveg_g = np.median(lin[:, vm], axis=1), float(np.median(ndvi[vm]))
    rec = {}
    for i, b in enumerate(B):
        if (b["obb"][0] - cx) ** 2 + (b["obb"][1] - cy) ** 2 > cr * cr:
            continue
        g = P[i]
        r = {}
        # footprint
        L_, W_ = b["obb"][3], b["obb"][4]
        r["L"], r["W"], r["az"] = round(L_, 1), round(W_, 1), round(math.degrees(b["obb"][2]) % 180, 0)
        r["area"] = round(g.area, 0)
        r["fpSrc"] = "OSM" if b["src"] == "osm" else "Microsoft ML"
        r["fpC"] = TIER_CONF.get(tiers.get(b["id"], ""), "U")
        # roof colour
        # Linear unmixing against vegetation: at ~2-3 m effective resolution and +-1 m registration, roof pixels
        # contain garden and tree light. Each pixel's vegetation share comes from its NDVI (roof ROOF_NDVI, local
        # vegetation = ring pixels with NDVI > 0.5), and that share of the local vegetation colour is removed.
        inner = g.buffer(-1.0)
        n = 0; rgb = None
        if not inner.is_empty:
            ring = g.buffer(12).difference(g.buffer(2))
            minx, miny, maxx, maxy = ring.bounds
            c0, c1, r0, r1 = int(minx - x0), int(maxx - x0) + 1, int(y1 - maxy), int(y1 - miny) + 1
            if c0 >= 0 and r0 >= 0 and c1 <= nx and r1 <= ny:
                Tl = Affine(1, 0, x0 + c0, 0, -1, y1 - r0); sh = (r1 - r0, c1 - c0)
                m = rasterize([(inner, 1)], out_shape=sh, transform=Tl).astype(bool)
                nd = ndvi[r0:r1, c0:c1]; vv = Vm[r0:r1, c0:c1]; li = lin[:, r0:r1, c0:c1]
                mr = rasterize([(ring, 1)], out_shape=sh, transform=Tl).astype(bool) & vv & (nd > 0.5)
                m &= vv & (nd < 0.45)
                n = int(m.sum())
                if n >= 4:
                    veg, vveg = (np.median(li[:, mr], axis=1), float(np.median(nd[mr]))) if mr.sum() >= 10 else (veg_g, vveg_g)
                    f = np.clip((nd[m] - ROOF_NDVI) / max(vveg - ROOF_NDVI, 0.1), 0, 0.7)
                    px = (li[:, m] - f * veg[:, None]) / (1 - f)
                    rgb = np.clip(np.median(px, axis=1), 0, 1)
                    sel = RNG.permutation(n)  # split-half reliability: two disjoint halves of the roof pixels
                    halves = (np.median(px[:, sel[: n // 2]], axis=1), np.median(px[:, sel[n // 2:]], axis=1))
                    r["veg"] = round(float(np.median(f)), 2)
        d = det.get(b["id"])
        r["_lin"], r["rcN"], r["_det"] = (None if rgb is None else rgb), n, (d[2] if d else 0)
        r["_halves"] = halves if rgb is not None else None
        # storeys / height
        r["fl"] = b["floors"]; r["eave"] = b["eave"]
        r["flC"] = "V" if b["hSrc"].startswith("osm") else "U"
        r["flSrc"] = b["hSrc"] if b["hSrc"].startswith("osm") else "default (2, or 1 under 35 m²)"
        # roof shape
        cls = b.get("cls")
        r["roof"] = b["roof"]
        if cls in FLAT_CLASSES:
            r["roofC"] = "E"; r["roofSrc"] = f"OSM class '{cls}'"
        elif b.get("roofSrc") not in (None, "estimated"):
            r["roofC"] = "V"; r["roofSrc"] = "OSM roof:shape"
        else:
            r["roofC"] = "U"; r["roofSrc"] = "neutral placeholder (shape not observable)"
        # use
        if cls in USE:
            r["use"] = USE[cls]; r["useC"] = "V"; r["useSrc"] = f"OSM building={cls}"
        elif cls and cls not in ("yes", "building"):
            r["use"] = cls; r["useC"] = "E"; r["useSrc"] = f"OSM building={cls}"
        else:
            r["use"] = "unknown"; r["useC"] = "U"
        if b.get("name"):
            r["name"] = b["name"]
        r["facC"] = "U"; r["balC"] = "U"
        rec[b["id"]] = r

    # Chroma calibration. Haze and the ~2-3 m effective resolution wash roof colours out (median saturation 0.04).
    # The ORDER of colours is measured; the spread is restored with one global factor so that the reddest 10 % of
    # roofs reach the linear red/green ratio of clay tile (~2.0). Colour families are measured, shades approximate.
    rows = [r for r in rec.values() if r["_lin"] is not None]
    lumw = np.array([0.2126, 0.7152, 0.0722])
    def stretch(c, k):
        y = float(lumw @ c); return np.clip(y + k * (c - y), 0, 1)
    rg90 = np.quantile([r["_lin"][0] / max(r["_lin"][1], 1e-4) for r in rows], 0.9)
    lo, hi = 1.0, 30.0
    for _ in range(40):
        k = (lo + hi) / 2
        v = np.quantile([(lambda c: c[0] / max(c[1], 1e-4))(stretch(r["_lin"], k)) for r in rows], 0.9)
        lo, hi = (k, hi) if v < 2.0 else (lo, k)
    cal["coregistration"] = coreg
    cal["photo_gain"] = PHOTO_GAIN.tolist()
    cal["chroma_k"] = round(k, 2); cal["rg90_raw"] = round(float(rg90), 3)
    for r in rec.values():
        c, n = r.pop("_lin"), r["rcN"]; dt = r.pop("_det")
        if c is None:
            r["rcC"] = "U"; r["matC"] = "U"; continue
        rgb = srgb(np.clip(stretch(c, k) * PHOTO_GAIN, 0, 1))
        hh, ll_, ss = colorsys.rgb_to_hls(*rgb)
        cast = 50 <= hh * 360 <= 170
        if cast:  # olive / green cast is leftover garden light, not paint: keep the lightness, drop the hue
            rgb = np.array(colorsys.hls_to_rgb(0.08, ll_, 0.03))
        r["rc"] = "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in rgb)
        hv = r.pop("_halves"); fam = material(rgb)
        same = all(material(srgb(np.clip(stretch(h, k) * PHOTO_GAIN, 0, 1))) == fam for h in hv)
        if fam.startswith("painted sheet (green)"):
            # green almost always means garden or tree pixels inside a ~1-2 m misplaced outline, not a green roof
            r["rcC"] = "U"; r["matC"] = "U"; r["rcNote"] = "mixed with vegetation"; r.pop("rc"); continue
        # Cross-check against Am's photo p01 (2026-11-21, 10 buildings seen in both): the colour family agreed for only
        # about half of them (a white flat roof read as grey-olive). Satellite roof colours are therefore ESTIMATED;
        # the split-half test result is kept as rcQ (1 = stable measurement).
        r["rcC"] = "E"; r["rcQ"] = int(n >= 12 and dt >= 1 and same and not cast)
        if cast: r["rcNote"] = "green cast removed (vegetation in the pixels)"
        r["mat"] = fam; r["matC"] = "E"

    conf = {k: {c: sum(1 for r in rec.values() if r[k] == c) for c in "VEU"} for k in ("fpC", "rcC", "matC", "flC", "roofC", "useC", "facC")}
    out = {"meta": {"pilot": PILOT, "n": len(rec), "imagery": "Satellogic EarthView 2022-08-31 1 m (CC BY 4.0)",
                    "colour": cal, "confidence": conf,
                    "rejected": {"gba_height": "OSM 4-storey house = 2.0 m, median 2.8 m: not usable for storeys",
                                 "shadows": "shadow side only 1 % darker (diffuse light): no heights",
                                 "meta_chm": "buildings masked to 0"}},
           "b": rec}
    (out_dir / "recon.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(out["meta"], indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
