# Whole-city phase: what is data and what is estimated

From November 2026 the default area is `plav-town`, which covers the whole town of Plav: 4.0 × 4.0 km, bbox
19.918–19.967 E, 42.580–42.616 N. It is centred on the old `plav-centre` origin, so old `cam=` values still work.
The old area can still be opened with `#centre`.

The **≈ button** in the right-hand bar (or `?est=0` / `#data`) hides every estimated detail listed below.
The scene then shows only verified data and the documented rules-v2 defaults.

## From data (Overture 2026-11-18.0 = OpenStreetMap + Microsoft ML footprints, Copernicus DEM, ESA WorldCover)

| Feature | Source | Notes |
|---|---|---|
| 3,526 building footprints | 764 OSM, 2,762 Microsoft ML | Reconciliation rules unchanged: 81 tiny ML and 27 ML-on-street footprints removed, 0 invented. See `#audit`. |
| Street centrelines, classes | OSM | Carriageway width by class is an estimate (OSM has no widths here). |
| 16 bridge spans | OSM `bridge=yes`, exact `between` ranges | Before batch 1, any segment with a bridge on part of it was drawn as a bridge along its whole length. |
| 62 power towers and poles, 6 lines | OSM | Pylon heights are estimates: 24 m towers, 9 m poles. |
| 2 piers, 1 football pitch, 6 cemeteries | OSM | Pitch line layout is the standard football layout scaled to the mapped pitch. |
| 3 pedestrian crossings | OSM | Zebra stripes across the nearest street. |
| Lake, rivers, terrain, tree cover | OSM, GLO-30, WorldCover | Unchanged. |

## Estimates (shown only with ≈ on)

| Estimate | Rule |
|---|---|
| Sidewalks (~14,600 m²) | 1.8 m along secondary and tertiary streets with at least 6 footprints within 45 m. They are cut by every crossing carriageway and kept off footprints. |
| Cemetery headstones | Irregular rows inside the mapped cemetery outlines, because no grave survey exists. Not drawn on the Low tier. |
| Roof pitch and eaves | +7–12° over the base pitch (steeper roofs for snow at 900+ m) and 0.75 m eaves. |
| Roof material | Per-building hash: 42% painted sheet metal (standing seams), 46% clay tile, 12% concrete tile. Small outbuildings get sheet metal. |
| Facade finish | Two-storey or taller houses: 14% exposed brick and 8% grey block. These unfinished facades have visible floor slabs, as is common in the region. The rest are plastered in whites, creams and pastels. |
| Balconies | 58% of houses with 2+ storeys and a wall ≥ 7 m get one upper-floor balcony on the longest wall that is not the entrance side. Railings are white metal, dark metal or timber. |
| Outbuildings | ML footprints under 30 m² are drawn as timber barns or sheds with plank walls. |

Heights are unchanged and still follow rules v2: OSM height or levels, otherwise 1 storey (sheds, under 35 m²) or 2 storeys.
Nothing about a specific building's real roof, colour or balcony is known. The estimates describe typical houses in
Plav and northern Montenegro, and the same building always gets the same look (deterministic hash of its id).
