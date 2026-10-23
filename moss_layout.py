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


def _items(boxes: list, palettes: list, width: int, height: int):
    """Yield (item_without_bbox, frac_box) for each canvas box, in element order.

    Text items match stock MOSS-Image Layout Prompt / OpenMOSS examples: typography
    lives in `caption` (user desc only); the literal string is only in `text`.
    """
    for box, palette in zip(boxes, palettes):
        meta = box.get("metadata") if isinstance(box.get("metadata"), dict) else {}
        is_text = meta.get("type") == "text"
        label = "text" if is_text else ("character" if meta.get("character") is True else "object")
        item = {"label": label, "caption": str(meta.get("desc", "") or "")}
        if is_text:
            item["text"] = str(meta.get("text", "") or "")
        if palette:
            item["palette"] = list(palette)[:5]
        x0 = _clamp01(float(box.get("x", 0)) / width)
        y0 = _clamp01(float(box.get("y", 0)) / height)
        x1 = _clamp01((float(box.get("x", 0)) + float(box.get("width", 0))) / width)
        y1 = _clamp01((float(box.get("y", 0)) + float(box.get("height", 0))) / height)
        yield item, (min(y0, y1), min(x0, x1), max(y0, y1), max(x0, x1))


# Preset name -> one summary.meta tag (boxed) and a short medium lead (plain / bypass).
# Boxed summary.caption stays the user caption only — same as stock Create Bounding Boxes /
# MOSS-Image Layout Prompt. Plain-text prompts may open with a one-clause medium lead.
STYLE_PRESETS = {
    "photo": {"meta": ["photograph"], "lead": "A photograph."},
    "film": {"meta": ["film"], "lead": "A film still."},
    "cinematic": {"meta": ["cinematic"], "lead": "A cinematic shot."},
    "studio product": {"meta": ["studio product"], "lead": "A studio product photo."},
    "editorial": {"meta": ["editorial"], "lead": "An editorial photograph."},
    "anime": {"meta": ["anime"], "lead": "An anime illustration."},
    "illustration": {"meta": ["illustration"], "lead": "An illustration."},
    "watercolor": {"meta": ["watercolor"], "lead": "A watercolor painting."},
    "oil painting": {"meta": ["oil painting"], "lead": "An oil painting."},
    "3d render": {"meta": ["3d render"], "lead": "A 3D render."},
    "pixel art": {"meta": ["pixel art"], "lead": "Pixel art."},
    "poster": {"meta": ["poster"], "lead": "A poster."},
    "comic": {"meta": ["comic"], "lead": "A comic panel."},
    "sketch": {"meta": ["sketch"], "lead": "A sketch."},
}
STYLE_PRESET_NAMES = ["none", *STYLE_PRESETS]
# Old names no longer in STYLE_PRESETS -> nearest current preset (workflows still validate).
LEGACY_PRESET_ALIASES = {
    "photoreal": "photo", "photograph": "photo", "analog photo": "photo",
    "analog film": "film", "cinematic still": "cinematic",
    "3d": "3d render", "unreal cinematic": "3d render", "unreal": "3d render",
    "cgi render": "3d render", "cgi": "3d render",
    "2d art": "illustration",
}
STYLE_PRESET_OPTIONS = STYLE_PRESET_NAMES + [k for k in LEGACY_PRESET_ALIASES if k not in STYLE_PRESETS]

# Dock camera dropdowns: option label is also the boxed meta tag (when not none).
CAM_POS_OPTIONS = ["none", "eye level", "low angle", "high angle", "bird's eye", "worm's eye", "dutch angle"]
CAM_LOC_OPTIONS = ["none", "outdoor", "indoor", "studio", "street", "nature", "urban"]
CAM_ANGLE_OPTIONS = ["none", "front view", "three-quarter", "profile", "over-shoulder", "close-up", "wide shot"]
# Plain-path short sentences (appended like photo_focus).
CAM_POS_PLAIN = {
    "none": "",
    "eye level": "Eye-level camera.",
    "low angle": "Low-angle shot.",
    "high angle": "High-angle shot.",
    "bird's eye": "Bird's-eye view.",
    "worm's eye": "Worm's-eye view.",
    "dutch angle": "Dutch angle.",
}
CAM_LOC_PLAIN = {
    "none": "",
    "outdoor": "Outdoor setting.",
    "indoor": "Indoor setting.",
    "studio": "Studio setting.",
    "street": "Street setting.",
    "nature": "Nature setting.",
    "urban": "Urban setting.",
}
CAM_ANGLE_PLAIN = {
    "none": "",
    "front view": "Front view.",
    "three-quarter": "Three-quarter view.",
    "profile": "Profile view.",
    "over-shoulder": "Over-the-shoulder framing.",
    "close-up": "Close-up.",
    "wide shot": "Wide shot.",
}

# photo-only focus: plain path gets the long sentence; boxed path gets a short summary.meta tag.
PHOTO_FOCUS = {
    "none": "",
    "shallow depth of field": "Shot at f/1.8, shallow depth of field, soft creamy bokeh background.",
    "full focus": "Shot at f/11, deep depth of field, everything in sharp focus front to back.",
    "moderate": "Shot at f/5.6, subject sharp, background slightly soft.",
    "wide-angle": "24mm wide-angle lens, deep focus, environment sharp.",
    "telephoto": "200mm telephoto lens, compressed perspective, blurred background.",
    "macro": "Macro lens close-up, razor-thin focus plane.",
}
# Boxed meta tags (photo preset only). Order into summary.meta: preset → focus → cams (max 4).
PHOTO_FOCUS_META = {
    "none": "",
    "shallow depth of field": "shallow dof",
    "full focus": "deep focus",
    "moderate": "moderate focus",
    "wide-angle": "wide-angle",
    "telephoto": "telephoto",
    "macro": "macro",
}
PHOTO_FOCUS_NAMES = list(PHOTO_FOCUS)


def resolve_preset(preset: str) -> str:
    p = (preset or "none").strip()
    return LEGACY_PRESET_ALIASES.get(p, p)


def style_tags(style: str) -> list:
    return [m.strip() for m in re.split(r"[,\n]", style or "") if m.strip()]


def _camera_meta(cam_pos="none", cam_loc="none", cam_angle="none") -> list:
    tags = []
    for v, opts in ((cam_pos, CAM_POS_OPTIONS), (cam_loc, CAM_LOC_OPTIONS), (cam_angle, CAM_ANGLE_OPTIONS)):
        t = (v or "none").strip()
        if t and t != "none" and t in opts:
            tags.append(t)
    return tags


def _append_plain_phrase(cap: str, phrase: str) -> str:
    phrase = (phrase or "").strip()
    if not phrase or phrase.lower() in (cap or "").lower():
        return cap
    if cap and cap[-1] not in ".!?\"'":
        cap += "."
    return f"{cap} {phrase}".strip()


def bake_style(caption: str, style: str = "", preset: str = "none", focus: str = "none", *,
               boxed: bool = False, cam_pos: str = "none", cam_loc: str = "none", cam_angle: str = "none"):
    """Return (caption, style_csv).

    boxed=True (layout with items): caption is the user string trimmed only; summary.meta
    fills as preset → focus tag (photo only) → camera tags (max 4). No medium prose in
    summary.caption.

    boxed=False (no boxes / bypass plain text): optional short medium lead, then the
    user caption; photo_focus (photo only) and camera phrases append as short sentences.
    Idempotent on already-leaded / already-phrased text.
    """
    cap = (caption or "").strip()
    tags = style_tags(style)
    name = resolve_preset(preset)
    cam_tags = _camera_meta(cam_pos, cam_loc, cam_angle)
    spec = STYLE_PRESETS.get(name)
    preset_meta = list(spec["meta"]) if spec else []
    focus_key = (focus or "none").strip()
    focus_tag = ""
    if name == "photo" and focus_key and focus_key != "none":
        focus_tag = (PHOTO_FOCUS_META.get(focus_key) or "").strip()
    seen = set()
    merged = []
    # preset → focus → cams → legacy style tags (DoF kept when three cams are set)
    for tag in preset_meta + ([focus_tag] if focus_tag else []) + cam_tags + tags:
        key = tag.lower()
        if not tag or key in seen:
            continue
        seen.add(key)
        merged.append(tag)
    tags = merged[:4]
    if not boxed:
        if spec:
            lead = spec.get("lead", "").strip()
            if lead and not cap.lower().startswith(lead.lower()):
                body = cap[:1].upper() + cap[1:] if cap else ""
                cap = f"{lead} {body}".strip()
            focus_phrase = PHOTO_FOCUS.get(focus_key, "") if name == "photo" else ""
            cap = _append_plain_phrase(cap, focus_phrase)
        for table, key in ((CAM_POS_PLAIN, cam_pos), (CAM_LOC_PLAIN, cam_loc), (CAM_ANGLE_PLAIN, cam_angle)):
            cap = _append_plain_phrase(cap, table.get((key or "none").strip(), ""))
    return cap, ", ".join(tags)


def _summary(caption: str, style: str) -> dict:
    """Always summary.canvas = single (official default; multi_panel/collage unused)."""
    s = {}
    meta = style_tags(style)
    if meta:
        s["meta"] = meta[:4]
    s["canvas"] = "single"
    s["caption"] = (caption or "").strip()
    return s


def build_native(boxes, palettes, width, height, caption="", style="", preset="none",
                 focus="none", cam_pos="none", cam_loc="none", cam_angle="none", **_ignored) -> str:
    """MOSS native abs_centralized JSON straight from the pixel boxes (no 0-1000 quantisation).
    Edges enclose the box like the stock MOSS-Image Layout Prompt node.
    With boxes: summary.caption is the user caption only; style/focus/camera → summary.meta.
    No boxes: plain-text prompt with optional short medium lead (+ photo_focus + camera).
    Legacy canvas= kwarg is accepted and ignored (always summary.canvas=single)."""
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
    bake_kw = dict(cam_pos=cam_pos, cam_loc=cam_loc, cam_angle=cam_angle)
    if not items:
        caption, _ = bake_style(caption, style, preset, focus, boxed=False, **bake_kw)
        return (caption or "").strip()
    caption, style = bake_style(caption, style, preset, focus, boxed=True, **bake_kw)
    layout = {"summary": _summary(caption, style), "items": items,
              "bbox_coord_space": NATIVE_SPACE, "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, separators=(",", ":"))


def build_relative(boxes, palettes, width, height, caption="", style="", preset="none",
                   focus="none", cam_pos="none", cam_loc="none", cam_angle="none", **_ignored) -> str:
    """Portable relative_1000 layout: feed it back into any canvas's bboxes input at any resolution.
    Legacy canvas= kwarg is accepted and ignored (always summary.canvas=single)."""
    items = []
    for item, frac in _items(boxes, palettes, width, height):
        item["bbox"] = [max(0, min(1000, round(v * 1000))) for v in frac]
        items.append(item)
    caption, style = bake_style(caption, style, preset, focus, boxed=bool(items),
                                cam_pos=cam_pos, cam_loc=cam_loc, cam_angle=cam_angle)
    layout = {"summary": _summary(caption, style), "items": items,
              "bbox_coord_space": "relative_1000", "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, indent=1)
