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

## Šehidska džamija

It is in Vojno Selo (the owner confirmed this), outside the central prototype area. It is kept for the municipality-wide scope.

## Procedural houses (all estimated, deterministic per building id)

Roof pitch and overhang by building type, window layout (grid, tall, paired, band, shop ground floor), bay width,
small colour variation, a chimney on most pitched roofs, and a plinth band. No balconies were added, because no data or
references support them for individual buildings.

## Roads, streetlights, traffic

- Road classes, geometry, surface (paved / unpaved / gravel) and junction topology come from Overture (OSM). Segments are split at connectors.
- No sidewalk, lamp or crossing data exists inside the prototype area. Sidewalks are not drawn. Streetlights are **decorative**, placed every 34 m along lit road classes.
- Traffic is decorative simulation on the real road graph (largest connected network, right-hand lanes, curves at junctions). It is not real traffic data.
