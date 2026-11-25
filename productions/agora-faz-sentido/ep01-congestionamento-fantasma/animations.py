"""AGORA FAZ SENTIDO · ep. 01 — programmatic 2D animations (16:9 and 9:16).

Every scene is drawn with Pillow at 2x supersampling (smooth edges), timed to
the real narration (scene timeline + speech onsets read from the WAV files) and
piped to FFmpeg. Traffic scenes use the IDM micro-simulation in trafficsim.py.

    python animations.py --timeline <project>/timeline.json --out <dir> [--scenes 5,7] [--vertical] [--still 2.0]
"""
import argparse
import glob
import json
import math
import os
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trafficsim import HIGHWAY, HUMAN_RING, SMART, platoon, ring_mixed  # noqa: E402

# ── Brand ──────────────────────────────────────────────────────────────────
NAVY = (11, 31, 58)
DEEP = (5, 14, 30)
PANEL = (19, 45, 82)
LINE = (44, 78, 124)
YEL = (255, 194, 14)
WHITE = (255, 255, 255)
MUTED = (160, 178, 205)
RED = (255, 70, 70)
ASPHALT = (24, 34, 52)
FONT_DIR = os.environ.get('AFS_FONT_DIR', '/root/.config/open-generative-ai/local-ai/fonts')

W, H, SS, FPS = 1920, 1080, 2, 30
SAFE = {'right': W - 48}  # right edge for footnotes/badges; the 9:16 layout crops at x=1720
_fonts = {}


def font(size, weight='ExtraBold'):
    key = (size, weight)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(FONT_DIR, f'Montserrat-{weight}.ttf'), int(size * SS))
    return _fonts[key]


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_io(t):
    t = clamp(t)
    return t * t * (3 - 2 * t)


def ease_back(t):
    t = clamp(t)
    c = 1.70158
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2


def mix(c1, c2, u):
    u = clamp(u)
    return tuple(int(a + (b - a) * u) for a, b in zip(c1, c2))


def speed_color(kmh, vmax=90.0):
    """White when flowing, yellow when slowing, red when (almost) stopped."""
    u = clamp(kmh / vmax)
    return mix(RED, YEL, u / 0.55) if u < 0.55 else mix(YEL, WHITE, (u - 0.55) / 0.45)


# ── Canvas with a 2D camera ────────────────────────────────────────────────
class Frame:
    def __init__(self, base):
        self.im = base.copy()
        self.d = ImageDraw.Draw(self.im, 'RGBA')
        self.cx, self.cy, self.z = W / 2, H / 2, 1.0  # world point at screen centre, zoom

    def camera(self, cx, cy, z):
        self.cx, self.cy, self.z = cx, cy, z

    def P(self, x, y, world=True):
        if world:
            x = (x - self.cx) * self.z + W / 2
            y = (y - self.cy) * self.z + H / 2
        return (x * SS, y * SS)

    def L(self, v, world=True):
        return v * SS * (self.z if world else 1)

    def rect(self, x0, y0, x1, y1, fill=None, outline=None, width=0, r=0, world=True):
        a, b = self.P(x0, y0, world), self.P(x1, y1, world)
        box = [min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])]
        self.d.rounded_rectangle(box, radius=self.L(r, world), fill=fill, outline=outline, width=int(self.L(width, world)))

    def circle(self, x, y, r, fill=None, outline=None, width=0, world=True):
        px, py = self.P(x, y, world)
        rr = self.L(r, world)
        self.d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=fill, outline=outline, width=int(self.L(width, world)))

    def arc(self, x, y, r, start, end, fill, width, world=True):
        px, py = self.P(x, y, world)
        rr = self.L(r, world)
        self.d.arc([px - rr, py - rr, px + rr, py + rr], start, end, fill=fill, width=int(self.L(width, world)))

    def line(self, pts, fill, width, world=True):
        self.d.line([self.P(x, y, world) for x, y in pts], fill=fill, width=max(1, int(self.L(width, world))), joint='curve')

    def poly(self, pts, fill, world=True):
        self.d.polygon([self.P(x, y, world) for x, y in pts], fill=fill)

    def glow(self, x, y, r, color, strength=1.0, world=True):
        for k in range(6, 0, -1):
            a = int(38 * strength * (1 - k / 7))
            self.circle(x, y, r * (0.45 + k * 0.28), fill=color + (a,), world=world)

    def text(self, x, y, s, size, fill=WHITE, weight='ExtraBold', anchor='mm', world=False, alpha=255):
        f = font(size * (self.z if world else 1), weight)
        col = fill + (int(alpha),) if len(fill) == 3 else fill
        self.d.text(self.P(x, y, world), s, font=f, fill=col, anchor=anchor)

    def text_width(self, s, size, weight='ExtraBold'):
        return font(size, weight).getlength(s) / SS

    def arrow(self, x0, y0, x1, y1, fill, width=10, head=28, world=True):
        ang = math.atan2(y1 - y0, x1 - x0)
        bx, by = x1 - head * math.cos(ang), y1 - head * math.sin(ang)
        self.line([(x0, y0), (bx, by)], fill, width, world)
        left = (bx + head * 0.6 * math.cos(ang + math.pi / 2), by + head * 0.6 * math.sin(ang + math.pi / 2))
        right = (bx + head * 0.6 * math.cos(ang - math.pi / 2), by + head * 0.6 * math.sin(ang - math.pi / 2))
        self.poly([(x1, y1), left, right], fill, world)

    def pill(self, x, y, s, size=30, fg=NAVY, bg=YEL, weight='ExtraBold', alpha=255, world=False):
        w = self.text_width(s, size * (self.z if world else 1), weight) + size * 1.2
        h = size * 1.7
        if world:
            w /= self.z
        self.rect(x - w / 2, y - h / 2, x + w / 2, y + h / 2, fill=bg + (int(alpha),), r=h / 2, world=world)
        self.text(x, y + size * 0.04, s, size, fill=fg, weight=weight, world=world, alpha=alpha)


def make_base(w=W, h=H, grid=True):
    """Navy radial gradient + faint grid + vignette (drawn once, copied per frame)."""
    yy, xx = np.mgrid[0:h * SS, 0:w * SS].astype(np.float32)
    cx, cy = w * SS / 2, h * SS * 0.42
    r = np.sqrt(((xx - cx) / (w * SS)) ** 2 + ((yy - cy) / (h * SS)) ** 2)
    u = np.clip(r / 0.75, 0, 1)[..., None]
    top = np.array(PANEL, np.float32)
    bottom = np.array(DEEP, np.float32)
    img = (top * (1 - u) + bottom * u).astype(np.uint8)
    # RGB (not RGBA): ImageDraw only alpha-blends RGBA colours onto RGB images.
    im = Image.fromarray(img, 'RGB')
    if grid:
        d = ImageDraw.Draw(im, 'RGBA')
        step = 120 * SS
        for gx in range(0, w * SS, step):
            d.line([(gx, 0), (gx, h * SS)], fill=(255, 255, 255, 7), width=SS)
        for gy in range(0, h * SS, step):
            d.line([(0, gy), (w * SS, gy)], fill=(255, 255, 255, 7), width=SS)
    return im


# ── Vehicles ───────────────────────────────────────────────────────────────
def car_side(f, x, y, L=150, color=WHITE, brake=0.0, highlight=False, world=True):
    """Side view, front facing right. (x, y) = centre of the car's base line."""
    h = L * 0.30
    if highlight:
        f.rect(x - L * 0.62, y - h * 2.05, x + L * 0.62, y + L * 0.12, outline=YEL, width=4, r=18, world=world)
    f.rect(x - L / 2, y - h, x + L / 2, y - h * 0.18, fill=color, r=h * 0.35, world=world)
    f.poly([(x - L * 0.30, y - h), (x - L * 0.16, y - h * 1.75), (x + L * 0.18, y - h * 1.75), (x + L * 0.34, y - h)], color, world)
    f.poly([(x - L * 0.25, y - h * 1.04), (x - L * 0.14, y - h * 1.6), (x + L * 0.0, y - h * 1.6), (x + L * 0.0, y - h * 1.04)], NAVY, world)
    f.poly([(x + L * 0.04, y - h * 1.04), (x + L * 0.04, y - h * 1.6), (x + L * 0.16, y - h * 1.6), (x + L * 0.28, y - h * 1.04)], NAVY, world)
    for wx in (x - L * 0.3, x + L * 0.3):
        f.circle(wx, y - h * 0.15, h * 0.42, fill=(18, 24, 36), world=world)
        f.circle(wx, y - h * 0.15, h * 0.18, fill=MUTED, world=world)
    f.rect(x + L * 0.44, y - h * 0.8, x + L * 0.5, y - h * 0.55, fill=YEL, r=3, world=world)
    tail = mix((120, 20, 20), RED, 0.3 + 0.7 * brake)
    f.rect(x - L * 0.5, y - h * 0.85, x - L * 0.44, y - h * 0.5, fill=tail, r=3, world=world)
    if brake > 0.05:
        f.glow(x - L * 0.5, y - h * 0.68, L * 0.16, RED, brake, world)


def car_top(f, x, y, ang, L=24, Wd=11, color=WHITE, brake=0.0, ring=None, world=True):
    """Top view rotated by `ang` (radians, direction of travel)."""
    c, s = math.cos(ang), math.sin(ang)

    def pt(u, v):
        return (x + u * c - v * s, y + u * s + v * c)
    if brake > 0.05:
        bx, by = pt(-L * 0.55, 0)
        f.glow(bx, by, L * 0.45, RED, brake, world)
    if ring:
        f.circle(x, y, L * 0.95, outline=ring, width=3, world=world)
    f.poly([pt(-L / 2, -Wd / 2), pt(L / 2 - 3, -Wd / 2), pt(L / 2, -Wd / 2 + 3), pt(L / 2, Wd / 2 - 3),
            pt(L / 2 - 3, Wd / 2), pt(-L / 2, Wd / 2)], color, world)
    f.poly([pt(L * 0.05, -Wd * 0.38), pt(L * 0.28, -Wd * 0.38), pt(L * 0.28, Wd * 0.38), pt(L * 0.05, Wd * 0.38)], NAVY, world)


def road_side(f, y, x0=-4000, x1=6000, offset=0.0, world=True):
    f.rect(x0, y - 6, x1, y + 70, fill=ASPHALT, world=world)
    f.line([(x0, y - 6), (x1, y - 6)], LINE, 3, world)
    f.line([(x0, y + 70), (x1, y + 70)], LINE, 3, world)
    dash = 90
    start = math.floor((x0 + offset) / (dash * 2)) * dash * 2 - offset
    xx = start
    while xx < x1:
        f.rect(xx, y + 30, xx + dash, y + 36, fill=(200, 210, 230, 150), world=world)
        xx += dash * 2


def footnote(f, s, alpha=200):
    f.text(SAFE['right'], H - 36, s, 20, fill=MUTED, weight='SemiBold', anchor='rd', alpha=alpha)


def corner_badge(f, s, y):
    w = f.text_width(s, 22) + 30
    f.pill(SAFE['right'] - w / 2, y, s, size=22, bg=PANEL, fg=WHITE)


def badge(f, x, y, s, t_in, t, size=26):
    a = ease_out((t - t_in) / 0.35)
    if a <= 0:
        return
    f.pill(x, y + (1 - a) * 20, s, size=size, alpha=255 * a)


def headline(f, s, t, t_in=0.0, y=110, size=54, color=WHITE):
    a = ease_out((t - t_in) / 0.45)
    if a <= 0:
        return
    f.text(W / 2, y + (1 - a) * 30, s, size, fill=color, alpha=255 * a)


# ── Timing from the real narration ─────────────────────────────────────────
def speech_onsets(wav_path, thr_db=-32.0, min_gap=0.12):
    """Return [(start, end)] of speech segments inside a narration WAV (seconds)."""
    with wave.open(wav_path) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    win = int(0.01 * sr)
    n = len(x) // win
    rms = np.sqrt((x[:n * win].reshape(n, win) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    voiced = db > thr_db
    segs, start, quiet = [], None, 0
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet * 0.01 >= min_gap:
                segs.append((start * 0.01, (i - quiet + 1) * 0.01))
                start, quiet = None, 0
    if start is not None:
        segs.append((start * 0.01, n * 0.01))
    return segs


class Timing:
    """Scene-local times (s) of words, from the narration WAV of that scene."""

    def __init__(self, scene, project):
        self.dur = scene['duration']
        self.n0 = scene['narration_start'] - scene['start']
        self.text = scene['narration']
        files = glob.glob(os.path.join(project, 'narration', f"scene-{scene['scene']:02d}-*.wav"))
        self.segs = [(self.n0 + a, self.n0 + b) for a, b in speech_onsets(files[0])] if files else [(self.n0, self.dur)]
        self.s0, self.s1 = self.segs[0][0], self.segs[-1][1]

    def at(self, words, default=0.0):
        """Approximate time a word is spoken (character position within the speech).
        `words` may be a list of alternatives; `default` = fraction of the speech
        used when none of them is in this narration."""
        for word in ([words] if isinstance(words, str) else words):
            idx = self.text.lower().find(word.lower())
            if idx >= 0:
                return self.s0 + (self.s1 - self.s0) * idx / max(1, len(self.text))
        return self.s0 + (self.s1 - self.s0) * default

    def seg(self, k):
        return self.segs[min(k, len(self.segs) - 1)]


# ── Simulations (computed once) ────────────────────────────────────────────
class Sims:
    def __init__(self):
        self.pt, self.px, self.pv = platoon(n=40, seconds=80, p=HIGHWAY, cruise=25.0, dip=21.0, reaction=1.0)
        self.rt, self.rx, self.rv = ring_mixed(seconds=150, p=HUMAN_RING)
        _, self.sx, self.sv = ring_mixed(seconds=150, p=HUMAN_RING, p_smart=SMART)
        stopped = [(self.pt[np.argmax(self.pv[:, i] < 1.4)], self.px[np.argmax(self.pv[:, i] < 1.4), i])
                   for i in range(40) if (self.pv[:, i] < 1.4).any()]
        if len(stopped) > 4:
            ts, xs = np.array(stopped).T
            self.wave_kmh = abs(np.polyfit(ts, xs, 1)[0]) * 3.6
            self.jam_t0, self.jam_x0 = ts[0], xs[0]
            self.jam_slope = np.polyfit(ts, xs, 1)[0]
        else:
            self.wave_kmh, self.jam_t0, self.jam_x0, self.jam_slope = 0, 20, 0, -4

    def at(self, T, X, V, t):
        k = int(clamp(t / 0.05, 0, len(T) - 1))
        return X[k], V[k]


RING_L = 230.0


def draw_ring(f, cx, cy, R, X, V, smart=None, label=None, scale_car=1.0):
    f.circle(cx, cy, R + 34, fill=ASPHALT)
    f.circle(cx, cy, R - 34, fill=NAVY + (255,))
    f.circle(cx, cy, R + 34, outline=LINE, width=3)
    f.circle(cx, cy, R - 34, outline=LINE, width=3)
    for k in range(40):
        a0 = k / 40 * 360
        f.arc(cx, cy, R, a0, a0 + 4.5, fill=(200, 210, 230, 120), width=3)
    for i in range(len(X)):
        th = (X[i] % RING_L) / RING_L * 2 * math.pi - math.pi / 2
        x, y = cx + R * math.cos(th), cy + R * math.sin(th)
        kmh = V[i] * 3.6
        is_smart = smart is not None and i == smart
        col = YEL if is_smart else speed_color(kmh, 30)
        car_top(f, x, y, th + math.pi / 2, L=26 * scale_car, Wd=13 * scale_car, color=col,
                brake=clamp((14 - kmh) / 14) if not is_smart else 0, ring=YEL if is_smart else None)


# ── Scenes ─────────────────────────────────────────────────────────────────
def icon_crash(f, x, y, s):
    car_side(f, x - 70 * s, y + 40 * s, L=120 * s, world=False)
    f.poly([(x + 10 * s, y - 40 * s), (x + 30 * s, y - 10 * s), (x + 60 * s, y - 20 * s), (x + 40 * s, y + 10 * s),
            (x + 65 * s, y + 35 * s), (x + 28 * s, y + 25 * s), (x + 15 * s, y + 55 * s), (x + 5 * s, y + 20 * s),
            (x - 25 * s, y + 25 * s), (x - 5 * s, y)], YEL, world=False)


def icon_cone(f, x, y, s):
    f.poly([(x - 18 * s, y - 60 * s), (x + 18 * s, y - 60 * s), (x + 52 * s, y + 50 * s), (x - 52 * s, y + 50 * s)], (255, 140, 40), world=False)
    f.poly([(x - 31 * s, y - 15 * s), (x + 31 * s, y - 15 * s), (x + 38 * s, y + 8 * s), (x - 38 * s, y + 8 * s)], WHITE, world=False)
    f.rect(x - 75 * s, y + 46 * s, x + 75 * s, y + 66 * s, fill=(255, 140, 40), r=6 * s, world=False)


def icon_broken(f, x, y, s):
    car_side(f, x, y + 45 * s, L=150 * s, world=False)
    for k in range(3):
        f.circle(x + 50 * s + k * 18 * s, y - 40 * s - k * 22 * s, (16 + k * 6) * s, fill=MUTED + (170,), world=False)


def stamp_x(f, x, y, s, u):
    if u <= 0:
        return
    k = 70 * s
    a = ease_out(u)
    f.line([(x - k * a, y - k * a), (x + k * a, y + k * a)], YEL, 16 * s, world=False)
    f.line([(x + k * a, y - k * a), (x - k * a, y + k * a)], YEL, 16 * s, world=False)


def s05(f, t, tm, sims):
    z = 1.0 + 0.05 * t / tm.dur
    f.camera(W / 2, H / 2, z)
    cards = [('ACIDENTE', icon_crash), ('OBRA', icon_cone), ('CARRO QUEBRADO', icon_broken)]
    for k, (label, icon) in enumerate(cards):
        a, b = tm.seg(k)
        x = W / 2 + (k - 1) * 580
        u = ease_back((t - a + 0.12) / 0.4)
        if u <= 0:
            continue
        s = (0.6 + 0.4 * u) * 1.45
        cy = 400
        f.rect(x - 175 * s, cy - 150 * s, x + 175 * s, cy + 175 * s, fill=PANEL + (240,), outline=LINE, width=3, r=26 * s, world=False)
        icon(f, x, cy - 10 * s, s)
        f.text(x, cy + 125 * s, label, 30 * s, fill=WHITE, world=False)
        stamp_x(f, x, cy - 10 * s, s * 1.1, (t - (b - 0.15)) / 0.3)
    headline(f, 'ENTÃO O QUE PAROU O TRÂNSITO?', t, tm.seg(2)[1] - 0.25, y=790, size=50, color=YEL)


def s07(f, t, tm, sims):
    # brake-light wave travelling along a dark road of dots
    f.camera(W / 2, H / 2, 1.0 + 0.06 * t / tm.dur)
    y = 760
    f.rect(-200, y - 40, W + 200, y + 40, fill=ASPHALT + (255,), r=20)
    for i in range(46):
        x = (i * 44 + t * 160) % (W + 220) - 110
        phase = (x / W) * 2 * math.pi + t * 3.2
        b = clamp(math.sin(phase) * 1.5 - 0.3)
        car_top(f, x, y, 0, L=28, Wd=14, color=mix(WHITE, YEL, b * 0.6), brake=b)
    t_title = tm.at('congestionamento', 0.5)
    headline(f, 'A CIÊNCIA EXPLICA', t, tm.s0, y=200, size=40, color=MUTED)
    a = ease_out((t - t_title + 0.1) / 0.5)
    if a > 0:
        jitter = (1 - a) * 18
        f.text(W / 2 + jitter, 400, 'CONGESTIONAMENTO', 112, fill=WHITE, alpha=255 * a)
        for k in range(3):
            f.text(W / 2 - jitter * (k + 1), 530 - k * 3, 'FANTASMA', 132, fill=YEL, alpha=80 * a / (k + 1))
        f.text(W / 2, 530, 'FANTASMA', 132, fill=YEL, alpha=255 * a)


SPEEDS = [(90, 80), (90, 72), (90, 62), (90, 48), (90, 30)]


def lane_cars(f, t, positions, brake_times, base_y=640, L=190, speeds=SPEEDS, highlight=None, tags=True):
    for i, x in enumerate(positions):
        tb = brake_times[i] if i < len(brake_times) else None
        b = clamp((t - tb) / 0.25) if tb is not None else 0
        v0, v1 = speeds[i] if i < len(speeds) else (90, 90)
        v = v0 + (v1 - v0) * ease_io((t - tb) / 1.0) if tb is not None and t > tb else v0
        car_side(f, x, base_y, L=L, color=mix(WHITE, speed_color(v1), b * 0.8), brake=b, highlight=(highlight == i))
        if tags:
            col = YEL if b > 0.2 else WHITE
            f.pill(x, base_y - L * 0.78, f'{int(round(v))} km/h', size=24, fg=NAVY, bg=col, world=True)


def s08(f, t, tm, sims):
    offset = t * 520
    f.camera(1080, 560, 1.28 + 0.05 * t / tm.dur)
    road_side(f, 640, offset=offset)
    xs = [1500, 1180, 860, 540, 220, -100]
    tb = tm.at(['reduz', 'freia', 'frear'], 0.6)
    lane_cars(f, t, xs, [tb], highlight=0)
    a = ease_out((t - tm.at(['único', 'motorista'], 0.2) + 0.1) / 0.4)
    if a > 0:
        f.pill(1500, 410, '1 MOTORISTA', size=30, alpha=255 * a, world=True)
    headline(f, 'TUDO COMEÇA COM UMA PEQUENA FREADA', t, tm.s0, y=170, size=52)


def s09(f, t, tm, sims):
    offset = t * 470
    u = ease_io(t / 1.4)
    cx, z = 1250 + 120 * u, 1.15 + 0.35 * u
    f.camera(cx, 560, z)
    road_side(f, 640, offset=offset)
    gap = 360 - 70 * ease_io((t - 0.6) / 2.5)
    xs = [1500, 1500 - gap, 1500 - gap - 360]
    lane_cars(f, t, xs, [-5.0], speeds=[(80, 80), (90, 90), (90, 90)])
    sx, _ = f.P(xs[1], 0)
    sx /= SS
    p = clamp((t - tm.at('percebe', 0.25) + 0.1) / 0.45)
    if p > 0:  # "eye" = perception
        e = ease_back(p)
        f.d.ellipse([(sx - 70 * e) * SS, (235 - 34 * e) * SS, (sx + 70 * e) * SS, (235 + 34 * e) * SS], fill=WHITE)
        f.circle(sx, 235, 26 * e, fill=NAVY, world=False)
        f.circle(sx, 235, 11 * e, fill=YEL, world=False)
    k = clamp((t - (tm.at('reagir', 0.7) - 0.7)) / 1.0)
    if k > 0:
        f.circle(sx, 235, 100, outline=PANEL, width=12, world=False)
        f.arc(sx, 235, 100, -90, -90 + 360 * k, fill=YEL, width=12, world=False)
        f.pill(sx, 375, 'TEMPO DE REAÇÃO ≈ 1 s', size=28)
    headline(f, 'O DE TRÁS PRECISA REAGIR', t, tm.s0, y=110, size=48)


def s10(f, t, tm, sims):
    f.camera(1120, 540, 1.22)
    road_side(f, 620, offset=t * 380)
    x1, x2 = 1380, 940 - 40 * ease_io(t / 3)
    tb2 = tm.at('frear') - 0.2
    lane_cars(f, t, [x1, x2], [-5.0, tb2], speeds=[(80, 80), (90, 72)], L=190)
    a = ease_out((t - tm.at('distância') + 0.1) / 0.4)
    if a > 0:
        yy = 700
        f.arrow(x2 + 100, yy, x1 - 100, yy, YEL, width=6, head=22)
        f.arrow(x1 - 100, yy, x2 + 100, yy, YEL, width=6, head=22)
        f.pill((x1 + x2) / 2, yy + 52, 'DISTÂNCIA', size=26, alpha=255 * a)
    b = ease_out((t - tm.at('tempo de reação') + 0.1) / 0.4)
    if b > 0:
        f.circle(260, 300, 80, outline=YEL, width=9, world=False)
        f.line([(260, 300), (260, 245)], YEL, 9, world=False)
        f.line([(260, 300), (300, 318)], YEL, 9, world=False)
        f.text(260, 425, 'TEMPO DE', 32, fill=WHITE, alpha=255 * b)
        f.text(260, 465, 'REAÇÃO', 32, fill=WHITE, alpha=255 * b)
    c = ease_out((t - tb2 - 0.4) / 0.5)
    if c > 0:
        f.rect(1500, 200, 1840, 470, fill=PANEL + (240,), outline=LINE, width=3, r=24, world=False)
        f.text(1670, 245, 'REDUÇÃO', 26, fill=MUTED)
        for k, (lab, val) in enumerate([('1º carro', 10), ('2º carro', 18)]):
            yy = 310 + k * 80
            f.text(1530, yy, lab, 24, fill=WHITE, weight='SemiBold', anchor='lm')
            f.rect(1650, yy - 18, 1650 + 9 * val * c, yy + 18, fill=YEL if k else WHITE, r=8, world=False)
            f.text(1660 + 9 * val * c, yy, f'-{val}', 24, fill=WHITE, anchor='lm')


def s11(f, t, tm, sims):
    u = ease_io(t / tm.dur)
    f.camera(907 - 40 * u, 540, 0.96 - 0.04 * u)
    road_side(f, 640, x0=-3000, x1=4000, offset=t * 300)
    xs = [1480 - i * 310 for i in range(5)]
    t0 = tm.s0 + 0.2
    times = [-5.0] + [t0 + k * (tm.s1 - t0) / 4 for k in range(4)]
    lane_cars(f, t, xs, times, L=190)
    headline(f, 'E A REAÇÃO SE REPETE…', t, tm.s0, y=130, size=50, color=YEL)


def road_window(f, X, V, left, span, y, lane=80, Lc=None, bars=False, bar_h=150, x0=80, x1=W - 80):
    """Cars of the platoon inside [left, left+span] metres, drawn on a road band."""
    k = (x1 - x0) / span
    f.rect(x0 - 70, y - lane / 2, x1 + 70, y + lane / 2, fill=ASPHALT, r=lane * 0.2, world=False)
    f.line([(x0 - 70, y - lane / 2), (x1 + 70, y - lane / 2)], LINE, 3, world=False)
    f.line([(x0 - 70, y + lane / 2), (x1 + 70, y + lane / 2)], LINE, 3, world=False)
    dash = 12 * k if 12 * k > 30 else 120
    off = (-left * k) % (dash * 2)
    xx = x0 - 70 - dash * 2 + off
    while xx < x1 + 70:
        f.rect(max(x0 - 70, xx), y - 3, min(x1 + 70, xx + dash), y + 3, fill=(200, 210, 230, 90), world=False)
        xx += dash * 2
    Lc = Lc or max(18, min(60, 5.2 * k))
    for i in range(len(X) - 1, -1, -1):
        sx = x0 + (X[i] - left) * k
        if x0 - 60 < sx < x1 + 60:
            kmh = V[i] * 3.6
            if bars:
                hh = bar_h * clamp(1 - kmh / 90)
                f.rect(sx - 6, y - lane / 2 - 14 - hh, sx + 6, y - lane / 2 - 14, fill=speed_color(kmh) + (230,), r=5, world=False)
            car_top(f, sx, y, 0, L=Lc, Wd=Lc * 0.5, color=speed_color(kmh), brake=clamp((70 - kmh) / 60), world=False)
    return k


def platoon_view(f, t_sim, sims, x_left, x_right, y=560, car_scale=1.0, heat=True):
    X, V = sims.at(sims.pt, sims.px, sims.pv, t_sim)
    Lc = 26 * car_scale if car_scale > 1.01 else None
    return road_window(f, X, V, x_left, x_right - x_left, y, lane=90, Lc=Lc, bars=heat)


def overview_detail(f, t_sim, sims, det_centre, det_span=220, y_det=560, y_ov=900):
    """Whole platoon (bottom strip) + magnified window that follows the action."""
    X, V = sims.at(sims.pt, sims.px, sims.pv, t_sim)
    ov_left = X[-1] - 60
    ov_span = X[0] - X[-1] + 120
    kov = road_window(f, X, V, ov_left, ov_span, y_ov, lane=34, Lc=11, bars=True, bar_h=80)
    det_left = det_centre - det_span / 2
    bx0 = 80 + (det_left - ov_left) * kov
    bx1 = bx0 + det_span * kov
    f.rect(bx0, y_ov - 30, bx1, y_ov + 30, outline=YEL, width=4, r=8, world=False)
    f.line([(bx0, y_ov - 30), (20, y_det + 70)], YEL + (120,), 2, world=False)
    f.line([(bx1, y_ov - 30), (W - 20, y_det + 70)], YEL + (120,), 2, world=False)
    road_window(f, X, V, det_left, det_span, y_det, lane=120)
    return X, V


def jam_centre(sims, t_sim):
    return sims.jam_x0 + sims.jam_slope * (t_sim - sims.jam_t0)


def s12(f, t, tm, sims):
    t_sim = 2 + t * (30 / tm.dur)
    X, V = sims.at(sims.pt, sims.px, sims.pv, t_sim)
    w = ease_io((t_sim - 9) / 12)
    centre = (X[0] - 70) * (1 - w) + jam_centre(sims, t_sim) * w
    overview_detail(f, t_sim, sims, centre, det_span=230, y_det=430, y_ov=730)
    headline(f, 'UMA PEQUENA REDUÇÃO…', t, 0.1, y=100, size=54)
    headline(f, '…VIRA UMA ONDA DE FRENAGEM', t, tm.at('onda', 0.5) - 0.3, y=185, size=54, color=YEL)
    f.text(80, 820, 'SIMULAÇÃO · 40 MOTORISTAS · TEMPO DE REAÇÃO 1 s · barras = quanto cada um freou', 22, fill=MUTED, weight='SemiBold', anchor='lm')
    corner_badge(f, 'TEMPO ACELERADO ×5', 820)
    f.text(80, 535, 'ZOOM', 22, fill=YEL, anchor='lm')


def s13(f, t, tm, sims):
    split = min(3.3, tm.dur * 0.5)
    if t < split:
        t_sim = 32 + t * 2.0
        centre = jam_centre(sims, 32.0) - 40  # fixed road window: watch the jam slide left
        span = 240
        left = centre - span / 2
        X, V = sims.at(sims.pt, sims.px, sims.pv, t_sim)
        k = road_window(f, X, V, left, span, 560, lane=130)
        jx = clamp(80 + (jam_centre(sims, t_sim) - left) * k, 360, W - 360)
        a = ease_out(t / 0.5)
        f.arrow(W / 2 - 320, 400, W / 2 + 320, 400, WHITE, width=14, head=40, world=False)
        f.text(W / 2, 330, 'OS CARROS AVANÇAM', 44, fill=WHITE, alpha=255 * a)
        f.arrow(jx + 260, 720, jx - 260, 720, YEL, width=14, head=40, world=False)
        f.text(jx, 800, 'A ONDA VOLTA', 44, fill=YEL, alpha=255 * a)
        corner_badge(f, 'TEMPO ACELERADO ×2', 120)
        return
    # space-time diagram drawn progressively
    tt = t - split
    u = 0.15 + 0.85 * ease_io(tt / (tm.dur - split - 0.2))
    gx0, gx1, gy0, gy1 = 260, 1760, 290, 820
    f.rect(gx0 - 20, gy0 - 20, gx1 + 20, gy1 + 20, fill=PANEL + (200,), r=20, world=False)
    t_lo, t_hi = 0.0, 70.0
    x_lo = sims.px[0].min() - 50
    x_hi = sims.px[int(t_hi / 0.05), 0]
    tmax = t_lo + (t_hi - t_lo) * u
    kmax = int(tmax / 0.05)
    for i in range(0, 40):
        pts = []
        for kk in range(0, kmax, 8):
            px = gx0 + (sims.pt[kk] - t_lo) / (t_hi - t_lo) * (gx1 - gx0)
            py = gy1 - (sims.px[kk, i] - x_lo) / (x_hi - x_lo) * (gy1 - gy0)
            if gy0 <= py <= gy1:
                pts.append((px, py, sims.pv[kk, i]))
        for (a1, b1, v1), (a2, b2, v2) in zip(pts, pts[1:]):
            f.line([(a1, b1), (a2, b2)], speed_color(v1 * 3.6) + (230,), 3, world=False)
    f.text(gx0, gy1 + 50, 'TEMPO →', 26, fill=MUTED, anchor='lm')
    f.text(gx0 - 20, gy0 - 50, 'POSIÇÃO NA ESTRADA ↑', 26, fill=MUTED, anchor='lm')
    a = ease_out((u - 0.5) / 0.3)
    if a > 0:
        f.pill(W / 2, 110, 'A FAIXA VERMELHA DESCE: A ONDA VAI PARA TRÁS', size=34, alpha=255 * a)
        f.text(W / 2, 185, 'em rodovias reais, cerca de 15 km/h (Treiber & Kesting, 2013)', 28, fill=WHITE, weight='SemiBold', alpha=255 * a)
    footnote(f, 'Diagrama espaço-tempo · cada linha é um carro · simulação IDM')


def s14(f, t, tm, sims):
    u = ease_io(t / tm.dur)
    f.camera(W / 2, H / 2, 1.0 + 0.08 * u)
    X, V = sims.at(sims.rt, sims.rx, sims.rv, t * 2.0)
    draw_ring(f, 640, 500, 310, X, V)
    a = ease_out((t - 0.3) / 0.5)
    f.text(1120, 300, 'EXPERIMENTO REAL', 34, fill=MUTED, anchor='lm', alpha=255 * a)
    f.text(1120, 370, 'JAPÃO, 2008', 64, fill=YEL, anchor='lm', alpha=255 * a)
    b = ease_out((t - tm.at(['veículos', 'carros'], 0.4)) / 0.5)
    f.text(1120, 480, '22 carros', 48, fill=WHITE, anchor='lm', alpha=255 * b)
    f.text(1120, 545, 'pista circular de 230 m', 40, fill=WHITE, weight='SemiBold', anchor='lm', alpha=255 * b)
    f.text(1120, 605, 'velocidade inicial ≈ 30 km/h', 40, fill=WHITE, weight='SemiBold', anchor='lm', alpha=255 * b)
    corner_badge(f, 'TEMPO ACELERADO ×2', 200)
    footnote(f, 'Sugiyama et al., New Journal of Physics 10, 033001 (2008) · reconstituição por simulação')


def s15(f, t, tm, sims):
    t_sim = 2.0 * 6.0 + t * (78 / tm.dur)
    X, V = sims.at(sims.rt, sims.rx, sims.rv, t_sim)
    f.camera(W / 2, H / 2 - 20, 1.0)
    draw_ring(f, 640, 500, 310, X, V)
    f.text(1120, 300, 'OBSTÁCULOS NA PISTA', 30, fill=MUTED, anchor='lm')
    f.text(1120, 380, '0', 96, fill=YEL, anchor='lm')
    sd = float(V.std() * 3.6)
    f.text(1120, 500, 'variação de velocidade', 30, fill=MUTED, weight='SemiBold', anchor='lm')
    f.rect(1120, 530, 1720, 570, fill=PANEL + (255,), r=20, world=False)
    f.rect(1120, 530, 1120 + 600 * clamp(sd / 14), 570, fill=mix(YEL, RED, sd / 14), r=20, world=False)
    stopped = int((V * 3.6 < 5).sum())
    a = ease_out((stopped - 1) / 2)
    if a > 0:
        f.text(1120, 660, 'CONGESTIONAMENTO', 54, fill=WHITE, anchor='lm', alpha=255 * a)
        f.text(1120, 725, 'SURGIU SOZINHO', 54, fill=YEL, anchor='lm', alpha=255 * a)
    corner_badge(f, 'TEMPO ACELERADO ×11', 200)
    footnote(f, 'Simulação IDM com os parâmetros do experimento · Sugiyama et al. (2008)')


def s17(f, t, tm, sims):
    items = [('DISTÂNCIA SEGURA', ['distância'], 0.05), ('SEM ACELERAÇÕES BRUSCAS', ['acelera', 'brusca'], 0.3),
             ('VELOCIDADE CONSTANTE', ['dirigir', 'dirija', 'constante'], 0.55)]
    split = tm.at(['ajuda', 'reduz'], default=0.85) - 0.2
    if t < split:
        f.camera(W / 2, H / 2, 1.0 + 0.04 * t / split)
        headline(f, 'COMO AMORTECER A ONDA', t, 0.0, y=150, size=50, color=YEL)
        for k, (lab, word, dflt) in enumerate(items):
            ti = tm.at(word, dflt) - 0.15
            a = ease_back((t - ti) / 0.4)
            if a <= 0:
                continue
            y = 340 + k * 190
            f.rect(360, y - 70, 1560, y + 70, fill=PANEL + (int(240 * clamp(a)),), outline=LINE, width=3, r=30, world=False)
            f.circle(470, y, 48 * a, fill=YEL, world=False)
            f.line([(448, y + 2), (466, y + 22), (498, y - 20)], NAVY, 10, world=False)
            f.text(560, y, lab, 50, fill=WHITE, anchor='lm', alpha=255 * clamp(a))
        return
    tt = t - split
    u = clamp(tt / (tm.dur - split - 0.15))
    headline(f, 'MENOS ONDAS', t - split, 0.0, y=150, size=56, color=YEL)
    gx0, gx1 = 200, 1720
    for row, (lab, grow, col) in enumerate([('BRUSCO', 0.55, RED), ('SUAVE', -0.65, WHITE)]):
        cy = 430 + row * 300
        f.text(gx0, cy - 110, lab, 34, fill=col, anchor='lm')
        f.line([(gx0, cy), (gx1, cy)], LINE, 2, world=False)
        pts = []
        for k in range(int(220 * u)):
            s = k / 220
            amp = 70 * math.exp(grow * s * 4)
            pts.append((gx0 + s * (gx1 - gx0), cy + min(110, amp) * math.sin(s * 26)))
        if len(pts) > 1:
            f.line(pts, col, 6, world=False)
    footnote(f, 'Curvas ilustrativas da velocidade ao longo do tempo')


def s18(f, t, tm, sims):
    t_sim = 6 + t * (100 / tm.dur)
    Xh, Vh = sims.at(sims.rt, sims.rx, sims.rv, t_sim)
    Xs, Vs = sims.at(sims.rt, sims.sx, sims.sv, t_sim)
    f.camera(W / 2, H / 2, 1.0)
    draw_ring(f, 500, 500, 225, Xh, Vh, scale_car=0.85)
    draw_ring(f, 1420, 500, 225, Xs, Vs, smart=0, scale_car=0.85)
    f.text(500, 175, 'SÓ MOTORISTAS', 34, fill=WHITE)
    f.text(1420, 160, '1 CARRO COM CONTROLE', 34, fill=YEL)
    f.text(1420, 200, 'INTELIGENTE DE VELOCIDADE', 34, fill=YEL)
    a = ease_out((t - tm.dur * 0.5) / 0.5)
    if a > 0:
        f.pill(500, 815, f'média {Vh.mean() * 3.6:.0f} km/h · {int((Vh * 3.6 < 5).sum())} parados', size=26, bg=PANEL, fg=WHITE, alpha=255 * a)
        f.pill(1420, 815, f'média {Vs.mean() * 3.6:.0f} km/h · {int((Vs * 3.6 < 5).sum())} parados', size=26, alpha=255 * a)
    f.pill(W / 2, 70, 'TEMPO ACELERADO ×12', size=22, bg=PANEL, fg=WHITE)
    footnote(f, 'Simulação ilustrativa inspirada em Stern et al., Transportation Research Part C 89 (2018)')


def s20(f, t, tm, sims):
    t_sim = 30 + t * (40 / tm.dur)
    X, V = sims.at(sims.pt, sims.px, sims.pv, t_sim)
    u = ease_io(t / (tm.dur * 0.8))
    lead = X[0]
    span = 120 + (X[0] - X[-1] + 400 - 120) * u
    left = lead - span + 60
    platoon_view(f, t_sim, sims, left, left + span, y=560, car_scale=1.0 + 3.0 * (1 - u), heat=False)
    n_vis = int(clamp((X > left).sum(), 1, 40))
    f.pill(W / 2, 250, f'× {n_vis} MOTORISTAS', size=44)
    corner_badge(f, 'TEMPO ACELERADO ×6', 960)
    a = ease_out((t - tm.at(['parar', 'para '], 0.8) + 0.1) / 0.4)
    if a > 0:
        f.text(W / 2, 820, 'A ESTRADA PARA', 76, fill=YEL, alpha=255 * a)


def logo(f, x, y, s=1.0, a=1.0):
    f.text(x, y - 60 * s, 'AGORA', 120 * s, fill=WHITE, alpha=255 * a)
    f.text(x, y + 70 * s, 'FAZ SENTIDO', 120 * s, fill=YEL, alpha=255 * a)
    w = 820 * s * ease_out(a)
    f.rect(x - w / 2, y + 150 * s, x + w / 2, y + 166 * s, fill=YEL, r=8, world=False)


def drift_particles(f, t, n=26, seed=3):
    """Slow floating yellow particles: keeps end cards alive (never a frozen frame)."""
    rng = np.random.default_rng(seed)
    xs, ys, sp, rr = rng.uniform(0, W, n), rng.uniform(0, H, n), rng.uniform(20, 60, n), rng.uniform(3, 9, n)
    for x, y, v, r in zip(xs, ys, sp, rr):
        yy = (y - v * t) % H
        a = int(60 + 60 * math.sin(t * 2 + x))
        f.circle(x + 14 * math.sin(t * 0.8 + y), yy, r, fill=YEL + (a,), world=False)


def s23(f, t, tm, sims):
    drift_particles(f, t)
    a = ease_back((t - 0.05) / 0.5)
    for k in range(10):
        ang = k / 10 * 2 * math.pi + t * 0.9
        f.circle(W / 2 + 620 * math.cos(ang), H / 2 + 330 * math.sin(ang), 10, fill=YEL + (140,), world=False)
    glow = 0.5 + 0.5 * math.sin(t * 4)
    f.glow(W / 2, H / 2 - 40, 360, YEL, 0.25 + 0.25 * glow, world=False)
    logo(f, W / 2, H / 2 - 40, 1.0 + 0.08 * t / tm.dur, clamp(a))


def s24(f, t, tm, sims):
    drift_particles(f, t, seed=7)
    logo(f, W / 2, 300 + 8 * math.sin(t * 1.6), 0.55 + 0.02 * t / tm.dur, 1.0)
    click = tm.at(['inscreva', 'siga'], 0.4) + 0.9
    pressed = t > click
    pulse = 1.0 + (0.025 * math.sin(t * 5) if not pressed else 0.0)
    s = (1.0 - 0.08 * clamp(1 - abs(t - click) / 0.15)) * pulse
    bw, bh = 620 * s, 130 * s
    f.rect(W / 2 - bw / 2, 560 - bh / 2, W / 2 + bw / 2, 560 + bh / 2, fill=(PANEL if pressed else YEL), outline=YEL, width=4, r=bh / 2, world=False)
    f.text(W / 2 - (24 if pressed else 0), 562, 'INSCRITO' if pressed else 'INSCREVA-SE', 56 * s, fill=(WHITE if pressed else NAVY))
    if pressed:
        x0 = W / 2 + 150
        f.line([(x0 - 22, 562), (x0 - 4, 582), (x0 + 28, 540)], YEL, 12, world=False)
        ring = clamp((t - click) / 0.6)
        f.circle(W / 2, 560, 330 * ring + 10, outline=YEL + (int(200 * (1 - ring)),), width=6, world=False)
    # cursor
    cx = W / 2 + 380 - 230 * ease_io((t - (click - 0.8)) / 0.7)
    cy = 760 - 170 * ease_io((t - (click - 0.8)) / 0.7)
    f.poly([(cx, cy), (cx + 0, cy + 60), (cx + 16, cy + 46), (cx + 28, cy + 72), (cx + 40, cy + 66), (cx + 28, cy + 40), (cx + 48, cy + 40)], WHITE, world=False)
    bell = clamp((t - click - 0.2) / 0.4)
    if bell > 0:
        sw = math.sin(t * 30) * 12 * (1 - clamp((t - click - 0.2) / 1.2)) + 3 * math.sin(t * 3)
        bx, by = W / 2 + 430 + sw, 560
        f.circle(W / 2 + 430, 560, 62, fill=YEL, world=False)
        f.poly([(bx - 24, by + 18), (bx - 18, by - 16), (bx - 8, by - 28), (bx + 8, by - 28), (bx + 18, by - 16), (bx + 24, by + 18)], NAVY, world=False)
        f.rect(bx - 32, by + 14, bx + 32, by + 24, fill=NAVY, r=5, world=False)
        f.circle(bx, by + 32, 7, fill=NAVY, world=False)
        f.circle(bx, by - 32, 5, fill=NAVY, world=False)
    f.text(W / 2, 820, 'Os segredos escondidos no seu cotidiano', 40, fill=MUTED, weight='SemiBold')


SCENES = {5: s05, 7: s07, 8: s08, 9: s09, 10: s10, 11: s11, 12: s12, 13: s13, 14: s14, 15: s15,
          17: s17, 18: s18, 20: s20, 23: s23, 24: s24}

# Short on-screen headline per scene for the vertical (Shorts) layout.
VERTICAL_HEAD = {5: 'NENHUMA CAUSA?', 7: 'CONGESTIONAMENTO FANTASMA', 8: '1 MOTORISTA FREIA',
                 9: 'TEMPO DE REAÇÃO', 10: 'FREIA UM POUCO MAIS', 11: 'EFEITO EM CADEIA', 12: 'EFEITO SANFONA',
                 13: 'A ONDA VAI PARA TRÁS', 14: 'O EXPERIMENTO', 15: 'SEM OBSTÁCULO NENHUM',
                 17: 'COMO EVITAR', 18: 'CONTROLE INTELIGENTE', 20: 'REAÇÃO EM CADEIA', 23: '', 24: ''}


def render_scene(num, scene, project, out_dir, sims, base, vertical=False, still=None, anim=None):
    tm = Timing(scene, project)
    anim = anim or num
    SAFE['right'] = 1700 if vertical else W - 48
    fn = SCENES[anim]
    frames = int(round(tm.dur * FPS))
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f'scene-{num:02d}.mp4')
    ow, oh = (1080, 1920) if vertical else (W, H)

    def draw(k):
        t = k / FPS
        fr = Frame(base)
        fn(fr, t, tm, sims)
        img = fr.im.resize((W, H), Image.LANCZOS)
        if vertical:
            img = compose_vertical(img, anim, t)
        return img

    if still is not None:
        img = draw(int(still * FPS))
        path = os.path.join(out_dir, f'still-{num:02d}.jpg')
        img.save(path, quality=88)
        return path
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{ow}x{oh}', '-r', str(FPS), '-i', '-',
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for k in range(frames):
        proc.stdin.write(draw(k).tobytes())
    proc.stdin.close()
    proc.wait()
    if proc.returncode:
        raise SystemExit(f'ffmpeg falhou na cena {num}')
    return out


_vbase = {}


def compose_vertical(stage, num, t):
    """9:16 layout: brand bar, scene headline, the 16:9 stage, room for subtitles."""
    if 'bg' not in _vbase:
        bg = make_base(1080, 1920, grid=True).resize((1080, 1920), Image.LANCZOS)
        _vbase['bg'] = bg
    img = _vbase['bg'].copy()
    # the side margins of the 16:9 stage are empty: crop them so everything is 26% bigger
    st = stage.crop((200, 0, 1720, 1080)).resize((1080, 768), Image.LANCZOS)
    img.paste(st, (0, 520))
    d = ImageDraw.Draw(img, 'RGBA')
    d.rectangle([0, 516, 1080, 520], fill=YEL)
    d.rectangle([0, 1288, 1080, 1292], fill=YEL)
    f1 = ImageFont.truetype(os.path.join(FONT_DIR, 'Montserrat-ExtraBold.ttf'), 34)
    d.text((540, 150), 'AGORA FAZ SENTIDO', font=f1, fill=YEL, anchor='mm')
    head = VERTICAL_HEAD.get(num, '')
    if head:
        a = int(255 * ease_out(t / 0.4))
        size = 74 if len(head) <= 16 else 58
        f2 = ImageFont.truetype(os.path.join(FONT_DIR, 'Montserrat-ExtraBold.ttf'), size)
        words = head.split(' ')
        lines, cur = [], ''
        for w_ in words:
            nxt = (cur + ' ' + w_).strip()
            if f2.getlength(nxt) > 960 and cur:
                lines.append(cur)
                cur = w_
            else:
                cur = nxt
        lines.append(cur)
        y0 = 345 - (len(lines) - 1) * size * 0.6
        for i, ln in enumerate(lines):
            d.text((540, y0 + i * size * 1.15), ln, font=f2, fill=(255, 255, 255, a), anchor='mm')
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--timeline', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--scenes', default='')
    ap.add_argument('--vertical', action='store_true')
    ap.add_argument('--still', type=float, default=None, help='render one JPEG at this time (s) instead of a video')
    ap.add_argument('--map', default='', help='k:m pairs — timeline scene k drawn with animation m (e.g. Shorts)')
    args = ap.parse_args()
    tl = json.load(open(args.timeline))
    project = os.path.dirname(os.path.abspath(args.timeline))
    mapping = {int(a): int(b) for a, b in (p.split(':') for p in args.map.split(',') if p.strip())}
    wanted = [int(s) for s in args.scenes.split(',') if s.strip()] or (sorted(mapping) if mapping else sorted(SCENES))
    sims = Sims()
    print(f'onda para trás na simulação: {sims.wave_kmh:.1f} km/h', flush=True)
    base = make_base()
    for num in wanted:
        scene = next(s for s in tl['scenes'] if s['scene'] == num)
        path = render_scene(num, scene, project, args.out, sims, base, vertical=args.vertical, still=args.still,
                            anim=mapping.get(num, num))
        print(f'cena {num:02d}: {path}', flush=True)


if __name__ == '__main__':
    main()
