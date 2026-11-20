"""Street furniture and small mapped features for an area (only what is mapped in Overture/OSM).

Writes public/data/<area>/furniture.json: [{k, x, y, [a]}] in local metres, plus mapped walls as polylines.
Nothing is invented: benches, fountains, drinking water, bus stops, give-way signs, crossings and parking
are placed exactly where they are mapped. Usage: python pipeline/furniture.py [area]
"""
import json, math, sys
import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import box
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build import CONFIG, HERE, ROOT, TO_UTM, to_local, lines_of, coords_list  # noqa: E402

KEEP = {"bench": "bench", "drinking_water": "fountain", "fountain": "fountain", "stop": "bus_stop",
        "bus_station": "bus_stop", "give_way": "give_way", "crossing": "crossing", "parking": "parking",
        "information": "info", "gate": "gate"}
WALLS = {"wall": "wall", "retaining_wall": "retaining_wall", "fence": "fence"}


def main(area_id="plav-centre"):
    area = CONFIG["areas"][area_id]
    W, S, E, N = area["bbox"]
    clon, clat = (W + E) / 2, (S + N) / 2
    ox, oy = TO_UTM.transform(clon, clat)
    origin = np.array([round(ox), round(oy)], dtype=float)
    hw = (E - W) / 2 * 111_320 * math.cos(math.radians(clat)); hh = (N - S) / 2 * 110_950
    core = box(-hw, -hh, hw, hh)
    rows = pq.read_table(HERE / "cache" / area_id / "infrastructure.parquet").to_pylist()
    pts, walls, counts = [], [], {}
    for r in rows:
        g = to_local(shapely.from_wkb(r["geometry"]), origin)
        k = KEEP.get(r["class"])
        if k:
            p = g.centroid
            if core.contains(p):
                pts.append({"k": k, "x": round(p.x, 1), "y": round(p.y, 1), "src": r.get("id")})
                counts[k] = counts.get(k, 0) + 1
        w = WALLS.get(r["class"])
        if w:
            for ln in lines_of(g.intersection(core) if g.geom_type != "Polygon" else g.exterior.intersection(core)):
                walls.append({"k": w, "pts": coords_list(ln)})
                counts[w] = counts.get(w, 0) + 1
    out = ROOT / "public" / "data" / area_id / "furniture.json"
    out.write_text(json.dumps({"source": "Overture infrastructure (OSM); positions as mapped", "points": pts, "walls": walls},
                              ensure_ascii=False, separators=(",", ":")))
    print(area_id, counts)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "plav-centre")
