"""底案 → 可编辑 PPTX（文字与文字框全部由 PPT 生成；气泡框用透明 PNG 素材，可拉伸）

工作流（对齐用户要求）：
  1. 底案图：无文字、无框、无气泡；
  2. 气泡框/标注框：用 assets/callouts 下的**透明 PNG 素材**（框外全透明，框内白底彩边），
     在 PPT 里作为图片插入，可任意拉伸成文字所需的宽高；
  3. 文字：PPT 原生文本框叠在气泡图上（无底色无边框），可直接改字/字号/颜色；
  4. 引导线：PPT 原生圆点虚线（可改）；
  5. 保存 PPTX 原件，方便调版后截图出图。

用法：python export_ppt.py --job job.json
job = {
  "base": "底案.png", "out": "out.pptx", "slide_w": 1280, "slide_h": 720,
  "labels": [{"text":"防灾减灾","shape":"callout","side":"left","anchor":[0.25,0.35],"color":"#3b7ea1"}],
  "font": "微软雅黑"
}
shape: callout(圆角框) / bubble(气泡，尾巴指向锚点) / tag(标签) / footer(底部胶囊)
"""

import argparse
import json
import os
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Emu, Pt

PX = 9525  # 1 px = 9525 EMU
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, "..", "assets", "callouts"))
COLOR_NAMES = {
    "#3b7ea1": "blue",
    "#c98a2b": "amber",
    "#8a5fbf": "purple",
    "#2f8f6b": "green",
    "#b5546a": "red",
}
FALLBACK_COLORS = ["#3b7ea1", "#c98a2b", "#8a5fbf", "#2f8f6b", "#b5546a"]


def px(value):
    return Emu(int(round(value * PX)))


def rgb(hex_color):
    value = str(hex_color or "#3b7ea1").lstrip("#")
    return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def color_name(hex_color):
    value = str(hex_color or "").lower()
    return COLOR_NAMES.get(value, "blue")


def load_manifest():
    path = os.path.join(ASSETS, "manifest.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return {"shapes": {}}


def asset_path(shape, color_name_value):
    path = os.path.join(ASSETS, f"{color_name_value}-{shape}.png")
    if os.path.exists(path):
        return path
    fallback = os.path.join(ASSETS, f"blue-{shape}.png")
    return fallback if os.path.exists(fallback) else os.path.join(ASSETS, "blue-rounded.png")


def bubble_shape_for(side):
    return {
        "left": "bubble_right",   # 框在左边，尾巴朝右指向锚点
        "right": "bubble_left",   # 框在右边，尾巴朝左
        "top": "bubble_bottom",
        "bottom": "bubble_top",
    }.get(side, "bubble_left")


def add_picture_frame(slide, asset, box):
    slide.shapes.add_picture(asset, px(box[0]), px(box[1]), px(box[2]), px(box[3]))


def add_textbox(slide, box, text, color, font_name, size=15):
    shape = slide.shapes.add_textbox(px(box[0]), px(box[1]), px(box[2]), px(box[3]))
    frame = shape.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.margin_left = Emu(int(box[2] * 0.06 * PX))
    frame.margin_right = Emu(int(box[2] * 0.06 * PX))
    frame.margin_top = Emu(0)
    frame.margin_bottom = Emu(0)
    paragraph = frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.CENTER
    run = paragraph.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.name = font_name
    run.font.color.rgb = rgb(color)
    return shape


def content_box(box, shape, manifest):
    meta = (manifest.get("shapes") or {}).get(shape) or {}
    inset = meta.get("inset") or {"left": 0.02, "right": 0.02, "top": 0.06, "bottom": 0.06}
    x, y, w, h = box
    left = w * inset.get("left", 0.02)
    right = w * (1 - inset.get("right", 0.02))
    top = h * inset.get("top", 0.06)
    bottom = h * (1 - inset.get("bottom", 0.06))
    return (x + left, y + top, right - left, bottom - top)


def add_label(slide, item, box, side, manifest, color, font_name):
    shape_kind = item.get("shape") or "callout"
    if shape_kind == "bubble":
        shape = bubble_shape_for(side)
    elif shape_kind == "tag":
        shape = "tag"
    elif shape_kind == "footer":
        shape = "pill"
    else:
        shape = "rounded"
    name = color_name(color)
    asset = asset_path(shape, name)
    add_picture_frame(slide, asset, box)
    inner = content_box(box, shape, manifest)
    text_shape = add_textbox(slide, inner, item["text"], color, font_name)
    return shape, text_shape


def add_connector(slide, start, end, color):
    from pptx.enum.dml import MSO_LINE_DASH_STYLE
    line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, px(start[0]), px(start[1]), px(end[0]), px(end[1]))
    line.line.color.rgb = rgb(color)
    line.line.width = Pt(3)
    line.line.dash_style = MSO_LINE_DASH_STYLE.ROUND_DOT
    return line


def place_callouts(slide, labels, picture, slide_w, slide_h, font_name, manifest):
    band_top = picture["top"] + 40
    band_height = picture["h"] - 80
    groups = {"left": [], "right": [], "top": [], "bottom": []}
    for item in labels:
        groups.setdefault(item.get("side") or "left", []).append(item)
    placed = []
    for side, items in groups.items():
        for index, item in enumerate(items):
            color = item.get("color") or FALLBACK_COLORS[index % len(FALLBACK_COLORS)]
            text = item["text"]
            w = max(88, min(180, max(len(text), 4) * 15 + 30))
            h = 45
            if side == "left":
                x = 22
                y = band_top + band_height * (index + 0.5) / max(len(items), 1) - h / 2
            elif side == "right":
                x = slide_w - 22 - w
                y = band_top + band_height * (index + 0.5) / max(len(items), 1) - h / 2
            elif side == "top":
                x = slide_w * (index + 0.5) / max(len(items), 1) - w / 2
                y = picture["top"] + 10
            else:
                x = slide_w * (index + 0.5) / max(len(items), 1) - w / 2
                y = slide_h - 158
            box = item.get("box") or [x, y, w, h]
            shape, _text = add_label(slide, item, box, side, manifest, color, font_name)
            anchor = item.get("anchor")
            if anchor:
                anchor_px = (anchor[0] * slide_w, anchor[1] * slide_h)
                if side == "left":
                    start = (box[0] + box[2], box[1] + box[3] / 2)
                elif side == "right":
                    start = (box[0], box[1] + box[3] / 2)
                elif side == "top":
                    start = (box[0] + box[2] / 2, box[1] + box[3])
                else:
                    start = (box[0] + box[2] / 2, box[1])
                add_connector(slide, start, anchor_px, color)
            placed.append({"text": text, "box": box, "color": color, "side": side, "frame": shape})
    return placed


def add_footer(slide, item, slide_w, slide_h, font_name, manifest):
    text = item["text"]
    w = min(slide_w * 0.62, max(240, len(text) * 17 + 70))
    h = 45
    x = (slide_w - w) / 2
    y = slide_h - 158
    color = item.get("color") or "#8a5fbf"
    box = [x, y, w, h]
    add_picture_frame(slide, asset_path("pill", color_name(color)), box)
    inner = content_box(box, "pill", manifest)
    add_textbox(slide, inner, text, color, font_name)
    return box


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    args = parser.parse_args()
    with open(args.job, "r", encoding="utf-8") as handle:
        job = json.load(handle)

    slide_w = int(job.get("slide_w") or 1280)
    slide_h = int(job.get("slide_h") or 720)
    font_name = job.get("font") or "微软雅黑"
    manifest = load_manifest()

    presentation = Presentation()
    presentation.slide_width = px(slide_w)
    presentation.slide_height = px(slide_h)
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])

    from PIL import Image
    with Image.open(job["base"]) as image:
        image_w, image_h = image.size
    picture = job.get("picture")
    if not picture:
        margin = 13
        max_w = slide_w - margin * 2
        picture_h = slide_h - 108 - 103
        scale = min(max_w / image_w, picture_h / image_h)
        w = image_w * scale
        h = image_h * scale
        picture = {"left": (slide_w - w) / 2, "top": 108 + (picture_h - h) / 2, "w": w, "h": h}
    slide.shapes.add_picture(job["base"], px(picture["left"]), px(picture["top"]), px(picture.get("width", picture.get("w"))), px(picture.get("height", picture.get("h"))))

    labels = job.get("labels") or []
    footer = next((item for item in labels if item.get("shape") == "footer"), None)
    callouts = [item for item in labels if item.get("shape") != "footer"]
    placed = place_callouts(slide, callouts, picture, slide_w, slide_h, font_name, manifest)
    footer_box = add_footer(slide, footer, slide_w, slide_h, font_name, manifest) if footer else None

    presentation.save(job["out"])
    print(json.dumps({
        "ok": True,
        "pptx": job["out"],
        "slide": [slide_w, slide_h],
        "picture": picture,
        "boxes": placed,
        "footer": footer_box,
        "mode": "bubble-assets + native-textboxes"
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
