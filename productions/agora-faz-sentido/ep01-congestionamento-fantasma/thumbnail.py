"""YouTube thumbnail (1280x720) for AGORA FAZ SENTIDO · ep. 01.

    python thumbnail.py <background.png> <out.jpg>
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import animations as A  # noqa: E402


def main():
    bg_path, out = sys.argv[1], sys.argv[2]
    W, H, SS = A.W, A.H, A.SS
    bg = Image.open(bg_path).convert('RGB')
    scale = max(W * SS / bg.width, H * SS / bg.height)
    bg = bg.resize((int(bg.width * scale), int(bg.height * scale)), Image.LANCZOS)
    left = (bg.width - W * SS) // 2
    top = (bg.height - H * SS) // 2
    bg = bg.crop((left, top, left + W * SS, top + H * SS)).filter(ImageFilter.GaussianBlur(3))
    # navy gradient from the left so the headline reads on any background
    arr = np.asarray(bg).astype(np.float32)
    x = np.linspace(0, 1, W * SS)[None, :, None]
    alpha = np.clip(0.92 - x * 0.75, 0.25, 0.92)
    navy = np.array(A.NAVY, np.float32)
    arr = arr * (1 - alpha) + navy * alpha
    base = Image.fromarray(arr.astype(np.uint8), 'RGB')

    f = A.Frame(base)
    sims = A.Sims()
    X, V = sims.at(sims.rt, sims.rx, sims.rv, 95.0)
    cx, cy, R = 1480, 560, 300
    f.glow(cx, cy, R * 0.9, A.YEL, 0.6, world=False)
    A.draw_ring(f, cx, cy, R, X, V, scale_car=1.5)
    # highlight the jam cluster
    slow = [(X[i] % A.RING_L) / A.RING_L * 2 * math.pi - math.pi / 2 for i in range(len(X)) if V[i] * 3.6 < 8]
    if slow:
        th = math.atan2(sum(math.sin(a) for a in slow), sum(math.cos(a) for a in slow))
        jx, jy = cx + R * math.cos(th), cy + R * math.sin(th)
        f.circle(jx, jy, 120, outline=A.YEL, width=10, world=False)
        f.arrow(jx - 330 * math.cos(th) * 0.2 - 240, jy - 200, jx - 120 * 0.8, jy - 60, A.YEL, width=16, head=46, world=False)

    f.rect(70, 70, 82, 150, fill=A.YEL, r=4, world=False)
    f.text(104, 92, 'AGORA', 44, fill=A.WHITE, anchor='lm')
    f.text(104, 136, 'FAZ SENTIDO', 44, fill=A.YEL, anchor='lm')
    f.text(80, 390, 'TRÂNSITO', 150, fill=A.WHITE, anchor='lm')
    f.text(80, 545, 'PARADO', 150, fill=A.WHITE, anchor='lm')
    w = f.text_width('SEM ACIDENTE?', 112, 'Black')
    f.rect(62, 640, 62 + w + 56, 800, fill=A.YEL, r=22, world=False)
    f.text(90, 722, 'SEM ACIDENTE?', 112, fill=A.NAVY, weight='Black', anchor='lm')
    f.text(84, 900, 'O congestionamento fantasma explicado', 40, fill=A.WHITE, weight='SemiBold', anchor='lm')

    img = f.im.resize((1280, 720), Image.LANCZOS)
    img.save(out, quality=93)
    print(out)


if __name__ == '__main__':
    main()
