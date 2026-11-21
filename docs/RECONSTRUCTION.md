# Phase 5.1: reconstructing the real buildings of central Plav (pilot, 843 buildings)

Goal: draw each building as the evidence shows it, and mark what is not known instead of decorating it.
Pipeline: `python pipeline/reconstruct.py plav-town` → `public/data/plav-town/recon.json` (pilot circle only,
centre 170,-230, radius 520 m, the same circle as `DETAIL_AREAS`). View: `#recon` colours buildings by the confidence of
one attribute; tapping any pilot building opens the inspector.

## Confidence classes

| class | meaning |
|---|---|
| VERIFIED | read directly from a source: an OSM tag, a measurement in the 1 m image that passes its reliability test, an outline confirmed by a second source |
| ESTIMATED | derived by a stated rule from indirect evidence (e.g. roof covering from roof colour) |
| UNKNOWN | no usable evidence; drawn as a neutral placeholder |

## Result (843 pilot buildings)

| attribute | verified | estimated | unknown | source |
|---|---|---|---|---|
| footprint, size, orientation | 510 | 317 | 16 | OSM / Microsoft outline, Phase 3 tier (second source) |
| roof colour | 412 | 423 | 8 | Satellogic EarthView 1 m, 2022-08-31 |
| roof covering | 0 | 835 | 8 | from roof colour |
| storeys / height | 2 | 0 | 841 | OSM `building:levels` / `height` only |
| roof shape, pitch, ridge | 0 | 0 | 843 | no source shows it |
| use | 16 | 1 | 826 | OSM building class |
| facade colour | 0 | 0 | 843 | no street-level imagery reachable |
| balconies, extensions | 0 | 0 | 843 | no street-level imagery reachable |

Footprints were already drawn exactly from their outlines (a 16 × 11 m house is 16 × 11 m in the model); this phase
did not change any outline.

## Roof colour measurement

1. **Band co-registration.** The Satellogic L1 mosaic is stitched from 384 m scenes whose red, blue and NIR bands are
   offset from green by up to ~10 px (4-6 px over the pilot), differently per scene. That put red and cyan fringes on
   every roof. Offsets are measured per scene by phase correlation of high-passed bands (residual after correction
   ≤ 0.2 px) and removed; the corrected image is then re-registered to the footprints as in Phase 3.
2. **Dehaze and white balance.** Haze offset per band from the darkest 0.3 % of pixels; white balance and exposure
   from asphalt (road carriageways, 114 k pixels).
3. **Vegetation unmixing.** At ~2-3 m effective resolution and ±1 m registration, roof pixels contain garden and
   tree light. Each pixel's vegetation share is taken from its NDVI (bare roof 0.0: confirmed roofs > 120 m² have
   median 0.07; vegetation = ring pixels with NDVI > 0.5) and removed.
4. **Chroma restore.** Haze and blur wash colours out (median saturation 0.04). One global factor restores the spread
   so that the reddest 10 % of roofs reach the linear red/green ratio of clay tile (~2.0). The *order* of colours is
   measured; the exact shade is approximate.
5. **Green cast.** An olive/green result (hue 50-170°) is garden light, not paint: the hue is dropped, the lightness
   kept, and the colour is ESTIMATED.
6. **Reliability test.** VERIFIED needs ≥ 12 roof pixels, the roof detector firing at the footprint, and the two
   random halves of the roof pixels giving the same colour family. Otherwise ESTIMATED.

Check by eye: the blue roof of Hala Sportova and the terracotta roof of the Opština are measured correctly
(`/mnt/project-files/plav-3d/phase5.1/compare-buildings.jpg`).

## Height and roof-shape sources tested and rejected

| source | test | result |
|---|---|---|
| GlobalBuildingAtlas LoD1 heights | vs OSM levels | a 4-storey house reads 2.0 m; median of all houses 2.8 m: unusable for storeys |
| shadows in the 1 m image | brightness 1-5 m beyond each footprint, 12 directions | shadow side only 1 % darker (diffuse light under haze): no heights |
| Meta canopy height (Maxar) | inside footprints | buildings masked to 0 |
| second Satellogic pass (stereo) | coverage | 2022-08-29 pass covers only the east third, not the pilot |
| roof facets in the 1 m image | — | same diffuse light: no facet contrast to read |

## What the renderer does in the pilot (evidence mode)

* roof colour = measured colour; unknown → neutral grey; covering estimated from colour (tile / sheet / concrete)
* walls = one neutral plaster tone (facade colour UNKNOWN)
* no balconies, porches, outside stairs, chimneys, stone ground floors, brick/block finishes, half-hip roofs, shutters,
  curtains or roller blinds; no random pitch or colour jitter
* storeys: OSM where tagged, otherwise the documented placeholder (2, or 1 under 35 m²), marked UNKNOWN
* roof shape: placeholder (hip, gable when elongated, flat for flat building classes), marked UNKNOWN

## What would raise storeys, roof shape and facades from UNKNOWN

Street-level photos of each street (openly licensed, e.g. Mapillary or Panoramax, both unreachable from this
environment) or the national orthophoto / cadastre. No usable source for these is reachable now.
