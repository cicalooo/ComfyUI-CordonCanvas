"""Frame invariants for moss_layout outputs: native bboxes must stay inside the
generation frame the model conditions on, relative_1000 must stay in [0,1000],
and layouts must round-trip across sizes without drifting (regions lining up).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from moss_layout import (
    build_native,
    build_relative,
    find_layout,
    layout_to_boxes,
)


def _boxes():
    return [
        {"x": 100, "y": 50, "width": 200, "height": 300,
         "metadata": {"type": "obj", "text": "", "desc": "a cat", "palette": []}},
        {"x": 0, "y": 0, "width": 64, "height": 64,
         "metadata": {"type": "text", "text": "hello", "desc": "", "palette": []}},
        {"x": 900, "y": 700, "width": 124, "height": 68,
         "metadata": {"type": "obj", "text": "", "desc": "dog", "palette": ["#FF0000"],
                      "use_palette": True, "character": True}},
    ]


def _boxes_for(w, h):
    return [
        {"x": round(w * 0.1), "y": round(h * 0.07), "width": round(w * 0.2), "height": round(h * 0.39),
         "metadata": {"type": "obj", "text": "", "desc": "a cat", "palette": []}},
        {"x": 0, "y": 0, "width": max(1, round(w * 0.06)), "height": max(1, round(h * 0.08)),
         "metadata": {"type": "text", "text": "hello", "desc": "", "palette": []}},
        {"x": round(w * 0.88), "y": round(h * 0.91), "width": max(1, w - round(w * 0.88) - 1),
         "height": max(1, h - round(h * 0.91) - 1),
         "metadata": {"type": "obj", "text": "", "desc": "dog", "palette": ["#FF0000"],
                      "use_palette": True, "character": True}},
    ]


def test_native_stays_in_frame():
    for w, h in [(1024, 1024), (1368, 768), (101, 77), (64, 64)]:
        boxes = _boxes_for(w, h)
        pals = [[] for _ in boxes]
        layout = json.loads(build_native(boxes, pals, w, h, "cap", "", "none"))
        assert layout["bbox_coord_space"] == "abs_centralized"
        assert layout["bbox_format"] == "yxyx"
        for item in layout["items"]:
            y0, x0, y1, x1 = item["bbox"]
            assert -h / 2 - 1 <= y0 <= y1 <= h / 2 + 1, (w, h, item["bbox"])
            assert -w / 2 - 1 <= x0 <= x1 <= w / 2 + 1, (w, h, item["bbox"])


def test_native_labels():
    pals = [[], [], ["#FF0000"]]
    layout = json.loads(build_native(_boxes(), pals, 1024, 768, "", "", "none"))
    assert [i["label"] for i in layout["items"]] == ["object", "text", "character"]
    assert layout["items"][1]["text"] == "hello"
    assert layout["items"][2]["palette"] == ["#FF0000"]


def test_relative_range_and_roundtrip():
    boxes = _boxes()
    pals = [[], [], []]
    rel = json.loads(build_relative(boxes, pals, 1024, 768, "", "", "none"))
    for item in rel["items"]:
        assert all(0 <= v <= 1000 for v in item["bbox"]), item["bbox"]
    # reuse at another size: fractional positions must survive within half a pixel
    back = layout_to_boxes(rel, 1368, 768)
    assert len(back) == 3
    for orig, new in zip(boxes, back):
        for key, dim_old, dim_new in (("x", 1024, 1368), ("y", 768, 768),
                                      ("width", 1024, 1368), ("height", 768, 768)):
            f_old, f_new = orig[key] / dim_old, new[key] / dim_new
            assert abs(f_old - f_new) * dim_new <= 1.0, (orig, new)


def test_empty_is_caption():
    assert build_native([], [], 1024, 1024, "just a cat", "", "none") == "just a cat"
    assert find_layout("just a cat") is None


def test_layout_input_parses_both_spaces():
    rel = json.loads(build_relative(_boxes(), [[], [], []], 1024, 1024, "", "", "none"))
    assert len(layout_to_boxes(rel, 512, 512)) == 3
    nat = json.loads(build_native(_boxes(), [[], [], ["#FF0000"]], 1024, 1024, "", "", "none"))
    assert len(layout_to_boxes(nat, 1024, 1024)) == 3
    # markdown-wrapped layout still found
    wrapped = "blah\n```json\n" + json.dumps(rel) + "\n```\ntail"
    assert find_layout(wrapped)["bbox_coord_space"] == "relative_1000"


def test_text_item_matches_stock():
    """Stock Create Bounding Boxes / OpenMOSS: caption = desc only; literal in text."""
    boxes = [
        {"x": 10, "y": 10, "width": 100, "height": 40,
         "metadata": {"type": "text", "text": "SALE", "desc": "bold red letters", "palette": []}},
        {"x": 10, "y": 60, "width": 100, "height": 40,
         "metadata": {"type": "text", "text": "hello", "desc": "", "palette": []}},
    ]
    layout = json.loads(build_native(boxes, [[], []], 1024, 768, "a poster", "", "none"))
    assert layout["items"][0]["label"] == "text"
    assert layout["items"][0]["text"] == "SALE"
    assert layout["items"][0]["caption"] == "bold red letters"
    assert layout["items"][1]["text"] == "hello"
    assert layout["items"][1]["caption"] == ""


def test_presets_and_legacy_aliases():
    from moss_layout import STYLE_PRESETS, STYLE_PRESET_NAMES, STYLE_PRESET_OPTIONS, LEGACY_PRESET_ALIASES, bake_style
    assert STYLE_PRESET_NAMES[0] == "none" and STYLE_PRESET_NAMES[1] == "photo"
    assert set(STYLE_PRESET_NAMES) == {
        "none", "photo", "film", "cinematic", "studio product", "editorial", "anime",
        "illustration", "watercolor", "oil painting", "3d render", "pixel art", "poster", "comic", "sketch",
    }
    for name, spec in STYLE_PRESETS.items():
        assert len(spec["meta"]) == 1 and spec["lead"]
    for old, target in LEGACY_PRESET_ALIASES.items():
        assert old in STYLE_PRESET_OPTIONS and target in STYLE_PRESETS
        assert bake_style("cap", "", old) == bake_style("cap", "", target)
    # first-class presets that used to be aliases
    for name in ("studio product", "editorial", "anime", "illustration", "cinematic", "film"):
        assert name in STYLE_PRESETS and name not in LEGACY_PRESET_ALIASES
    layout = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "cap", "", "cgi render"))
    assert layout["summary"]["meta"] == ["3d render"]


def test_boxed_caption_untouched_plain_gets_short_lead():
    from moss_layout import STYLE_PRESETS, bake_style
    for name, spec in STYLE_PRESETS.items():
        # boxed: user caption only; meta tags from preset
        cap, tags = bake_style("a cat wearing glasses", "", name, boxed=True)
        assert cap == "a cat wearing glasses" and tags == ", ".join(spec["meta"])
        # plain: short medium lead
        cap, tags = bake_style("a cat wearing glasses", "", name, boxed=False)
        assert cap == f'{spec["lead"]} A cat wearing glasses' and tags == ", ".join(spec["meta"])
        assert bake_style(cap, "", name, boxed=False)[0] == cap  # idempotent lead
    assert bake_style("a cat", "", "none", boxed=False) == ("a cat", "")
    assert bake_style("a cat", "", "none", boxed=True) == ("a cat", "")
    assert bake_style("", "", "photo", boxed=False)[0] == STYLE_PRESETS["photo"]["lead"]
    # boxed build: summary.caption is user only even with photo preset
    layout = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "a cat", "", "photo"))
    assert layout["summary"]["caption"] == "a cat"
    assert layout["summary"]["meta"] == ["photograph"]


def test_canvas_always_single():
    # canvas combo removed; always official default "single". Legacy canvas= kwarg ignored.
    for fn in (build_native, build_relative):
        layout = json.loads(fn(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo"))
        assert layout["summary"]["canvas"] == "single"
        assert list(layout["summary"]) == ["meta", "canvas", "caption"]
        legacy = json.loads(fn(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo", canvas="multi_panel"))
        assert legacy["summary"]["canvas"] == "single"
    none = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "cap", "", "none"))
    assert none["summary"] == {"canvas": "single", "caption": "cap"}


def test_photo_focus_plain_and_boxed_meta():
    from moss_layout import PHOTO_FOCUS, PHOTO_FOCUS_META, bake_style
    assert bake_style("a cat", "", "photo", "none", boxed=False) == bake_style("a cat", "", "photo", boxed=False)
    for name, phrase in PHOTO_FOCUS.items():
        if not phrase:
            continue
        meta_tag = PHOTO_FOCUS_META[name]
        # plain path: lead + caption + focus phrase
        cap, _ = bake_style("a cat wearing glasses", "", "photo", name, boxed=False)
        assert cap.startswith("A photograph.")
        assert cap.endswith(phrase)
        assert bake_style(cap, "", "photo", name, boxed=False)[0] == cap  # idempotent
        assert bake_style("a cat", "", "photoreal", name, boxed=False)[0] == bake_style("a cat", "", "photo", name, boxed=False)[0]
        # boxed path: caption unchanged; short focus tag in meta
        boxed_cap, tags = bake_style("a cat", "", "photo", name, boxed=True)
        assert boxed_cap == "a cat" and tags == f"photograph, {meta_tag}"
        for other in ("3d render", "illustration", "none", "anime"):
            assert bake_style("a cat", "", other, name, boxed=False) == bake_style("a cat", "", other, boxed=False)
            bcap, btags = bake_style("a cat", "", other, name, boxed=True)
            assert bcap == "a cat"
            assert meta_tag not in btags  # non-photo: no focus meta
    layout = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo", focus="macro"))
    assert layout["summary"]["caption"] == "cap"
    assert layout["summary"]["meta"] == ["photograph", "macro"]
    rel = json.loads(build_relative(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo", focus="macro"))
    assert rel["summary"]["caption"] == "cap"
    assert rel["summary"]["meta"] == ["photograph", "macro"]
    assert build_native([], [], 1024, 768, "cap", "", "photo", focus="macro").endswith(PHOTO_FOCUS["macro"])
    # anime + shallow: no focus tag
    anime = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "a cat", "", "anime", focus="shallow depth of field"))
    assert anime["summary"]["caption"] == "a cat"
    assert anime["summary"]["meta"] == ["anime"]
    # photo + shallow boxed
    shallow = json.loads(build_native(
        _boxes(), [[], [], []], 1024, 768, "a cat", "", "photo", focus="shallow depth of field"))
    assert shallow["summary"] == {
        "meta": ["photograph", "shallow dof"],
        "canvas": "single",
        "caption": "a cat",
    }


def test_camera_boxed_meta_and_plain_phrases():
    from moss_layout import bake_style, CAM_POS_PLAIN, CAM_LOC_PLAIN, CAM_ANGLE_PLAIN
    # boxed: caption untouched; meta = preset → focus → cams, max 4 (close-up dropped)
    cap, tags = bake_style("a cat", "", "photo", "full focus", boxed=True,
                           cam_pos="low angle", cam_loc="outdoor", cam_angle="close-up")
    assert cap == "a cat"
    assert tags == "photograph, deep focus, low angle, outdoor"
    # no focus: preset + three cams fit exactly
    cap, tags = bake_style("a cat", "", "photo", boxed=True,
                           cam_pos="low angle", cam_loc="outdoor", cam_angle="close-up")
    assert tags.split(", ") == ["photograph", "low angle", "outdoor", "close-up"]
    # plain: short sentences; focus still photo-only
    cap, _ = bake_style("a cat", "", "photo", "full focus", boxed=False,
                        cam_pos="low angle", cam_loc="outdoor", cam_angle="close-up")
    assert cap.startswith("A photograph.")
    assert "full focus" in cap.lower() or "f/11" in cap
    assert CAM_POS_PLAIN["low angle"] in cap
    assert CAM_LOC_PLAIN["outdoor"] in cap
    assert CAM_ANGLE_PLAIN["close-up"] in cap
    assert bake_style(cap, "", "photo", "full focus", boxed=False,
                      cam_pos="low angle", cam_loc="outdoor", cam_angle="close-up")[0] == cap
    # build: sample boxed summary — preset + focus + 2 cams (3rd cam truncated)
    layout = json.loads(build_native(
        _boxes(), [[], [], []], 1024, 768, "a cat", "", "photo",
        focus="full focus", cam_pos="low angle", cam_loc="outdoor", cam_angle="close-up"))
    assert layout["summary"] == {
        "meta": ["photograph", "deep focus", "low angle", "outdoor"],
        "canvas": "single",
        "caption": "a cat",
    }
