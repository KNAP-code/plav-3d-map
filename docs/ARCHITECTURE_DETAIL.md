# Phase 4: architectural detail (all ESTIMATED styling)

The detail system is procedural. It is shared by every building and is deterministic per building id. Footprints, heights, streets, terrain and water are unchanged.

**Rollout:** the system is switched on district by district through `DETAIL_AREAS` in `src/geo/buildings.ts`. Batch 1 is central Plav: a 520 m circle around (170, −230), covering 843 buildings. Details appear only with **≈ (estimates) on**.

## Batch 1 (pilot: central Plav)

| Part | What | Where |
|---|---|---|
| Roofs | Fascia and barge boards (0.24 m), sloped soffits back to the wall, 0.9 m eaves, 22 % of hips become half-hips, ridge and hip caps, chimney rain caps, tile weathering and lichen tint | buildings.ts, materials.ts |
| Windows | Frames in white, brown timber or dark grey; mullion and transom; stone sill with drop shadow; reveal shadow; sky-reflection glass; louvred shutters on 45 % of houses | materials.ts (shader, no extra geometry) |
| Walls | Stone plinth on every house, rubble-stone ground floor on 24 %, belt course at the first floor on 55 %, cornice line, soft plaster mottling | materials.ts |
| Entrances | Open porch with posts and a lean-to roof on 38 % of houses ≥ 70 m², otherwise a canopy; outside stair on 20 % of two-storey houses without a balcony | buildings.ts (near-only detail mesh) |
| Planting | 4–8 shrubs and perennials along the entrance wall | buildings.ts |
| Surroundings | Path from the street-facing wall to the street (flagstone or gravel); parking pad on 40 % of larger plots; clipped hedges on parts of the back of 33 % of yards; shrubs in yards; soft contact shadow ring around each house | src/geo/surroundings.ts |

**Switched off: dormers and cross-gables.** The code exists (`dormers` and `cross` in `variation()`), but they are major structural features with no per-building evidence.

**Performance:** no new per-building draw calls.
- Facade detail lives in the existing shader.
- Roof parts are in the merged tile mesh.
- Porches, stairs, planting and ridge caps are in the existing near-only detail mesh. The low tier skips it.
- Surroundings and contact shadows add one merged mesh each.

# Phase 5: realism pilot (central Plav, same 843 buildings)

**Rendering changes:**

- **Physically based building materials.** A texture array holds 8 tileable 512 px layers, generated in `pipeline/materials_pbr.py` from seeded noise, so no third-party images are involved. Each layer stores albedo, roughness and a normal map. The layers are plaster, rubble stone, brick, concrete block, timber, clay tile, standing-seam metal and concrete. They are sampled in metres and use 8× anisotropic filtering.
- **Normal mapping without tangents.** The tangent frame is built from screen derivatives, so the geometry needs no tangent attributes. Roughness and metalness are per pixel. Metal roofs use metalness 0.55.
- **Recessed windows.** Each window is a ray-marched 18 cm opening, giving parallax reveals with a shadowed head, half-lit jambs and a lit sill. Behind the glass, frames, mullions and transoms are drawn. There are dark rooms, net curtains or drapes 25 cm behind the glass on some windows, and roller blinds, a common local feature, partly lowered on about 60 % of windows. Glass has roughness 0.04 and reflects the sky environment map. Side shutters are now on 14 % of houses instead of 45 %.
- **Sky reflections.** A sky environment map (a PMREM-prefiltered gradient sky with a sun glow) is applied to the building material at intensity 0.55.
- **Vegetation.** Trees use smooth, lumpy crowns (subdivided icosahedra) with world-space leaf-clump shading and normal perturbation. Shrubs are rounded 7-sided blobs, and planting moved onto the terrain.
- **Grade.** Tilt-shift is off by default, saturation is −0.12 (was −0.2) and the vignette is 0.14 (was 0.28).

**Performance** (headless Chromium + SwiftShader, Pixel 7 emulation, 60 frames, whole-neighbourhood camera). These are relative numbers only, not phone fps.

| | high, before | high, after | medium, before | medium, after |
|---|---|---|---|---|
| frame p50 | 1025 ms | 1028 ms | 633 ms | 758 ms |
| draw calls | 72 | 68 | 51 | 48 |
| triangles | 1.07 M | 1.22 M | 0.92 M | 1.07 M |
| JS heap | 286 MB | 269 MB | 239 MB | 254 MB |
| first frame | 6.2 s | 5.3 s | 5.2 s | 5.1 s |

Extra costs:
- Download: 2.7 MB of material maps.
- GPU memory: about 11 MB for the texture array.
- Triangles: +15 %, all from the smoother tree crowns.
