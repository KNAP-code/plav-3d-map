"""Download the raw open data for one area into pipeline/cache/<area>/.

Sources (all legally reusable, see ../DATA_SOURCES.md):
  * Overture Maps (OSM-derived buildings/roads/water/land use, Microsoft ML buildings) — ODbL
  * Copernicus DEM GLO-30 — free licence with attribution
  * ESA WorldCover 10 m v200 (2021) — CC BY 4.0

Usage:  python fetch.py plav-centre
Only anonymous public S3 buckets are used; nothing is scraped.
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import rasterio
from rasterio.merge import merge
from rasterio.windows import from_bounds

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "areas.json").read_text())

OVERTURE_BUCKET = "overturemaps-us-west-2"
DEM_URL = (
    "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/"
    "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"
)
WORLDCOVER_URL = (
    "/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_N{lat:02d}E{lon:03d}_Map.tif"
)


def expand_bbox(bbox, metres):
    w, s, e, n = bbox
    lat = (s + n) / 2
    dlat = metres / 111_320
    dlon = metres / (111_320 * math.cos(math.radians(lat)))
    return [w - dlon, s - dlat, e + dlon, n + dlat]


def overture(fs, release, theme, typ, bbox, out: Path):
    """Read only the row groups whose bbox statistics intersect `bbox`."""
    W, S, E, N = bbox
    prefix = f"{OVERTURE_BUCKET}/release/{release}/theme={theme}/type={typ}"
    files = [f.path for f in fs.get_file_info(pafs.FileSelector(prefix)) if f.path.endswith(".parquet")]
    groups = defaultdict(list)
    for path in files:
        md = pq.ParquetFile(path, filesystem=fs).metadata
        names = {md.schema.column(i).path: i for i in range(md.num_columns)}
        for rg in range(md.num_row_groups):
            r = md.row_group(rg)
            try:
                xmin = r.column(names["bbox.xmin"]).statistics.min
                xmax = r.column(names["bbox.xmax"]).statistics.max
                ymin = r.column(names["bbox.ymin"]).statistics.min
                ymax = r.column(names["bbox.ymax"]).statistics.max
            except (KeyError, AttributeError):
                continue
            if xmin <= E and xmax >= W and ymin <= N and ymax >= S:
                groups[path].append(rg)
    tables = []
    for path, rgs in groups.items():
        t = pq.ParquetFile(path, filesystem=fs).read_row_groups(rgs)
        b = t["bbox"]
        mask = pc.and_(
            pc.and_(pc.less_equal(pc.struct_field(b, "xmin"), E), pc.greater_equal(pc.struct_field(b, "xmax"), W)),
            pc.and_(pc.less_equal(pc.struct_field(b, "ymin"), N), pc.greater_equal(pc.struct_field(b, "ymax"), S)),
        )
        tables.append(t.filter(mask))
    table = pa.concat_tables(tables, promote_options="default") if tables else pa.table({})
    pq.write_table(table, out)
    print(f"  {theme}/{typ}: {table.num_rows} features -> {out.name}")


def raster_window(url_tpl, tile_deg, bbox, out: Path):
    W, S, E, N = bbox
    urls = []
    for lat in range(math.floor(S / tile_deg) * tile_deg, math.floor(N / tile_deg) * tile_deg + 1, tile_deg):
        for lon in range(math.floor(W / tile_deg) * tile_deg, math.floor(E / tile_deg) * tile_deg + 1, tile_deg):
            urls.append(url_tpl.format(lat=lat, lon=lon))
    srcs = [rasterio.open(u) for u in urls]
    arr, transform = merge(srcs, bounds=(W, S, E, N))
    profile = srcs[0].profile.copy()
    profile.update(driver="GTiff", height=arr.shape[1], width=arr.shape[2], transform=transform, count=1,
                   compress="deflate", tiled=False)
    profile.pop("blockxsize", None); profile.pop("blockysize", None)
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(arr[0], 1)
    print(f"  raster {out.name}: {arr.shape[2]}x{arr.shape[1]} from {len(urls)} tile(s)")
    for s in srcs:
        s.close()


def main(area_id: str):
    area = CONFIG["areas"][area_id]
    release = CONFIG["overture_release"]
    core = area["bbox"]
    near = expand_bbox(core, 400)          # roads/buildings slightly beyond the edge (clipped later)
    ctx = expand_bbox(core, area["context_radius_m"])
    cache = HERE / "cache" / area_id
    cache.mkdir(parents=True, exist_ok=True)
    fs = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    print(f"[{area_id}] Overture {release}")
    overture(fs, release, "buildings", "building", near, cache / "buildings.parquet")
    overture(fs, release, "transportation", "segment", near, cache / "segments.parquet")
    overture(fs, release, "base", "water", ctx, cache / "water.parquet")
    overture(fs, release, "base", "land_use", near, cache / "land_use.parquet")
    overture(fs, release, "base", "infrastructure", near, cache / "infrastructure.parquet")
    print(f"[{area_id}] rasters")
    raster_window(DEM_URL, 1, ctx, cache / "dem.tif")
    raster_window(WORLDCOVER_URL, 3, ctx, cache / "worldcover.tif")
    (cache / "fetch.json").write_text(json.dumps({"area": area_id, "release": release, "core": core,
                                                   "near": near, "context": ctx}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-centre")
