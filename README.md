# Plav 3D Map

Interactive stylized 3D miniature map of Plav and Murino, Montenegro.

Inspired by the visual experience of Sarajevo.mapa.ba.

Built with Next.js, React Three Fiber (Three.js) and an offline Python data pipeline.
Status: **first prototype** covering central Plav (about 2.0 × 1.8 km, 2,084 buildings).

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
npm run build          # static export in ./out
```

Useful URL parameters:

| Parameter | Effect |
|---|---|
| `?area=plav-sample` | the small čaršija sample (348 buildings) instead of the full prototype area |
| `?stats=1` | fps, draw calls, triangles, GPU name, first-frame time |
| `?q=high\|medium\|low` | force a quality tier (default: high on desktop, medium on touch devices, steps down automatically if fps drops) |
| `?style=warm\|alpine` | style preset |
| `?tune=1` | live style panel (sun, roof pitch, colours, AO, tilt-shift) with "copy JSON" |
| `?lang=en` | English UI |
| `?cam=x,y,distance,azimuth,polar` | reproducible camera (local metres, degrees) |

## Data pipeline

```bash
cd pipeline
pip install -r requirements.txt
python fetch.py plav-centre    # downloads open data into pipeline/cache (not committed)
python build.py plav-centre    # writes public/data/plav-centre
```

Areas are defined in `pipeline/areas.json`; adding Murino or the whole municipality is a new entry there.
See [DATA_SOURCES.md](DATA_SOURCES.md) for licences, attribution and exactly which values are estimates.

## Layout

```
pipeline/            fetch.py, build.py, areas.json (Python, offline)
public/data/<area>/  baked assets: terrain (uint16), land cover (png), buildings/vectors (json), trees (float32)
src/data/            asset loader and heightfield sampler
src/geo/             geometry builders: buildings + roofs, roads, water, terrain, trees
src/scene/           R3F components, materials (procedural windows, roof tiles, ground), lights, post-processing, camera
src/style/presets.ts all visual tokens
src/ui/              viewer, HUD, BS/EN text, tuning panel
scripts/             screenshot and performance measurement (Playwright)
```
