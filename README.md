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
- Inputs: `background` (image, optional), `bboxes` (boxes / array / MOSS layout JSON, optional), `width`, `height`, `caption`, plus dock-only `style_preset`, `photo_focus`, `cam_pos`, `cam_loc`, `cam_angle`, `batch_size`, `latent_type`.
- Outputs: `preview`, `bboxes`, `elements`, `latent`, `character_boxes`, `moss_layout` (native `abs_centralized` JSON → text encoder), `layout_1000` (portable 0–1000 layout).

**Cordon Latent Upscale** — latent upscale snapped to a multiple; outputs latent, width, height.
**Cordon Inject Noise** — tops up noise at a two-pass sigma handoff.

## Editor controls
- **Fit / Stretch / Revert** (toolbar): changing width/height does **not** move boxes by itself (they stay in the previous pixel space). **Fit** remaps from that pre-change size with a uniform letterboxed scale (centred, like the background overlay); **Stretch** scales X and Y independently onto the new canvas; **Revert** undoes the last Fit/Stretch (one level).
- Drag empty: new box · drag box: move · handles: resize · Shift/Ctrl+drag: new box over others
- Alt+click: cycle overlapping · Del/right-click: remove · Esc: deselect
- ⊘ boxes (end of toolbar): bypass all boxes → `moss_layout`/`layout_1000` become caption-only plain text (short medium lead; boxes kept in the editor, shown dimmed)
- Wheel: zoom (to 16×) · middle-drag or Space+drag: pan · double-click empty: fit · Ctrl+wheel: graph zoom

## Style presets & camera
Presets (default **photo**): `none`, `photo`, `film`, `cinematic`, `studio product`, `editorial`, `anime`, `illustration`, `watercolor`, `oil painting`, `3d render`, `pixel art`, `poster`, `comic`, `sketch`. Each contributes **one** `summary.meta` tag on boxed layouts; plain / bypass opens with a short medium lead (e.g. "A photograph."). Legacy names map to the nearest current preset.

**Boxed layouts** keep `summary.caption` as the user caption only (stock MOSS Create Bounding Boxes + Layout Prompt). `summary.meta` fills in order **preset → photo focus tag → cam pos/loc/angle** (max 4). Focus tags are short (`shallow dof`, `deep focus`, …) and photo-preset only. `summary.canvas` is always `single`.

**No boxes / bypass**: short lead + optional photo **focus** sentence (photo preset only) + camera short sentences. Focus never writes long prose into boxed `summary.caption`.

## Notes
- `relative_1000` (used by `layout_1000`) is a CordonCanvas convention, not an official MOSS coordinate space; feed `moss_layout` to the encoder.
- Text boxes match stock/OpenMOSS: user desc in `caption`, literal only in `text`.

## License
Apache-2.0 — see [LICENSE](LICENSE).
