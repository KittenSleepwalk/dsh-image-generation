"""生成气泡框/标注框素材（透明 PNG）：框内白色底、彩色边框，框外完全透明，可在 PPT 里任意拉伸。

产物：assets/callouts/{color}-{shape}.png + manifest.json
  shapes: rounded（圆角矩形）、bubble_left / bubble_right / bubble_top / bubble_bottom（带尾巴气泡）、pill（胶囊）、tag（标签）
  colors: blue / amber / purple / green / red
manifest 记录每种 shape 的宽高比、内容区内边距（0-1 相对），供 PPT 放文字框用。
"""

import json
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "assets", "callouts"))

COLORS = {
    "blue": "#3b7ea1",
    "amber": "#c98a2b",
    "purple": "#8a5fbf",
    "green": "#2f8f6b",
    "red": "#b5546a",
}
SCALE = 4  # 4x 超采样，PPT 拉伸时更平滑
BASE_W, BASE_H = 430, 130
TAIL = 26


def rgb(hex_color):
    value = hex_color.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), 255)


def draw_rounded(draw, box, radius, fill, outline, width):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_shape(shape, color_hex):
    w, h = BASE_W * SCALE, BASE_H * SCALE
    border = 6 * SCALE
    radius = 24 * SCALE
    if shape in ("bubble_left", "bubble_right", "bubble_top", "bubble_bottom"):
        canvas_w = w + (TAIL * SCALE if shape in ("bubble_left", "bubble_right") else 0)
        canvas_h = h + (TAIL * SCALE if shape in ("bubble_top", "bubble_bottom") else 0)
    else:
        canvas_w, canvas_h = w, h
    image = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    fill = (255, 255, 255, 246)
    outline = rgb(color_hex)

    if shape == "bubble_left":
        box = (TAIL * SCALE, 0, canvas_w, h)
        draw_rounded(draw, box, radius, fill, outline, border)
        cy = h // 2
        draw.polygon([(TAIL * SCALE, cy - 18 * SCALE), (TAIL * SCALE, cy + 18 * SCALE), (0, cy)], fill=fill, outline=outline)
    elif shape == "bubble_right":
        box = (0, 0, canvas_w - TAIL * SCALE, h)
        draw_rounded(draw, box, radius, fill, outline, border)
        cy = h // 2
        draw.polygon([(box[2], cy - 18 * SCALE), (box[2], cy + 18 * SCALE), (canvas_w, cy)], fill=fill, outline=outline)
    elif shape == "bubble_top":
        box = (0, TAIL * SCALE, w, canvas_h)
        draw_rounded(draw, box, radius, fill, outline, border)
        cx = w // 2
        draw.polygon([(cx - 18 * SCALE, TAIL * SCALE), (cx + 18 * SCALE, TAIL * SCALE), (cx, 0)], fill=fill, outline=outline)
    elif shape == "bubble_bottom":
        box = (0, 0, w, canvas_h - TAIL * SCALE)
        draw_rounded(draw, box, radius, fill, outline, border)
        cx = w // 2
        draw.polygon([(cx - 18 * SCALE, box[3]), (cx + 18 * SCALE, box[3]), (cx, canvas_h)], fill=fill, outline=outline)
    elif shape == "pill":
        draw_rounded(draw, (0, 0, w, h), h // 2, fill, outline, border)
    elif shape == "tag":
        box = (0, 0, w - 26 * SCALE, h)
        draw_rounded(draw, box, radius, fill, outline, border)
        draw.polygon([(box[2], h // 2 - 20 * SCALE), (box[2], h // 2 + 20 * SCALE), (w, h // 2)], fill=fill, outline=outline)
    else:  # rounded
        draw_rounded(draw, (0, 0, w, h), radius, fill, outline, border)
    return image


def main():
    os.makedirs(OUT, exist_ok=True)
    shapes = ["rounded", "bubble_left", "bubble_right", "bubble_top", "bubble_bottom", "pill", "tag"]
    manifest = {"shapes": {}}
    for shape in shapes:
        for name, color in COLORS.items():
            image = make_shape(shape, color)
            path = os.path.join(OUT, f"{name}-{shape}.png")
            image.save(path)
        image = make_shape(shape, COLORS["blue"])
        aspect = round(image.width / image.height, 4)
        # 内容区（给文字框用）：避开尾巴
        inset = {"left": 0.02, "right": 0.02, "top": 0.06, "bottom": 0.06}
        if shape == "bubble_left":
            inset["left"] = round(TAIL * SCALE / image.width, 4) + 0.02
        elif shape == "bubble_right":
            inset["right"] = round(TAIL * SCALE / image.width, 4) + 0.02
        elif shape == "bubble_top":
            inset["top"] = round(TAIL * SCALE / image.height, 4) + 0.04
        elif shape == "bubble_bottom":
            inset["bottom"] = round(TAIL * SCALE / image.height, 4) + 0.04
        elif shape == "tag":
            inset["right"] = round(26 * SCALE / image.width, 4) + 0.02
        manifest["shapes"][shape] = {"aspect": aspect, "inset": inset}
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=1)
    print(json.dumps({"ok": True, "dir": OUT, "shapes": len(shapes), "files": len(shapes) * len(COLORS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
