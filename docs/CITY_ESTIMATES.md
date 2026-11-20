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

## Gardens (batch 4, `pipeline/gardens.py` → `gardens.json`, all estimates)

| Estimate | Rule |
|---|---|
| 2,732 yard lawns | Each house's Voronoi cell among all footprints, at most 12 m from the house, minus streets, paths, water and other footprints. Drawn as a mown-lawn tint. |
| 1,789 fences (36 km) | 75% of yards get a timber picket fence (60%) or a wire fence (40%) along the yard edge that is within 2.5 m of a street. |
| 288 vegetable plots | 35% of yards over 250 m²: a 4 × 7 m plot of soil and crop rows on the side away from the street, only where it fits. |
| 3,017 fruit trees | 0–3 small trees per yard, ≥ 3 m from the house, never within 3 m of a WorldCover tree. |
| 1,151 haystacks | On mapped meadows and farmland (OSM, 9.0 km²) within 350 m of a house, about one candidate per 0.6 ha, sometimes in small groups. |

Fences and haystacks are not drawn on the Low tier.
