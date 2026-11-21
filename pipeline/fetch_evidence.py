"""Download independent geometry evidence for one area into pipeline/cache/<area>/evidence/.

Phase 3 (city geometry) checks the shown footprints and streets against sources that were produced separately
from them. Everything here is read from anonymous public S3 buckets with HTTP range reads; nothing is scraped.

  ms2023.parquet   Microsoft Global ML Building Footprints as packaged by VIDA (google-microsoft-open-buildings,
                   by_country MNE). This is the *raw* Microsoft layer: unlike Overture it also contains a Microsoft
                   outline under buildings that OpenStreetMap already maps, so OSM and Microsoft can be compared
                   building by building. ODbL. s3://us-west-2.opendata.source.coop/vida/...
  gba.parquet      GlobalBuildingAtlas LoD1 (TUM, Zhu et al. 2025, doi 10.14459/2025mp1782307), tile
                   e015_n45_e020_n40, rows in the area. In Plav it is OSM 2025 + Microsoft 2024 polygons with
                   heights estimated from PlanetScope imagery. Used only for comparison.
  chm.tif          Meta / WRI "DINOv3 Global Canopy Height Map v2" (CC BY 4.0), 1.19 m pixels, EPSG:3857, derived
                   from Maxar imagery acquired 2011-11-02 .. 2019-08-07 for this tile (acq_dates.parquet).
                   Buildings are 0 m in it; trees have heights. It is the only sub-metre open layer we found that
                   comes from a third imagery source, so it tells where trees stand, where they do not, and where
                   a footprint lies under tree crowns.
  satellogic_toa.tif  Satellogic EarthView (CC BY 4.0), 1 m red/green/blue/NIR top-of-atmosphere reflectance,
                   pass of 2022-08-31 (newsat20, 3.9 deg off-nadir), 384 m regions mosaicked. Product level L1: it is
                   NOT orthorectified to survey accuracy (as delivered it sits ~38 m north of Sentinel-2 / OSM, see
                   verify_city.py), so it is used for presence, outline, orientation and *relative* position only.
                   s3://satellogic-earthview/data/tif/zone=34N/...

Usage: python pipeline/fetch_evidence.py plav-town
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "areas.json").read_text())
BUCKET = "us-west-2.opendata.source.coop"
HTTP = f"https://s3.us-west-2.amazonaws.com/{BUCKET}"
MS = f"{BUCKET}/vida/google-microsoft-open-buildings/geoparquet/by_country/country_iso=MNE/MNE.parquet"
GBA = f"{BUCKET}/tge-labs/globalbuildingatlas-lod1/e{{lo:03d}}_n{{la1:02d}}_e{{lo2:03d}}_n{{la0:02d}}.parquet"
CHM_INDEX = f"{BUCKET}/tge-labs/meta-chm-v2/tiles.parquet"
CHM_DATES = f"{BUCKET}/tge-labs/meta-chm-v2/acq_dates.parquet"


def expand(bbox, m):
    W, S, E, N = bbox
    dl = m / 111_320; dn = m / (111_320 * math.cos(math.radians((S + N) / 2)))
    return [W - dn, S - dl, E + dn, N + dl]


def bbox_rows(fs, path, bbox):
    """Read only row groups whose bbox statistics intersect, then filter rows."""
    W, S, E, N = bbox
    f = pq.ParquetFile(path, filesystem=fs)
    md = f.metadata
    names = {md.schema.column(i).path: i for i in range(md.num_columns)}
    keep = []
    for r in range(md.num_row_groups):
        g = md.row_group(r)
        st = lambda k: g.column(names[k]).statistics  # noqa: E731
        if st("bbox.xmin").min <= E and st("bbox.xmax").max >= W and st("bbox.ymin").min <= N and st("bbox.ymax").max >= S:
            keep.append(r)
    t = f.read_row_groups(keep)
    b = t["bbox"]
    m = pc.and_(
        pc.and_(pc.less_equal(pc.struct_field(b, "xmin"), E), pc.greater_equal(pc.struct_field(b, "xmax"), W)),
        pc.and_(pc.less_equal(pc.struct_field(b, "ymin"), N), pc.greater_equal(pc.struct_field(b, "ymax"), S)),
    )
    return t.filter(m), len(keep), md.num_row_groups


def quadkey(lon, lat, z):
    x = (lon + 180) / 360
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2
    n = 2 ** z; tx, ty = int(x * n), int(y * n); s = ""
    for i in range(z, 0, -1):
        m = 1 << (i - 1); s += str((1 if tx & m else 0) + (2 if ty & m else 0))
    return s


SAT = "https://satellogic-earthview.s3.amazonaws.com"
SAT_DATE = "2022-08-31"


def s3_keys(base, prefix):
    import re
    import urllib.parse
    import urllib.request
    keys, tok = [], None
    while True:
        q = f"{base}/?list-type=2&prefix={urllib.parse.quote(prefix)}" + (f"&continuation-token={urllib.parse.quote(tok)}" if tok else "")
        x = urllib.request.urlopen(q, timeout=60).read().decode()
        keys += re.findall(r"<Key>([^<]+)</Key>", x)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", x)
        if not m:
            return keys
        tok = m.group(1)


def satellogic(area, out):
    """Mosaic every 384 m EarthView region of the SAT_DATE pass that overlaps the area (+400 m)."""
    import urllib.request
    from pyproj import Transformer
    from rasterio.merge import merge
    W, S, E, N = expand(area["bbox"], 400)
    T = Transformer.from_crs("EPSG:4326", "EPSG:32634", always_xy=True)
    xs, ys = T.transform([W, E, W, E], [S, S, N, N])
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    tdir = out / "satellogic"; tdir.mkdir(exist_ok=True)
    files, meta = [], []
    for e3 in range(int(x0 // 1000) - 1, int(x1 // 1000) + 1):
        for k in s3_keys(SAT, f"data/tif/zone=34N/region={e3}"):
            if f"date={SAT_DATE}" not in k or not k.endswith("_TOA.tif"):
                continue
            e, n = (int(v) for v in k.split("region=")[1].split("/")[0].split("_"))
            if e + 384 < x0 or e > x1 or n < y0 or n - 384 > y1:
                continue
            f = tdir / k.rsplit("/", 1)[1]
            if not f.exists():
                f.write_bytes(urllib.request.urlopen(f"{SAT}/{k}", timeout=120).read())
            files.append(f)
            jk = k.replace("data/tif", "data/json").replace("_TOA.tif", "_metadata.json")
            try:
                p = json.loads(urllib.request.urlopen(f"{SAT}/{jk}", timeout=60).read())["properties"]
                meta.append({"id": f.stem, "platform": p.get("platform"), "off_nadir": p.get("view:off_nadir"),
                             "datetime": p.get("datetime"), "product": p.get("satl:product_name")})
            except Exception:  # metadata is informative only
                pass
    srcs = [rasterio.open(f) for f in sorted(files)]
    a, t = merge(srcs)
    prof = srcs[0].profile
    prof.update(width=a.shape[2], height=a.shape[1], transform=t, compress="deflate", tiled=True)
    with rasterio.open(out / "satellogic_toa.tif", "w", **prof) as d:
        d.write(a)
    off = sorted({round(m["off_nadir"], 1) for m in meta if m.get("off_nadir") is not None})
    return {"date": SAT_DATE, "regions": len(files), "off_nadir": off, "platforms": sorted({m["platform"] for m in meta}),
            "product": sorted({m["product"] for m in meta if m.get("product")}), "shape": list(a.shape)}


def main(area_id):
    area = CONFIG["areas"][area_id]
    out = HERE / "cache" / area_id / "evidence"
    out.mkdir(parents=True, exist_ok=True)
    bb = expand(area["bbox"], 400)
    fs = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    meta = {"bbox": bb}

    t, k, n = bbox_rows(fs, MS, bb)
    pq.write_table(t, out / "ms2023.parquet")
    meta["ms2023"] = {"rows": t.num_rows, "row_groups": f"{k}/{n}", "sources": pc.value_counts(t["bf_source"]).to_pylist()}
    print("ms2023", meta["ms2023"])

    lo = int(bb[0] // 5 * 5); la0 = int(bb[1] // 5 * 5)
    gpath = GBA.format(lo=lo, lo2=lo + 5, la0=la0, la1=la0 + 5)
    t, k, n = bbox_rows(fs, gpath, bb)
    pq.write_table(t, out / "gba.parquet")
    meta["gba"] = {"file": gpath.split("/")[-1], "rows": t.num_rows, "row_groups": f"{k}/{n}",
                   "sources": pc.value_counts(t["source"]).to_pylist()}
    print("gba", meta["gba"])

    qks = sorted({quadkey(x, y, 10) for x in (bb[0], bb[2]) for y in (bb[1], bb[3])})
    idx = pq.read_table(CHM_INDEX, filesystem=fs)
    rows = idx.filter(pc.is_in(idx["quadkey"], value_set=pa.array(qks))).to_pylist()
    dates = pq.read_table(CHM_DATES, filesystem=fs)
    meta["chm"] = {"tiles": qks, "acq": dates.filter(pc.is_in(dates["quadkey"], value_set=pa.array(qks))).to_pylist()}
    if len(rows) != 1:
        raise SystemExit(f"area spans {len(rows)} CHM tiles; mosaicking not implemented")
    url = "/vsicurl/" + HTTP + "/tge-labs/meta-chm-v2/chm/" + rows[0]["quadkey"] + ".tif"
    with rasterio.open(url) as s:
        w = from_bounds(*transform_bounds("EPSG:4326", s.crs, *bb), transform=s.transform).round_offsets().round_lengths()
        a = s.read(1, window=w)
        prof = dict(driver="GTiff", dtype="uint8", count=1, crs=s.crs, transform=s.window_transform(w),
                    width=a.shape[1], height=a.shape[0], compress="deflate")
    with rasterio.open(out / "chm.tif", "w", **prof) as d:
        d.write(a, 1)
    meta["chm"]["shape"] = list(a.shape)
    print("chm", meta["chm"])
    meta["satellogic"] = satellogic(area, out)
    print("satellogic", meta["satellogic"])
    (out / "evidence.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-town")
