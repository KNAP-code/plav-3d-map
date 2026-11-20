# Phase 1 — Authentic terrain and mountains

Plav sits on a valley floor at about 905–960 m. Prokletije rises to 2,500–2,700 m within 10–20 km on three sides.
Until this phase, the map drew an 18 × 18 km ring of 60 m terrain behind the 4 × 4 km town. That ring was faded by
haze, and it cut through the middle of the ranges that form Plav's skyline. This phase replaces it with real terrain
out to the skylines you can see from the valley. The city itself is unchanged.

Everything below is reproducible:

```
cd pipeline
python terrain.py fetch          # GLO-30, SRTM, WorldCover, OSM summits -> cache/terrain/   (~40 s, AWS open data)
python terrain_viewshed.py       # visibility analysis that decides the extent
python terrain.py build          # public/data/plav-town/terrain/   (~10 s)
python terrain_validate.py       # docs/terrain/validation.json
python terrain_maps.py           # docs/terrain/*.png   (needs matplotlib)
```

## 1. Elevation data: what exists and what we used

| Dataset | Resolution here | Model / epoch | Vertical datum | Stated accuracy | Licence | Reachable from the build | Verdict |
|---|---|---|---|---|---|---|---|
| **Copernicus DEM GLO-30** (DGED, AWS `copernicus-dem-30m`) | 1″ ≈ 30.9 m N–S × 22.7 m E–W | Surface model (canopy, buildings), TanDEM-X 2011–2015 | EGM2008 | < 4 m absolute (LE90, spec) | Free worldwide incl. commercial, with attribution | yes | **Used**: the best open global DEM, already the source of the city terrain |
| NASA SRTM GL1 (AWS terrain tiles `skadi`) | 1″ | C-band radar surface model, Feb 2000; steep voids filled | EGM96 | 16 m (LE90, spec) | Public domain | yes | **Used only as an independent check** |
| OpenTopography | — | hosts COP30, SRTM, NASADEM, ALOS AW3D30 | — | — | per dataset; API key | **no** (blocked) | Distributor, nothing new for Montenegro |
| ALOS AW3D30 (JAXA) | 1″ | Optical stereo surface model, 2006–2011 | EGM96 | ~5 m (stated) | Free with attribution | not tested (only via OpenTopography/JAXA, blocked) | Could serve as a third check later |
| FABDEM (bare-earth GLO-30) | 1″ | GLO-30 with trees and buildings removed by ML | EGM2008 | — | **CC BY-NC-SA 4.0 (non-commercial)** | not tested | Not used because of the licence |
| EU-DEM v1.1 | 25 m | SRTM/ASTER hybrid | EVRS | ~7 m RMSE (stated) | Copernicus Land, free | not tested | Superseded by GLO-30 |
| Montenegro official (Uprava za katastar i državnu imovinu, geoportal.co.me) | — | — | national (Trieste) | — | cadastre/geoportal data has no open licence (finding from earlier phases) | **no** (geoportal blocked) | **No openly licensed national DEM or LiDAR download was found.** Higher-resolution data may be available from the Real Estate Administration on request |

Measured agreement between the two reachable sources (300 m sample grid over ±18 km, 14,641 points, SRTM minus GLO-30):
median −1.9 m, MAD 6.0 m, 95% within 21.8 m. In forest GLO-30 sits 3.8 m higher (median), as expected for an X-band
surface model over canopy. In open ground the median is +0.6 m.

## 2. Coverage from visibility, not a radius

`pipeline/terrain_viewshed.py` sweeps 1,440 rays (every 0.25°) to 65 km from five real places in the valley, with the eye at 1.7 m:
the čaršija (Redžepagića kula), the north and south ends of the lake shore, the Lim valley north of the town, and a
slope NE of the town at about 1,180 m. It uses Earth curvature and standard refraction (k = 0.13). It records the
skyline point for each azimuth. A sixth observer, 1,000 m above the čaršija, represents the oblique map camera.

| Observer | Skyline distance, median | 95th pct | max |
|---|---|---|---|
| čaršija | 4.7 km | 15.3 km | 19.7 km |
| lake north shore | 4.0 km | 12.9 km | 20.0 km |
| lake south end | 4.2 km | 13.3 km | 17.3 km |
| Lim valley north | 0.8 km | 5.2 km | 10.9 km |
| slope NE of town (1,180 m) | 3.8 km | 18.6 km | 36.6 km (north up the Lim valley) |
| aerial, 1,000 m above čaršija | 13.6 km | 38.8 km | 65 km |

Extent rule (`choose_l3_half`): the extent must hold every ground skyline plus 3 km and the aerial camera's 95th-percentile
skyline. That gives **±38.9 km**. Mountains beyond it are hidden behind nearer ridges from the valley and fade into the
horizon haze from the air. See `docs/terrain/coverage-map.png`, where the black dots are the real skyline points.

## 3. Reconstruction

* **Projection.** This is the city's own frame: UTM 34N (EPSG:32634) minus the scene origin `[413245, 4716717]`, unchanged.
  Grid convergence at Plav is −0.716°: the scene's "north" is grid north, so true bearings are 0.72° smaller than scene bearings.
  The scale factor is 0.99969, so distances are 0.03% short, about 3 m per 10 km. Measured peak distances agree to ≤ 10 m (table below).
* **Vertical datum.** GLO-30 heights are orthometric above EGM2008 and are used unchanged, with **no datum conversion**. Montenegrin
  maps use the Trieste levelling datum. Its offset from EGM2008 is not published openly for Plav, and it is expected to be well under
  the DEM's own error (sub-metre to about 1 m). OSM summit heights mostly come from such maps.
* **Curvature.** In the far levels each vertex is lowered by d²/(2·R_eff) from the scene origin (R_eff = R/(1−0.13)), so the
  ridges stand where an eye in Plav sees them: 4.9 m at 6 km, 44 m at 18 km, 206 m at the corner of the 39 km extent.
  The 8 m city grid has no drop applied (≤ 0.5 m at its corners). The validation reports heights with the drop added back.
* **Nested, chunked levels** (a baked geometry clipmap centred on the town, because the camera is kept over the town):

| Level | Grid | Extent | Vertices | Chunks | Source sampling |
|---|---|---|---|---|---|
| core | 8 m | 4.0 × 4.0 km | 252k | 16 tiles | **unchanged** city terrain |
| L1 | 30 m | ±6.0 km | 161k | 16 | cubic, σ 0.8 px: the same resampling as the core, so they agree at the join |
| L2 | 60 m | ±18.0 km | 361k (320k outside L1) | 24 | bilinear, light anti-alias filter, summit-preserving |
| L3 | 180 m | ±38.9 km | 187k (150k outside L2) | 24 | same |

  *Summit preserving* means that a vertex whose ±½-cell window holds a local summit takes that summit's real 30 m DEM
  height. Without this rule, a coarse grid shaves 20–50 m off sharp peaks. With it, rendered summits are within −1.1 m
  (median, L2) and −1.9 m (L3) of the GLO-30 summit.
* **No cracks.** Each finer level's outer ring of vertices takes the next coarser level's surface, measured ≤ 0.07 m apart.
  Each chunk carries its own skirt for every LOD stride. L1 vertices inside the city core copy the core's heights,
  0.25 m lower. L1 vertices just outside are capped so their triangles never rise over the core's border.
* **Water.** The lakes and rivers mapped within ±9 km (Plavsko jezero, Malo blato, Visitorsko jezero, the small glacial lakes)
  are carved exactly as before: lakes sit 2 m under their flat level with a 25 m bank. Farther lakes are coloured from WorldCover.
* **Nothing invented.** No noise displaces the terrain anywhere. Every height comes from GLO-30.

### Viewer (`src/geo/terrainLevels.ts`, `FarTerrain` in `src/scene/World.tsx`)

* 64 chunk meshes. three.js culls them by the view frustum.
* Per-chunk LOD: each frame picks a stride of 1, 2 or 4 so that one coarse cell stays under a set angle. The angle is
  0.005 rad on High, 0.011 on Medium and 0.02 on Low. Geometry for a stride is built the first time it is needed, then cached.
* Normals come from the level's own heightfield, using central differences that reach into the coarser level at borders,
  so there is no shading seam at chunk edges.
* The core terrain no longer averages its skirt into its border normals. That removed a dark line along the core edge.
* A band of 3D trees (18,419 trees) continues 300 m past the core, thinning to none. It uses the same WorldCover rule as
  the city trees, so the forest does not stop at a straight line.
* The camera may now go out to 10 km (was 6.4 km) and tilt to 78° (was 72°), so the mountains can be framed. It is kept
  at least 25 m above the terrain, because Visitor's slopes rise right at the town's edge.

## 4. Look (`farTerrainMaterial`)

The colour comes from data first. ESA WorldCover 10 m classes, baked per level, give forest, meadow, bare rock and
water. On top of that:

* the valley floor uses the city core's own grass palette and mottling, so there is no colour seam;
* meadows above about 1,600 m (true elevation) shift to a paler, drier alpine grassland;
* forest is drawn as canopy, in the same tone the city's 3D trees give from a distance: broadleaf low, darker conifer/mixed above about 1,300 m;
* bare/sparse ground and steep open slopes (more than about 35°) above about 1,200 m show pale limestone and scree, the Prokletije rock colour;
* aerial perspective: near the town the scene's own haze is used, so buildings and terrain match. With distance it is
  capped by a slow exponential (10% + 62%·(1 − e^(−d/22 km))), so ridges 10–40 km away stay readable as soft
  silhouettes. The last 15% of the extent fades into the horizon colour;
* a sky dome runs from the haze colour at the horizon to a deeper tone at the zenith, and follows day, sunset and night.

No snow is drawn. WorldCover 2021 has almost no snow/ice pixels here (2 of 361k on L2), and the season is not
specified. This is a style choice for later.

## 5. Validation (`docs/terrain/validation.json`)

### Mountain heights, distances and bearings (18 key summits)

OSM `ele` comes mostly from topographic maps. GLO-30 and SRTM give the highest DEM value within 120 m of the OSM point.
Mesh is the highest rendered value within 200 m, with the curvature drop added back. Distance and bearing are measured
from Redžepagića kula: geodesic (true) / in the scene (grid).

| Summit | OSM ele | GLO-30 | SRTM | Mesh | Level | Dist. km true / scene | Bearing true / grid |
|---|---|---|---|---|---|---|---|
| Visitor (Bandera, Krivi smet) | 2211 | 2162 | 2190 | 2160 | L1 | 5.15 / 5.15 | 288.1° / 288.9° |
| Hridski krš | 2358 | 2348 | 2350 | 2348 | L2 | 8.72 / 8.71 | 110.2° / 110.9° |
| Krš Bogićevica (Hridski) | 2374 | 2353 | 2329 | 2346 | L2 | 9.13 / 9.13 | 106.5° / 107.2° |
| Maja e Ropës | 2502 | 2496 | 2486 | 2493 | L2 | 13.50 / 13.50 | 100.0° / 100.7° |
| Starac | 2352 | 2345 | 2340 | 2345 | L2 | 8.91 / 8.90 | 66.6° / 67.3° |
| Bandera od Starca (Crni krš) | 2426 | 2417 | 2406 | 2416 | L2 | 9.64 / 9.64 | 66.7° / 67.4° |
| Maja e Rosit / Rosni vrh | 2523 | 2485 | 2488 | 2482 | L2 | 15.11 / 15.10 | 211.3° / 212.0° |
| Dobra Kolata | 2525 | 2460 | 2462 | 2459 | L2 | 12.46 / 12.45 | 197.7° / 198.4° |
| Zla Kolata | 2535 | 2488 | 2492 | 2485 | L2 | 12.97 / 12.97 | 198.4° / 199.2° |
| Maja Kollatës | 2552 | 2542 | 2539 | 2540 | L2 | 12.84 / 12.84 | 193.6° / 194.3° |
| Maja e Jezercës | 2694 | 2676 | 2678 | 2674 | L2 | 20.27 / 20.27 | 212.7° / 213.4° |
| Gjeravicë | 2656 | 2646 | 2630 | 2644 | L2 | 17.43 / 17.43 | 113.5° / 114.2° |
| Kom Kučki | 2487 | 2440 | 2437 | 2439 | L3 | 26.68 / 26.67 | 290.8° / 291.5° |
| Kom Vasojevićki | 2461 | 2438 | 2444 | 2438 | L3 | 25.03 / 25.02 | 294.3° / 295.0° |
| Hajla | 2403 | 2395 | 2386 | 2390 | L2 | 23.92 / 23.92 | 41.2° / 42.0° |
| Karanfil Ljuljaševića | 2224 | 2208 | 2212 | 2206 | L2 | 15.55 / 15.54 | 229.5° / 230.2° |
| Maja e Qenit / Pasji vrh | 2405 | 2399 | 2396 | 2398 | L2 | 10.83 / 10.83 | 88.5° / 89.2° |
| Bogiçevica | 2204 | 2198 | 2194 | 2197 | L2 | 11.77 / 11.76 | 104.9° / 105.6° |

Across all 1,043 named OSM summits inside the extent, GLO-30 minus OSM has a median of −3.2 m, with 90% within 36 m.
SRTM minus OSM has a median of −8.4 m. **The rendered mesh reproduces GLO-30**: median +0.2 m on L1, −1.1 m on L2 and
−1.9 m on L3. In the worst 10% it is −2 m, −3 m and −12.5 m.

**Known and not corrected:** narrow, sharp summits are 40–65 m lower in *both* 30 m DEMs than their surveyed heights.
Examples are Visitor (−49 m), the Kolata peaks (−47 to −65 m), Rosni vrh (−38 m) and Kom Kučki (−47 m). A 30 m pixel
averages a summit with its slopes. The map shows the DEM values. It does not raise peaks to the published heights,
because that would be an edit that is not in the elevation data.

### Skyline from the valley

The viewpoint is the east shore of Plavsko jezero (42.59335 N, 19.93401 E), with the eye at 1.7 m. The test compares the elevation
angle every 0.5° of azimuth from the full 30 m DEM, with curvature and refraction, against the rendered terrain as baked:
**mean |Δ| 0.08°, 95% within 0.32°, max 0.51°**. The largest differences are on a hill 0.6 km away inside the
unchanged city core, whose 8 m grid is a slightly smoothed resampling (about 3 m). See `docs/terrain/skyline-profile.png`.
The ground-level panorama overlays the DEM skyline and the summit markers on the actual render.

### Orientation, valley shape, seams, city alignment

* All 18 summits sit at the correct bearing, within the 0.72° grid convergence, and the correct distance (≤ 10 m).
* The valley floor, the lake and the Lim are the city's existing data. Visitor rises WNW of the lake, the Prokletije wall
  lies S–SE, Bogićevica and Hridski krš lie ESE, Starac lies ENE, and the Komovi lie on the WNW horizon at 25–27 km.
  This matches the hillshade (`docs/terrain/elevation-map.png`).
* Level seams: L1–L2 0.05 m and L2–L3 0.07 m by construction. At the core border, L1 minus core is −0.7 m (median) and
  at most 2.7 m above the core (99% ≤ 0.75 m). The core's 25 m skirt covers the joins.
* City: `terrain_core.bin`, `buildings.json`, `vectors.json`, `streets.json` and `trees.bin` are byte-identical to the
  previous commit (checked by hash). Buildings, roads and landmarks did not move, so nothing new floats or is buried.

### Photographs

The reachable photo sites (plavto.me brochures and galleries) had no photo with a known standpoint and direction, so
there is **no photographic comparison** in this phase. The terrain must not be called photographically accurate. The
DEM-skyline overlay is the strongest check available. A few of your own photos with known standpoints, for example
from the lake promenade towards Visitor or from the čaršija towards Prokletije, would allow a direct check.

## 6. Performance

See `docs/PERFORMANCE.md`, section "Phase 1 terrain".
