#!/usr/bin/env node
/** Pure Fit/Stretch math (mirrors web/cordon_canvas.js remapFromSrc). */
function clipBox(b, nw, nh) {
  let x = Math.round(+b.x), y = Math.round(+b.y), w = Math.max(1, Math.round(+b.width)), h = Math.max(1, Math.round(+b.height));
  if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
  if (x + w > nw) w = Math.max(1, nw - x); if (y + h > nh) h = Math.max(1, nh - y);
  return { x, y, width: Math.max(1, w), height: Math.max(1, h), metadata: b.metadata };
}
function remap(boxes, sw, sh, nw, nh, mode) {
  const out = [];
  if (mode === "stretch") {
    const sx = nw / sw, sy = nh / sh;
    for (const b of boxes) out.push(clipBox({ ...b, x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy }, nw, nh));
  } else {
    const sc = Math.min(nw / sw, nh / sh);
    const ox = (nw - sw * sc) / 2, oy = (nh - sh * sc) / 2;
    for (const b of boxes) out.push(clipBox({ ...b, x: ox + b.x * sc, y: oy + b.y * sc, width: b.width * sc, height: b.height * sc }, nw, nh));
  }
  return out;
}

const src = [{ x: 256, y: 256, width: 512, height: 512, metadata: { type: "obj" } }]; // centred half of 1024²
const fit = remap(src, 1024, 1024, 1920, 1080, "fit");
const stretch = remap(src, 1024, 1024, 1920, 1080, "stretch");

// Fit: sc = min(1920/1024, 1080/1024) = 1080/1024; letterbox X
const sc = 1080 / 1024;
const ox = (1920 - 1024 * sc) / 2;
const fy = Math.round(0 + 256 * sc), fx = Math.round(ox + 256 * sc);
const fw = Math.max(1, Math.round(512 * sc)), fh = Math.max(1, Math.round(512 * sc));
if (fit[0].x !== fx || fit[0].y !== fy || fit[0].width !== fw || fit[0].height !== fh) {
  console.error("FIT mismatch", fit[0], { fx, fy, fw, fh });
  process.exit(1);
}
// Stretch: sx=1920/1024, sy=1080/1024
const sx = 1920 / 1024, sy = 1080 / 1024;
const stx = Math.round(256 * sx), sty = Math.round(256 * sy);
const stw = Math.max(1, Math.round(512 * sx)), sth = Math.max(1, Math.round(512 * sy));
if (stretch[0].x !== stx || stretch[0].y !== sty || stretch[0].width !== stw || stretch[0].height !== sth) {
  console.error("STRETCH mismatch", stretch[0], { stx, sty, stw, sth });
  process.exit(1);
}
// Fit must NOT equal Stretch for this aspect change
if (fit[0].x === stretch[0].x && fit[0].width === stretch[0].width) {
  console.error("Fit unexpectedly equals Stretch");
  process.exit(1);
}
console.log("ok fit", fit[0]);
console.log("ok stretch", stretch[0]);
