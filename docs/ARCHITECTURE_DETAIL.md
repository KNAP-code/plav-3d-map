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
