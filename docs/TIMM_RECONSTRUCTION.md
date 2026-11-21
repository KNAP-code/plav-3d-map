# Caffe TIMM: photo-driven reconstruction (proof of concept)

Am's instruction of 2026-11-21 22:39Z: identify the exact TIMM building first, then rebuild its geometry from the real
photograph, and change nothing else on the street until Am approves. Model: `TIMM` in `src/geo/landmarks.ts`
(custom geometry that replaces the procedural house on that footprint).

## Which building is TIMM

| candidate | OSM way | footprint | evidence for | evidence against |
|---|---|---|---|---|
| **0a7635b8** (chosen) | 533439703 | 13.6 × 13.1 m, centre (-164.8, -8.9), front 9.3 m from the Racina centreline | Overture place "Caffe & Restoran Timm" 3 m away; plain rectangular street front, like the flat continuous facade in the photo; the 1 m image shows a bright roofed strip about 20.5 m wide and 3.75 m deep in front of it, centred on it within ~1 m: the terrace roof in the photo, which is also wider than the building | none found |
| 43747d8b | 535310531 | 19.4 × 14.5 m, centre (-178.1, -0.7) | Overture point 6 m away | its street front is stepped (a ~5 m notch at the corner), which the photo's flat symmetric-looking front does not show; the terrace strip only touches its corner |

Identification confidence: high but not certified. A street-level view showing both buildings would settle it.
The photo camera was solved on the model: about 35 m in front of the facade, across Racina on the paved area,
3.75 m up, looking north-east, vertical field of view 22.5°. The overlay check is
`/mnt/project-files/plav-3d/timm/timm-overlay-check.jpg`.

## What was reconstructed from the photograph

* Ground floor plus three upper floors; facade width = footprint width (13.6 m).
* Projecting balconies on all three upper floors of both wings: solid dark-red parapets, white slab edges and copings,
  white flower boxes (counted: 4 per balcony on the left, 3 / 6 / 5 on the right).
* The central curved vertical section: a half-cylinder in front of the wall, dark red, with white bands at the floor
  levels and three tall windows per floor.
* The white vertical strips on both sides of the curved section, full height.
* Light recessed walls behind the balconies, with one window or balcony door per wing and floor and a wall lamp on
  each side.
* Ground-floor commercial glazing.
* The glazed cafe terrace: 20.5 × 3.75 m (width and depth measured in the 1 m image; it extends beyond the building
  on both sides as in the photo), dark posts, a low light screen, a dark fascia band, light roof, and the entrance
  right of centre with the red carpet.
* The TIMM sign board on the first-floor parapet, right of the curved section.
* The white eave board above the top balconies.

## What remains uncertain (ESTIMATED or UNKNOWN)

* Heights come from photo proportions scaled by the footprint width (±10 %): ground floor 3.8 m, upper floors 2.9 m,
  eave 12.2 m, parapets 1.1 m.
* Facade divisions come from one frontal photo without perspective correction (±0.5 m). The facade is not
  symmetric: left wing 3.6 m, right wing 5.6 m.
* Depths: balconies 1.3 m, curved section 2.3 m beyond the wall. A frontal photo cannot show depth.
* Colours: the photo was taken at night under warm light.
* Roof: hidden by trees. A neutral hip placeholder in the roof colour from the 1 m image (shape UNKNOWN).
* Top of the curved section: above the photo frame. It is ended just above the eave with a flat cap (UNKNOWN).
* Sides and back: not in the photo, so they are plain walls with no windows or balconies (UNKNOWN).
* The sign's lettering, the hanging globe lamps and the terrace furniture are not modelled.

## Comparisons (project files, `/mnt/project-files/plav-3d/timm/`)

* `timm-photo-existing-reconstructed.jpg`: real photo / existing model / reconstruction, at the matched camera, day and night
* `timm-street-and-aerial.jpg`: existing vs reconstructed from the pavement and from above, same cameras
* `timm-overlay-check.jpg`: the reconstruction blended 50 % over the photo

Nothing else on the street changed.
