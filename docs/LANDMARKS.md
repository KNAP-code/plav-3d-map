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

Modelled from the Tourist Organisation Plav texts and the OSM footprints. No photos were available, so roof shapes,
proportions, window layouts and minaret forms are estimates. See docs/ARCHITECTURE_REFERENCES.md for each attribute's confidence.
The Carska (Imperial) mosque is the Stara džamija (plavto.me), not Sultanija.

## Šehidska džamija

It is in Vojno Selo (the owner confirmed this), outside the central prototype area. It is kept for the municipality-wide scope.

## Procedural houses (all estimates, deterministic per building id)

Footprints and positions are the real OSM/Overture ones and are never changed. Everything below is an estimate,
because OSM has no roof, facade or balcony data for Plav.

- Building type:
  - traditional Plav house: about 30% of 1-2 storey houses of 45-220 m², with a rubble-stone ground floor, white upper floor, small square windows with shutters, steep hipped or half-hipped roof with deep eaves, and a darker roof
  - house: everything else under 4 storeys
  - apartment block: 4+ storeys, or 3 storeys over 260 m²
- Roof type: hip, gable, half-hip (Krüppelwalm) or flat; about 30% of blocks are flat. Roofs on irregular footprints follow the footprint, which gives complex roofs on L-shaped buildings.
- Pitch and overhang depend on the building type.
- Facade: window layout (grid, tall, paired, wide band, shopfront), window size varies per building, light window surrounds, and shutters on traditional houses and about 30% of other houses.
- Wall and roof colours come from separate palettes for traditional houses, houses and blocks.
- Details: an entrance (door, lintel, step, and a canopy on modern houses) on the wall facing the nearest street. Balconies on about half of the 2-3 storey houses (wooden on traditional houses) and on most blocks; there are none on shops. Chimneys on most pitched roofs.
- Also estimated: gutters with one downpipe on pitched-roof houses; an exterior wooden stair to the upper floor on about 45% of 2-storey traditional houses; subtle weathering (rising damp, streaks under sills); three deciduous tree crown shapes (round, tall oval, broad), assigned per tree.
- Details are a separate mesh per tile. It is drawn only near the camera (650 m on high, 420 m on medium, never on low) and casts no shadow.

## Streets (estimates vs mapped)

- Mapped, at their mapped positions (`pipeline/furniture.py`): 2 benches, 9 public fountains or drinking taps, 2 bus stops, 4 parking signs, 2 information boards, and 3 walls or retaining walls.
- No pedestrian crossings or road signs are mapped inside the prototype area, so none are drawn.
- Sidewalks with kerbs (1.7 m) on tertiary and larger streets are an ESTIMATE, because OSM has no sidewalk tags here. They stop short of junctions. The `off=street` URL parameter hides them.

## Roads, streetlights, traffic

- Road classes, geometry, surface (paved / unpaved / gravel) and junction topology come from Overture (OSM). Segments are split at connectors.
- No sidewalk, lamp or crossing data exists inside the prototype area. Sidewalks are not drawn. Streetlights are **decorative**, placed every 34 m along lit road classes.
- Traffic is decorative simulation on the real road graph (largest connected network, right-hand lanes, curves at junctions). It is not real traffic data.
