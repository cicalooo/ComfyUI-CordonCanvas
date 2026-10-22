// Pure size/crop geometry mirroring ComfyUI-UniResize (UniLoadNode / UniResizeNode / UniRatioNode),
// comfy_extras/nodes_post_processing.py and comfy_extras/nodes_resolution.py
// (core ResolutionSelector). No ComfyUI imports, so it can be unit-tested with node.
// A "state" is { w, h, rect:[sx,sy,sw,sh] } : output size + the region of the source image it shows.

export const MAX_RESOLUTION = 16384;

/** Python 3 round(): half to even. */
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return d < 0.5 ? f : f + 1;
}

export const initState = (w, h) => ({ w, h, rect: [0, 0, w, h] });

function mapRect(st, x, y, vw, vh) { // visible sub-region (in current output coords) -> source rect
  const [sx, sy, sw, sh] = st.rect, fx = sw / st.w, fy = sh / st.h;
  return [sx + x * fx, sy + y * fy, vw * fx, vh * fy];
}

/** comfy.utils.common_upscale(..., crop) */
export function upscale(st, W, H, crop = "disabled") {
  W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
  let rect = st.rect;
  if (crop === "center") {
    const ow = st.w, oh = st.h, oa = ow / oh, na = W / H;
    let x = 0, y = 0;
    if (oa > na) x = pyRound((ow - ow * (na / oa)) / 2);
    else if (oa < na) y = pyRound((oh - oh * (oa / na)) / 2);
    rect = mapRect(st, x, y, ow - 2 * x, oh - 2 * y);
  }
  return { w: W, h: H, rect };
}

export function scaleToMultipleCover(st, m) {
  if (m <= 1) return st;
  const { w, h } = st;
  const tw = Math.floor(w / m) * m, th = Math.floor(h / m) * m;
  if (tw === 0 || th === 0) return st;
  if (tw === w && th === h) return st;
  const sW = tw / w, sH = th / h;
  let scw, sch;
  if (sW >= sH) { scw = tw; sch = Math.ceil(h * sW); if (sch < th) sch = th; }
  else { sch = th; scw = Math.ceil(w * sH); if (scw < tw) scw = tw; }
  const scaled = upscale(st, scw, sch);
  const x0 = Math.floor((scw - tw) / 2), y0 = Math.floor((sch - th) / 2);
  return { w: tw, h: th, rect: mapRect(scaled, x0, y0, tw, th) };
}

/**
 * UniResize apply_resize(). p: values of the "resize_type.*" sub-widgets (width, height, crop, multiplier,
 * longer_size, shorter_size, megapixels, multiple). match: [w,h] of the match input or null.
 * Returns a state, or null when a needed input (match) is unknown.
 */
export function applyResize(st, mode, p, adhere, match = null) {
  let r;
  const num = (k, d) => (Number.isFinite(+p[k]) ? +p[k] : d);
  switch (mode) {
    case undefined: case null: case "disabled": r = st; break;
    case "scale by multiplier": { const m = num("multiplier", 1); r = upscale(st, pyRound(st.w * m), pyRound(st.h * m)); break; }
    case "scale dimensions": case "scale width": case "scale height": {
      let W = mode === "scale height" ? 0 : num("width", 1024), H = mode === "scale width" ? 0 : num("height", 1024);
      const crop = mode === "scale dimensions" ? (p.crop || "disabled") : "disabled";
      if (W === 0 && H === 0) { r = st; break; }
      if (W === 0) W = Math.max(1, pyRound(st.w * H / st.h));
      else if (H === 0) H = Math.max(1, pyRound(st.h * W / st.w));
      r = upscale(st, W, H, crop); break;
    }
    case "scale longer dimension": {
      const L = num("longer_size", 1024); let { w, h } = st;
      if (h > w) { w = pyRound((w / h) * L); h = L; } else if (w > h) { h = pyRound((h / w) * L); w = L; } else { w = h = L; }
      r = upscale(st, w, h); break;
    }
    case "scale shorter dimension": {
      const S = num("shorter_size", 1024); let { w, h } = st;
      if (h < w) { w = pyRound((w / h) * S); h = S; } else if (w < h) { h = pyRound((h / w) * S); w = S; } else { w = h = S; }
      r = upscale(st, w, h); break;
    }
    case "scale total pixels": {
      const total = Math.trunc(num("megapixels", 1) * 1024 * 1024);
      const s = Math.sqrt(total / (st.w * st.h));
      r = upscale(st, pyRound(st.w * s), pyRound(st.h * s)); break;
    }
    case "match size": if (!match) return null; r = upscale(st, match[0], match[1], p.crop || "disabled"); break;
    case "scale to multiple": r = scaleToMultipleCover(st, Math.trunc(num("multiple", 32))); break;
    default: return null;
  }
  if (adhere && adhere !== "disabled") {
    const grid = parseInt(adhere, 10);
    const aligned = mode === "scale to multiple" && Math.trunc(+p.multiple) === grid;
    if (!aligned) r = scaleToMultipleCover(r, grid);
  }
  return r;
}

/** UniLoad: no resize requested -> original size. */
export function uniLoadState(natW, natH, mode, p, adhere, match) {
  const st = initState(natW, natH);
  if ((mode ?? "disabled") === "disabled" && (adhere ?? "disabled") === "disabled") return st;
  return applyResize(st, mode, p, adhere, match);
}

// ---------- UniRatio (resolutions.py solve) ----------
export const ASPECT_RATIOS = {
  "1:1": [1, 1], "5:4": [5, 4], "4:5": [4, 5], "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3],
  "16:10": [16, 10], "10:16": [10, 16], "16:9": [16, 9], "9:16": [9, 16], "2:1": [2, 1], "1:2": [1, 2],
  "21:9": [21, 9], "9:21": [9, 21], "32:9": [32, 9], "9:32": [9, 32], "3:1": [3, 1], "1:3": [1, 3],
};
const EXPLICIT = new Set(["scale dimensions", "match size", "scale by multiplier"]);
function snap(v, m) { return m <= 1 ? Math.max(1, pyRound(v)) : Math.max(m, pyRound(v / m) * m); }
function bestAreaFit(ratio, area, m) {
  const bw = snap(Math.sqrt(area * ratio), m), bh = snap(Math.sqrt(area / ratio), m), step = Math.max(1, m);
  let best = null;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const w = bw + i * step, h = bh + j * step;
    if (w < step || h < step || w > MAX_RESOLUTION || h > MAX_RESOLUTION) continue;
    const err = Math.abs(w * h - area) / area + Math.abs(w / h - ratio) / ratio;
    if (!best || err < best[0]) best = [err, w, h];
  }
  return best ? [best[1], best[2]] : null;
}
/** Returns [w,h] or null (unknown reference / invalid). */
export function uniRatioSolve(mode, ratioName, multipleStr, p, reference = null) {
  const m = multipleStr === "disabled" ? 1 : parseInt(multipleStr, 10) || 1;
  const n = (k, d) => (Number.isFinite(+p[k]) ? +p[k] : d);
  let out;
  if (EXPLICIT.has(mode)) {
    let tw, th;
    if (mode === "scale dimensions") { tw = n("width", 1024); th = n("height", 1024); }
    else {
      if (!reference) return null;
      [tw, th] = reference;
      if (mode === "scale by multiplier") { const k = n("multiplier", 1); tw *= k; th *= k; }
    }
    out = [snap(tw, m), snap(th, m)];
  } else {
    const rr = ASPECT_RATIOS[ratioName]; if (!rr) return null;
    const ratio = rr[0] / rr[1];
    if (mode === "scale total pixels") out = bestAreaFit(ratio, n("megapixels", 1) * 1e6, m);
    else if (mode === "scale longer dimension") { const pin = snap(n("longer_size", 1024), m), o = snap(ratio >= 1 ? pin / ratio : pin * ratio, m); out = ratio >= 1 ? [pin, o] : [o, pin]; }
    else if (mode === "scale shorter dimension") { const pin = snap(n("shorter_size", 768), m), o = snap(ratio >= 1 ? pin * ratio : pin / ratio, m); out = ratio >= 1 ? [o, pin] : [pin, o]; }
    else if (mode === "scale width") { const pin = snap(n("width", 1024), m); out = [pin, snap(pin / ratio, m)]; }
    else if (mode === "scale height") { const pin = snap(n("height", 1024), m); out = [snap(pin * ratio, m), pin]; }
    else return null;
  }
  if (!out || out[0] < 1 || out[1] < 1 || out[0] > MAX_RESOLUTION || out[1] > MAX_RESOLUTION) return null;
  return out;
}

// ---------- Core ResolutionSelector (comfy_extras/nodes_resolution.py) ----------
// Width/height are computed from aspect_ratio + megapixels + multiple widgets:
//   total = megapixels * 1024 * 1024; s = sqrt(total / (rw * rh));
//   w = round(rw * s / m) * m; h = round(rh * s / m) * m   (Python banker's round)
export const RES_SELECTOR_ASPECTS = {
  "1:1 (Square)": [1, 1],
  "2:3 (Portrait Photo)": [2, 3],
  "3:2 (Photo)": [3, 2],
  "3:4 (Portrait Standard)": [3, 4],
  "4:3 (Standard)": [4, 3],
  "9:16 (Portrait Widescreen)": [9, 16],
  "16:9 (Widescreen)": [16, 9],
  "21:9 (Ultrawide)": [21, 9],
};
/** Returns {w, h} or null (unknown aspect / invalid megapixels). Mirrors execute() exactly. */
export function resolutionSelectorSize(aspectName, megapixels, multiple) {
  const r = RES_SELECTOR_ASPECTS[aspectName];
  const mp = Number(megapixels), m0 = Math.round(Number(multiple));
  const m = Number.isFinite(m0) && m0 > 0 ? m0 : 8;
  if (!r || !Number.isFinite(mp) || mp <= 0) return null;
  const total = mp * 1024 * 1024;
  const s = Math.sqrt(total / (r[0] * r[1]));
  const w = pyRound(r[0] * s / m) * m, h = pyRound(r[1] * s / m) * m;
  if (w < 1 || h < 1 || w > MAX_RESOLUTION || h > MAX_RESOLUTION) return null;
  return { w, h };
}
