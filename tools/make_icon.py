# -*- coding: utf-8 -*-
"""
生成 LiveReview 全套图标：resources/icon.png / icon.ico / src/renderer/assets/logo.svg

三处（程序内左上角 / 任务栏 / exe 本体）使用同一份几何与配色：
    - exe 与任务栏：icon.ico（多尺寸）
    - 程序内左上角：logo.svg（Vite 打包进渲染层）

设计：赭红渐变圆角方 + 纸白「播放三角 + 声浪条」，沿用暖纸底 / 赭红的视觉系统。
改图标只需改下面的参数，重跑本脚本即可。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'resources')
ASSETS = os.path.join(ROOT, 'src', 'renderer', 'assets')

SIZE = 256          # 基准画布
SS = 4              # 超采样倍数（先画大再缩小，天然抗锯齿）
N = SIZE * SS

# ---------------------------------------------------------------- 配色
GRAD = [(198, 82, 74), (168, 50, 45), (126, 36, 32)]   # 亮赭红 -> 赭红 -> 深赭
PAPER_WHITE = (253, 252, 249)

# ---------------------------------------------------------------- 几何（256 基准）
R = 58              # 圆角半径
TRI = [(45, 80), (45, 176), (127, 128)]                 # 播放三角（竖直边在左）
BARS = [(145, 44), (171, 78), (197, 44)]                # (x, 高度)，宽 15，垂直居中于 128
BAR_W = 15


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def grad_at(t):
    """三段渐变：0 -> 0.5 -> 1"""
    if t < 0.5:
        return lerp(GRAD[0], GRAD[1], t / 0.5)
    return lerp(GRAD[1], GRAD[2], (t - 0.5) / 0.5)


def build_base():
    """渐变圆角方：先生成渐变方块，再用圆角蒙版裁出"""
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    buf = bytearray()
    denom = 2.0 * (N - 1)
    for y in range(N):
        for x in range(N):
            r, g, b = grad_at((x + y) / denom)
            buf += bytes((r, g, b, 255))
    flat = Image.frombytes('RGBA', (N, N), bytes(buf))
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=R * SS, fill=255)
    img.paste(flat, (0, 0), mask)
    return img, mask


def build():
    img, mask = build_base()
    d = ImageDraw.Draw(img)

    # 内描边：一圈极淡的高光，小尺寸下让边缘更利落
    d.rounded_rectangle(
        [SS * 2, SS * 2, N - 1 - SS * 2, N - 1 - SS * 2],
        radius=max(1, (R - 2) * SS),
        outline=(255, 255, 255, 34),
        width=max(1, SS),
    )

    # 播放三角
    d.polygon([(p[0] * SS, p[1] * SS) for p in TRI], fill=PAPER_WHITE + (255,))

    # 声浪条（圆角竖条，垂直居中）
    for x, h in BARS:
        y0 = 128 - h / 2
        y1 = 128 + h / 2
        d.rounded_rectangle(
            [x * SS, y0 * SS, (x + BAR_W) * SS, y1 * SS],
            radius=BAR_W * SS / 2,
            fill=PAPER_WHITE + (255,),
        )

    # 缩回基准尺寸（LANCZOS 抗锯齿）
    out = img.resize((SIZE, SIZE), Image.LANCZOS)

    # 圆角外仍是透明：再套一次精确蒙版，消除缩放带来的边缘杂色
    m = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, fill=255)
    final = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(out, (0, 0), m)
    return final


SVG_TMPL = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c6524a"/>
      <stop offset="0.5" stop-color="#a8322d"/>
      <stop offset="1" stop-color="#7e2420"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="{r}" ry="{r}" fill="url(#g)"/>
  <rect x="2" y="2" width="252" height="252" rx="{r2}" ry="{r2}" fill="none" stroke="#ffffff" stroke-opacity="0.13"/>
  <polygon points="{tri}" fill="#fdfcf9"/>
  {bars}
</svg>
'''


def write_svg():
    bars = '\n  '.join(
        '<rect x="%d" y="%d" width="%d" height="%d" rx="%d" ry="%d" fill="#fdfcf9"/>'
        % (x, 128 - h / 2, BAR_W, h, BAR_W / 2, BAR_W / 2)
        for x, h in BARS
    )
    svg = SVG_TMPL.format(
        r=R,
        r2=R - 2,
        tri=' '.join('%d,%d' % p for p in TRI),
        bars=bars,
    )
    os.makedirs(ASSETS, exist_ok=True)
    with open(os.path.join(ASSETS, 'logo.svg'), 'w', encoding='utf-8') as f:
        f.write(svg)


def main():
    os.makedirs(RES, exist_ok=True)
    img = build()

    img.save(os.path.join(RES, 'icon.png'))

    # ICO：Windows 会按场景挑尺寸（任务栏 / 资源管理器 / Alt-Tab 各取所需）
    sizes = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(
        os.path.join(RES, 'icon.ico'),
        format='ICO',
        sizes=sizes,
    )

    write_svg()

    print('icon.png  ', os.path.join(RES, 'icon.png'))
    print('icon.ico  ', os.path.join(RES, 'icon.ico'), sizes)
    print('logo.svg  ', os.path.join(ASSETS, 'logo.svg'))


if __name__ == '__main__':
    main()
