# Geographic accuracy audit: plav-town (4 × 4 km)

Run on 2026-11-20 by `pipeline/fetch_s2.py` + `pipeline/audit_buildings.py` + `pipeline/audit_geo.py`. Every number below
comes from `pipeline/cache/plav-town/audit-geo.json` and `public/data/plav-town/audit.json`, and the scripts reproduce them.

## Sources

| Role | Source | Licence |
|---|---|---|
| Footprints | Overture 2026-11-18.0: OpenStreetMap (764 shown) and Microsoft ML Buildings 2026-08-11 (2,762 shown) | ODbL |
| Independent imagery | Copernicus Sentinel-2 L2A, tile 34TDN, 2025-07-21, 2025-08-10 and 2025-08-21 (all 100 % cloud-free over Plav), per-band median, 10 m | Copernicus free and open ("Contains modified Copernicus Sentinel data 2025") |
| Land cover | ESA WorldCover 2021 v200, 10 m | CC BY 4.0 |
| Streets, water | OpenStreetMap through Overture (a separate layer from the footprints) | ODbL |

We did not use Google Maps, Google Earth, Bing or Esri imagery, or any geometry traced from them. The imagery is used
only as evidence. It never creates, moves or reshapes a footprint.

## What the imagery test can and cannot tell

A roof shows up at 10 m as a higher built-up index (NDBI) and a lower vegetation index (NDVI) than the grass around it.
We calibrated the test on the 764 OSM footprints, which people mapped, against the same shapes moved 40–120 m onto
open ground with no footprint within 15 m (1,000+ samples):

| Footprint size | OSM houses with a built signal | Open ground with a built signal (false positives) | OSM houses that look like vegetation |
|---|---|---|---|
| < 40 m² | 10 % | 0 % | 0 % |
| 40–80 m² | 51 % | 4 % | 9.5 % |
| 80–150 m² | 51 % | 3 % | 0.5 % |
| ≥ 150 m² | 60 % | 8 % | 0.3 % |

So a built signal is strong evidence that something is there. A missing signal proves nothing for a single house:
40–50 % of real OSM houses have none, because of gardens, trees, roof colour and mixed pixels. That is why no building
was removed on imagery alone.

## Results for the 3,526 shown buildings

| Check | Result |
|---|---|
| Duplicates (≥ 50 % shared) | **0** |
| Overlaps (≥ 2 m² and ≥ 5 %) | **0** pairs |
| In mapped water (≥ 25 %) | **0** |
| OSM road centreline ≥ 1 m inside a footprint | **1**, an OSM `building=roof` canopy over a service road. This is expected, not an error. |
| Density (50 m cells) | The densest cell is 63 % covered, and it is an OSM-mapped centre cell. No cell exceeds it. |
| Position vs source geometry | Max 0.11 m, mean 0.02 m (rounding only) |
| Layer shift vs Sentinel-2 | OSM and ML both match best at 0 m E / −2 m N, with the correlation at 0 m almost identical (0.0745 vs 0.0749 OSM). The two layers agree with each other and show no shift beyond the imagery's own few-metre accuracy. |
| Sentinel-2 built signal | OSM: 414 visible, 340 not resolvable, 10 look like vegetation. ML: 765 visible, 1,865 not resolvable, 132 look like vegetation. |

**ML compared with OSM.** By size, ML footprints have a built signal less often than OSM ones: 49 % against 60 % at
≥ 150 m², and 31 % against 51 % at 80–150 m². Part of the ML set is probably false detections. Part may be houses in
greener, more rural settings. A 10 m image cannot say which applies to each building, so the ML set stays shown and
labelled "Microsoft ML detection: unverified". `#osm` shows OpenStreetMap only.

## The 917 flagged buildings

| Flag (from audit_buildings.py) | Count | Sentinel-2 result | Outcome |
|---|---|---|---|
| isolated_ml (no WorldCover built-up within 25 m) | 702 | 67 visible, 556 not resolvable, 79 look like vegetation | 67 cleared. The rest stay for review. |
| skewed_to_street (rotated > 25° to the nearest street) | 224 | 70 visible, 153 not resolvable, 1 vegetation | Kept. Orientation cannot be tested at 10 m, and ML outlines are traced from imagery, so a skew is not an error by itself. |
| large_ml (> 600 m², may merge buildings) | 11 | 7 visible | Kept for review. |
| odd_shape | 10 | 6 visible | Kept for review. |
| on_street (≥ 15 % on an estimated carriageway width) | 5 | 2 visible | Kept. Street widths are estimates, and no centreline runs through them. |

New flags: `s2_vegetation` (132 ML footprints look like vegetation in all three 2025 scenes, 79 of them also flagged by
WorldCover) and `road_through` (the canopy above). **To review now: 905**, down from 917. The `#audit` view shows the
Sentinel-2 class of each building and steps through them with "Next building to review".

## Possible unmapped buildings

32 cells of 50 m are built-up in WorldCover but have no footprint. In 7 of them Sentinel-2 also shows ≥ 3 built pixels,
and 6 of those 7 contain a mapped road, which explains the signal. The remaining cell is at 42.599138 N, 19.940867 E,
150 m west of the centre. Without a legally usable footprint source, **nothing was added**. These are listed in
`audit-geo.json` for mapping in OSM.

## Corrections made

**None to geometry.** No footprint met the rule for a demonstrable error: two independent sources agreeing, such as a
water polygon plus open-water imagery, or a duplicate of an OSM building. No building was invented, moved or deleted in
this pass. The 108 footprints removed earlier (81 ML under 15 m², 27 ML lying across a street centreline) stay removed.
20 of them show a built signal, but on a street that signal is the asphalt itself.

## Limits

- Sentinel-2 is 10 m. It cannot confirm small houses, outlines, orientation or heights. Sub-metre open imagery that is
  licensed for this use was not available here. The Montenegrin cadastre has no usable licence.
- Heights: 8 buildings have a source height. The rest follow rules v2 and are marked as estimated.
- What would settle the 905: a local check on the ground, or OSM mappers tracing them from permitted imagery.
