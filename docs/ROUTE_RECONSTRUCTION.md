# Centre route: Plato, Caffe TIMM, the schools and the stadium (batch 1)

Am's brief of 2026-11-21: reconstruct the real street that connects the Plato, Caffe TIMM, the secondary school, the
primary school and the stadium, with an eye-level walk. Pipeline: `python pipeline/reconstruct.py plav-town` then
`python pipeline/route_recon.py plav-town` → `public/data/plav-town/route.json`. In the app: the button
"Šetnja centrom" (or `#walk`, or `?walk=<metres>` for a fixed position).

## Where the five places are

| place | position (local m) | source | position | identity |
|---|---|---|---|---|
| Caffe & Restoran Timm | -174, -14 (Racina, north side) | Overture place, confidence 0.94 | ESTIMATED | ESTIMATED: the point lies 3 m from building 0a7635b8 and 6 m from 43747d8b |
| Plato (candidate 1) | paved area -305..-157, -70..43 | OSM way 1198743606: highway=pedestrian, area, paving_stones | VERIFIED | ESTIMATED: a paved square beside both schools and 20 m from TIMM |
| Plato (candidate 2) | Gradski trg, fountain at 0, -70 | Overture fountain, footways, tourist office | VERIFIED | ESTIMATED: the town's events are announced on the "Gradski trg" (plavto.me) |
| Srednja škola Bećo Bašić | -217, -76 | Overture place + OSM school building 98460503 | VERIFIED | VERIFIED |
| OŠ Hajro Šahmanović | -279, -24 | OSM building "Hajro Sahmanovic" (school) + Overture | VERIFIED | VERIFIED |
| Stadion Pod Racinom | pitch centre -186, 88, 97 × 65 m | OSM stadium "Stadion Racina" + pitch; Overture | VERIFIED | VERIFIED |

The connecting street is Racina (OSM tertiary): it runs along the north edge of the paved area and the school grounds,
passes TIMM at the junction with the service road (-159, -33), and the service road leads north to the stadium.

## What changed in batch 1

1. **Roof colours (all 843 pilot buildings).** Compared with Am's photo p01, the 1 m satellite colours were too blue:
   clay roofs read mauve or purple (hue 280-340°), five roofs on the route read as "blue sheet". Two corrections:
   * local white balance on asphalt (Gaussian window 80 m) instead of one balance for the whole scene;
   * a satellite → photo white balance (linear R × 1.485, B × 0.733), fitted on the 43 roofs measured in both.
     Leave-one-out test: colour family agrees for 29 of 43 roofs instead of 22, hue error on clearly coloured roofs
     7° instead of 18°. Satellite roof colours stay ESTIMATED.
2. **The paved area.** Its surface colour is measured in the 1 m image (#8b8780, median of the pixels without
   vegetation, asphalt white balance; ESTIMATED). It was drawn as a uniform light-grey placeholder.
3. **Trees on the route.** WorldCover (10 m) missed the single trees, so the paved area was bare. Six crowns are now
   measured in the 1 m image (NDVI > 0.33 and darker than the stadium lawn), one tree per crown, sized from the crown
   radius. Position VERIFIED to about 2 m, size ESTIMATED, species UNKNOWN.
4. **Eye-level walk.** 237 m from the west end of the paved area along Racina (south pavement, eye 1.65 m, 1.4 m/s or
   4×), past both schools and TIMM, then up the service road; the last 20 m turn towards the pitch. Stops for each
   landmark show how sure the identification is. The way into the stadium grounds is not mapped, so the walk ends on
   the service road beside it.
5. **Labels.** The inspector names the school buildings and marks the TIMM candidate as an estimated identity.

No outline, height or roof shape was changed: nothing reachable shows them for these buildings (below).

## Reference imagery: what could and could not be used

* **Google Maps / Earth / Street View.** www.google.com and earth.google.com are refused by this environment's
  network proxy. The Street View API answers `REQUEST_DENIED: You must use an API key`. There is no key, and Google's
  terms do not allow building 3D models from its imagery, so nothing from Google was used.
* **Mapillary, Panoramax, Wikimedia Commons.** Refused by the network proxy.
* **Am's photo p01.** The route is 400-500 m from that camera, about 1.2 px per metre, and the grey block at the far end
  of the main street hides TIMM and the paved area (`/mnt/project-files/plav-3d/route-batch1/photo1-route-at-400m.jpg`).
  It cannot show storeys or facades here.
* **plavto.me.** The event pages name the "Gradski trg" but carry only posters, no photos of the street.
* **Satellogic 1 m (2022-08-31).** Usable for roof colour, the paved area and tree crowns.

## Confidence per building (27 buildings within 35 m of the walk, plus the named schools)

V = VERIFIED, E = ESTIMATED, U = UNKNOWN. Facades, storeys and roof shapes are UNKNOWN everywhere on the route: they
are drawn as the neutral placeholders of docs/RECONSTRUCTION.md (plaster walls, 2 storeys, hip roof), not invented.

| along walk (m) | id | building | size (m) | outline | roof colour | covering (E) | storeys | roof shape | facade |
|---|---|---|---|---|---|---|---|---|---|
| 12 | 0ff3d1cb |  | 13.1 × 12.5 | V | #63555b E | grey sheet / concrete | 2 U | hip U | U |
| 37 | 081fe2e0 |  | 20.6 × 19.1 | V | #7b5e58 E | clay tile (terracotta) | 2 U | hip U | U |
| 39 | 6aa65c9f | OŠ Hajro Šahmanović | 69.1 × 19.6 | E | #8f6959 E | clay tile (terracotta) | 2 U | gable U | U |
| 61 | 8d72c7d9 |  | 22.1 × 18.2 | V | #6c4f4f E | clay tile (terracotta) | 2 U | hip U | U |
| 62 | 808847eb | Hala sportova | 54.4 × 29.9 | V | #4b5d98 E | painted sheet (blue) | 2 U | flat U | U |
| 79 | e51e2ffe |  | 5.9 × 5.7 | E | #8d7164 E | clay tile (terracotta) | 1 U | hip U | U |
| 90 | eb554fd2 |  | 15.7 × 13.4 | V | #a25c4e E | clay tile (terracotta) | 2 U | hip U | U |
| 109 | 43747d8b |  | 19.4 × 14.5 | E | #a25e50 E | clay tile (terracotta) | 2 U | hip U | U |
| 122 | 98460503 | Srednja škola Bećo Bašić | 46.9 × 45.0 | V | #8b5659 E | clay tile (terracotta) | 2 U | flat U | U |
| 142 | 2da46f29 |  | 23.8 × 7.2 | V | #7d5b5b E | clay tile (terracotta) | 2 U | gable U | U |
| 142 | 479bf77d |  | 11.5 × 9.1 | V | #a05c4e E | clay tile (terracotta) | 2 U | hip U | U |
| 143 | 155fa3fd |  | 20.5 × 11.0 | V | #c05c4a E | clay tile (terracotta) | 2 U | gable U | U |
| 156 | 0d170537 |  | 7.7 × 7.3 | E | #927a66 E | clay tile (terracotta) | 2 U | hip U | U |
| 159 | 46c0b305 |  | 12.5 × 10.3 | E | #8f5d5c E | clay tile (terracotta) | 2 U | hip U | U |
| 162 | 32e26d81 |  | 19.6 × 10.8 | E | #7d605b E | clay tile (terracotta) | 2 U | gable U | U |
| 163 | 0a7635b8 | Caffe & Restoran Timm (identity ESTIMATED) | 13.6 × 13.1 | E | #99625c E | clay tile (terracotta) | 2 U | hip U | U |
| 167 | 1faa2780 |  | 13.0 × 8.0 | V | #655a5c E | grey sheet / concrete | 2 U | hip U | U |
| 182 | 2f98f8dd |  | 17.8 × 9.8 | V | #70635a E | grey sheet / concrete | 2 U | gable U | U |
| 182 | 62561249 |  | 10.5 × 9.9 | V | #775753 E | clay tile (terracotta) | 2 U | hip U | U |
| 193 | ba5b3f78 |  | 20.4 × 16.9 | V | #82655b E | clay tile (terracotta) | 2 U | hip U | U |
| 193 | e5fb7513 |  | 5.6 × 5.2 | E | #6e6565 E | grey sheet / concrete | 1 U | gable U | U |
| 202 | 311ba664 |  | 16.3 × 11.4 | V | #805e5b E | clay tile (terracotta) | 2 U | hip U | U |
| 205 | dfa3df2f |  | 13.9 × 12.9 | V | #9c544f E | clay tile (terracotta) | 2 U | hip U | U |
| 210 | 36ab9aa5 |  | 12.3 × 8.7 | V | #5f5759 E | grey sheet / concrete | 2 U | hip U | U |
| 218 | a839500d |  | 12.2 × 8.9 | E | #6a565b E | grey sheet / concrete | 2 U | hip U | U |
| 226 | bef431a3 |  | 10.9 × 3.7 | E | #705f5d E | grey sheet / concrete | 2 U | gable U | U |
| 236 | 922d9c43 |  | 13.1 × 12.4 | V | #6a5c60 E | grey sheet / concrete | 2 U | hip U | U |

Overall: every route building is **low confidence** apart from its outline (15 VERIFIED, 9 ESTIMATED of the 24 along
the walk). The schools and the stadium are identified with certainty, but their height, roof shape and facades are
UNKNOWN.

## What would raise the route from UNKNOWN

Photos from the street, taken roughly at the walk's positions:
1. Caffe TIMM from Racina, the whole front and its neighbours (also settles which footprint it is);
2. the Plato, from one corner, so the square and its surroundings are recognisable (and which place it is);
3. Srednja škola Bećo Bašić, the front facing the paved area;
4. OŠ Hajro Šahmanović, the long front facing Racina;
5. the stadium: the main stand and the entrance, from the pitch side.

## Performance (SwiftShader, 120 frames, same build settings)

| view | p50 frame | draw calls | triangles |
|---|---|---|---|
| v28 high (before) | 1080 ms | 68 | 1.19 M |
| v29 high | 862 ms | 68 | 1.19 M |
| v29 walk at 112 m | 865 ms | 68 | 1.19 M |

Software rendering, so only the relative values mean anything: six trees and the walk add no draw calls.
