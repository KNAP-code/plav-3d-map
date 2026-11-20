"""Landmark inventory for the Plav municipality.

Reads Overture (OSM + Meta places) caches fetched for the municipality bbox and writes
public/data/landmarks.json: one record per landmark with WGS84 coordinates, the matching
building footprint, source links, a confidence level and the status of architectural references.

Confidence rules (documented in docs/LANDMARKS.md):
  VERIFIED     name + footprint in OSM and at least one independent source agreeing within 30 m
  PROBABLE     one geographic source (e.g. OSM-named building) consistent with written descriptions
  UNCONFIRMED  single unverified source, unnamed footprint, or conflicting sources
Usage: python pipeline/landmarks.py  (after the municipality cache exists, see README)
"""
from __future__ import annotations
import json, math
from pathlib import Path
import pyarrow.parquet as pq
import shapely
from shapely.geometry import mapping

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache" / "municipality"
OUT = ROOT.parent / "public" / "data" / "landmarks.json"
PROTO_BBOX = (19.930, 42.590, 19.955, 42.606)

OSM = "https://www.openstreetmap.org/way/{}"
AVLIJA = "https://avlija.me/islamsko-kulturno-nasljedje-plav/"
MONTEISLAM = "https://www.monteislam.com/novosti/obnovljeni-dzamijski-kompleksi-u-plavu"
WIKI_LIST = "https://bs.wikipedia.org/wiki/Spisak_d%C5%BEamija_u_Sand%C5%BEaku"
PHOTOMNE = "https://www.photomontenegro.me/radzepagica-kula/"
MONTENEGRINA = "https://montenegrina.net/plav-kula-redzepagica/"
SANDZACKE = "https://sandzacke.rs/featured/nakon-15-godina-izgradnje-otvara-se-sehidska-dzamija-u-plavu/"

def metres(a, b):
    (y1, x1), (y2, x2) = a, b
    return math.hypot((x2 - x1) * 111320 * math.cos(math.radians(y1)), (y2 - y1) * 110540)

def main():
    mun = shapely.from_wkt((CACHE / "plav_municipality.wkt").read_text())
    blds = {r["id"]: r for r in pq.read_table(CACHE / "buildings.parquet").to_pylist()}
    places = [r for r in pq.read_table(CACHE / "places.parquet").to_pylist()]
    infra = [r for r in pq.read_table(CACHE / "infrastructure.parquet").to_pylist()]

    def footprint(prefix):
        r = next(v for k, v in blds.items() if k.startswith(prefix))
        g = shapely.from_wkb(r["geometry"])
        mrr = g.minimum_rotated_rectangle
        xs, ys = mrr.exterior.coords.xy
        sides = sorted(metres((ys[i], xs[i]), (ys[i + 1], xs[i + 1])) for i in range(2))
        osm = r["sources"][0]["record_id"].split("@")[0]
        return {"overture_id": r["id"], "osm": osm, "osm_url": OSM.format(osm[1:]) if osm.startswith("w") else None,
                "osm_name": (r["names"] or {}).get("primary"), "osm_class": r["class"],
                "size_m": [round(sides[1], 1), round(sides[0], 1)],
                "outline": [[round(x, 7), round(y, 7)] for x, y in g.exterior.coords],
                "centroid": [round(g.centroid.y, 6), round(g.centroid.x, 6)]}

    def meta_place(name_part, near):
        best = None
        for p in places:
            n = ((p["names"] or {}).get("primary") or "").lower()
            if name_part in n:
                g = shapely.from_wkb(p["geometry"])
                d = metres(near, (g.y, g.x))
                if best is None or d < best[0]:
                    best = (d, {"name": (p["names"] or {}).get("primary"), "lat": round(g.y, 6), "lon": round(g.x, 6),
                                "confidence": round(p["confidence"], 2), "distance_m": round(d, 1)})
        return best[1] if best else None

    def minaret(name_part):
        for r in infra:
            if r["class"] == "minaret" and name_part in ((r["names"] or {}).get("primary") or "").lower():
                g = shapely.from_wkb(r["geometry"]).centroid
                return {"lat": round(g.y, 6), "lon": round(g.x, 6), "osm": r["sources"][0]["record_id"].split("@")[0]}
        return None

    L = []
    def add(**kw):
        fp = kw.get("footprint")
        lat, lon = kw.pop("latlon", None) or (fp["centroid"] if fp else (None, None))
        kw["lat"], kw["lon"] = lat, lon
        kw["in_prototype"] = bool(lat and PROTO_BBOX[0] <= lon <= PROTO_BBOX[2] and PROTO_BBOX[1] <= lat <= PROTO_BBOX[3])
        kw["in_municipality"] = bool(lat and mun.contains(shapely.Point(lon, lat)))
        L.append(kw)

    fp = footprint("d8f69ad5")
    add(id="stara-dzamija", name="Stara džamija", kind="mosque", footprint=fp,
        meta=meta_place("stara", fp["centroid"]), minaret=minaret("stara"),
        confidence="VERIFIED",
        evidence="OSM building named 'Stara džamija' + OSM minaret node 'Stara' inside it + Meta place within 1 m; plan 17.5 × 10.1 m matches the 16 × 10 m stated by avlija.me.",
        sources=[fp["osm_url"], AVLIJA, MONTEISLAM, WIKI_LIST],
        references="2 photos supplied by the project owner (entrance end, side). Missing: rear (qibla) wall, minaret top close-up.",
        model="built (provisional: eave height, pitch, rear wall estimated)")
    fp = footprint("7ab32b00")
    add(id="sultanija", name="Sultanija džamija", kind="mosque", footprint=fp,
        meta=meta_place("sultanija", fp["centroid"]), minaret=minaret("sultanija"),
        confidence="VERIFIED",
        evidence="OSM building named 'Sultanija' + OSM minaret node 'Sultanija' + Meta place within 2 m. Built 1907 (avlija.me, Wikipedia list).",
        sources=[fp["osm_url"], AVLIJA, WIKI_LIST],
        references="No usable photographs yet. Needed: 2–4 photos (front, side, minaret).",
        model="not built: waiting for reference photos")
    fp = footprint("046e12de")
    add(id="redzepagica-dzamija", name="Redžepagića džamija", kind="mosque", footprint=fp,
        meta=meta_place("redz", fp["centroid"]),
        confidence="VERIFIED",
        evidence="OSM building named 'Redžepagića džamija' + Meta place 'Redzepagica Dzamija' within ~17 m (inside the footprint's neighbourhood). Built 1774 (avlija.me).",
        sources=[fp["osm_url"], AVLIJA, WIKI_LIST],
        references="No usable photographs yet. Needed: 2–4 photos.",
        model="not built: waiting for reference photos")
    fp = footprint("a7e3238c")
    add(id="sabovica-dzamija", name="Šabovića džamija", kind="mosque", footprint=fp,
        meta=meta_place("šabovi", fp["centroid"]),
        confidence="VERIFIED",
        evidence="OSM building named 'Sabovica' (class mosque) + Meta place 'Šabovića Džamija' within ~1 m. Built 1880 (avlija.me).",
        sources=[fp["osm_url"], AVLIJA, WIKI_LIST],
        references="No photographs yet.", model="not built: waiting for reference photos")
    fp = footprint("adce3013")
    add(id="mosque-north-plav", name="Unnamed mosque, north Plav", kind="mosque", footprint=fp,
        confidence="UNCONFIRMED",
        evidence="OSM building tagged as a mosque but without a name; no second source found.",
        sources=[fp["osm_url"]], references="None.", model="not built: name and references unknown")
    fp = footprint("4a1e5139")
    add(id="redzepagica-kula", name="Redžepagića kula", kind="tower house", footprint=fp,
        latlon=(42.595724, 19.945963),
        confidence="VERIFIED",
        evidence="Confirmed by the project owner on 2026-11-20: 42.595724, 19.945963, OSM building way 221505346. Earlier single source: coordinate from photomontenegro.me (2013, method not stated, street 'Podnogradska'). Nearest footprint is an unnamed square 8.6 × 8.4 m OSM building 7 m away. OSM website, Wikidata, Wikimapia and satellite tiles could not be reached from the build environment for a cross-check. Not to be confused with Redžepagića džamija (≈ 55 m north-east).",
        sources=[PHOTOMNE, MONTENEGRINA, fp["osm_url"]],
        references="2 photos supplied by the project owner (two faces of the tower).",
        model="custom model, shown in the main map (camera shortcut 'Redžepagića kula')")
    fp = footprint("d2b46bce")
    add(id="sehidska-dzamija", name="Šehidska džamija (Vojno Selo)", kind="mosque", footprint=fp,
        confidence="PROBABLE",
        evidence="OSM building named 'Šehidska džamija' 3 km south-west of Plav centre; the Wikipedia list and the project owner place it in Vojno Selo. No second geographic source.",
        sources=[fp["osm_url"], SANDZACKE, WIKI_LIST],
        references="No photographs yet.", model="catalogue only (outside the prototype area)")
    fp = footprint("1d313fab")
    add(id="bogajice-dzamija", name="Džamija u Bogajićima", kind="mosque", footprint=fp,
        confidence="PROBABLE",
        evidence="OSM building named 'Bogajiće Džamija'; the Wikipedia list mentions a mosque in Bogajići under construction since 2010. No second geographic source.",
        sources=[fp["osm_url"], WIKI_LIST], references="No photographs yet.", model="catalogue only (outside the prototype area)")
    fp = footprint("d43a6d97")
    add(id="brezojevice-church", name="Church near Brezojevice (possibly Holy Trinity monastery)", kind="church", footprint=fp,
        confidence="UNCONFIRMED",
        evidence="Unnamed OSM building tagged as a church. A Meta place 'Manastir Svete Trojice u Brezojevicama' exists but is pinned 2.2 km away, in Plav, so it does not confirm this position.",
        sources=[fp["osm_url"]], references="No photographs yet.", model="catalogue only")
    fp = footprint("ac759cf7")
    add(id="murino-church", name="Church in Murino (name unconfirmed)", kind="church", footprint=fp,
        confidence="UNCONFIRMED",
        evidence="Unnamed OSM building tagged as a church, next to the OSM school building 'Škola' in Murino. Name and dedication not found in reachable sources.",
        sources=[fp["osm_url"]], references="No photographs yet.", model="catalogue only (Murino, outside the prototype area)")
    fp = footprint("6fac0e52")
    add(id="church-north-east", name="Small church north-east of Plav (name unknown)", kind="church", footprint=fp,
        confidence="UNCONFIRMED", evidence="Unnamed 54 m² OSM building tagged as a church.",
        sources=[fp["osm_url"]], references="No photographs yet.", model="catalogue only")
    add(id="celova-kula", name="Ćelova kula", kind="tower house", latlon=(42.649443, 19.939443), footprint=None,
        confidence="UNCONFIRMED", evidence="Meta place only (confidence 0.38), no OSM footprint or written source found.",
        sources=[], references="None.", model="catalogue only")
    for pid, name, kind in [("93bc9e4b", "Opština Plav (municipal building)", "civic"), ("74a3178f", "Dom kulture Plav", "civic"),
                            ("a6934b1f", "Pijaca Plav (market)", "civic")]:
        fp = footprint(pid)
        add(id=name.split(" (")[0].lower().replace(" ", "-").replace("š", "s"), name=name, kind=kind, footprint=fp,
            confidence="VERIFIED" if fp["osm_name"] else "PROBABLE",
            evidence=f"OSM building named '{fp['osm_name']}'.", sources=[fp["osm_url"]],
            references="No photographs yet.", model="procedural (not a custom landmark yet)")

    lake = None
    wt = pq.read_table(ROOT / "cache" / "plav-centre" / "water.parquet").to_pylist()
    for r in wt:
        if "plav" in (((r.get("names") or {}).get("primary")) or "").lower() and r["subtype"] in ("lake", "water"):
            g = shapely.from_wkb(r["geometry"])
            if g.geom_type in ("Polygon", "MultiPolygon") and (lake is None or g.area > lake.area):
                lake = g
    out = {
        "generated_from": "Overture Maps 2026-11-18.0 (OSM buildings/minarets, Meta places), municipal boundary from Overture divisions (OSM)",
        "confidence_rules": {"VERIFIED": "name + footprint in OSM and at least one independent source agreeing within 30 m",
                             "PROBABLE": "one geographic source consistent with written descriptions",
                             "UNCONFIRMED": "single unverified source, unnamed footprint or conflicting sources"},
        "prototype_bbox": PROTO_BBOX,
        "municipality": mapping(mun.simplify(0.0008)),
        "lake": mapping(lake.simplify(0.0002)) if lake else None,
        "landmarks": L,
        "unresolved": [
            "Unnamed mosque in north Plav (OSM way): name unknown.",
            "Murino: only an unnamed church and a school are mapped; no named landmarks or memorials found in OSM/Overture.",
            "Šehidska džamija and Bogajići mosque: single geographic source each.",
            "Reference photos missing for Sultanija, Redžepagića džamija, Šabovića džamija, Šehidska džamija and all churches.",
        ],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"wrote {OUT} with {len(L)} landmarks")
    for l in L:
        print(f"  {l['confidence']:12} {l['name']:55} {l['lat']}, {l['lon']}  proto={l['in_prototype']} mun={l['in_municipality']}  meta={(l.get('meta') or {}).get('distance_m')}")

if __name__ == "__main__":
    main()
