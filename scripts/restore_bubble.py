"""Paste a page's speech bubble from the original art onto a generated version, pixel for pixel.

The bubble is the pale mint blob in the lower part of the original: pixels near its fill colour,
holes (the lettering) filled, the largest blob kept, edges feathered a little.
  python restore_bubble.py original.png generated.jpg out.jpg debug.jpg
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

orig_p, gen_p, out_p, dbg_p = sys.argv[1:5]
orig = np.asarray(Image.open(orig_p).convert('RGB')).astype(np.float32)
gen = np.asarray(Image.open(gen_p).convert('RGB')).astype(np.float32)
assert orig.shape == gen.shape, (orig.shape, gen.shape)
h, w, _ = orig.shape

# Fill colour: the most common light colour in the bottom third.
bottom = orig[int(h * 0.6):].reshape(-1, 3)
light = bottom[bottom.mean(1) > 200]
q = (light // 4).astype(int)
keys, counts = np.unique(q[:, 0] * 65536 + q[:, 1] * 256 + q[:, 2], return_counts=True)
k = keys[counts.argmax()]
fill = np.array([k // 65536, (k // 256) % 256, k % 256]) * 4 + 2
near = np.abs(orig - fill).max(2) < 22
near[: int(h * 0.5)] = False

near = ndimage.binary_closing(near, iterations=6)
near = ndimage.binary_fill_holes(near)
labels, n = ndimage.label(near)
sizes = ndimage.sum(near, labels, range(1, n + 1))
mask = labels == (sizes.argmax() + 1)
mask = ndimage.binary_dilation(mask, iterations=3)  # take the bubble's own soft edge too
alpha = ndimage.gaussian_filter(mask.astype(np.float32), 1.5)[..., None]

out = gen * (1 - alpha) + orig * alpha
Image.fromarray(out.round().clip(0, 255).astype(np.uint8)).save(out_p, quality=95)

ys, xs = np.where(mask)
print(f'fill {fill.tolist()}  bubble x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()}  {mask.mean() * 100:.1f}% of the page')
y0, y1, x0, x1 = max(0, ys.min() - 60), min(h, ys.max() + 60), max(0, xs.min() - 60), min(w, xs.max() + 60)
crop = lambda a: Image.fromarray(a[y0:y1, x0:x1].round().clip(0, 255).astype(np.uint8))
tint = gen.copy(); tint[mask] = tint[mask] * 0.5 + np.array([255, 0, 0]) * 0.5
parts = [crop(gen), crop(tint), crop(out)]
dbg = Image.new('RGB', (parts[0].width, parts[0].height * 3), 'white')
for i, p in enumerate(parts): dbg.paste(p, (0, i * p.height))
dbg.save(dbg_p, quality=88)
