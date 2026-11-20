# Landmarks: verified vs estimated (2026-11-20)

Landmark models live in `src/geo/landmarks.ts`. Each model replaces the procedural building with the same
footprint id, so it is never duplicated. If the model has its own minaret, it also replaces the generic OSM minaret. Models marked
*provisional* in code are hidden unless the page is opened with `#review` / `?review=1`.

## Stara džamija (OSM building, Overture id d8f69ad5…) — shown, PROVISIONAL

Sources: avlija.me "Islamsko kulturno nasljeđe: Plav" (2024), monteislam.com (2011), and two reference photos supplied by the project owner.

Verified:
- Position and footprint: the OSM building named "Stara džamija", 17.5 × 10.1 m. The written source gives a 16 × 10 m plan.
- Steep hipped roof with a wood-shingle look. The photos show it, and the source says the roof is a plastic imitation of wooden shingles laid in 1986.
- Wooden minaret with a shingle-clad shaft in a chevron pattern. It rises from the ridge near the entrance end and has an enclosed balcony and a bell-shaped cap (photos). The source says it is wooden and 10 m tall.
- The entrance end and part of the long side are dark timber (sofraluci) with ogee-shaped openings (photos). The source says the building is part stone and part wood.
- White plastered stone walls with tall round-arched windows and a grey plinth (photo 2).
- A wooden šadrvan (octagonal pavilion) stands in front of the entrance (photo 1 and the source).
- The entrance is at the north-west end. The OSM minaret node lies in that half of the footprint, and that end faces away from the qibla.

Estimated (needs visual verification):
- Eave height 5.0 m and roof pitch 45°, both from photo proportions.
- Minaret height of about 10 m above the ridge, from photo proportions.
- Length of the timber section along the side (40%) and the number of arched windows (4 per side).
- Exact position of the šadrvan.
- Rear (qibla) wall. No photo is available, so it is modelled as plain plaster with two arched windows.

## Redžepagića kula (OSM way 221505346) — CONFIRMED, shown in the main map

- Position confirmed by the project owner on 2026-11-20: 42.595724 N, 19.945963 E, OSM building way 221505346 (8.6 × 8.4 m).
  The model replaces the generic building on that footprint, keeps its centre and orientation, and sits on the terrain at the footprint's ground height.
- Not to be confused with Redžepagića džamija, about 55 m to the north-east.
- Camera shortcut: the "Redžepagića kula" chip flies to the door face.
- Verified from the sources and the owner's two photos:
  - square rubble-stone tower whose walls taper towards the top
  - round-arched wooden door and small square openings in the stone
  - dark timber čardak overhanging all four sides, with corbel beams, corner posts, diagonal braces, a light beam band and pairs of small white-framed windows
  - closed timber erker on the front face hanging below the čardak, with its own reddish mono-pitch roof
  - erkers on the side faces near the front corners
  - steep hipped reddish-brown roof with deep eaves and a finial rod
- Estimated:
  - heights (stone 10 m, timber storey 2.6 m, roof rise 3.4 m) from photo proportions
  - which face is the front (the one towards the nearest street)
  - the rear face, which has no photo
  - exact sizes of the erkers and windows

## Sultanija, Redžepagića džamija, Šabovića džamija (2026-11-20)

Modelled from the Tourist Organisation Plav texts and the OSM footprints, then corrected against the plavto.me gallery
photos (viewed as references, not copied). Walls, roofs, domes, window types and minaret forms now follow the photos;
heights, counts and the parts the photos do not show remain estimates. See docs/ARCHITECTURE_REFERENCES.md for each attribute's confidence.
The Carska (Imperial) mosque is the Stara džamija (plavto.me), not Sultanija.

## Šehidska džamija

It is in Vojno Selo (the owner confirmed this), outside the central prototype area. It is kept for the municipality-wide scope.

## Ordinary buildings (rules v2, 2026-11-20)

Footprints and positions are the real OSM/Overture ones and are never changed. Nothing about an ordinary building's
appearance is chosen at random any more; every attribute is either from data or one documented default.

| attribute | rule | source |
|---|---|---|
| storeys | OSM height or building:levels when present (7 buildings); otherwise 1 storey for sheds, garages and footprints under 35 m², and 2 storeys (ground + one upper floor) for everything else | OSM, or default (estimate) |
| apartment-block styling | only where OSM records 4 or more levels (1 building) | OSM |
| roof shape | flat for garage/industrial classes and footprints over 1,500 m²; gable when the footprint is at least 1.8× longer than wide; hipped otherwise | footprint geometry (estimate: OSM has no roof tags here) |
| roof pitch, overhang | one value per type (house, small building, block) | default (estimate) |
| windows | regular grid sized to each wall | default (estimate) |
| shops | only on buildings OSM classes as commercial or retail | OSM |
| balconies, exterior stairs, traditional stone-ground-floor style | not drawn: there is no per-building evidence | removed |
| entrance | one door on the wall facing the nearest street | estimate |
| chimney | on every pitched-roof building over 35 m² | estimate |
| colours | small tone variation per building, so neighbours do not merge visually | estimate |

Tested and rejected: deriving heights from the Copernicus GLO-30 elevation model. The building signal at 30 m is
swamped by terrain slope (no relation to OSM levels or footprint size), so it was not used. GHSL building heights are
not reachable from the build environment.

Removed compared with rules v1: random 1-4 storey heights driven by footprint area, random traditional-house styling (30%),
random balconies (about 50%), random shops (12%), random roof conversions (half-hip, flat on blocks) and random window layouts.
Effect: 2,029 buildings → 1,759 at 2 storeys, 267 at 1, 2 at 3 and 1 at 4 (before: 1,075 / 421 / 476 / 57).

## Streets (estimates vs mapped)

- Mapped, at their mapped positions (`pipeline/furniture.py`): 2 benches, 9 public fountains or drinking taps, 2 bus stops, 4 parking signs, 2 information boards, and 3 walls or retaining walls.
- No pedestrian crossings or road signs are mapped inside the prototype area, so none are drawn.
- Sidewalks with kerbs (1.7 m) on tertiary and larger streets are an ESTIMATE, because OSM has no sidewalk tags here. They stop short of junctions. The `off=street` URL parameter hides them.

## Roads, streetlights, traffic

- Road classes, geometry, surface (paved / unpaved / gravel) and junction topology come from Overture (OSM). Segments are split at connectors.
- No sidewalk, lamp or crossing data exists inside the prototype area. Sidewalks are not drawn. Streetlights are **decorative**, placed every 34 m along lit road classes.
- Traffic is decorative simulation on the real road graph (largest connected network, right-hand lanes, curves at junctions). It is not real traffic data.
