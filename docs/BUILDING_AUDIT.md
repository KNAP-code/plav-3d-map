# Building audit: central Plav prototype

This file is generated from `pipeline/audit_buildings.py`; the numbers below are from the 2026-11-20 run.
Area: the central Plav prototype box (19.930-19.955 E, 42.590-42.606 N). Source: Overture Maps release
2026-11-18.0, which is the newest release published, checked against the S3 bucket listing. Its building theme combines
OpenStreetMap footprints with Microsoft Global ML Building Footprints (machine-detected from imagery, ODbL).

## What the scene contained before (commit 2cf738f)

| | count |
|---|---|
| source footprints in the area | 2084 |
| from OpenStreetMap (human-mapped) | 546 |
| from Microsoft ML (machine-detected) | 1538 |
| shown in the scene | 2084 |
| procedurally invented buildings | 0 (the scene never added buildings without a footprint) |
| duplicates (two footprints covering >= 30% of the smaller one) | 0 (Overture already drops ML footprints that overlap OSM ones) |
| footprints under 15 m² (all ML) | 42 |
| footprints with >= 15% of their area on a mapped street carriageway | 19 |
| footprints with height or levels from the source | 7 |
| position check: scene footprint centroid vs source geometry | max 0.11 m, mean 0.02 m |

The positions, shapes and orientation of all footprints are the source ones; nothing was moved or rotated. The
"invented" look came mostly from (a) 74% of footprints being ML detections, which are boxier and include small sheds,
(b) all heights and roof shapes but 7 being estimates, and (c) small sheds rendered as houses with windows.

## Reconciliation rules (pipeline/build.py)

1. OpenStreetMap footprints are always kept.
2. Microsoft ML footprints under 15 m² are removed: 42.
3. Microsoft ML footprints with >= 15% of their area on a mapped street carriageway are removed: 13. The street is human-mapped, so the detection is the less reliable of the two.
4. Microsoft ML footprints of 15-30 m² are shown as plain single-storey outbuildings, with no windows, doors, balconies or chimneys: 204.
5. No footprint is moved, reshaped or added. The landmark models replace their own footprint only.

## After

| | count |
|---|---|
| shown | 2029 (546 OSM, 1483 ML) |
| removed | 55 |
| duplicates shown | 0 |
| OSM footprints overlapping a street by >= 15% (kept, flagged for review) | 5 |
| position check | max 0.11 m |

## Coverage (incomplete areas)

Coverage is measured against ESA WorldCover 2021 (10 m), not against reality. A 50 m cell counts as built-up when at least
25% of its pixels are class 50 (built-up, which includes paved areas). Of 439 built-up cells,
423 (96.4%) contain at least one footprint, and 59.7% contain an OSM
footprint. The 16 cells below are built-up on WorldCover but have no footprint. They may be paved areas, demolished
buildings, or buildings missing from both datasets, and need checking against imagery:

| lat, lon (cell centre) | local x, y (m) | built-up share |
|---|---|---|
| 42.604989, 19.931422 | -899.3, 787.4 | 44% |
| 42.59692, 19.935217 | -599.3, -112.6 | 32% |
| 42.597398, 19.938256 | -349.3, -62.6 | 40% |
| 42.592451, 19.938949 | -299.3, -612.6 | 32% |
| 42.599221, 19.940663 | -149.3, 137.4 | 32% |
| 42.599244, 19.9431 | 50.7, 137.4 | 36% |
| 42.5997, 19.943702 | 100.7, 187.4 | 76% |
| 42.590273, 19.946908 | 350.7, -862.6 | 28% |
| 42.599283, 19.947366 | 400.7, 137.4 | 56% |
| 42.599733, 19.947358 | 400.7, 187.4 | 32% |
| 42.600184, 19.947351 | 400.7, 237.4 | 76% |
| 42.600634, 19.947343 | 400.7, 287.4 | 80% |
| 42.601084, 19.947336 | 400.7, 337.4 | 88% |
| 42.591185, 19.948112 | 450.7, -762.6 | 36% |
| 42.596604, 19.949849 | 600.7, -162.6 | 32% |
| 42.599339, 19.95346 | 900.7, 137.4 | 52% |

The five cells at about 19.9473 E, 42.5993-42.6011 N form one north-south strip.

## Imagery and sources

- OpenStreetMap servers, Overpass, Geofabrik and imagery tiles are blocked from the build environment, so this run uses the
  OSM data contained in the newest Overture release. It is a few weeks old, not live OSM.
- Esri World Imagery and Bing imagery may be used for tracing into OpenStreetMap (contributing to OSM), not for building
  our own derived dataset. The legally clean way to fix a footprint is to edit OSM and re-run the pipeline.
- Montenegro's Real Estate Administration publishes orthophotos on its geoportal. Its reuse licence for derived data
  was not found and needs confirming before any use beyond viewing.
- No data was traced or extracted from Google imagery.

## Verification status (option A: OSM + checked ML footprints)

All 2,029 candidate buildings are kept. None of the ML footprints is treated as verified.

| status | shown | meaning |
|---|---|---|
| landmark_verified | 2 | Stara džamija and Redžepagića kula, position confirmed by the owner or by the mapped footprint |
| osm_mapped | 544 | human-mapped in OpenStreetMap, not separately checked against imagery |
| ml_unverified | 1483 | Microsoft machine detection, not checked |

## Review flags (shown buildings, a building can have several)

| flag | count | check |
|---|---|---|
| isolated_ml | 173 | ML footprint with no WorldCover built-up pixel within 25 m. It could be a barn or shed in a field, or a false detection. |
| skewed_to_street | 133 | ML footprint within 12 m of a street, rotated 25-65° against it while being clearly rectangular. Detections are often rotated; real houses can be too. |
| odd_shape | 6 | rectangularity under 0.55 or aspect over 6 |
| large_ml | 6 | ML footprint over 600 m² (often two buildings merged into one) |
| on_street | 5 | OSM footprint with >= 15% of its area on the mapped carriageway (the street or the building is off) |
| duplicate (>= 30% overlap) | 0 | |
| partial overlap (5-30%, >= 2 m²) | 0 | |

315 shown buildings carry at least one flag. A flag means "look at this"; it does not prove the footprint is wrong.

## Inspection mode

Open the preview with `#audit`:
- yellow: flagged for manual review; tap any building for its details
- green: OpenStreetMap footprint
- blue: Microsoft ML footprint
- light blue: ML outbuilding
- orange: OSM footprint overlapping a street
- purple: height from source
- red on the ground: removed footprint
- magenta: built-up cell with no footprint

Tapping a building shows its source, verification status, area, floors, whether height and roof are estimated, its
flags in plain words, and a link to the OSM way. "Next building to review" flies to the flagged buildings in turn.
`#osm` shows OSM footprints only. `#audit,osm` combines both.

## Remaining uncertainties

1. 1,483 ML footprints are unverified. Of these, 315 buildings are flagged. Confirming or removing them needs a person with imagery they may legally use (for example, editing OSM with the Esri or Bing layers in the iD editor).
2. 16 built-up cells have no footprint (table above), including one north-south strip at 19.9473 E.
3. All heights and roof shapes are estimates, except 7 heights from source data and the two landmark models.
4. OSM data comes from the Overture release, not live OSM.
5. No orthophoto with a confirmed licence for derived data was available, so no footprint was checked against imagery in this environment.

## Performance (SwiftShader, Pixel 7 emulation, relative only)

| tier | p50 frame 2cf738f → after | draw calls | triangles |
|---|---|---|---|
| low | 167 → 160 ms | 27 → 27 | 262k → 261k |
| medium | 468 → 458 ms | 29 → 29 | 365k → 363k |
| high | 976 → 1042 ms | 42 → 42 | 499k → 498k |

The differences are within run-to-run noise on this shared machine. The triangle count drops slightly because there are fewer buildings and fewer details on outbuildings.
