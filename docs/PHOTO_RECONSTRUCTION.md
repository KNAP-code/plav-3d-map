# Photo batch 1: buildings reconstructed from reference photographs

Pipeline: `python pipeline/photo_recon.py plav-town /mnt/project-files/plav-3d/photos` → `public/data/plav-town/photo.json`.
The photos stay in the project files and are not committed. In the app, tap a building (or open `#recon`) to see each value and where it comes from.

## Photo p01: aerial view west along Čaršija / Racina towards the lake

**Camera:** solved by least squares from the Sultanija minaret tip (41.5 m, adrialine.me), the Opština and Stara džamija roofs and the summit direction, then refined with four nearer roofs.
Result: x 218.7, y -145.4, 35.5 m above the street, heading 280°, tilt -10.4°, vertical field of view 65.8°. Residuals are about 5 px on a 1000 px photo.

**Matching:** each footprint is projected into the photo at roof height. A building is assigned only where its outline lands on one building and nowhere else.

### Reconstructed by hand (13 buildings, 14 after splitting one outline)

| building | storeys | roof | roof colour | facade | other | notes |
|---|---|---|---|---|---|---|
| Opština Plav (`93bc9e4b`) | 4 (E) | hip (V) · red sheet metal | #bb6f6c | #d3d1cf |  | 3 window rows above a ground floor hidden by the buildings in front; OSM says 3 levels red sheet hip roof with a cross wing towards the street  |
| Pošta Plav (`4674a8c3`) | 2 (E) | hip (V) · red sheet metal | #b6776d | #d5d1cd |  |  red sheet roof, hipped with several facets  |
| grey house on the street (north part of OSM outline 2923) (`2923140d#far`) | 4 (E) | gable (V) · dark grey sheet / slate | #635344 | #998d8c |  | attic row plus 3 window rows; lowest floor hidden by the house in front dark grey roof, gable end with attic windows facing the street OSM outline covers two buildings seen in photo p01; split at the middle of its long axis (split position ESTIMATED) |
| old ochre house with shop awning (south part of OSM outline 2923) (`2923140d#near`) | 2 (E) | hip (E) · clay tile | #9d5449 | #947049 |  |  clay tile roof, hipped with a gable OSM outline covers two buildings seen in photo p01; split at the middle of its long axis (split position ESTIMATED) |
| long building with green sheet roof (east side of the street) (`c8f1ba86`) | –  | gable (V), ~48° · green-grey sheet metal | #696861 | – |  |  steep green-grey sheet gable roof with roof windows and cut-in balconies along the street  |
| white block with flat roof and stacked balconies (`bc5f0b13`) | 4 (V) | flat (V) · flat membrane | #f7f7f1 | #d3d0cf | balconies (V) | 4 window rows visible on the south-east face flat roof with light membrane and roof plant  |
| grey annex between the Opština and the white block (`ebd9fb74`) | 3 (E) | flat (V) ·  | – | #d4d1ce |  |  flat roof terrace  |
| Osnovni sud (`67d9b26d`) | 2 (E) | hip (V) · red tile or sheet | #6c3632 | #d5d3cd |  |    |
| house with orange tile roof behind the court (`d06b09eb`) | –  | hip (V) · clay tile (orange) | #c68966 | – |  |    |
| house with orange tile roof west of Sultanija (`37e24e79`) | –  | hip (V) · clay tile (orange) | #b77758 | – |  |    |
| pink house (south of the street, near the camera) (`628a8bbc`) | 2 (E) | hip (V) · clay tile | #734438 | #b99386 |  |    |
| house with dark brown roof west of Stara džamija (`cce20748`) | –  | hip (E) · dark brown sheet or tile | #321f18 | – |  |    |
| small garage with red door (`24171ec7`) | 1 (V) | gable (V) · red sheet | #60352d | #d4d1ce |  |    |

### Roof colour only, by automatic projection (33 buildings)

For these buildings the roof is projected with the solved camera and the parts hidden behind nearer buildings are removed. The roof colour is the median of what is left.
It is rejected when the visible area is small, when the colours are mixed, or when the pixels are green (trees). It is VERIFIED when at least 300 px are visible within 200 m, otherwise ESTIMATED.
Storeys, roof shape and facade colour stay as they were for these buildings.

`718d5153` #90837f (E), `51a7f34a` #514535 (V), `4bfa6782` #67312a (V), `7af6419e` #af765b (E), `7ab32b00` #b16f6d (V), `ce2b2ba6` #35301f (V), `f958e19e` #856f61 (V), `25ff0dbc` #94654a (V), `a696ee0a` #5f3b31 (V), `bc8a29f6` #9f6856 (V), `7a4a059f` #292319 (V), `3c1bea44` #504a3e (E), `118a8520` #6c5e56 (V), `7c6fac13` #393536 (E), `91bb823c` #572f2a (E), `a321ab12` #814a3a (E), `943e8e47` #6a3330 (V), `26477621` #64544d (E), `e0fe8cdf` #492d27 (E), `6cf923d5` #b37b61 (E), `d65be83f` #513c35 (E), `78c2aa2d` #726363 (E), `48868f05` #5e4f4c (E), `5a109102` #54362f (E), `6ba88c3e` #79493d (V), `f6c6a5d6` #6c5038 (E), `138757a7` #877b7a (E), `90599a43` #52302b (E), `01acea43` #3f2416 (E), `76819fee` #988c83 (E), `f5acd19a` #5c4d4c (E), `a986e7ba` #bda184 (E), `2d56678a` #796b6f (E)

## What changed elsewhere

* **Satellite roof colours downgraded.** 10 buildings appear in both the photo and the satellite image. The satellite colour family matched for only about half of them; for example, a white flat roof read as grey-olive. All satellite roof colours are now ESTIMATED (0 VERIFIED, previously 412).
* **Sultanija minaret.** It already has its sourced height of 41.5 m in the landmark model. The photo's camera fit confirms that height.

## Remaining inaccuracies and missing information

* **Storeys.** Where a ground floor is hidden behind another building, the storey count is ESTIMATED. Examples: Opština (4 in the photo, 3 in OSM), the grey house and the Pošta.
* **Split outline.** OSM outline 2923 covers two different houses. It is split at the middle of its long axis; the real dividing wall is not visible.
* **Long building with the green-grey roof.** Its walls are not visible, so its storey count is still the placeholder.
* **Window and door layouts** are still generic: the photo is 1000 px wide, which is too small to place windows reliably.
* **Farther streets.** Beyond about 260 m, and all streets not seen in p01, are unchanged.
* **Sultanija and Stara džamija** are hand-built landmark models and were not changed here.

## Performance (SwiftShader, high tier, relative only)

p50 1080 ms vs 1028 ms before (within run-to-run noise on the software renderer), 68 draw calls (unchanged), 1.19 M triangles (1.22 M before). No new meshes or textures.
