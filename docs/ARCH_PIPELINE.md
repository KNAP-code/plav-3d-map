# Automated architectural reconstruction: pipeline and central-Plav pilot

Brief: Am, 2026-11-21 23:01Z. This is an evidence-driven pipeline for the whole town. Nothing decorative is generated
at random. Each value carries VERIFIED, ESTIMATED or UNKNOWN.

Run:

```
python pipeline/reconstruct.py plav-town      # roof colour + outline evidence, all buildings
python pipeline/arch_pipeline.py plav-town    # discovery, photo matching, facade reading, validation gate
```

Outputs:
- `public/data/plav-town/recon.json` holds the satellite evidence for all 3,535 buildings.
- `public/data/plav-town/arch.json` holds the facade readings that passed the gate.
- `docs/arch_pipeline_report.json` holds the full report: sources, every wall read, and the validation rows.

## 1. Source discovery (probed automatically on every run)

| Source | Reachable from the build environment | Licence | Use |
|---|---|---|---|
| Overture Maps (S3) | yes | ODbL / CDLA | footprints, OSM tags, places |
| Satellogic EarthView 1 m (S3) | yes | CC BY 4.0 | roof colour, terraces, trees |
| Copernicus DEM GLO-30 | yes | Copernicus | terrain only; it has no building heights |
| OSM API / Overpass | **no** (network refuses) | ODbL | levels/height/roof tags; the Overture copy is used instead |
| Mapillary | **no** | CC BY-SA, token | street photos with camera pose |
| Panoramax, KartaView | **no** | open | street photos |
| Wikimedia Commons, Flickr | **no** | per photo | geotagged photos |
| Geoportal Crne Gore (WMS) | **no** | official | orthophoto, cadastre, heights |
| OpenAerialMap | **no** | CC BY 4.0 | drone orthophotos |
| Google Street View API | reachable, but no key | terms forbid deriving 3D | **not used** |
| plavto.me | yes | view only | photos have no location or direction, so they cannot be matched |

Consequence: no street-level photo source with camera positions is reachable from this environment. The pipeline
therefore runs automatically on the photos it does have:
- photos with a solved camera (p01 aerial, p02 TIMM);
- any photo dropped into `/mnt/project-files/plav-3d/photos/inbox/`. EXIF GPS and compass give a starting camera.

Opening the network to `graph.mapillary.com` (plus a free Mapillary token) and `commons.wikimedia.org` would let the
same stages run on public street-level imagery with no manual uploads.

## 2. Stages

1. **Discovery.** Builds a per-building inventory: outline tier, OSM levels tag, satellite roof colour, photos that see it.
2. **Matching.** For each photo camera, every wall at least 3 m long that faces the camera within 70° and lies within
   230 m is a candidate. Nearer buildings occlude it, using their full silhouettes.
3. **Geometry analysis.** Each wall is rectified into a facade image (0.25 m × 0.1 m cells) between the ground and the
   prior eave. A wall is rejected if:
   - any part of it falls outside the photo;
   - less than half of it is visible;
   - more than 30 % of it is vegetation;
   - it has fewer than 6 px per metre.
4. **Reconstruction.** Facade colour is the lit plaster colour (the brightest 40 % of non-vegetation pixels). Storeys
   are read from window bands, and only when the storey height comes out between 2.4 and 3.9 m.
5. **Validation gate.** The automatic readings are compared with the hand-read values of photo batch 1 on the same
   buildings. Each kind of measure is applied to the model only if:
   - storeys: at least 3 buildings, and at least 80 % match exactly;
   - colour: at least 3 buildings, and the median sRGB distance is 40 or less.
   An automatic value is never VERIFIED. Values that pass the gate are ESTIMATED.
6. **Rendering.** The loader merges the layers in this order: satellite evidence, then gated automatic values, then
   hand-read photo values.

## 3. Pilot result (central Plav, run of 2026-11-22)

| | Buildings |
|---|---|
| Buildings processed automatically (inventory, outline, roof colour) | 3,535 |
| Roof colour measured (ESTIMATED, satellite calibrated on photo p01) | 2,910 |
| Seen by a photo camera (matched walls: 257) | 170 |
| Walls clean enough to read | 7 walls on 4 buildings |
| Storeys read | 2 |
| Facade colour read | 4 |
| **Applied to the model after validation** | **0** |

Why nothing was applied:
- Photo p01 is an oblique aerial shot. Most walls are foreshortened, in shade, or behind trees and other buildings.
- The automatic facade colours came out about 120 sRGB units darker than the hand reading (shaded walls against lit
  walls).
- Only one storey count could be compared, so there was too little data to pass the gate.
- The gate is doing its job: no unvalidated value reaches the model.

The first version of the detector (eave found from the image) read the white flat-roof block as 1 storey; the photo
shows 4. That failure is why the eave is now taken from the prior height and why the gate exists.

## 4. Invented geometry removed (town-wide)

None of the following has evidence behind it, so all of it is now off by default (`?decor` shows it again for comparison):
- estimated garden fences (1,796, 36 km);
- estimated paths, pads, hedges and shrubs;
- haystacks (1,151);
- estimated fruit trees (3,028);
- random balconies, chimneys, porches, stairs, half-hips and stone/brick finishes on ordinary buildings.

What is kept:
- yards, which are a ground colour only;
- OSM-mapped walls and furniture;
- hand-read photo values;
- the modelled landmarks.

Estimated sidewalks along streets are still drawn.

**TIMM.** The picket fence in front of the cafe came from the estimated garden fences and is gone. The terrace frontage
now follows the photo: a low screen (0.8 m, was 1.2 m), lighter glazing above it, dark posts, the dark fascia band,
and the entrance gap.

## 5. Performance

| Build | Frame time p50 | Frame time p95 | Draw calls |
|---|---|---|---|
| v30 | 540 ms | 828 ms | 48 |
| v31 | 532 ms | 694 ms | 45 |

These are SwiftShader software-rendering numbers at medium quality, so they compare the two builds rather than
predict a phone. Removing the decor lowers the load. LOD is unchanged:
- buildings use near/far tiers;
- landmarks are one merged draw each.

## 6. Limits

- Facade materials, windows, balconies and terraces need street-level photos. None are reachable from this
  environment (see section 1).
- EXIF cameras in the inbox are matched only after refinement on known roofs. That step is not automated yet.
- Prior eave heights are mostly estimated (6.4 m default). Storey counts read against them are only as good as those
  priors.
