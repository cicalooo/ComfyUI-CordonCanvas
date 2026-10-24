#!/usr/bin/env node
/** Pure Fit/Stretch math (mirrors web/cordon_canvas.js remapBoxes). */
function clipBox(b, nw, nh) {
  let x = Math.round(+b.x) || 0, y = Math.round(+b.y) || 0;
  let w = Math.max(1, Math.round(+b.width) || 1), h = Math.max(1, Math.round(+b.height) || 1);
  if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
  if (w < 1) w = 1; if (h < 1) h = 1;
  if (x >= nw) { x = Math.max(0, nw - 1); w = 1; }
  if (y >= nh) { y = Math.max(0, nh - 1); h = 1; }
  if (x + w > nw) w = Math.max(1, nw - x);
  if (y + h > nh) h = Math.max(1, nh - y);
  return { x, y, width: Math.max(1, w), height: Math.max(1, h), metadata: b.metadata };
}
function remap(boxes, sw, sh, nw, nh, mode) {
  const out = [];
  const Ws = Math.max(1, +sw || 1), Hs = Math.max(1, +sh || 1);
  const W = Math.max(1, +nw || 1), H = Math.max(1, +nh || 1);
  if (mode === "stretch") {
    // Anisotropic only — NEVER Fit's union letterbox sc=min(...).
    const sx = W / Ws, sy = H / Hs;
    for (const b of boxes) {
      const bw = Math.max(0, +b.width || 0), bh = Math.max(0, +b.height || 0);
      out.push(clipBox({
        ...b,
        x: (+b.x || 0) * sx,
        y: (+b.y || 0) * sy,
        width: Math.max(1, bw * sx),
        height: Math.max(1, bh * sy),
      }, W, H));
    }
    return out;
  }
  // Fit: uniform letterbox of the BOX UNION into the current canvas
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, +b.x || 0); minY = Math.min(minY, +b.y || 0);
    maxX = Math.max(maxX, (+b.x || 0) + (+b.width || 0)); maxY = Math.max(maxY, (+b.y || 0) + (+b.height || 0));
  }
  const uw = Math.max(1, maxX - minX), uh = Math.max(1, maxY - minY);
  const sc = Math.min(W / uw, H / uh);
  const ucx = (minX + maxX) / 2, ucy = (minY + maxY) / 2;
  const ncx = W / 2, ncy = H / 2;
  for (const b of boxes) {
    const cx = (+b.x || 0) + (+b.width || 0) / 2, cy = (+b.y || 0) + (+b.height || 0) / 2;
    const nw_ = Math.max(1, (+b.width || 0) * sc), nh_ = Math.max(1, (+b.height || 0) * sc);
    out.push(clipBox({
      ...b,
      x: ncx + (cx - ucx) * sc - nw_ / 2,
      y: ncy + (cy - ucy) * sc - nh_ / 2,
      width: nw_, height: nh_,
    }, W, H));
  }
  return out;
}

const src = [{ x: 256, y: 256, width: 512, height: 512, metadata: { type: "obj" } }]; // centred half of 1024²
const SW = 1024, SH = 1024, NW = 1920, NH = 1080;
const fit = remap(src, SW, SH, NW, NH, "fit");
const stretch = remap(src, SW, SH, NW, NH, "stretch");

// Fit: union 512×512 → sc = min(1920/512, 1080/512) = 1080/512; centre → (960,540)
const sc = Math.min(NW / 512, NH / 512);
const fw = Math.max(1, Math.round(512 * sc)), fh = Math.max(1, Math.round(512 * sc));
const fx = Math.round(NW / 2 - fw / 2), fy = Math.round(NH / 2 - fh / 2);
if (fit[0].x !== fx || fit[0].y !== fy || fit[0].width !== fw || fit[0].height !== fh) {
  console.error("FIT mismatch", fit[0], { fx, fy, fw, fh, sc });
  process.exit(1);
}
if (fit[0].height !== NH) {
  console.error("FIT should fill canvas height", fit[0]);
  process.exit(1);
}
// Stretch: sx=1920/1024, sy=1080/1024 → ≈ {480,270,960,540}
const sx = NW / SW, sy = NH / SH;
const stx = Math.round(256 * sx), sty = Math.round(256 * sy);
const stw = Math.max(1, Math.round(512 * sx)), sth = Math.max(1, Math.round(512 * sy));
if (stretch[0].x !== stx || stretch[0].y !== sty || stretch[0].width !== stw || stretch[0].height !== sth) {
  console.error("STRETCH mismatch", stretch[0], { stx, sty, stw, sth });
  process.exit(1);
}
// Stretch must be visible (non-zero, on-canvas)
if (!(stretch[0].width >= 2 && stretch[0].height >= 2)) {
  console.error("STRETCH vanished / too small", stretch[0]);
  process.exit(1);
}
if (stretch[0].x < 0 || stretch[0].y < 0 || stretch[0].x + stretch[0].width > NW || stretch[0].y + stretch[0].height > NH) {
  console.error("STRETCH off-canvas", stretch[0]);
  process.exit(1);
}
// Stretch must NOT equal Fit (anisotropic vs uniform letterbox)
if (stretch[0].x === fit[0].x && stretch[0].y === fit[0].y &&
    stretch[0].width === fit[0].width && stretch[0].height === fit[0].height) {
  console.error("Stretch unexpectedly equals Fit", stretch[0], fit[0]);
  process.exit(1);
}
// Stretch aspect of box follows canvas aspect change (sx≠sy here)
if (Math.abs(stretch[0].width / stretch[0].height - (512 * sx) / (512 * sy)) > 0.05) {
  console.error("STRETCH should be anisotropic", stretch[0], { sx, sy });
  process.exit(1);
}
// Fit twice from same src is idempotent
const fit2 = remap(src, SW, SH, NW, NH, "fit");
if (JSON.stringify(fit) !== JSON.stringify(fit2)) {
  console.error("Fit not idempotent", fit, fit2);
  process.exit(1);
}
console.log("ok fit", fit[0]);
console.log("ok stretch", stretch[0]);
console.log("ok Stretch ≠ Fit; sx=", sx, "sy=", sy);
