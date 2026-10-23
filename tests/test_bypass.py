"""bypass_boxes: prompt outputs fall back to the no-boxes path (caption + short medium lead)."""
import importlib.util
import json
import os
import sys
import types

PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/home/ac/comfy/ComfyUI")

pkg = types.ModuleType("cordoncanvas_bypass_test")
pkg.__path__ = [PACK]
sys.modules["cordoncanvas_bypass_test"] = pkg
spec = importlib.util.spec_from_file_location(
    "cordoncanvas_bypass_test.cordoncanvas", os.path.join(PACK, "__init__.py"))
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

BOXES = json.dumps([
    {"x": 10, "y": 20, "width": 200, "height": 100,
     "metadata": {"type": "obj", "text": "", "desc": "a cat", "palette": [], "character": True}},
    {"x": 300, "y": 300, "width": 300, "height": 80,
     "metadata": {"type": "text", "text": "HELLO", "desc": "bold", "palette": []}},
])


def _run(bypass, box_data=BOXES):
    out = mod.CordonCanvas.execute(512, 512, box_data=box_data, caption="a quiet street",
                                   style_preset="photo", bypass_boxes=bypass)
    preview, bboxes, elements, latent, chars, native, rel = out.args
    return elements, chars, native, rel


def test_bypass_matches_no_boxes_path():
    elements, chars, native, rel = _run(True)
    _, _, empty_native, _ = _run(False, box_data="[]")
    assert native == empty_native == rel
    assert native.startswith("A photograph.") and "A quiet street" in native
    assert not native.lstrip().startswith("{")
    assert chars == "" and len(elements) == 0


def test_without_bypass_layout_has_boxes():
    elements, chars, native, rel = _run(False)
    layout = json.loads(native)
    assert len(layout["items"]) == 2 and chars == "1"
    assert json.loads(rel)["bbox_coord_space"] == "relative_1000"


def test_bypass_with_photo_focus():
    out = mod.CordonCanvas.execute(512, 512, box_data=BOXES, caption="a quiet street", style_preset="photo",
                                   bypass_boxes=True, photo_focus="full focus")
    native, rel = out.args[5], out.args[6]
    assert native == rel and native.endswith("everything in sharp focus front to back.")
    assert "lens depth of field" not in native
