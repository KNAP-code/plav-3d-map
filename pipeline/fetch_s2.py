"""Sentinel-2 L2A reference composite for the geographic audit -> pipeline/cache/<area>/s2_median.tif.

Source: Copernicus Sentinel-2 L2A COGs on the AWS open-data bucket (sentinel-cogs), free and open licence
("Contains modified Copernicus Sentinel data 2025"). Three cloud-free summer 2025 scenes of tile 34TDN over Plav are
median-combined per band (B02 B03 B04 B08 at 10 m, B11 B12 resampled from 20 m). Used only as independent evidence
in pipeline/audit_geo.py, never to draw or create geometry.
Usage: python pipeline/fetch_s2.py [area]
"""
import os, sys, math, numpy as np, rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, TO_UTM  # noqa: E402

os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")
os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
BASE = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/34/T/DN/"
SCENES = ["S2A_34TDN_20250721_0_L2A", "S2A_34TDN_20250810_0_L2A", "S2C_34TDN_20250821_0_L2A"]  # 100% clear over Plav (SCL)
BANDS = ["B02", "B03", "B04", "B08", "B11", "B12"]


def main(area_id="plav-town"):
    W, S, E, N = CONFIG["areas"][area_id]["bbox"]
    ox, oy = TO_UTM.transform((W + E) / 2, (S + N) / 2)
    ox, oy = round(ox), round(oy)
    hw = (E - W) / 2 * 111_320 * math.cos(math.radians((S + N) / 2)) + 150
    bb = (ox - hw, oy - hw, ox + hw, oy + hw)
    # snap to the 10 m grid
    bb = tuple(math.floor(v / 10) * 10 for v in bb[:2]) + tuple(math.ceil(v / 10) * 10 for v in bb[2:])
    w, h = int((bb[2] - bb[0]) / 10), int((bb[3] - bb[1]) / 10)
    stack = np.zeros((len(BANDS), len(SCENES), h, w), np.float32)
    for j, s in enumerate(SCENES):
        y, m = s.split("_")[2][:4], int(s.split("_")[2][4:6])
        for i, b in enumerate(BANDS):
            with rasterio.open(f"/vsicurl/{BASE}{y}/{m}/{s}/{b}.tif") as r:
                win = from_bounds(*bb, r.transform)
                stack[i, j] = r.read(1, window=win, out_shape=(h, w), resampling=Resampling.bilinear).astype(np.float32) / 10000
                crs = r.crs
            print(s, b, flush=True)
    med = np.median(stack, axis=1)
    out = HERE / "cache" / area_id / "s2_median.tif"
    tr = rasterio.transform.from_origin(bb[0], bb[3], 10, 10)
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=len(BANDS), dtype="float32", crs=crs, transform=tr, compress="deflate") as d:
        d.write(med)
        d.update_tags(source="Copernicus Sentinel-2 L2A, " + ", ".join(SCENES), bands=" ".join(BANDS))
    print(out, med.shape)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
