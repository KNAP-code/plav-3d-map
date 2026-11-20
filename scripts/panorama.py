"""Stitch six 60° rendered frames into a 360° ground-level panorama and overlay, independently of the renderer:
  * the skyline computed from the full 30 m GLO-30 DEM (thin dashed line), from docs/terrain/validation.json
  * named OSM peaks (marker at the bearing / elevation angle computed from the DEM summit and the observer)

Frames are rectilinear (hfov 60°, pitch 0); points are projected into the frame they belong to, so the overlay sits
exactly where the real-data skyline and summits fall in each frame.

    python3 scripts/panorama.py <frames dir> <prefix> <out.jpg>
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
from terrain import R_EFF, dem_at, ll_to_local, local_to_ll  # noqa: E402

frames_dir, prefix, out = sys.argv[1:4]
V = json.loads((ROOT / "docs" / "terrain" / "validation.json").read_text())
sky = V["skyline"]
ox, oy, eye = sky["observer"]["x"], sky["observer"]["y"], sky["observer"]["eye_m"]
oh = sky["observer"]["ground_glo30"] + eye
W, H, HF = 1280, 800, 60.0
f = (W / 2) / math.tan(math.radians(HF / 2))
centres = [0, 60, 120, 180, 240, 300]
pano = Image.new("RGB", (W * 6, H))
for k, c in enumerate(centres):
    pano.paste(Image.open(f"{frames_dir}/{prefix}-p{c}.jpg").convert("RGB"), (k * W, 0))
d = ImageDraw.Draw(pano)
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
    big = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
except OSError:
    font = big = ImageFont.load_default()


def project(bearing, elev):
    """bearing/elevation angle (deg, grid frame) -> pano pixel, choosing the frame whose centre is nearest."""
    k = int(((bearing + 30) % 360) // 60)
    rel = math.radians(((bearing - centres[k] + 180) % 360) - 180)
    x = W / 2 + f * math.tan(rel)
    y = H / 2 - f * math.tan(math.radians(elev)) / math.cos(rel)
    return k * W + x, y


# DEM skyline (0.5° steps), dashed
pts = [project(i * 0.5, a) for i, a in enumerate(sky["skyline_dem_deg"])]
for i in range(len(pts) - 1):
    (x0, y0), (x1, y1) = pts[i], pts[i + 1]
    if abs(x1 - x0) < 60 and i % 2 == 0:
        d.line([(x0, y0), (x1, y1)], fill=(255, 240, 120), width=2)
# peaks visible from the observer: summit angle >= skyline angle - 0.15°
peaks = [p for p in json.loads((ROOT / "pipeline" / "cache" / "terrain" / "osm_peaks.json").read_text()) if p["cls"] == "peak" and p["name"] and p["ele"]]
labels = []
for p in peaks:
    x, y = ll_to_local(p["lon"], p["lat"])
    r = math.hypot(x - ox, y - oy)
    if r < 1500 or r > 38000:
        continue
    b = math.degrees(math.atan2(x - ox, y - oy)) % 360
    h = float(dem_at(p["lon"], p["lat"]))
    e = math.degrees(math.atan2(h - r * r / (2 * R_EFF) - oh, r))
    s = sky["skyline_dem_deg"][int(round(b / 0.5)) % 720]
    if e < s - 0.15 or p["ele"] < 1700:
        continue
    labels.append((p["ele"], b, e, p["name"], r))
labels.sort(reverse=True)
placed = []
for ele, b, e, name, r in labels:
    px, py = project(b, e)
    if any(abs(px - qx) < 150 for qx in placed):
        continue
    placed.append(px)
    d.line([(px, py - 4), (px, py - 70)], fill=(255, 255, 255), width=1)
    d.ellipse([px - 4, py - 4, px + 4, py + 4], outline=(255, 255, 255), width=2)
    txt = f"{name.split(' / ')[0]}  {ele} m · {r / 1000:.1f} km"
    tw = d.textlength(txt, font=font)
    d.rectangle([px - tw / 2 - 5, py - 94, px + tw / 2 + 5, py - 72], fill=(30, 34, 40))
    d.text((px - tw / 2, py - 92), txt, fill=(255, 255, 255), font=font)
for k, c in enumerate(centres):
    lab = {0: "N", 60: "NE 60°", 120: "SE 120°", 180: "S", 240: "SW 240°", 300: "NW 300°"}[c]
    d.text((k * W + W / 2 - 30, H - 34), lab, fill=(255, 255, 255), font=big, stroke_width=2, stroke_fill=(0, 0, 0))
lon, lat = local_to_ll(ox, oy)
cap = (f"Ground-level 360° panorama, eye {eye} m above the east shore of Plavsko jezero ({float(lat):.5f} N, {float(lon):.5f} E). "
       f"Dashed yellow = skyline computed from the 30 m Copernicus DEM; markers = OSM summits at their DEM bearing/elevation angle.")
d.rectangle([0, 0, W * 6, 30], fill=(30, 34, 40))
d.text((10, 6), cap, fill=(255, 255, 255), font=font)
pano.save(out, quality=88)
small = pano.resize((W * 6 // 2, H // 2))
small.save(out.replace(".jpg", "-small.jpg"), quality=85)
print(out, len(placed), "labels")
