"""MOSS-Image layout JSON helpers (no ComfyUI imports, unit-testable).

Two coordinate spaces, both [top, left, bottom, right] ("yxyx"):
  * relative_1000   - top-left origin, 0..1000 on each axis; resolution independent.
  * abs_centralized - MOSS native: pixels with the origin at the canvas centre.
Canvas boxes are pixel dicts {x, y, width, height, metadata} at the node's width/height.
"""
import json
import re

RELATIVE_SPACES = {None, "", "relative_1000", "normalized_1000", "0_1000", "rel1000"}
NATIVE_SPACE = "abs_centralized"
_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S | re.I)


def _is_layout(obj) -> bool:
    return isinstance(obj, dict) and isinstance(obj.get("items"), list)


def find_layout(text):
    """Return a MOSS layout dict from a dict, raw JSON, or LLM output (markdown fences / surrounding prose).
    None when the text holds no {"items": [...]} object."""
    if _is_layout(text):
        return text
    if not isinstance(text, str) or "items" not in text:
        return None
    candidates = [text.strip()] + [m.group(1).strip() for m in _FENCE.finditer(text)]
    for c in candidates:
        try:
            obj = json.loads(c)
        except (ValueError, TypeError):
            continue
        if _is_layout(obj):
            return obj
    dec = json.JSONDecoder()
    pos = text.find("{")
    while pos != -1:
        try:
            obj, _ = dec.raw_decode(text, pos)
            if _is_layout(obj):
                return obj
        except ValueError:
            pass
        pos = text.find("{", pos + 1)
    return None


def _clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def layout_to_boxes(layout: dict, width: int, height: int) -> list:
    """MOSS layout (relative_1000 or abs_centralized, yxyx or xyxy) -> canvas pixel boxes."""
    space = layout.get("bbox_coord_space")
    if space not in RELATIVE_SPACES and space != NATIVE_SPACE:
        raise ValueError(f"bboxes: unsupported bbox_coord_space {space!r} (use relative_1000 or abs_centralized)")
    fmt = layout.get("bbox_format") or "yxyx"
    if fmt not in ("yxyx", "xyxy"):
        raise ValueError(f"bboxes: unsupported bbox_format {fmt!r} (use yxyx)")
    out = []
    for i, item in enumerate(layout.get("items") or []):
        if not isinstance(item, dict):
            continue
        bbox = item.get("bbox")
        try:
            a, b, c, d = (float(v) for v in bbox)
        except (TypeError, ValueError):
            raise ValueError(f"bboxes: item {i + 1} needs a numeric 4-value bbox")
        y0, x0, y1, x1 = (a, b, c, d) if fmt == "yxyx" else (b, a, d, c)
        if space == NATIVE_SPACE:
            fy0, fy1 = (y0 + height // 2) / height, (y1 + height // 2) / height
            fx0, fx1 = (x0 + width // 2) / width, (x1 + width // 2) / width
        else:
            fy0, fy1, fx0, fx1 = y0 / 1000, y1 / 1000, x0 / 1000, x1 / 1000
        fy0, fy1 = sorted((_clamp01(fy0), _clamp01(fy1)))
        fx0, fx1 = sorted((_clamp01(fx0), _clamp01(fx1)))
        label = str(item.get("label") or item.get("type") or "object").lower()
        is_text = label == "text"
        palette = item.get("palette") or item.get("color_palette") or []
        palette = [p for p in palette if isinstance(p, str) and p] if isinstance(palette, list) else []
        px, py = round(fx0 * width), round(fy0 * height)
        meta = {
            "type": "text" if is_text else "obj",
            "text": str(item.get("text") or "") if is_text else "",
            "desc": str(item.get("caption") or item.get("desc") or ""),
            "palette": palette,
            "use_palette": bool(palette),
        }
        if label == "character":
            meta["character"] = True
        out.append({"x": px, "y": py, "width": round(fx1 * width) - px, "height": round(fy1 * height) - py,
                    "metadata": meta})
    return out


def text_caption(desc: str, text: str) -> str:
    """Official text items keep the literal string in `text` and describe typography in
    `caption`. Users report weak rendering when the caption doesn't say it is text, so the
    literal is also quoted in the caption when the description doesn't already contain it."""
    desc = (desc or "").strip()
    text = (text or "").strip()
    if not text or text in desc:
        return desc or (f'The text "{text}".' if text else desc)
    if not desc:
        return f'The text "{text}".'
    return f'{desc.rstrip(" .")}, reading "{text}".' if "text" in desc.lower() else f'The text "{text}": {desc}'


def _items(boxes: list, palettes: list, width: int, height: int):
    """Yield (item_without_bbox, frac_box) for each canvas box, in element order."""
    for box, palette in zip(boxes, palettes):
        meta = box.get("metadata") if isinstance(box.get("metadata"), dict) else {}
        is_text = meta.get("type") == "text"
        label = "text" if is_text else ("character" if meta.get("character") is True else "object")
        item = {"label": label, "caption": str(meta.get("desc", "") or "")}
        if is_text:
            item["text"] = str(meta.get("text", "") or "")
            item["caption"] = text_caption(item["caption"], item["text"])
        if palette:
            item["palette"] = list(palette)[:5]
        x0 = _clamp01(float(box.get("x", 0)) / width)
        y0 = _clamp01(float(box.get("y", 0)) / height)
        x1 = _clamp01((float(box.get("x", 0)) + float(box.get("width", 0))) / width)
        y1 = _clamp01((float(box.get("y", 0)) + float(box.get("height", 0))) / height)
        yield item, (min(y0, y1), min(x0, x1), max(y0, y1), max(x0, x1))


# Preset name -> summary.meta tags, a medium PREFIX that leads the caption and a short
# reinforcing SUFFIX with concrete visible medium cues. Evidence (OpenMOSS/MOSS-Image):
# training captions open with framing + medium ("A top-down flat lay of a watercolor
# painting ...", paper Fig. 2) and the recaptioner describes "artistic style" as visible
# content; summary.meta is an "array of medium/genre tags" kept ~90% of the time in
# training. Positive-only wording; the caption widget itself is never rewritten.
STYLE_PRESETS = {
    "photo": {
        "meta": ["photograph"],
        "prefix": "A real-world photograph captured with a camera.",
        "prompt": "Natural light, lens depth of field, fine sensor grain and real-world textures with small imperfections.",
    },
    "3d render": {
        "meta": ["3d render"],
        "prefix": "A 3D CGI render.",
        "prompt": "Physically based materials, ray-traced lighting and soft shadows, clean modeled geometry and subtle subsurface scattering.",
    },
    "2d art": {
        "meta": ["illustration"],
        "prefix": "A 2D digital illustration.",
        "prompt": "Hand-drawn linework, flat or cel shading, a limited color palette and a flat, graphic look.",
    },
}
STYLE_PRESET_NAMES = ["none", *STYLE_PRESETS]
# Every earlier preset name -> nearest current preset, so old workflows still validate.
LEGACY_PRESET_ALIASES = {
    "photoreal": "photo", "photograph": "photo", "studio product": "photo", "editorial": "photo",
    "analog film": "photo", "analog photo": "photo", "cinematic still": "photo", "cinematic": "photo",
    "3d": "3d render", "unreal cinematic": "3d render", "unreal": "3d render", "cgi render": "3d render", "cgi": "3d render",
    "illustration": "2d art", "anime": "2d art", "oil painting": "2d art", "watercolor": "2d art",
    "pixel art": "2d art", "poster": "2d art",
}
STYLE_PRESET_OPTIONS = STYLE_PRESET_NAMES + [k for k in LEGACY_PRESET_ALIASES if k not in STYLE_PRESETS]
CANVAS_MODES = ["single", "multi_panel", "collage"]
# photo-only camera/focus phrase; when set, the photo suffix drops its depth-of-field clause.
PHOTO_FOCUS = {
    "none": "",
    "shallow depth of field": "Shot at f/1.8, shallow depth of field, soft creamy bokeh background.",
    "full focus": "Shot at f/11, deep depth of field, everything in sharp focus front to back.",
    "moderate": "Shot at f/5.6, subject sharp, background slightly soft.",
    "wide-angle": "24mm wide-angle lens, deep focus, environment sharp.",
    "telephoto": "200mm telephoto lens, compressed perspective, blurred background.",
    "macro": "Macro lens close-up, razor-thin focus plane.",
}
PHOTO_FOCUS_NAMES = list(PHOTO_FOCUS)
PHOTO_SUFFIX_NO_DOF = "Natural light, fine sensor grain and real-world textures with small imperfections."


def resolve_preset(preset: str) -> str:
    p = (preset or "none").strip()
    return LEGACY_PRESET_ALIASES.get(p, p)


def style_tags(style: str) -> list:
    return [m.strip() for m in re.split(r"[,\n]", style or "") if m.strip()]


def bake_style(caption: str, style: str = "", preset: str = "none", focus: str = "none"):
    """Return (caption, style_csv) with a preset applied for both empty and boxed outputs.

    The preset's medium prefix leads the caption and its cue sentence is appended
    (plain-text path and summary.caption); idempotent on already-baked text.
    Preset meta tags lead summary.meta; extra style tags (legacy callers only, the
    widget was removed) fill the remaining slots (max 4).
    """
    cap = (caption or "").strip()
    tags = style_tags(style)
    spec = STYLE_PRESETS.get(resolve_preset(preset))
    if spec:
        seen = set()
        merged = []
        for tag in list(spec["meta"]) + tags:
            key = tag.lower()
            if not tag or key in seen:
                continue
            seen.add(key)
            merged.append(tag)
        tags = merged[:4]
        prefix = spec.get("prefix", "").strip()
        suffix = spec.get("prompt", "").strip()
        focus_phrase = PHOTO_FOCUS.get(focus or "none", "") if resolve_preset(preset) == "photo" else ""
        if focus_phrase:
            suffix = f"{PHOTO_SUFFIX_NO_DOF} {focus_phrase}"
        if prefix and not cap.lower().startswith(prefix.lower()):
            body = cap[:1].upper() + cap[1:] if cap else ""
            cap = f"{prefix} {body}".strip()
        if suffix and suffix.lower() not in cap.lower():
            if cap and cap[-1] not in ".!?\"'":
                cap += "."
            cap = f"{cap} {suffix}".strip()
    return cap, ", ".join(tags)


def _summary(caption: str, style: str, canvas: str = "single") -> dict:
    s = {}
    meta = style_tags(style)
    if meta:
        s["meta"] = meta[:4]
    s["canvas"] = canvas if canvas in CANVAS_MODES else "single"
    s["caption"] = (caption or "").strip()
    return s


def build_native(boxes, palettes, width, height, caption="", style="", preset="none", canvas="single", focus="none") -> str:
    """MOSS native abs_centralized JSON straight from the pixel boxes (no 0-1000 quantisation).
    Edges enclose the box like the stock MOSS-Image Layout Prompt node.
    No boxes: the caption is passed through as plain text so the encoder still has a prompt.
    A style preset is baked into that text and, when boxes exist, into summary.caption and summary.meta."""
    caption, style = bake_style(caption, style, preset, focus)
    items = []
    hw, hh = width // 2, height // 2
    for item, (fy0, fx0, fy1, fx1) in _items(boxes, palettes, width, height):
        bbox = [round(fy0 * height) - hh, round(fx0 * width) - hw, round(fy1 * height) - hh, round(fx1 * width) - hw]
        if bbox[2] <= bbox[0]:
            bbox[2] = bbox[0] + 1
        if bbox[3] <= bbox[1]:
            bbox[3] = bbox[1] + 1
        item["bbox"] = bbox
        items.append(item)
    if not items:
        return (caption or "").strip()
    layout = {"summary": _summary(caption, style, canvas), "items": items,
              "bbox_coord_space": NATIVE_SPACE, "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, separators=(",", ":"))


def build_relative(boxes, palettes, width, height, caption="", style="", preset="none", canvas="single", focus="none") -> str:
    """Portable relative_1000 layout: feed it back into any canvas's bboxes input at any resolution."""
    caption, style = bake_style(caption, style, preset, focus)
    items = []
    for item, frac in _items(boxes, palettes, width, height):
        item["bbox"] = [max(0, min(1000, round(v * 1000))) for v in frac]
        items.append(item)
    layout = {"summary": _summary(caption, style, canvas), "items": items,
              "bbox_coord_space": "relative_1000", "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, indent=1)
