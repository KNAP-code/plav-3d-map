# Phase 2 water: uncertainty register

Status: Phase 2 **conditionally approved** by the project owner on 2026-11-21. The Phase 2 water is frozen at commit
18e5cfd (preview v22). This register lists every open point: what is known, what the model does, and what evidence
would settle it. Numbers come from `docs/water/audit.json`. Method and sources are in `docs/WATER.md`.

Each entry is marked with one of these labels:

- **VERIFIED**: two independent sources agree.
- **DATA**: one open dataset, not cross-checked.
- **ESTIMATE**: a modelling choice that no data supports.

## 1. Lake elevation (open, highest impact on absolute heights)

| | Value | Source |
| --- | --- | --- |
| Model water level | **904.5 m** | Copernicus DEM GLO-30, the flattened water value: 5th and 50th percentile inside the lake are both 904.5, and the 95th percentile is 906.15 near the shore |
| Published elevation | **907 m** | [plavto.me](https://www.plavto.me/turisticka-ponuda/plavsko-jezero) (Plav tourist organisation) |
| Ground 20 m outside the mapped shore | p5 904.85 · p50 907.24 · p95 911.18 m | GLO-30 |

- **Status: DATA, not reconciled.** The two values differ by 2.5 m, and the sources do not explain why. Possible
  causes:
  - Vertical datum: GLO-30 uses the EGM2008 geoid, while Montenegrin maps use the Trieste datum. That difference is
    normally under 1 m, so it cannot explain all of it.
  - DEM water editing: GLO-30 sets water bodies to one flat value.
  - Seasonal level: the published number may be a nominal or high-water value.
  - Rounding in the published figure.
- **Why 904.5 m is kept:** every height in the scene (terrain, city, Phase 1 mountains) comes from GLO-30. Raising
  the water to 907 m would flood the shore, whose 5th percentile is 904.85 m. In GLO-30 terms the relative heights
  are consistent. The absolute number is not confirmed.
- **The HUD shows "≈ 903 m n.v."** over the lake. That is the camera-target ground value, so it should not be read
  as the lake level.
- **What would settle it:**
  - A surveyed level from the Hydro-meteorological Institute of Montenegro (ZHMS), if Plav has a gauge.
  - Cadastral or topographic sheets that use the national datum.
  - A GNSS reading at the waterline.

## 2. Shoreline and shoreline vegetation (open)

- **Shoreline outline: DATA (OSM way 26631263), cross-checked.**
  - Area 1.974 km² against the published 2 km².
  - Sentinel-2 (10 m) shows no open water outside the outline beyond 1,600 m² of mixed pixels.
  - The OSM line has no survey date or accuracy tag. At 10 m resolution, edges inside the vegetation cannot be
    checked.
- **Open water vs vegetation: DATA (Sentinel-2 L2A, median of 21 Jul, 10 Aug and 21 Aug 2025).**
  - 1.215 km² is open water and 0.742 km² is vegetated.
  - The open-water edge lies a median 124 m (N), 138 m (E), 117 m (S) and 37 m (W) inside the mapped shore.
- **What the vegetation is: UNKNOWN.** NDVI cannot tell emergent reed or sedge from floating plants (water lilies),
  wet meadow, or floating peat mats. The model draws all of it as a reed / sedge canopy over water.
- **Height and density: ESTIMATE.**
  - Canopy 0.35–1.1 m above the water, with tufts up to about 2.5 m. These are stylised values.
  - Density follows NDVI, which shows the share of cover, not stem density.
  - The colour is 40 % the cell's own Sentinel-2 colour and 60 % the palette.
- **Season: snapshot only.** Spring high water, autumn die-back and winter ice (the lake freezes, per plavto.me) are
  not modelled. The vegetation belt may be much smaller in spring or in other years.
- **Cleared corridors along walkways: ESTIMATE.** The canopy is lowered within about 7 m of every mapped pier and
  footbridge so they stay visible. Whether such channels exist is unknown.
- **What would settle it:**
  - Dated ground photos of the east and south shores.
  - A Sentinel-2 series across seasons and years.
  - A habitat map from Prokletije National Park or the Agency for Nature and Environmental Protection (EPA
    Montenegro).

## 3. Raft (Splavovi) construction (open)

- **Position and shape: VERIFIED.**
  - OSM `man_made=pier`, way 153506366, name "Splavovi": 1,432 m², 160 m long, entirely over the lake.
  - On Sentinel-2 the deck is about 3× brighter than the water around it (0.236 vs 0.075 reflectance sum).
- **Use: DATA (one text source).** plavto.me: "Splav na jezeru je atraktivno kupalište, mjesto za vožnju pedalina,
  kajaka ili čamaca" ("the raft on the lake is an attractive bathing place, for pedal boats, kayaks or boats").
  The text speaks of one raft and gives no count.
- **Construction: UNKNOWN.** No source gives any of the following:
  - whether it floats on pontoons or stands on piles;
  - deck height, materials or railings;
  - any roofed huts;
  - whether it is still present today.
- **What the model does:** a plain timber deck 0.55 m above the water, in the mapped outline (ESTIMATE). There are
  no piles, floats, railings or roofs.
- **Second pier:** OSM way 149586743, 286 m², 83 m, on the south-east shore. Sentinel-2 is weakly consistent
  (0.228 vs 0.176) because it runs through vegetation. Drawn the same way, with construction unknown.
- **No other rafts, boats or platforms are drawn,** because none are mapped or documented.
- **What would settle it:** dated photos of the Splavovi from the shore or the water, or a description from the
  operator or the municipality.

## 4. Other open points

| # | Item | Status | Model | Would settle it |
| --- | --- | --- | --- | --- |
| 4.1 | Lake depth / bathymetry | no open source (plavto.me gives mean 3 m and max 9 m only) | bed carved 2 m under the surface, never visible | a published bathymetric survey |
| 4.2 | River widths | DATA (OSM river areas: Lim 27.9 m, Ljuča 22.5 m mean) | as mapped | aerial imagery finer than 10 m |
| 4.3 | River water surfaces | DATA-derived (GLO-30, 15th percentile in 12 m, isotonic fit); the DEM cannot see the water surface under trees | Lim 904.5 → 805.9 m, Ljuča 916.2 → 904.5 m | gauge levels or a lidar DEM |
| 4.4 | Deep cuts | 21 cells of the 30 m level are cut more than 5 m, where GLO-30 likely reads trees or bridge decks over a narrow river | kept | lidar DEM |
| 4.5 | Bridges | positions DATA (OSM spans); structure, piers and parapets unknown | generic decks | photos or survey |
| 4.6 | Pier walkways and footbridges | positions DATA; width and railings ESTIMATE (2.2 m timber) | generic | photos |
| 4.7 | Culverts | only OSM `layer=-1` stretches are hidden (14, 247 m) | unmapped culverts still drawn as open water | field check or OSM edits |
| 4.8 | Intermittent streams | OSM tag; drawn 40 % narrower and always wet | ESTIMATE | seasonal data |
| 4.9 | Beyond ±9 km | lower Lim and Gusinje springs coloured from WorldCover only | — | extend the area |
| 4.10 | Look | at low camera angles the lake reads paler than before, because it reflects the hazy sky as well as the mountains | style choice, adjustable | owner's preference |

## Not changed after the conditional approval

No geometry, data or rendering changes were made after commit 18e5cfd. This register is documentation only.
