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

## Redžepagića kula (candidate OSM way 221505346) — HIDDEN until the location is confirmed

- The only coordinate found is 42.595724 N, 19.945963 E, from photomontenegro.me (2013, no stated method). It names the street "Podnogradska".
- The nearest footprint is a square 8.6 × 8.4 m OSM building 7 m away, about 55 m from Redžepagića džamija. It has no name tag in the Overture data.
- Cross-checks attempted: the OSM way page, Wikidata, Wikimapia, satellite tiles and the municipal and tourist sites. None was reachable from the build sandbox or none stated a location, so the position is **unverified**.
- What the model shows (from the sources and the owner's photos): a square stone tower with walls over 1 m thick that taper towards the top, two stone storeys, an overhanging timber čardak with framed windows, closed timber erkers (one with its own roof), a steep hipped roof with deep eaves, an arched door and slit openings.
- Estimated: stone height 8 m, timber storey 2.6 m and roof rise 2.6 m from photo proportions. The front face is assumed to be the one towards the nearest street. The window count and positions are also estimated.

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
