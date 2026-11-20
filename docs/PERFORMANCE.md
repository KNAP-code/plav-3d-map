# Performance pass (2026-11-20)

Measured with `scripts/bench.mjs` (in-app `#bench`: a fixed pan / orbit / zoom flight, 30 warm-up frames,
then N frames; frame-time percentiles, draw calls and triangles read after all passes).
Machine: headless Chromium with **SwiftShader (CPU rasteriser)**, Pixel 7 emulation (412×839 CSS px).
SwiftShader numbers are only meaningful **relative to each other**. They are not phone fps.
Real-device numbers must come from `#stats` / `#bench` on the phones themselves.

## Bottlenecks found (profile before changing anything)

| # | Finding | Evidence |
|---|---|---|
| 1 | Shadow map re-rendered on almost every moving frame (frustum followed the camera target) | 19 of 20 bench frames re-rendered the 2048² map; `off=shadows` −31% frame time; triangles 1.42 M → 0.95 M without it |
| 2 | Whole React tree re-rendered during camera movement (`setView` for the compass, throttled 120 ms) | 1 React render per bench frame |
| 3 | Synchronous shader-error checks (`getProgramInfoLog`) on every compile | 7.6 s main-thread in the CPU profile; tier switches recompiled everything |
| 4 | Terrain fragment shader: 4-octave procedural noise per pixel, plus 360 k terrain triangles drawn in one unculled mesh | `off=terrain` −24% |
| 5 | Trees: 4 InstancedMeshes, all 12 k trees always drawn (no culling) | `off=trees` −28%, 0.79 M triangles incl. shadow pass |
| 6 | N8AO + SMAA on mobile | `off=ao` −13% |
| 7 | DPR up to 1.6 on medium (2.6× the pixels of DPR 1) | |

## Changes

- **Shadows**: never re-rendered while moving. Low / medium: one 2048² map fitted to the whole area, rendered once.
  High: 4096² fitted to the view, re-rendered once when the camera comes to rest. Only buildings, trees and minarets cast;
  the far context terrain no longer samples the shadow map.
- **Rendering on demand** (`frameloop="demand"`): zero GPU work while nothing moves (verified: no frames during 8 s idle).
- **No React work per frame**: compass and elevation are written straight to the DOM; HUD memoised; stable callbacks.
- **Buildings**: 4×4 tiles, walls + roofs merged into one mesh per tile (one draw call), frustum-culled.
  Distance LOD: far tiles use a flat-tone shader without the window / roof-tile pattern. All 2,084 footprints unchanged;
  per-building vertex spans kept (`geometry.userData.ranges`) for selection.
- **Trees**: 2 InstancedMeshes (crown + trunk merged), sorted into 256 m tiles; only tiles in the view frustum are written,
  far tiles draw every 2nd tree; the instance buffer is rewritten only when that set changes. Full set is written for shadow renders.
- **Terrain**: 4×4 frustum-culled tiles sharing one vertex buffer; noise from a 256² texture instead of per-pixel fbm;
  coarser context ring (and core on low).
- **Post-processing per tier**: high = N8AO + tilt-shift + SMAA; medium = tilt-shift + 2× MSAA; low = tilt-shift (smaller kernel).
  The tilt-shift miniature look stays on every tier.
- **DPR caps**: phones low 1.0 / medium 1.25 / high 1.75; desktop 1.0 / 1.5 / 2.0. `?dpr=` overrides for testing.
- **Adaptive quality** (replaces drei PerformanceMonitor): phones start on medium (low with ≤ 4 GB RAM), desktops on high;
  median frame time while moving is checked every 90 frames; steps down (high > 22 ms, medium > 36 ms), never back up by itself.
  A tier picked in the HUD (HQ / MQ / LQ) switches adaptation off.
- `gl.debug.checkShaderErrors` off (on with `?debug=1`).

## Results (SwiftShader, relative)

| Config | DPR | p50 frame | p95 | JS p50 | draw calls | triangles / frame | shadow re-renders | React renders |
|---|---|---|---|---|---|---|---|---|
| **Before**, medium | 1.6 | 1741–2257 ms | 1904–2423 ms | 206 ms | 36 | 1,418 k | 19 / 20 frames | 1 / frame |
| After, medium (same DPR) | 1.6 | 432 ms | 480 ms | 1.4 ms | 23 | 279 k | 0 | 0 |
| After, medium (phone default) | 1.25 | 299 ms | 363 ms | 1.1 ms | 23 | 279 k | 0 | 0 |
| After, low | 1.0 | 109 ms | 121 ms | 1.1 ms | 23 | 206 k | 0 | 0 |
| After, high | 1.75 | 644 ms | 731 ms | 1.8 ms | 33 | 396 k | 0 | 0 |

Same DPR, same tier: about **4–5× less frame time** and 5× fewer triangles. Raw data: `perf-2026-11-20.json`.
Before / after screenshots: `screenshots/perf-compare-landing.jpg` (old MQ · new MQ · new LQ) and
`screenshots/perf-compare-closeup.jpg` (old · new HQ · new MQ).

## How to measure on a phone

Open the preview with `#stats` (live overlay: fps while moving, p95 frame time, draw calls, triangles, DPR, tier, GPU)
or `#bench` (runs the fixed flight and prints percentiles). Add `#low` / `#medium` / `#high` in a separate load to force a tier.
Targets (50–60 fps flagship, ≥ 30 fps mid-range) are **not yet verified** on real devices.

## Phase 4 check (landmarks, house variation, roads, streetlights, traffic, night)

Same benchmark and machine (SwiftShader, Pixel 7 emulation, 30 frames), with traffic on (`cars=1`):

| Config | DPR | p50 frame | JS p50 | calls | triangles |
|---|---|---|---|---|---|
| medium (before phase 4) | 1.25 | 299 ms | 1.1 ms | 23 | 279 k |
| medium + traffic | 1.25 | 287 ms | 1.3 ms | 25 | 328 k |
| medium + traffic + night | 1.25 | 289 ms | 1.1 ms | 27 | 330 k |
| low (no traffic) | 1.0 | 103 ms | 1.0 ms | 24 | 254 k |
| high + traffic | 1.75 | 603 ms | 1.6 ms | 37 | 447 k |

The new content adds 2–4 draw calls (landmarks, streetlights, cars, glow halos only at night) and about 50 k triangles.
Frame time is within run-to-run noise. Traffic needs frames to animate, so while it is on the idle view redraws at about 30 fps
(full rate during interaction). Traffic is off on Low, can be switched off in the HUD, and pauses while the tab is hidden.
