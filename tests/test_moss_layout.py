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


def test_text_item_caption_quotes_literal():
    from moss_layout import text_caption
    layout = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "", "", "none"))
    t = layout["items"][1]
    assert t["label"] == "text" and t["text"] == "hello"
    assert t["caption"] == 'The text "hello".'
    assert text_caption("bold red letters", "SALE") == 'The text "SALE": bold red letters'
    assert text_caption("bold red text", "SALE") == 'bold red text, reading "SALE".'
    assert text_caption('the word "SALE" in red', "SALE") == 'the word "SALE" in red'
    # idempotent on round-trip
    once = text_caption("bold red letters", "SALE")
    assert text_caption(once, "SALE") == once


def test_presets_and_legacy_aliases():
    from moss_layout import STYLE_PRESETS, STYLE_PRESET_NAMES, STYLE_PRESET_OPTIONS, LEGACY_PRESET_ALIASES, bake_style
    assert STYLE_PRESET_NAMES == ["none", "photo", "3d render", "2d art"]
    for old in ("photoreal", "studio product", "editorial", "analog film", "cinematic still", "illustration", "anime",
                "oil painting", "watercolor", "pixel art", "poster", "unreal cinematic", "cgi render"):
        assert old in STYLE_PRESET_OPTIONS and LEGACY_PRESET_ALIASES[old] in STYLE_PRESETS
        assert bake_style("cap", "", old) == bake_style("cap", "", LEGACY_PRESET_ALIASES[old])
    layout = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "cap", "", "cgi render"))
    assert layout["summary"]["meta"] == ["3d render"]


def test_prefix_leads_and_suffix_follows():
    from moss_layout import STYLE_PRESETS, bake_style
    for name, spec in STYLE_PRESETS.items():
        cap, tags = bake_style("a cat wearing glasses", "", name)
        assert cap.startswith(spec["prefix"] + " A cat wearing glasses.")
        assert cap.endswith(spec["prompt"]) and tags == ", ".join(spec["meta"])
        assert bake_style(cap, "", name)[0] == cap  # idempotent
    assert bake_style("a cat", "", "none") == ("a cat", "")
    assert bake_style("", "", "photo")[0] == STYLE_PRESETS["photo"]["prefix"] + " " + STYLE_PRESETS["photo"]["prompt"]


def test_canvas_mode():
    for mode in ("single", "multi_panel", "collage"):
        for fn in (build_native, build_relative):
            layout = json.loads(fn(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo", mode))
            assert layout["summary"]["canvas"] == mode
            assert list(layout["summary"]) == ["meta", "canvas", "caption"]
    bad = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "cap", "", "none", "bogus"))
    assert bad["summary"] == {"canvas": "single", "caption": "cap"}


def test_photo_focus():
    from moss_layout import PHOTO_FOCUS, PHOTO_SUFFIX_NO_DOF, STYLE_PRESETS, bake_style
    assert bake_style("a cat", "", "photo", "none") == bake_style("a cat", "", "photo")
    for name, phrase in PHOTO_FOCUS.items():
        if not phrase:
            continue
        cap, _ = bake_style("a cat wearing glasses", "", "photo", name)
        assert cap.endswith(f"{PHOTO_SUFFIX_NO_DOF} {phrase}")
        assert "lens depth of field" not in cap
        assert bake_style(cap, "", "photo", name)[0] == cap  # idempotent
        assert bake_style("a cat", "", "photoreal", name)[0] == bake_style("a cat", "", "photo", name)[0]
        for other in ("3d render", "2d art", "none"):
            assert bake_style("a cat", "", other, name) == bake_style("a cat", "", other)
    layout = json.loads(build_native(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo", "single", "macro"))
    assert layout["summary"]["caption"].endswith(PHOTO_FOCUS["macro"])
    rel = json.loads(build_relative(_boxes(), [[], [], []], 1024, 768, "cap", "", "photo", "single", "macro"))
    assert rel["summary"]["caption"] == layout["summary"]["caption"]
    assert build_native([], [], 1024, 768, "cap", "", "photo", "single", "macro").endswith(PHOTO_FOCUS["macro"])
