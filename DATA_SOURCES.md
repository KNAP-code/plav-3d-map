# Data sources, licences and estimates

PLAV 3D uses only openly licensed data. Nothing is scraped and no cadastral data is used.

| Data | Source | Licence | Used for |
|---|---|---|---|
| Building footprints (hand-mapped) | OpenStreetMap, via Overture Maps release pinned in `pipeline/areas.json` | ODbL 1.0 | footprints, names, building class |
| Building footprints (machine-traced) | Microsoft Global ML Building Footprints, via Overture Maps | ODbL 1.0 (as distributed by Overture) | footprints where OSM has none |
| Roads, water, land use, minarets | OpenStreetMap via Overture Maps | ODbL 1.0 | streets, lake, rivers, pitches, cemeteries |
| Terrain | Copernicus DEM GLO-30 (AWS open data `copernicus-dem-30m`) | Copernicus DEM licence, free with attribution | city terrain, lake level, surrounding mountains to ±38.9 km (`pipeline/terrain.py`, see `docs/TERRAIN.md`) |
| Terrain check only | NASA SRTM 1″ (AWS terrain tiles `elevation-tiles-prod/skadi`) | public domain (USGS/NASA) | independent cross-check of GLO-30; not drawn |
| Summit names and heights (check only) | OpenStreetMap `natural=peak` + `ele` via Overture `base/land` | ODbL 1.0 | validation table and panorama labels; not drawn in the app |
| Tree cover | ESA WorldCover 10 m 2021 v200 (AWS open data `esa-worldcover`) | CC BY 4.0 | tree positions, ground colour |

Required attribution (shown in the app's info panel):

- © OpenStreetMap contributors (ODbL)
- Microsoft Global ML Building Footprints via Overture Maps (ODbL)
- Overture Maps Foundation
- ESA WorldCover 10 m 2021 v200 (CC BY 4.0)
- Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA

The baked files in `public/data/` are a derived database of OpenStreetMap and are therefore also ODbL.

## What is real and what is estimated

Every baked building carries flags (`hSrc`, `roofSrc`) so estimates stay distinguishable from data.

| Item | Real or estimated | Rule (estimate-rules-v1, `pipeline/build.py`) |
|---|---|---|
| Building position and footprint | **Real** (OSM or Microsoft ML) | simplified by 0.2 m; footprints under 8 m² dropped |
| Building height | **Estimated** unless OSM has `height` or `building:levels` (7 of 2,084 in the prototype area) | floors from footprint area: < 35 m² → 1; 35–80 m² → 1–2; 80–220 m² → 2–3; 220–500 m² → 3–4; > 500 m² → 2–3; 2.9 m per floor + 0.6 m; deterministic per building id |
| Roof shape | **Estimated** for every building (OSM has no roof data here) | hip by default; gable for long footprints (aspect ≥ 1.6, 60%); flat for garages/industrial, footprints > 1,500 m² or very irregular shapes. Pitch and overhang come from the style config |
| Wall and roof colours, windows | **Stylised** | palette in `src/style/presets.ts`; window grid derived from floor count |
| Trees | **Positions from data, appearance stylised** | one tree per ESA WorldCover tree-cover pixel (10 m), plus a second one at 45%, jittered inside the pixel; none on buildings, roads or water; conifer share rises with elevation (stylised) |
| Lake level | **Real** (from the DEM) | 20th percentile of DEM values inside the OSM lake polygon |
| Road widths | **Estimated** | by OSM road class |
| Minaret height | **Estimated** | 24 m for every OSM `tower:type=minaret` |

## Known limitations

- 74% of buildings in the prototype area are machine-traced outlines, which can be offset by a few metres or merge neighbouring houses.
- The Copernicus DEM is a 30 m surface model (it includes tree canopy and buildings). It is smoothed and only gives the broad shape of the valley.
- Narrow summits are lower in a 30 m DEM than their surveyed heights (Visitor 2,211 m → 2,162 m in GLO-30, Zla Kolata 2,535 → 2,488 m). The terrain shows the DEM values unchanged; see `docs/TERRAIN.md`.
- Gardens and street trees are mostly classed as "built-up" by WorldCover, so the town has fewer trees than in reality. No trees are invented.
- Geofabrik and the OSM API were not reachable from the build environment, so OSM data comes from the Overture Maps copy (release pinned in `pipeline/areas.json`).

## Phase 3 verification evidence (used only to check geometry, never drawn or copied into the map)

| Source | Use | Licence / attribution |
|---|---|---|
| Satellogic EarthView, 1 m RGB+NIR, pass 2022-08-31 (s3://satellogic-earthview) | roof presence and relative position per building, road lines, public spaces (`pipeline/verify_city.py`) | CC BY 4.0, © Satellogic |
| Microsoft Global ML Building Footprints, raw, via VIDA (source.coop `vida/google-microsoft-open-buildings`) | outline-by-outline comparison with OSM | ODbL |
| Meta / WRI DINOv3 Global Canopy Height Map v2 (source.coop `tge-labs/meta-chm-v2`) | tree canopy over footprints | CC BY 4.0, Meta Data for Good, Tolan et al. 2024 |
| GlobalBuildingAtlas LoD1 (source.coop `tge-labs/globalbuildingatlas-lod1`, Zhu et al. 2025, doi 10.14459/2025mp1782307) | list of Microsoft 2024 footprints missing from the map (nothing added) | comparison only |

Results: `docs/CITY_GEOMETRY.md`, `public/data/plav-town/verify.json`, map view `#verify`.
