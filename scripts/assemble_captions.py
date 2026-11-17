"""文本框 / 气泡框专门组装：底案图 + 标签清单 -> 文字版图 + captions.json

设计原则（针对「模型自己画框」的问题：位置随机、无引导线、和元素脱节、字体不可控）：
  1. 图像只负责画面，框和字由本脚本确定性绘制（位置、尺寸、颜色、字体全部可控）；
  2. 每种框有明确语义：
       title  顶部标题胶囊（粗体、强调色条）
       label  贴边标签（圆角矩形 + 引导线指向锚点）
       bubble 气泡（带小尾巴指向锚点，用于提示/结论）
       footer 底部结论条
  3. 自动排版：按锚点分左右侧，纵向避让，超长自动换行/缩字号；
  4. 产出三件套：底案（原图）、文字版（带框带字）、captions.json（框位/文字/字号/颜色，便于 PPT 回填）。

用法（由 lib/captions.js 调用）：
  python assemble_captions.py --job job.json
job.json = {
  "base": "xxx.png", "out_dir": "out", "basename": "name",
  "width": 1344, "height": 768, "font": "C:/Windows/Fonts/msyh.ttc", "font_bold": "...msyhbd.ttc",
  "labels": [{"text":"边缘 / 颜色","shape":"label","side":"right","anchor":[0.62,0.42],"color":"#3b7ea1"}]
}
"""

import argparse
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

DEFAULT_COLORS = ["#3b7ea1", "#c98a2b", "#8a5fbf", "#2f8f6b", "#b5546a"]


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def text_size(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def wrap_text(draw, text, font, max_width):
    lines = []
    current = ""
    for char in text:
        candidate = current + char
        if text_size(draw, candidate, font)[0] <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = char
    if current:
        lines.append(current)
    return lines


def fit_font(draw, text, font_path, size, max_width, max_lines=2):
    for candidate in range(size, 12, -2):
        font = load_font(font_path, candidate)
        lines = wrap_text(draw, text, font, max_width)
        if len(lines) <= max_lines:
            return font, lines
    font = load_font(font_path, 14)
    return font, wrap_text(draw, text, font, max_width)[:max_lines]


def rounded(draw, xy, radius, fill, outline, width=2):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def add_shadow(base, box, radius, offset=(0, 4), alpha=60):
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0 + offset[0], y0 + offset[1], x1 + offset[0], y1 + offset[1]), radius=radius, fill=(0, 0, 0, alpha))
    base.alpha_composite(shadow)


def hex_rgba(color, alpha=255):
    color = color.lstrip("#")
    if len(color) == 3:
        color = "".join(ch * 2 for ch in color)
    return (int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16), alpha)


def lighten(color, amount=0.86):
    color = color.lstrip("#")
    rgb = [int(color[i:i + 2], 16) for i in (0, 2, 4)]
    rgb = [int(channel + (255 - channel) * amount) for channel in rgb]
    return "#%02x%02x%02x" % tuple(rgb)


def draw_bubble(draw, base, box, radius, fill, outline, anchor, text_pos, text):
    # 圆角主体
    rounded(draw, box, radius, fill, outline, 2)
    # 尾巴：从框体近锚点的一边中点指向锚点
    x0, y0, x1, y1 = box
    ax, ay = anchor
    if ax < x0:
        start = (x0, (y0 + y1) / 2)
    elif ax > x1:
        start = (x1, (y0 + y1) / 2)
    elif ay < y0:
        start = ((x0 + x1) / 2, y0)
    else:
        start = ((x0 + x1) / 2, y1)
    spread = 12
    if start[0] in (x0, x1):
        p1 = (start[0], start[1] - spread)
        p2 = (start[0], start[1] + spread)
    else:
        p1 = (start[0] - spread, start[1])
        p2 = (start[0] + spread, start[1])
    draw.polygon([p1, p2, (ax, ay)], fill=hex_rgba(fill, 255), outline=hex_rgba(outline, 255))
    draw.polygon([p1, p2, (ax, ay)], outline=hex_rgba(outline))


def draw_leader(draw, box, anchor, color):
    x0, y0, x1, y1 = box
    ax, ay = anchor
    if ax < x0:
        start = (x0, (y0 + y1) / 2)
    elif ax > x1:
        start = (x1, (y0 + y1) / 2)
    elif ay < y0:
        start = ((x0 + x1) / 2, y0)
    else:
        start = ((x0 + x1) / 2, y1)
    draw.line([start, (ax, ay)], fill=hex_rgba(color), width=2)
    r = 4
    draw.ellipse((ax - r, ay - r, ax + r, ay + r), fill=hex_rgba(color))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    args = parser.parse_args()
    with open(args.job, "r", encoding="utf-8") as handle:
        job = json.load(handle)

    base = Image.open(job["base"]).convert("RGBA")
    width, height = base.size
    font_path = job.get("font") or "C:/Windows/Fonts/msyh.ttc"
    font_bold = job.get("font_bold") or font_path
    draw = ImageDraw.Draw(base)
    margin = max(16, int(min(width, height) * 0.03))
    title_size = max(20, int(min(width, height) * 0.045))
    label_size = max(14, int(min(width, height) * 0.028))
    result = []

    labels = job.get("labels") or []
    # 先排 title / footer，再排 label/bubble（沿锚点侧边纵向避让）
    title = next((item for item in labels if item.get("shape") == "title"), None)
    footer = next((item for item in labels if item.get("shape") == "footer"), None)
    middles = [item for item in labels if item.get("shape") not in ("title", "footer")]

    def place_title(item):
        font, lines = fit_font(draw, item["text"], font_bold, title_size, int(width * 0.6), 1)
        tw, th = text_size(draw, lines[0], font)
        box = (margin, margin, margin + tw + 44, margin + th + 30)
        add_shadow(base, box, 12)
        rounded(draw, box, 12, hex_rgba("#ffffff", 242), hex_rgba(item.get("color") or DEFAULT_COLORS[0]), 3)
        draw.rectangle((box[0] + 10, box[1] + 8, box[0] + 16, box[3] - 8), fill=hex_rgba(item.get("color") or DEFAULT_COLORS[0]))
        draw.text((box[0] + 26, box[1] + 14), lines[0], font=font, fill=hex_rgba("#1d1d1f"))
        result.append({"shape": "title", "text": item["text"], "box": list(box), "color": item.get("color") or DEFAULT_COLORS[0], "font_size": font.size})

    def place_footer(item):
        font, lines = fit_font(draw, item["text"], font_path, label_size, int(width * 0.7), 1)
        tw, th = text_size(draw, lines[0], font)
        box = ((width - tw - 40) / 2, height - margin - th - 24, (width + tw + 40) / 2, height - margin)
        add_shadow(base, box, 14)
        rounded(draw, box, 14, hex_rgba("#ffffff", 242), hex_rgba(item.get("color") or DEFAULT_COLORS[2]), 2)
        draw.text(((width - tw) / 2, box[1] + 12), lines[0], font=font, fill=hex_rgba("#1d1d1f"))
        result.append({"shape": "footer", "text": item["text"], "box": list(box), "color": item.get("color") or DEFAULT_COLORS[2], "font_size": font.size})

    if title:
        place_title(title)
    if footer:
        place_footer(footer)

    # 侧边标签：按 side 分组，纵向均分避让
    sides = {"right": [], "left": [], "top": [], "bottom": []}
    for item in middles:
        side = item.get("side") or ("right" if (item.get("anchor") or [0.5, 0.5])[0] >= 0.5 else "left")
        sides[side if side in sides else "right"].append(item)

    for side, items in sides.items():
        if not items:
            continue
        if side in ("top", "bottom"):
            slot_w = (width - margin * 2) / max(len(items), 1)
            for index, item in enumerate(items):
                color = item.get("color") or DEFAULT_COLORS[index % len(DEFAULT_COLORS)]
                font, lines = fit_font(draw, item["text"], font_bold, label_size, int(slot_w * 0.8), 1)
                tw = text_size(draw, lines[0], font)[0]
                box_w = tw + 28
                box_h = text_size(draw, "汉", font)[1] + 20
                cx = margin + slot_w * index + slot_w / 2
                top = margin + (title_size + 50) if side == "top" else height - margin - box_h - (label_size + 46 if footer else 0)
                box = (cx - box_w / 2, top, cx + box_w / 2, top + box_h)
                anchor = item.get("anchor")
                anchor = (anchor[0] * width, anchor[1] * height) if anchor else (cx, box[3] + 20 if side == "top" else box[1] - 20)
                add_shadow(base, box, 10)
                rounded(draw, box, 10, hex_rgba(lighten(color, 0.92), 238), hex_rgba(color), 2)
                draw.text((box[0] + 14, box[1] + 10), lines[0], font=font, fill=hex_rgba("#1d1d1f"))
                draw_leader(draw, box, anchor, color)
                result.append({"shape": item.get("shape") or "label", "text": item["text"], "box": list(box), "anchor": list(anchor), "side": side, "color": color, "font_size": font.size})
            continue
        box_width = int(width * 0.22)
        slot_height = (height - margin * 2 - (title_size + 40 if title else 0) - (label_size + 40 if footer else 0)) / max(len(items), 1)
        for index, item in enumerate(items):
            color = item.get("color") or DEFAULT_COLORS[index % len(DEFAULT_COLORS)]
            font, lines = fit_font(draw, item["text"], font_bold, label_size, box_width - 28, 2)
            line_h = text_size(draw, "汉", font)[1] + 6
            box_h = line_h * len(lines) + 20
            box_w = max(text_size(draw, line, font)[0] for line in lines) + 28
            top = margin + (title_size + 44 if title else 0) + slot_height * index + slot_height / 2 - box_h / 2
            if side == "right":
                x1 = width - margin
                x0 = x1 - box_w
            else:
                x0 = margin
                x1 = x0 + box_w
            box = (x0, top, x1, top + box_h)
            anchor = item.get("anchor")
            anchor = (anchor[0] * width, anchor[1] * height) if anchor else ((x0 - 24) if side == "right" else (x1 + 24), top + box_h / 2)
            add_shadow(base, box, 10)
            if (item.get("shape") or "label") == "bubble":
                draw_bubble(draw, base, box, 10, lighten(color, 0.92), color, anchor, None, None)
            else:
                rounded(draw, box, 10, hex_rgba(lighten(color, 0.92), 238), hex_rgba(color), 2)
            y = box[1] + 10
            for line in lines:
                draw.text((box[0] + 14, y), line, font=font, fill=hex_rgba("#1d1d1f"))
                y += line_h
            draw_leader(draw, box, anchor, color)
            result.append({"shape": item.get("shape") or "label", "text": item["text"], "box": list(box), "anchor": list(anchor), "side": side, "color": color, "font_size": font.size})

    out_dir = job.get("out_dir") or os.path.dirname(job["base"])
    os.makedirs(out_dir, exist_ok=True)
    basename = job.get("basename") or os.path.splitext(os.path.basename(job["base"]))[0]
    base_path = os.path.join(out_dir, basename + "_底案.png")
    text_path = os.path.join(out_dir, basename + "_文字版.png")
    manifest_path = os.path.join(out_dir, basename + "_captions.json")

    Image.open(job["base"]).convert("RGB").save(base_path)
    base.convert("RGB").save(text_path)
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump({"base": base_path, "text": text_path, "canvas": [width, height], "boxes": result}, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "base": base_path, "text": text_path, "manifest": manifest_path, "boxes": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
