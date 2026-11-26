# The MOSSES layout's pictures (hansol/mods/hansol/mosses/): run once, the output is committed.
#   python -X utf8 hansol/tools/mosses-assets.py
# All pictures are made here from noise and geometry (no outside artwork): deep space, a star layer, eight planets, glows, the carrier's
# schematic, and the SVG masks that turn. The Herdr window (GPUI) has no blur or radial gradient of its own, so the soft light is in the pictures.
import math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mods", "hansol", "mosses")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(11)


def fbm(w, h, octaves=6, base=4, seed=None, wrap=False):
    r = np.random.default_rng(seed) if seed is not None else rng
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        gw, gh = base * 2 ** o, max(2, int(base * 2 ** o * h / w))
        g = r.random((gh, gw)).astype(np.float32)
        if wrap:
            g = np.concatenate([g, g[:, :1]], axis=1)
        im = Image.fromarray((g * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        out += np.asarray(im, np.float32) / 255 * amp
        tot += amp
        amp *= 0.5
    return out / tot


def ramp(v, stops):
    v = np.clip(v, 0, 1)
    out = np.zeros(v.shape + (3,), np.float32)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (v >= p0) & (v <= p1)
        t = ((v - p0) / max(1e-6, p1 - p0))[..., None]
        out = np.where(m[..., None], np.array(c0, np.float32) * (1 - t) + np.array(c1, np.float32) * t, out)
    return out


def hx(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def save(arr, name, **kw):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(os.path.join(OUT, name), **kw)


def blur(a, radius):
    return np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255


# ---- deep space: blue clouds, dust lanes, stars
def space():
    W, H = 1920, 1200
    a, b, c = fbm(W, H, 7, 3, 1), fbm(W, H, 6, 5, 2), fbm(W, H, 5, 2, 3)
    cloud = np.clip((a * 0.65 + b * 0.35 - 0.42) * 2.6, 0, 1) ** 1.5
    lane = np.clip((c - 0.45) * 3.0, 0, 1)
    col = ramp(cloud * (0.55 + 0.45 * lane), [(0, hx("#01030c")), (0.25, hx("#04103a")), (0.55, hx("#0b2a86")), (0.8, hx("#2a62d8")), (1, hx("#8fd0ff"))])
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vig = 1 - 0.55 * np.clip(((xx / W - 0.5) ** 2 + (yy / H - 0.5) ** 2) * 2.2, 0, 1)
    col *= vig[..., None] * 0.9
    star = np.zeros((H, W), np.float32)
    n = 2600
    star[rng.integers(0, H, n), rng.integers(0, W, n)] = rng.random(n) ** 3
    big = np.zeros((H, W), np.float32)
    n = 90
    big[rng.integers(0, H, n), rng.integers(0, W, n)] = 0.6 + 0.4 * rng.random(n)
    bigb = np.clip(blur(big, 1.6) * 9, 0, 1)
    col += (star[..., None] * 200 + bigb[..., None] * 255) * np.array([0.85, 0.92, 1.0])
    save(col, "space.jpg", quality=88)


# ---- a star layer that drifts
def starlayer():
    W, H = 1600, 900
    a = np.zeros((H, W), np.float32)
    n = 110  # few and faint (240 bright dots in four layers read as noise)
    a[rng.integers(0, H, n), rng.integers(0, W, n)] = 0.2 + 0.35 * rng.random(n)
    b = np.zeros((H, W), np.float32)
    b[rng.integers(0, H, 8), rng.integers(0, W, 8)] = 1.0  # eight bright ones with a soft core
    al = np.clip(a + blur(a, 0.8) * 2 + b + blur(b, 1.6) * 9, 0, 1)
    out = np.zeros((H, W, 4), np.float32)
    out[..., :3] = (215, 232, 255)
    out[..., 3] = al * 255
    save(out, "stars.png", optimize=True)


# ---- planets: a lit sphere with a surface, an atmosphere and (one) a ring. The picture is E times the planet's diameter.
E = 1.6


def planet(name, kind, cols, atmo, seed, ring=None, bands=9.0, veins=None):
    S = 560
    N = S * 2
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    x = (xx / (N - 1) * 2 - 1) * E
    y = (yy / (N - 1) * 2 - 1) * E
    r2 = x * x + y * y
    r = np.sqrt(r2)
    inside = r <= 1
    z = np.sqrt(np.clip(1 - r2, 0, 1))
    L = np.array([-0.56, -0.48, 0.67], np.float32)
    L /= np.linalg.norm(L)
    lam = np.clip(x * L[0] + y * L[1] + z * L[2], 0, 1)
    u = np.arctan2(x, z + 1e-6) / math.pi * 0.5 + 0.5
    v = np.arcsin(np.clip(y, -1, 1)) / math.pi + 0.5
    tex = fbm(1024, 512, 7, 4, seed, wrap=True)
    tex2 = fbm(1024, 512, 6, 8, seed + 50, wrap=True)
    iu = np.clip((u * 0.5 * 1023).astype(int), 0, 1023)
    iv = np.clip((v * 511).astype(int), 0, 511)
    t1, t2 = tex[iv, iu], tex2[iv, iu]
    if kind == "gas":
        val = 0.5 + 0.16 * np.sin((v + (t2 - 0.5) * 0.08) * bands * math.pi + (t1 - 0.5) * 2.0) + (t2 - 0.5) * 0.5 + (t1 - 0.5) * 0.25  # soft bands that drift (they were toy stripes)
    elif kind == "rock":
        val = np.clip((t1 - 0.36) * 2.4, 0, 1) * 0.75 + t2 * 0.25
    else:
        val = np.clip((t1 * 0.7 + t2 * 0.3 - 0.3) * 1.9, 0, 1)
    surf = ramp(val, cols)
    A = np.array(hx(atmo), np.float32)
    fres = (1 - z) ** 3.0
    shade = (lam ** 1.3)[..., None]  # a dark night side, a sharp terminator
    col = surf * shade + A * (fres ** 2 * (0.05 + 1.2 * lam))[..., None]
    if veins:  # glowing cracks (lava, lit ice): their own light, brightest on the night side
        vein = np.clip(1 - np.abs(t2 - 0.5) / 0.03, 0, 1) ** 2 * inside
        col = col + np.array(hx(veins), np.float32) * (vein * (0.45 + 0.55 * (1 - lam)))[..., None]
    alpha = inside.astype(np.float32)
    lit = np.clip((x * L[0] + y * L[1]) / np.maximum(r, 1e-3) * 0.6 + 0.55, 0.08, 1)
    halo = np.exp(-np.clip(r - 1, 0, None) * 9.0) * 0.55 * lit * (~inside)
    col = np.where(inside[..., None], col, A)
    alpha = np.maximum(alpha, halo)
    if ring:
        ra, rb, rc = ring
        rr = np.sqrt(x * x + (y / 0.26) ** 2)
        m = (rr > ra) & (rr < rb) & ~(inside & (y < 0))
        tone = 0.75 + 0.25 * np.sin(rr * 60)
        rcol = np.array(hx(rc), np.float32)[None, None, :] * tone[..., None]
        col = np.where(m[..., None], rcol, col)
        alpha = np.where(m, 0.8, alpha)
    out = np.dstack([col, alpha * 255])
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).resize((S, S), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)


def planets():
    planet("planet-0.png", "ocean", [(0, hx("#0a2f7a")), (0.45, hx("#1763b8")), (0.58, hx("#2a5a5a")), (0.8, hx("#3f6f6a")), (1, hx("#c9d6e2"))], "#7ec8ff", 21)
    planet("planet-1.png", "gas", [(0, hx("#5a3418")), (0.35, hx("#b9793a")), (0.6, hx("#e6c08a")), (1, hx("#f7e9cf"))], "#ffd9a0", 22, bands=11)
    planet("planet-2.png", "rock", [(0, hx("#3a1a12")), (0.5, hx("#9a4a2a")), (0.85, hx("#d98a55")), (1, hx("#f0c9a0"))], "#ff9d6a", 23)
    planet("planet-3.png", "gas", [(0, hx("#123a5a")), (0.4, hx("#2a86a8")), (0.7, hx("#7fd3d8")), (1, hx("#e2fbff"))], "#8ff0ff", 24, bands=7)
    planet("planet-4.png", "rock", [(0, hx("#2a2c36")), (0.5, hx("#6d7284")), (0.85, hx("#b4bac8")), (1, hx("#f0f2f6"))], "#c8d8ff", 25)
    planet("planet-5.png", "gas", [(0, hx("#2a1a5a")), (0.4, hx("#6a48c0")), (0.7, hx("#b49af0")), (1, hx("#efe6ff"))], "#c8b0ff", 26, bands=13)
    planet("planet-6.png", "gas", [(0, hx("#0c2a4a")), (0.4, hx("#2f6f9a")), (0.7, hx("#8cc0d8")), (1, hx("#eaf6ff"))], "#bfe6ff", 27, ring=(1.25, 1.58, "#9fb8d0"), bands=8)
    planet("planet-7.png", "ocean", [(0, hx("#06343a")), (0.45, hx("#0f7f86")), (0.6, hx("#58c0a8")), (0.85, hx("#d8f0e0")), (1, hx("#ffffff"))], "#8fffe0", 28)
    new_planets()


def new_planets():  # 2026-11-27: four more looks (lava, ice, a ringed desert giant, an acid giant), so every work space can have its own
    planet("planet-8.png", "rock", [(0, hx("#0c0806")), (0.5, hx("#2a1a14")), (0.85, hx("#4a3026")), (1, hx("#6a4a3a"))], "#ff6a2a", 29, veins="#ff8a2a")
    planet("planet-9.png", "rock", [(0, hx("#7a9ab4")), (0.45, hx("#c4dcec")), (0.8, hx("#eef6fc")), (1, hx("#ffffff"))], "#dff4ff", 30, veins="#4ad8ff")
    planet("planet-10.png", "gas", [(0, hx("#4a2e10")), (0.4, hx("#a8742e")), (0.7, hx("#e2bc6e")), (1, hx("#fbeac0"))], "#ffd08a", 31, ring=(1.2, 1.62, "#d8b98a"), bands=10)
    planet("planet-11.png", "gas", [(0, hx("#1a3a10")), (0.4, hx("#5a9a2a")), (0.7, hx("#b8e05a")), (1, hx("#f2ffc8"))], "#c8ff7a", 32, bands=15)


# ---- soft lights
def glow(name, colour, size=128, k=5.0):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    r = np.sqrt((xx - size / 2 + 0.5) ** 2 + (yy - size / 2 + 0.5) ** 2) / (size / 2)
    r = r / 0.75  # nothing at all in the outer quarter: a stretched picture shows no edge
    a = np.where(r < 1, np.clip(np.exp(-r * r * k) - math.exp(-k), 0, 1), 0)
    out = np.zeros((size, size, 4), np.float32)
    out[..., :3] = hx(colour)
    out[a <= 0, :3] = 0
    out[..., 3] = a * 255
    save(out, name, optimize=True)


# ---- the carrier: a top view drawn from plain shapes (bow to the right)
def carrier():
    K = 4
    W, H = 560 * K, 190 * K
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c, f, m = (120, 215, 255, 255), (60, 150, 255, 46), H // 2

    def P(pts):
        return [(x * K, m + y * K) for x, y in pts]

    def shape(pts, w=2):
        d.polygon(P(pts), fill=f)
        d.line(P(pts + [pts[0]]), fill=c, width=w * K // 2, joint="curve")

    shape([(60, -22), (300, -26), (430, -16), (520, -4), (536, 0), (520, 4), (430, 16), (300, 26), (60, 22), (44, 10), (44, -10)])
    shape([(120, -30), (330, -34), (372, -58), (150, -62), (104, -46)])
    shape([(120, 30), (330, 34), (372, 58), (150, 62), (104, 46)])
    shape([(24, -40), (96, -40), (104, -28), (60, -24), (24, -26)])
    shape([(24, 40), (96, 40), (104, 28), (60, 24), (24, 26)])
    shape([(250, -10), (318, -8), (330, 0), (318, 8), (250, 10)], 1)
    thin = (120, 215, 255, 120)
    for x in range(150, 350, 22):
        d.line(P([(x, -58), (x + 10, -36)]), fill=thin, width=K // 2)
        d.line(P([(x, 58), (x + 10, 36)]), fill=thin, width=K // 2)
    for x in range(90, 500, 34):
        d.line(P([(x, -3), (x + 16, -3)]), fill=thin, width=K // 2)
        d.line(P([(x, 3), (x + 16, 3)]), fill=thin, width=K // 2)
    for y in (-33, 33):
        d.line(P([(6, y), (24, y)]), fill=(150, 230, 255, 220), width=K * 2)
    sm = im.resize((560, 190), Image.LANCZOS)
    a = np.asarray(sm.filter(ImageFilter.GaussianBlur(5)), np.float32).copy()
    a[..., 3] *= 0.7
    Image.alpha_composite(Image.fromarray(a.astype(np.uint8)), sm).save(os.path.join(OUT, "carrier.png"), optimize=True)


# ---- masks that turn (GPUI tints an SVG with text_color)
def svgs():
    def w(name, body):
        open(os.path.join(OUT, name), "w", encoding="utf8").write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none" stroke="#000" stroke-width="1">' + body + "</svg>")

    ticks = ""
    for i in range(72):
        a = i * math.pi / 36
        r1 = 99 if i % 6 == 0 else 95
        ticks += '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>' % (100 + 90 * math.cos(a), 100 + 90 * math.sin(a), 100 + r1 * math.cos(a), 100 + r1 * math.sin(a))
    w("ring-ticks.svg", '<circle cx="100" cy="100" r="90"/>' + ticks)
    seg = ""
    for a0, a1, sw in [(0.1, 1.2, 3), (1.5, 2.0, 1), (2.3, 3.6, 3), (3.9, 4.3, 1), (4.6, 5.9, 3)]:
        seg += '<path d="M %.2f %.2f A 96 96 0 0 1 %.2f %.2f" stroke-width="%d"/>' % (100 + 96 * math.cos(a0), 100 + 96 * math.sin(a0), 100 + 96 * math.cos(a1), 100 + 96 * math.sin(a1), sw)
    w("ring-seg.svg", seg)
    w("ring-dash.svg", '<circle cx="100" cy="100" r="96" stroke-dasharray="2 9"/>')
    w("sweep.svg", '<path d="M 100 100 L 100 4 A 96 96 0 0 1 148 16.9 Z" fill="#000" fill-opacity="0.35" stroke="none"/><line x1="100" y1="100" x2="100" y2="4" stroke-width="1.5"/>')


# ---- a near planet seen from low orbit: the upper right part of a big sphere, a lit rim, clouds, a faint coordinate grid, lights on the night side
def limb():
    N = 1200
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    R, cx, cy = 1180.0, -160.0, 1330.0
    x, y = (xx - cx) / R, (yy - cy) / R
    r2 = x * x + y * y
    r = np.sqrt(r2)
    inside = r <= 1
    z = np.sqrt(np.clip(1 - r2, 0, 1))
    u = np.arctan2(x, z + 1e-6) / math.pi + 0.5
    v = np.arcsin(np.clip(y, -1, 1)) / math.pi + 0.5
    tex = fbm(2048, 1024, 8, 6, 71, wrap=True)
    tex2 = fbm(2048, 1024, 7, 14, 72, wrap=True)
    iu = np.clip((u * 2047).astype(int), 0, 2047)
    iv = np.clip((v * 1023).astype(int), 0, 1023)
    cloud = np.clip((tex[iv, iu] * 0.6 + tex2[iv, iu] * 0.4 - 0.47) * 4.0, 0, 1)
    land = np.clip((tex2[iv, iu] - 0.5) * 5.0, 0, 1)
    L = np.array([0.62, -0.62, 0.48], np.float32)
    L /= np.linalg.norm(L)
    lam = np.clip(x * L[0] + y * L[1] + z * L[2], 0, 1)
    base = ramp(land, [(0, hx("#061a3e")), (0.5, hx("#0b2c5c")), (1, hx("#1d3a44"))])
    col = base * (0.10 + 0.9 * lam[..., None]) + np.array([200, 222, 255], np.float32) * (cloud * (0.05 + 0.85 * lam))[..., None]
    fres = (1 - z) ** 2.4
    col += np.array(hx("#59b8ff"), np.float32) * (fres * (0.35 + 0.9 * lam))[..., None]
    grid = (np.minimum(np.abs((u * 48) % 1 - 0.5), np.abs((v * 24) % 1 - 0.5)) < 0.015) & inside
    col += np.array([90, 170, 230], np.float32) * (grid * 0.10)[..., None]
    night = np.clip(0.25 - lam, 0, 1) * 4
    city = (fbm(2048, 1024, 3, 220, 73, wrap=True)[iv, iu] > 0.80) & (land > 0.5)
    col += np.array([255, 170, 90], np.float32) * (blur(city.astype(np.float32), 1.2) * 2.2 * night)[..., None]
    halo = np.exp(-np.clip(r - 1, 0, None) * R / 26.0) * 0.8 * (~inside)
    col = np.where(inside[..., None], col, np.array(hx("#6fc4ff"), np.float32))
    alpha = np.where(inside, 1.0, halo)
    out = np.dstack([col, alpha * 255])
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).resize((900, 900), Image.LANCZOS).save(os.path.join(OUT, "limb.png"), optimize=True)


# ---- moons (the agents): small cratered spheres, lit from the upper left
def moon(name, seed, tint):
    N = 192
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    x, y = xx / (N - 1) * 2 - 1, yy / (N - 1) * 2 - 1
    r2 = x * x + y * y
    inside = r2 <= 1
    z = np.sqrt(np.clip(1 - r2, 0, 1))
    L = np.array([-0.56, -0.48, 0.67], np.float32)
    L /= np.linalg.norm(L)
    lam = np.clip(x * L[0] + y * L[1] + z * L[2], 0, 1)
    tex = fbm(N, N, 5, 5, seed)
    crater = np.clip((fbm(N, N, 3, 14, seed + 9) - 0.62) * 9, 0, 1)
    val = np.clip(0.55 + (tex - 0.5) * 0.9 - crater * 0.35, 0, 1)
    col = np.array(hx(tint), np.float32)[None, None, :] * (val * (0.06 + 0.94 * lam ** 0.8))[..., None]
    a = np.clip((1 - np.sqrt(r2)) * N / 4, 0, 1)
    out = np.dstack([col, a * 255])
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)


space()
limb()
starlayer()
moon("moon-0.png", 41, "#e6e2da")
moon("moon-1.png", 42, "#d8c4a8")
moon("moon-2.png", 43, "#c2d2e2")
planets()
svgs()
for k, c in {"working": "#35c6dc", "blocked": "#ff9d3a", "done": "#3fd47f", "idle": "#9fb0c8", "shell": "#b59cff", "white": "#ffffff", "blue": "#4f9dff"}.items():
    glow("glow-%s.png" % k, c)
print("ok", sorted(os.listdir(OUT)))
