"""ComfyUI-CordonCanvas: classic (LiteGraph/DOM) editor version of the stock Create Bounding Boxes node."""
import json
import re

import torch

import comfy.model_management
import comfy.sample
import comfy.utils
import nodes
from typing_extensions import override
from comfy_api.latest import ComfyExtension, io
from comfy_extras.nodes_bounding_boxes import (
    boxes_from_input,
    boxes_to_regions,
    render_preview,
    fractions_to_bbox_frame,
    build_elements,
    _bg_from_image,
)

from .latent import DOWNSCALE, target_size
from .moss_layout import STYLE_PRESET_OPTIONS, CANVAS_MODES, PHOTO_FOCUS_NAMES, find_layout, layout_to_boxes, build_native, build_relative

WEB_DIRECTORY = "./web"

# label -> (channels, spatial downscale); first entry matches stock EmptyLatentImage
LATENT_TYPES = {
    "4ch /8 (SD1.x, SDXL)": (4, 8),
    "16ch /8 (SD3, Flux.1)": (16, 8),
    "128ch /16 (MOSS/Flux.2)": (128, 16),
}


# Colours the editor used to auto-assign into metadata.palette (pre display_color versions).
LEGACY_AUTO_COLORS = {"#E6194B", "#3CB44B", "#FFE119", "#4363D8", "#F58231",
                      "#911EB4", "#42D4F4", "#F032E6", "#BFEF45", "#FABED4"}
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _prompt_palette(meta: dict, from_editor: bool) -> list:
    """Palette that goes into the prompt elements.

    metadata.use_palette True -> palette, False -> none.
    Absent (old saves / upstream input): editor boxes whose palette is just the old auto colour are
    treated as display-only; anything else (custom palettes, upstream elements) is kept.
    """
    palette = [c for c in (meta.get("palette") or []) if isinstance(c, str) and c]
    flag = meta.get("use_palette")
    if flag is True:
        return palette
    if flag is False:
        return []
    if from_editor and len(palette) == 1 and palette[0].upper() in LEGACY_AUTO_COLORS:
        return []
    return palette


def _display_color(meta: dict, from_editor: bool):
    c = meta.get("display_color")
    if isinstance(c, str) and _HEX.match(c):
        return c.upper()
    palette = [x for x in (meta.get("palette") or []) if isinstance(x, str) and x]
    if from_editor and meta.get("use_palette") is None and len(palette) == 1 and palette[0].upper() in LEGACY_AUTO_COLORS:
        return palette[0].upper()
    return None


def _letterbox(bg, width: int, height: int):
    """Pad the background to the canvas aspect (centred, black) instead of letting the preview stretch it,
    matching what the editor shows. Boxes are fractions of the canvas, so they stay correct."""
    if bg is None or not width or not height:
        return bg
    from PIL import Image
    iw, ih = bg.size
    target = width / height
    if iw <= 0 or ih <= 0 or abs((iw / ih) / target - 1) <= 0.005:
        return bg
    if iw / ih > target:
        nw, nh = iw, max(1, round(iw / target))
    else:
        nw, nh = max(1, round(ih * target)), ih
    canvas = Image.new("RGB", (nw, nh), (0, 0, 0))
    canvas.paste(bg.convert("RGB"), ((nw - iw) // 2, (nh - ih) // 2))
    return canvas


def _parse_boxes(text):
    if isinstance(text, list):
        return text
    if not isinstance(text, str) or not text.strip():
        return []
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out = []
    for b in data:
        if not isinstance(b, dict):
            continue
        meta = b.get("metadata") if isinstance(b.get("metadata"), dict) else {}
        out.append({
            "x": int(round(float(b.get("x", 0)))),
            "y": int(round(float(b.get("y", 0)))),
            "width": int(round(float(b.get("width", 0)))),
            "height": int(round(float(b.get("height", 0)))),
            "metadata": {
                "type": "text" if meta.get("type") == "text" else "obj",
                "text": str(meta.get("text", "") or ""),
                "desc": str(meta.get("desc", "") or ""),
                "palette": [c for c in (meta.get("palette") or []) if isinstance(c, str) and c],
            },
        })
        if meta.get("character") is True and out[-1]["metadata"]["type"] != "text":
            out[-1]["metadata"]["character"] = True
        if isinstance(meta.get("use_palette"), bool):
            out[-1]["metadata"]["use_palette"] = meta["use_palette"]
        if isinstance(meta.get("display_color"), str) and _HEX.match(meta["display_color"]):
            out[-1]["metadata"]["display_color"] = meta["display_color"].upper()
    return out


class CordonCanvas(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="CordonCanvas",
            display_name="Cordon Canvas",
            category="utilities",
            description="Classic-frontend canvas editor for bounding boxes. Outputs a preview image, "
                        "pixel-space bounding boxes and prompt elements (same formats as stock Create Bounding Boxes), "
                        "plus MOSS-Image layout JSON. Caption is a multiline input on the node; "
                        "preset, batch and latent controls live in the editor dock.",
            inputs=[
                io.Image.Input("background", optional=True,
                               tooltip="Optional image shown behind the boxes in the editor and preview."),
                io.MultiType.Input("bboxes", [io.BoundingBox, io.Array, io.String], optional=True,
                                   tooltip="Bounding boxes, elements, or a JSON string (also a MOSS layout in relative_1000 or "
                                           "abs_centralized coords, even inside LLM/markdown text) to initialize the canvas. "
                                           "A changed upstream value replaces the canvas boxes; otherwise canvas edits win."),
                io.Int.Input("width", default=1024, min=64, max=16384, step=16),
                io.Int.Input("height", default=1024, min=64, max=16384, step=16),
                io.String.Input("box_data", default="[]", multiline=False,
                                tooltip="JSON list of {x,y,width,height,metadata:{type,text,desc,palette}} in pixels. Managed by the canvas."),
                io.String.Input("last_incoming", default="", multiline=False, optional=True,
                                tooltip="Internal: JSON of the upstream bboxes value that last initialized the canvas."),
                io.Int.Input("batch_size", default=1, min=1, max=4096, optional=True,
                             tooltip="Batch size of the empty latent output. Edited in the dock."),
                io.Combo.Input("latent_type", options=list(LATENT_TYPES.keys()), default="128ch /16 (MOSS/Flux.2)",
                               optional=True, tooltip="Channels/downscale of the empty latent output. Edited in the dock."),
                io.String.Input("caption", multiline=True, default="", optional=True,
                                tooltip="Whole-image description for moss_layout (summary.caption). "
                                        "A connected string overrides the widget."),
                io.Combo.Input("style_preset", options=STYLE_PRESET_OPTIONS, default="photo",
                               tooltip="Leads the prompt with a medium statement and appends medium cues for both an empty canvas and boxed layouts, "
                                       "without changing the caption widget. Boxed layouts also get the preset's summary.meta tags. "
                                       "Edited in the dock. Legacy names map to current presets."),
                io.Combo.Input("canvas", options=CANVAS_MODES, default="single", optional=True,
                               tooltip="summary.canvas of the layout: single, multi_panel or collage. Edited in the dock."),
                io.Combo.Input("photo_focus", options=PHOTO_FOCUS_NAMES, default="none", optional=True,
                               tooltip="Camera/focus phrase for the photo preset (ignored for other presets). Edited in the dock."),
                io.Boolean.Input("bypass_boxes", default=False, optional=True,
                                 tooltip="Bypass boxes: caption-only prompt. moss_layout/layout_1000 become the caption plus "
                                         "the style sentence; bboxes/elements/character_boxes/preview are empty. "
                                         "Editor boxes are kept. Toggled in the dock."),
            ],
            outputs=[
                io.Image.Output(display_name="preview"),
                io.BoundingBox.Output(display_name="bboxes"),
                io.Array.Output(display_name="elements"),
                io.Latent.Output(display_name="latent"),
                io.String.Output(display_name="character_boxes",
                                 tooltip="1-based element numbers of boxes flagged as characters, e.g. \"2, 4\". "
                                         "Connect to MOSS-Image Layout Prompt's character_boxes input."),
                io.String.Output(display_name="moss_layout",
                                 tooltip="Native MOSS-Image layout JSON (abs_centralized pixels at width×height, characters included), "
                                         "built from exact pixel boxes. Feed it straight to the text encoder instead of "
                                         "MOSS-Image Layout Prompt. Plain caption when there are no boxes."),
                io.String.Output(display_name="layout_1000",
                                 tooltip="Resolution-independent relative_1000 layout JSON. Paste/link it into any canvas's "
                                         "bboxes input to reuse the layout at another size."),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, width, height, box_data="[]", last_incoming="", background=None, bboxes=None,
                batch_size=1, latent_type=None, caption=None, style_preset="none", canvas="single", bypass_boxes=False, photo_focus="none") -> io.NodeOutput:
        layout = find_layout(bboxes) if isinstance(bboxes, (str, dict)) else None
        incoming = layout_to_boxes(layout, width, height) if layout is not None else boxes_from_input(bboxes, width, height)
        applied = _parse_boxes(last_incoming)
        incoming_norm = _parse_boxes(incoming)
        upstream_changed = bool(incoming) and incoming_norm != applied
        source = incoming if upstream_changed else _parse_boxes(box_data)
        from_editor = not upstream_changed
        if bypass_boxes:
            source = []  # caption-only: same as the no-boxes path; editor box_data is untouched
        regions = boxes_to_regions(source, width, height)
        preview_regions = []
        for box, region in zip([b for b in source if isinstance(b, dict)], regions):
            meta = box.get("metadata") if isinstance(box.get("metadata"), dict) else {}
            region["palette"] = _prompt_palette(meta, from_editor)
            shown = dict(region)
            disp = _display_color(meta, from_editor)
            if not shown["palette"] and disp:
                shown["palette"] = [disp]  # preview outline colour only; never reaches elements
            preview_regions.append(shown)
        preview = render_preview(preview_regions, width, height, _letterbox(_bg_from_image(background), width, height))
        ui = {"dims": [width, height]}
        if incoming:
            ui["input_bboxes"] = incoming_norm
            ui["upstream_changed"] = [upstream_changed]
        if background is not None and len(background) > 0:
            saved = nodes.PreviewImage().save_images(background[:1], "comfy.cordoncanvas.background")
            ui["background_images"] = saved["ui"]["images"]
        ch, ds = LATENT_TYPES.get(latent_type, next(iter(LATENT_TYPES.values())))
        latent = torch.zeros([batch_size, ch, height // ds, width // ds],
                             device=comfy.model_management.intermediate_device(),
                             dtype=comfy.model_management.intermediate_dtype())
        latent_out = {"samples": latent}
        if ds == 8:
            latent_out["downscale_ratio_spacial"] = 8
        # same order as build_elements(): dict boxes only; text boxes are never characters (MOSS keeps them "text")
        character_boxes = ", ".join(
            str(i + 1) for i, box in enumerate(b for b in source if isinstance(b, dict))
            if isinstance(box.get("metadata"), dict) and box["metadata"].get("character") is True
            and box["metadata"].get("type") != "text"
        )
        dict_boxes = [b for b in source if isinstance(b, dict)]
        palettes = [r["palette"] for r in regions]
        moss_native = build_native(dict_boxes, palettes, width, height, caption or "", "", style_preset or "none", canvas or "single", photo_focus or "none")
        layout_1000 = build_relative(dict_boxes, palettes, width, height, caption or "", "", style_preset or "none", canvas or "single", photo_focus or "none")
        if bypass_boxes:
            layout_1000 = moss_native  # caption-only plain text on both prompt outputs
        return io.NodeOutput(preview, fractions_to_bbox_frame(regions, width, height),
                             build_elements(regions), latent_out, character_boxes,
                             moss_native, layout_1000, ui=ui)


MOSS_UPSCALE_METHODS = ["bislerp", "bicubic", "bilinear", "area", "nearest-exact"]


def _upscale_mask(mask, latent_w, latent_h):
    orig_ndim = mask.ndim
    if orig_ndim == 2:
        mask = mask.unsqueeze(0).unsqueeze(0)
    elif orig_ndim == 3:
        mask = mask.unsqueeze(1)
    up = comfy.utils.common_upscale(mask.float(), latent_w, latent_h, "bilinear", "disabled")
    if orig_ndim == 2 and up.ndim == 4:
        up = up.squeeze(0).squeeze(0)
    elif orig_ndim == 3 and up.ndim == 4:
        up = up.squeeze(1)
    return up


class CordonLatentUpscale(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="CordonLatentUpscale",
            display_name="Cordon Latent Upscale",
            category="model/latent/moss",
            description="Upscale a MOSS / Flux.2 latent by pixel size. Stock Latent Upscale divides by 8 and is wrong here (128ch /16). Does not write downscale_ratio_spacial.",
            search_aliases=["moss upscale", "flux2 latent upscale", "kromoss hires", "latent upscale 16", "cordon upscale"],
            inputs=[
                io.Latent.Input("samples"),
                io.Combo.Input("upscale_method", options=MOSS_UPSCALE_METHODS, default="bislerp"),
                io.Float.Input("scale_by", default=1.5, min=0.25, max=4.0, step=0.05,
                               tooltip="Used when width and height are 0."),
                io.Int.Input("width", default=0, min=0, max=16384, step=16,
                             tooltip="Pixel width. 0 = from scale_by. Snapped to multiple."),
                io.Int.Input("height", default=0, min=0, max=16384, step=16,
                             tooltip="Pixel height. 0 = from scale_by. Snapped to multiple."),
                io.Int.Input("multiple", default=DOWNSCALE, min=16, max=128, step=16,
                             tooltip="Pixel snap. MOSS needs 16."),
            ],
            outputs=[
                io.Latent.Output(display_name="latent"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
            ],
        )

    @classmethod
    def execute(cls, samples, upscale_method, scale_by, width, height, multiple) -> io.NodeOutput:
        x = samples["samples"]
        pw, ph, lw, lh = target_size(int(x.shape[-2]), int(x.shape[-1]), scale_by, width, height, multiple)
        out = samples.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = comfy.utils.common_upscale(x, lw, lh, upscale_method, "disabled")
        if "noise_mask" in samples:
            out["noise_mask"] = _upscale_mask(samples["noise_mask"], lw, lh)
        return io.NodeOutput(out, pw, ph)


class CordonInjectNoise(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="CordonInjectNoise",
            display_name="Cordon Inject Noise",
            category="model/sampling/moss",
            description="Prep an upscaled pass-1 leftover-noise latent for pass 2 with SamplerCustomAdvanced + Disable Noise. "
                        "Feed low_sigmas from Split Sigmas. Strength 0 is an exact continuation of the pass-1 noise; "
                        "raise it only if upscale smoothing visibly softens grain. Do not use Random Noise on pass 2.",
            search_aliases=["moss inject", "hires noise", "split sigma inject", "kromoss inject", "cordon noise"],
            inputs=[
                io.Latent.Input("latent"),
                io.Model.Input("model", tooltip="Same shifted model the sampler uses."),
                io.Sigmas.Input("sigmas", tooltip="Low sigmas from Split Sigmas. The first value is the handoff."),
                io.Float.Input("strength", default=0.0, min=0.0, max=1.0, step=0.01,
                               tooltip="Fresh noise added in pass-2 start space. 0 = exact leftover-noise continuation (default). Raise only if upscale smoothing softens grain."),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff, control_after_generate=True),
            ],
            outputs=[io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, latent, model, sigmas, strength, seed) -> io.NodeOutput:
        samples = latent["samples"]
        if sigmas is None or sigmas.numel() == 0:
            return io.NodeOutput(latent)
        try:
            h = float(sigmas.flatten()[0].to(dtype=torch.float32).item())
        except (ValueError, RuntimeError, AttributeError):
            return io.NodeOutput(latent)
        if h <= 1e-6 or h >= 0.999:
            return io.NodeOutput(latent)
        if float(strength) <= 0:
            # Pass-1 `output` is already inverse-scaled: P = x_h / (1-h).
            # Pass 2 with DisableNoise starts from (1-h)*L, so L = P continues
            # exactly (upscale is homogeneous, so this holds after upscale too).
            return io.NodeOutput(latent)
        try:
            ms = model.get_model_object("model_sampling") if model is not None else None
            s = float(getattr(ms, "noise_scale", 1.0))
        except (AttributeError, ValueError):
            s = 1.0
        # Top up fresh noise in pass-2 start space: x = (1-h)*L + strength*s*n,
        # so L = P + strength*s/(1-h) * n.
        orig_dtype = samples.dtype
        base = samples.to(device=samples.device, dtype=torch.float32)
        noise = comfy.sample.prepare_noise(samples, int(seed)).to(device=samples.device, dtype=torch.float32)
        out_latent = base + (float(strength) * s / max(1.0 - h, 1e-5)) * noise
        out = latent.copy()
        out["samples"] = out_latent.to(dtype=orig_dtype)
        return io.NodeOutput(out)


class CordonCanvasExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [CordonCanvas, CordonLatentUpscale, CordonInjectNoise]


async def comfy_entrypoint() -> CordonCanvasExtension:
    return CordonCanvasExtension()
