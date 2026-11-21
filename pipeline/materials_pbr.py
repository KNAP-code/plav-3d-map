"""Generate the procedural PBR material set for buildings (Phase 5): public/data/textures/building_pbr.png.

One 512x512 tileable layer per material, stacked vertically (layer k at rows 512k..512k+511), RGBA8:
  R = albedo factor (0.5 = neutral; multiplied by 2 x the building's own colour in the shader)
  G = roughness
  B, A = tangent-space normal x, y (0.5 = flat)
Layers: 0 plaster, 1 rubble stone, 2 brick, 3 concrete block, 4 timber planks, 5 clay tile (Mediterranean
"kupa"/barrel-flat interlocking rows), 6 standing-seam sheet metal, 7 concrete tile / bare concrete.
All tiles repeat every 512 px = TEX_M metres (per layer below); everything is made from seeded noise, no third-party
images, so there is nothing to license.
Usage: python pipeline/materials_pbr.py
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

N = 512
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "textures"
# metres covered by one 512 px tile, per layer (read by the shader as well, keep in sync with materials.ts PBR_M)
TEX_M = [2.0, 3.0, 2.0, 3.2, 2.4, 2.4, 2.0, 2.0]
rng = np.random.default_rng(7)


def noise(scale, seed, octaves=5, persist=0.5):
    """Tileable fractal value noise in [0,1] (sum of bilinear-upsampled periodic random grids)."""
    r = np.random.default_rng(seed)
    out = np.zeros((N, N)); amp = 1.0; tot = 0.0; s = scale
    for _ in range(octaves):
        g = r.random((s, s))
        g = np.pad(g, ((0, 1), (0, 1)), mode="wrap")
        z = ndimage.zoom(g, (N + N // s) / s, order=3, mode="grid-wrap")[: N, : N]
        out += amp * z; tot += amp; amp *= persist; s *= 2
        if s > N:
            break
    out /= tot
    return (out - out.min()) / (np.ptp(out) + 1e-9)


def normal_from_height(h, strength):
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    n = np.stack([-gx, -gy, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def pack(alb, rough, h, strength):
    n = normal_from_height(h, strength)
    rough = np.broadcast_to(rough, h.shape)
    img = np.stack([np.clip(alb, 0, 1), np.clip(rough, 0, 1), n[..., 0] * 0.5 + 0.5, n[..., 1] * 0.5 + 0.5], -1)
    return (img * 255 + 0.5).astype(np.uint8)


yy, xx = np.mgrid[0:N, 0:N] / N  # 0..1 over one tile


def plaster():
    big = noise(4, 1, 4); fine = noise(64, 2, 3); grain = rng.random((N, N))
    h = 0.6 * fine + 0.25 * ndimage.gaussian_filter(grain, 0.7, mode="wrap") + 0.15 * big
    stains = noise(3, 3, 3)
    alb = 0.5 + 0.06 * (big - 0.5) + 0.04 * (fine - 0.5) - 0.07 * np.clip(stains - 0.6, 0, 1) * 2.5
    return pack(alb, 0.88 + 0.08 * fine, h, 6.0)


def rubble():
    # irregular stones: jittered Voronoi cells on a periodic grid
    cells = 9; r = np.random.default_rng(11)
    pts = (np.stack(np.mgrid[0:cells, 0:cells], -1).reshape(-1, 2) + 0.15 + 0.7 * r.random((cells * cells, 2))) / cells
    pts[:, 0] *= 1.0; pts[:, 1] = pts[:, 1]
    P = np.concatenate([pts + [dx, dy] for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    ys, xs = np.mgrid[0:N, 0:N] / N
    # stones flatter than tall
    d = np.full((N, N, 2), 9.0); idx = np.zeros((N, N), int)
    for k, (py, px) in enumerate(P):
        dd = np.sqrt(((xs - px) * 1.0) ** 2 + ((ys - py) * 1.6) ** 2)
        upd = dd < d[..., 0]
        d[..., 1] = np.where(upd, d[..., 0], np.minimum(d[..., 1], dd))
        d[..., 0] = np.where(upd, dd, d[..., 0]); idx = np.where(upd, k % (cells * cells), idx)
    edge = d[..., 1] - d[..., 0]
    mortar = 1 - np.clip(edge / 0.018, 0, 1)
    tone = np.random.default_rng(5).random(cells * cells)[idx]
    rough_s = noise(32, 13, 4)
    h = (1 - mortar) * (0.6 + 0.4 * np.clip(edge / 0.06, 0, 1)) + 0.15 * rough_s
    alb = np.where(mortar > 0.5, 0.56, 0.36 + 0.22 * tone + 0.08 * (rough_s - 0.5))
    return pack(alb, 0.9 + 0.05 * rough_s, h, 9.0)


def brick():
    rows = 32; per_row = 8  # 2 m tile: 6.25 cm courses, 25 cm bricks
    ry = yy * rows; row = np.floor(ry)
    rx = xx * per_row + 0.5 * (row % 2)
    fx, fy = rx % 1, ry % 1
    mortar = np.maximum(1 - np.clip(np.minimum(fx, 1 - fx) / 0.04, 0, 1), 1 - np.clip(np.minimum(fy, 1 - fy) / 0.12, 0, 1))
    bid = (np.floor(rx) % per_row + row * 31) % 97
    tone = np.random.default_rng(3).random(97)[bid.astype(int)]
    n = noise(64, 21, 3)
    alb = np.where(mortar > 0.5, 0.72, 0.42 + 0.18 * tone + 0.06 * (n - 0.5))
    h = (1 - mortar) + 0.1 * n
    return pack(alb, 0.85 + 0.1 * n, h, 5.0)


def block():
    rows = 16; per_row = 8  # 20 x 40 cm concrete blocks over 3.2 m
    ry = yy * rows; row = np.floor(ry); rx = xx * per_row + 0.5 * (row % 2)
    fx, fy = rx % 1, ry % 1
    mortar = np.maximum(1 - np.clip(np.minimum(fx, 1 - fx) / 0.025, 0, 1), 1 - np.clip(np.minimum(fy, 1 - fy) / 0.05, 0, 1))
    n = noise(96, 31, 3); pores = (rng.random((N, N)) > 0.985).astype(float)
    alb = np.where(mortar > 0.5, 0.6, 0.48 + 0.06 * n - 0.1 * pores)
    h = (1 - mortar) * 0.8 + 0.12 * n - 0.2 * pores
    return pack(alb, 0.93, h, 4.0)


def timber():
    planks = 12  # vertical boards ~20 cm over 2.4 m
    px = xx * planks; pid = np.floor(px); f = px % 1
    gap = 1 - np.clip(np.minimum(f, 1 - f) / 0.03, 0, 1)
    grain = noise(8, 41, 5)
    streak = np.sin((yy * 40 + grain * 6 + pid * 1.7) * np.pi) * 0.5 + 0.5
    tone = np.random.default_rng(9).random(planks)[pid.astype(int) % planks]
    alb = 0.38 + 0.16 * tone + 0.08 * streak - 0.25 * gap
    h = (1 - gap) + 0.08 * streak
    return pack(alb, 0.8 + 0.1 * grain, h, 6.0)


def clay_tile():
    # interlocking clay roof tiles: courses of ~32 cm (7.5 per 2.4 m), tile width ~24 cm (10 per tile), each
    # tile rounded across (barrel profile) and with a shadowed lower lip; y runs down the slope.
    cy, cx = 7.5, 10
    ry = yy * cy; row = np.floor(ry); rx = xx * cx + 0.5 * (row % 2)
    fx, fy = rx % 1, ry % 1
    barrel = np.sin(fx * np.pi) ** 0.6                      # rounded across the tile
    lip = np.clip((fy - 0.82) / 0.18, 0, 1)                # overlap edge at the lower end of each course
    h = barrel * 0.7 + fy * 0.5 - lip * 0.9
    tid = ((np.floor(rx) % cx) * 13 + row * 7) % 211
    tone = np.random.default_rng(17).random(211)[tid.astype(int)]
    n = noise(48, 51, 4); moss = np.clip(noise(6, 52, 4) - 0.62, 0, 1) * 2
    alb = 0.43 + 0.17 * tone + 0.05 * (n - 0.5) - 0.18 * lip - 0.08 * (1 - barrel) - 0.1 * moss
    return pack(alb, 0.78 + 0.1 * n, h, 14.0)


def metal():
    seams = 4  # standing seam every 0.5 m over 2 m
    f = (xx * seams) % 1
    seam = np.exp(-((np.minimum(f, 1 - f)) / 0.018) ** 2)
    ribs = 0.15 * np.exp(-((np.abs(f - 0.5)) / 0.05) ** 2)
    n = noise(8, 61, 4); dents = noise(32, 62, 3)
    h = seam + ribs + 0.03 * dents
    alb = 0.5 + 0.05 * (n - 0.5) + 0.06 * seam
    return pack(alb, 0.42 + 0.18 * n, h, 10.0)


def concrete():
    n = noise(6, 71, 5); fine = noise(96, 72, 2); pores = (rng.random((N, N)) > 0.99).astype(float)
    alb = 0.5 + 0.08 * (n - 0.5) + 0.03 * (fine - 0.5) - 0.12 * ndimage.gaussian_filter(pores, 0.6, mode="wrap") * 3
    h = 0.4 * fine + 0.2 * n - 0.3 * pores
    return pack(alb, 0.9, h, 3.0)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    layers = [plaster(), rubble(), brick(), block(), timber(), clay_tile(), metal(), concrete()]
    img = np.concatenate(layers, 0)
    Image.fromarray(img, "RGBA").save(OUT / "building_pbr.png", optimize=True)
    print("layers", len(layers), "->", OUT / "building_pbr.png", (OUT / "building_pbr.png").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
