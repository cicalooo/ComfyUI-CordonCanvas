"""Pixel-correct Flux.2 / MOSS latent resize. No ComfyUI imports."""

DOWNSCALE = 16


def snap(value: int, multiple: int) -> int:
    multiple = max(1, int(multiple))
    return max(multiple, int(round(float(value) / multiple)) * multiple)


def target_size(latent_h: int, latent_w: int, scale_by: float, width: int, height: int, multiple: int = DOWNSCALE):
    """Return (pixel_w, pixel_h, latent_w, latent_h).

    width/height are pixels. 0 means derive that axis. Both 0 uses scale_by on the
    latent's pixel size (latent * 16). Never uses the SD /8 rule.
    """
    if latent_h < 1 or latent_w < 1:
        raise ValueError(f"latent spatial size must be positive, got {latent_w}x{latent_h}")
    base_w = latent_w * DOWNSCALE
    base_h = latent_h * DOWNSCALE
    if width > 0 and height > 0:
        pw, ph = width, height
    elif width > 0:
        pw = width
        ph = round(base_h * width / base_w)
    elif height > 0:
        ph = height
        pw = round(base_w * height / base_h)
    else:
        if scale_by <= 0:
            raise ValueError("scale_by must be > 0 when width and height are 0")
        pw = round(base_w * scale_by)
        ph = round(base_h * scale_by)
    pw, ph = snap(pw, multiple), snap(ph, multiple)
    return pw, ph, pw // DOWNSCALE, ph // DOWNSCALE
