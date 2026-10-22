# ComfyUI-CordonCanvas

Canvas bounding-box editor for ComfyUI that builds MOSS-Image layout prompts, empty latents and box conditioning.

![Cordon Canvas in ComfyUI](docs/screenshot.png)

## Install
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/cicalooo/ComfyUI-CordonCanvas
```
Restart ComfyUI. Uses the classic (LiteGraph) frontend.

## Nodes
**Cordon Canvas**
- Inputs: `background` (image, optional), `bboxes` (boxes / array / MOSS layout JSON, optional), `width`, `height`, `caption`, plus dock-only `style_preset`, `canvas`, `batch_size`, `latent_type`.
- Outputs: `preview`, `bboxes`, `elements`, `latent`, `character_boxes`, `moss_layout` (native `abs_centralized` JSON → text encoder), `layout_1000` (portable 0–1000 layout).

**Cordon Latent Upscale** — latent upscale snapped to a multiple; outputs latent, width, height.
**Cordon Inject Noise** — tops up noise at a two-pass sigma handoff.

## Editor controls
- Drag empty: new box · drag box: move · handles: resize · Shift/Ctrl+drag: new box over others
- Alt+click: cycle overlapping · Del/right-click: remove · Esc: deselect
- Wheel: zoom (to 16×) · middle-drag or Space+drag: pan · double-click empty: fit · Ctrl+wheel: graph zoom

## Style presets
`none`, `photoreal` (default), `studio product`, `editorial`, `analog film`, `cinematic still`, `illustration`, `anime`, `oil painting`, `watercolor`, `3d render`, `pixel art`, `poster`. Each adds 1–2 `summary.meta` tags and a positive style sentence. Legacy names (`unreal cinematic`, `cgi render`, …) still load and map to current presets.

## Notes
- `relative_1000` (used by `layout_1000`) is a CordonCanvas convention, not an official MOSS coordinate space; feed `moss_layout` to the encoder.
- Text boxes use the official `{"label":"text","text":…}` item and additionally quote the literal in the caption (e.g. `The text "SALE": bold red letters`) for more reliable rendering.

## License
Apache-2.0 — see [LICENSE](LICENSE).
