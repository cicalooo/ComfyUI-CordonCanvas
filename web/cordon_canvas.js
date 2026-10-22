import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { initState, applyResize, upscale, uniLoadState, uniRatioSolve, resolutionSelectorSize } from "./uni_geometry.js";

const NODE_ID = "CordonCanvas";
// ---------- canvas-docked editor panel (Kijai-inspired, own implementation) ----------
// Single mode, persisted per node: the dock lives in graph space under the Cordon node —
// it moves with the node AND the viewport (part of the canvas), never above ComfyUI chrome.
// Node drag needs no manual delta math (transform inheritance does it).
// The editor size is always independent of node.size.
const CDC_DOCK_MINW = 300, CDC_DOCK_MINH = 340;
const CDC_TITLE_H = (window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30);
const cdcLive = new Set();     // every node with a dock (placement loop + orphan sweep)
function cdcChain(obj, prop, fn) {
  if (!obj) return;
  if (prop in obj) {
    const prev = obj[prop];
    obj[prop] = function (...a) { const r = prev.apply(this, a); fn.apply(this, a); return r; };
  } else obj[prop] = fn;
}
// Which graph host the dock follows, or null (hide) when its graph isn't displayed.
function cdcAnchor(n) {
  const c = app.canvas;
  if (!c || !c.graph) return null;
  if (n.graph === c.graph) return n;
  return null;
}
// Place the dock for node n. Inside the Vue node element (inherits canvas transform)
// or, without a Vue element, body-fixed with a canvas transform.
function cdcPlace(n, rect) {
  const c = app.canvas, fl = n._cdcDock;
  if (!c || !fl) return;
  const host = cdcAnchor(n);
  if (!host) return;
  const gr = n.properties.cdc_dockGraph || (n.properties.cdc_dockGraph = { x: 0, y: (host.size?.[1] ?? 120) + 6, w: 440, h: 560 });
  let hostEl = null;
  if (host.id != null) {
    if (n._cdcHostId !== host.id || !n._cdcHostEl?.isConnected) {
      n._cdcHostEl = document.querySelector(`[data-node-id="${host.id}"]`);
      n._cdcHostId = host.id; n._cdcSig = "";
    }
    hostEl = n._cdcHostEl;
  }
  if (hostEl) {
    if (fl.parentElement !== hostEl) { hostEl.appendChild(fl); n._cdcSig = ""; }
    fl.style.position = "absolute"; fl.style.transform = ""; fl.style.transformOrigin = ""; fl.style.zIndex = "";
    const sig = `v|${gr.x}|${gr.y}|${gr.w}|${gr.h}`;
    if (n._cdcSig !== sig) {
      fl.style.left = Math.round(gr.x) + "px"; fl.style.top = Math.round(CDC_TITLE_H + gr.y) + "px";
      fl.style.width = Math.round(gr.w) + "px"; fl.style.height = Math.round(gr.h) + "px";
      n._cdcSig = sig;
    }
    return;
  }
  if (fl.parentElement !== document.body) { document.body.appendChild(fl); n._cdcSig = ""; }
  if (!host.pos) return;
  const ds = c.ds, scale = ds.scale || 1;
  rect = rect || c.canvas.getBoundingClientRect();
  const bx = rect.left + (host.pos[0] + gr.x + ds.offset[0]) * scale;
  const by = rect.top + (host.pos[1] + gr.y + ds.offset[1]) * scale;
  const tf = `translate(${Math.round(bx)}px,${Math.round(by)}px) scale(${scale})`;
  if (n._cdcSig !== tf) {
    fl.style.position = "fixed"; fl.style.transformOrigin = "top left"; fl.style.transform = tf; fl.style.zIndex = "";
    fl.style.left = ""; fl.style.top = "";
    fl.style.width = Math.round(gr.w) + "px"; fl.style.height = Math.round(gr.h) + "px";
    n._cdcSig = tf;
  }
}
function cdcSweep() {
  for (const n of [...cdcLive]) {
    try {
      if (n.graph?.getNodeById?.(n.id) === n) continue;
    } catch { continue; }
    try { n._cdcRO?.disconnect(); } catch {}
    try { n._visObs?.disconnect(); } catch {}
    try { n._cdcDock?.remove(); } catch {}
    cdcLive.delete(n);
  }
}
// Event-driven loop: woken by canvas redraws, window resize, and interactions;
// idle-stops after a few settled frames so it never fights the user or burns CPU.
const CDC_IDLE_STOP = 8;
let _cdcRAF = 0, _cdcIdle = 0, _cdcVueMode = null, _cdcWakes = false;
function cdcTick() {
  const c = app.canvas;
  if (c && cdcLive.size) {
    const vue = !!window.LiteGraph?.vueNodesMode;
    if (vue !== _cdcVueMode) {
      _cdcVueMode = vue;
      for (const n of cdcLive) { n._cdcSig = ""; n._cdcHostEl = null; n._cdcHostId = null; }
    }
    const rect = vue ? null : c.canvas.getBoundingClientRect();
    for (const n of cdcLive) {
      const a = cdcAnchor(n);
      const show = n.properties.cdc_open !== false && !n.properties.cdc_min && !!a;
      if (n._cdcDock) n._cdcDock.style.display = show ? "" : "none";
      try {
        const locked = !!(n.flags && n.flags.pinned);
        n._cdcDock?.classList.toggle("locked", locked);
      } catch {}
      if (a) cdcPlace(n, rect);
    }
  }
  // Keep the loop alive briefly after wakes so docked placements settle, then stop.
  if (cdcLive.size && ++_cdcIdle < CDC_IDLE_STOP) _cdcRAF = requestAnimationFrame(cdcTick);
  else _cdcRAF = 0;
}
function cdcWake() {
  _cdcIdle = 0;
  if (!_cdcRAF && cdcLive.size) _cdcRAF = requestAnimationFrame(cdcTick);
}
function cdcInstallWakes() {
  if (_cdcWakes) return;
  const c = app.canvas; if (!c) return;
  _cdcWakes = true;
  cdcChain(c, "onDrawForeground", () => { cdcSweep(); cdcWake(); });
}
// Dock geometry setup (per node). The dock is always canvas-docked under the node.
// Drops legacy floating-mode leftovers (cdc_pinned / cdc_dockRect / cdc_win / cdc_pinVer,
// bbc_* pin keys) so old saves open docked under the node at their last docked geometry
// (or the default slot when they never had one).
function migrateDockGeom(node) {
  const p = (node.properties ??= {});
  if (p.cdc_dockGraph === undefined && p.bbc_dockGraph !== undefined) {
    p.cdc_dockGraph = p.bbc_dockGraph;
    try { delete p.bbc_dockGraph; } catch {}
  }
  for (const k of ["cdc_pinned", "cdc_dockRect", "cdc_win", "cdc_pinVer", "bbc_pinned", "bbc_win"]) {
    try { delete p[k]; } catch {}
  }
  // bbc_open/bbc_min predate the cdc_ keys; carry them over once, then drop.
  for (const [o, n] of [["bbc_open", "cdc_open"], ["bbc_min", "cdc_min"]]) {
    if (p[n] === undefined && p[o] !== undefined) p[n] = p[o];
    try { delete p[o]; } catch {}
  }
  const g = p.cdc_dockGraph;
  if (!g || !Number.isFinite(+g.x) || !Number.isFinite(+g.y)) {
    p.cdc_dockGraph = { x: 0, y: (node.size?.[1] ?? 120) + 6, w: 440, h: 560 };
  } else {
    g.w = Math.max(CDC_DOCK_MINW, Math.round(+g.w) || 440);
    g.h = Math.max(CDC_DOCK_MINH, Math.round(+g.h) || 560);
  }
}
function cdcDrag(e, target, onMove, onEnd) {
  try { target.setPointerCapture(e.pointerId); } catch {}
  const mv = (me) => { if (me.pointerId === e.pointerId) onMove(me); };
  const up = (ue) => {
    if (ue.pointerId !== e.pointerId) return;
    target.removeEventListener("pointermove", mv);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onEnd?.(ue);
  };
  target.addEventListener("pointermove", mv);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}
function cdcInjectCSS() {
  if (document.getElementById("cdc-dock-style")) return;
  const s = document.createElement("style");
  s.id = "cdc-dock-style";
  s.textContent = `
    .cdc-dock { position:fixed; display:flex; flex-direction:column; background:#1b1b1b; color:#ddd;
      border:1px solid #555; border-radius:8px; box-shadow:0 8px 30px rgba(0,0,0,0.55);
      min-width:${CDC_DOCK_MINW}px; min-height:${CDC_DOCK_MINH}px; overflow:hidden; pointer-events:auto; box-sizing:border-box; }
    .cdc-head { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:4px 8px;
      background:#2a2a2a; cursor:move; user-select:none; border-bottom:1px solid #444; font:12px sans-serif; color:#ccc; }
    .cdc-head .cdc-btn { background:#333; border:1px solid #555; border-radius:4px; color:#bbb;
      font:11px sans-serif; cursor:pointer; padding:1px 7px; line-height:16px; white-space:nowrap; }
    .cdc-head .cdc-btn:hover { border-color:#7a5; color:#fff; }
    .cdc-head .cdc-btn.active { border-color:#7a5; color:#8f8; background:#2a3a2a; }
    .cdc-bar { display:flex; gap:2px; align-items:center; }
    .cdc-bar .cdc-btn { background:#333; border:1px solid #555; border-radius:3px; color:#bbb;
      font:11px sans-serif; cursor:pointer; padding:1px 4px; line-height:16px; white-space:nowrap; }
    .cdc-bar .cdc-btn:hover { border-color:#7a5; color:#fff; }
    .cdc-bar .cdc-btn.active { border-color:#7a5; color:#8f8; background:#2a3a2a; }
    .cdc-bar input[type=range] { width:48px; }
    .cdc-body { flex:1 1 auto; min-height:0; padding:6px; box-sizing:border-box; overflow:hidden; display:flex; }
    .cdc-body > div { flex:1 1 auto; min-height:0; }
    .cdc-dock.min { min-height:0 !important; height:auto !important; }
    .cdc-dock.min .cdc-body, .cdc-dock.min .cdc-rsz { display:none; }
    .cdc-dock.locked .cdc-rsz { display:none; }
    .cdc-dock.locked .cdc-head { cursor:default; }
    .cdc-rsz { position:absolute; z-index:5; touch-action:none; }
    .cdc-rsz.n { top:0; left:10px; right:10px; height:6px; cursor:ns-resize; }
    .cdc-rsz.s { bottom:0; left:10px; right:10px; height:6px; cursor:ns-resize; }
    .cdc-rsz.e { right:0; top:10px; bottom:10px; width:6px; cursor:ew-resize; }
    .cdc-rsz.w { left:0; top:10px; bottom:10px; width:6px; cursor:ew-resize; }
    .cdc-rsz.ne { top:0; right:0; width:12px; height:12px; cursor:nesw-resize; }
    .cdc-rsz.nw { top:0; left:0; width:12px; height:12px; cursor:nwse-resize; }
    .cdc-rsz.se { bottom:0; right:0; width:12px; height:12px; cursor:nwse-resize; }
    .cdc-rsz.sw { bottom:0; left:0; width:12px; height:12px; cursor:nesw-resize; }
    .cdc-dock.snap { box-shadow:0 -3px 0 0 #7a5, 0 8px 30px rgba(0,0,0,0.55); }
  `;
  document.head.appendChild(s);
}
const COLORS = ["#E6194B", "#3CB44B", "#FFE119", "#4363D8", "#F58231", "#911EB4", "#42D4F4", "#F032E6", "#BFEF45", "#FABED4"];
const HANDLE = 7;
const MIN_PX = 4;

// ---------- shared image cache (url -> HTMLImageElement) ----------
const IMG_CACHE = new Map();
const IMG_LISTENERS = new Set();
function cachedImage(url) {
  let e = IMG_CACHE.get(url);
  if (!e) {
    const img = new Image();
    e = { img, ready: false, failed: false };
    img.onload = () => { e.ready = true; IMG_LISTENERS.forEach((f) => f()); };
    img.onerror = () => { e.failed = true; IMG_LISTENERS.forEach((f) => f()); };
    img.src = url;
    IMG_CACHE.set(url, e);
    if (IMG_CACHE.size > 64) IMG_CACHE.delete(IMG_CACHE.keys().next().value);
  }
  return e;
}
const nodeKind = (n) => n?.comfyClass || n?.type;
const UNI_LOAD = "UniLoadNode", UNI_RESIZE = "UniResizeNode", UNI_RATIO = "UniRatioNode";
const RES_SELECTOR = "ResolutionSelector"; // ComfyUI core: width/height computed from widgets

const isHex = (c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/**
 * Separate the editor display colour (metadata.display_color, never sent to prompts) from the
 * prompt palette (metadata.palette, only used when metadata.use_palette is true).
 * fromEditor: boxes saved by this editor -> a lone old auto colour is migrated to display_color.
 */
function migrateBoxes(list, fromEditor = true) {
  list.forEach((b, i) => {
    const m = (b.metadata && typeof b.metadata === "object") ? b.metadata : (b.metadata = {});
    m.type ??= "obj"; m.text ??= ""; m.desc ??= "";
    m.character = m.character === true && m.type !== "text";
    let pal = Array.isArray(m.palette) ? m.palette.filter(isHex).map((c) => c.toUpperCase()) : [];
    if (typeof m.use_palette !== "boolean") {
      if (fromEditor && pal.length === 1 && COLORS.includes(pal[0]) && !isHex(m.display_color)) {
        m.display_color = pal[0]; pal = []; m.use_palette = false;
      } else m.use_palette = pal.length > 0;
    }
    m.palette = pal;
    if (!isHex(m.display_color)) m.display_color = COLORS[i % COLORS.length];
  });
  return list;
}

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.type = "hidden";
  if (w.element) w.element.style.display = "none";
}

function parse(text) {
  try { const d = JSON.parse(text || "[]"); return Array.isArray(d) ? d : []; } catch { return []; }
}

function el(tag, attrs = {}, style = {}) {
  const e = document.createElement(tag);
  Object.assign(e, attrs); Object.assign(e.style, style);
  return e;
}

function setupNode(node) {
  const W = (n) => node.widgets?.find((w) => w.name === n);
  const dataW = W("box_data"), lastW = W("last_incoming"), widthW = W("width"), heightW = W("height");
  hideWidget(dataW); hideWidget(lastW);
  // batch/latent/preset live in the dock (keeps the node body small); hidden on the node itself.
  // caption lives on the node itself (multiline widget / linkable input) — not duplicated in the dock.
  const batchW = W("batch_size"), latentW = W("latent_type"), presetW = W("style_preset"), canvasW = W("canvas");
  for (const w of [batchW, latentW, presetW, canvasW]) hideWidget(w);

  let boxes = migrateBoxes(parse(dataW?.value));
  let sel = -1, drag = null, bgImg = null, upInfo = null; // upInfo: {url, entry, state} from the upstream chain
  let followInfo = null, followCands = []; // followInfo: downstream mirror (no graph edge, no cycle); followCands: [{id,title,kind}]
  const hasBackgroundLink = () => !!node.inputs?.find((i) => i.name === "background" && i.link != null);
  // current background: {img, rect:[sx,sy,sw,sh], w, h}
  let lastMismatch = "";
  // Recomputed on every draw from the image that is actually loaded right now + current upstream settings.
  // Priority: linked background (explicit) > downstream follow mirror (only when background input is empty) > last run.
  const freshBg = () => {
    let info = null;
    try { info = backgroundInfo(); } catch { info = null; }
    const img = info?.entry?.img;
    if (info?.state && info.entry.ready && img?.naturalWidth) return { img, rect: info.state.rect, w: info.state.w, h: info.state.h, from: "upstream" };
    if (!hasBackgroundLink() && followInfo?.entry?.ready && followInfo.state) {
      const fimg = followInfo.entry.img;
      if (fimg?.naturalWidth) return { img: fimg, rect: followInfo.state.rect, w: followInfo.state.w, h: followInfo.state.h, from: followInfo.label || "follow" };
    }
    if (bgImg?.complete && bgImg.naturalWidth) return { img: bgImg, rect: [0, 0, bgImg.naturalWidth, bgImg.naturalHeight], w: bgImg.naturalWidth, h: bgImg.naturalHeight, from: "last run" };
    return null;
  };
  // effective (resolved) canvas size; see resolveDims()
  let eff = { w: 0, h: 0, srcW: "widget", srcH: "widget" };
  const runDims = { w: null, h: null };
  const widgetNum = (w) => { const v = Math.round(+w?.value); return Number.isFinite(v) && v > 0 ? v : 1024; };
  // Latent downscale parsed from the latent_type widget ("128ch /16 ..." -> 16).
  // The backend floors width/height to this multiple for the latent, so a canvas size
  // that is not divisible renders (and conditions layout regions on) a smaller frame.
  function latentDs() {
    const m = String(curLatentW()?.value ?? "").match(/\/\s*(\d+)/);
    const ds = m ? +m[1] : 8;
    return ds > 0 ? ds : 8;
  }
  const dims = () => [Math.max(1, eff.w || widgetNum(node.widgets?.find((w) => w.name === "width") ?? widthW)), Math.max(1, eff.h || widgetNum(node.widgets?.find((w) => w.name === "height") ?? heightW))];

  // ---------- DOM ----------
  const root = el("div", {}, { display: "flex", flexDirection: "column", gap: "4px", width: "100%", height: "100%",
    boxSizing: "border-box", font: "12px sans-serif", color: "#ddd", overflow: "hidden" });
  const bar = el("div", { className: "cdc-bar" }, { flex: "0 0 auto" });
  const btn = (t, f, title) => { const b = el("button", { className: "cdc-btn", textContent: t, title: title || "" }, {});
    b.onclick = (e) => { e.stopPropagation(); f(); }; return b; };
  node.properties ??= {};
  node.properties.cdc_overlay ??= true;
  node.properties.cdc_opacity ??= 0.65;
  node.properties.cdc_follow ??= "auto"; // "auto" | "off" | downstream node id (number)
  const ovBtn = btn("👁", () => { node.properties.cdc_overlay = !node.properties.cdc_overlay; syncOvBtn(); draw(); }, "Show background image");
  const syncOvBtn = () => ovBtn.classList.toggle("active", !!node.properties.cdc_overlay);
  const ovSl = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: node.properties.cdc_opacity, title: "Background opacity" }, { width: "48px" });
  ovSl.oninput = () => { node.properties.cdc_opacity = +ovSl.value; draw(); };
  for (const i of [ovSl]) { i.addEventListener("pointerdown", (e) => e.stopPropagation()); i.addEventListener("keydown", (e) => e.stopPropagation()); }
  const followBtn = btn("🔗", () => { cycleFollow(); });
  followBtn.title = "Mirror a downstream image (e.g. SaveImage) as the background without a link (links back would be a dependency cycle). Click to cycle: auto → off → downstream node → …";
  const shortLbl = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);
  const updateFollowBtn = () => {
    const mode = node.properties.cdc_follow ?? "auto";
    let t = "🔗auto";
    if (mode === "off") t = "🔗off";
    else if (typeof mode === "number") {
      const c = followCands.find((x) => x.id === mode);
      t = "🔗" + shortLbl(c ? (c.kind || ("#" + mode)) : ("#" + mode), 10);
    } else if (followInfo) {
      t = "🔗" + shortLbl(followInfo.label || "auto", 10);
    }
    followBtn.textContent = t;
    followBtn.classList.toggle("active", !!followInfo && mode !== "off");
  };
  function cycleFollow() {
    const mode = node.properties.cdc_follow ?? "auto";
    const withImg = followCands.filter((c) => c.hasImg);
    const pool = withImg.length ? withImg : followCands;
    if (mode === "auto") {
      node.properties.cdc_follow = "off";
      flash("follow: off — downstream mirror disabled");
    } else if (mode === "off") {
      if (pool.length) {
        node.properties.cdc_follow = pool[0].id;
        flash(`follow: ${pool[0].kind || "node"} ${pool[0].title || pool[0].id} — editor-only mirror (no link, no cycle)`);
      } else { node.properties.cdc_follow = "auto"; flash("follow: auto — no downstream image nodes found yet"); }
    } else {
      const i = pool.findIndex((c) => c.id === mode);
      if (i >= 0 && i < pool.length - 1) {
        node.properties.cdc_follow = pool[i + 1].id;
        flash(`follow: ${pool[i + 1].kind || "node"} ${pool[i + 1].title || pool[i + 1].id} — editor-only mirror (no link, no cycle)`);
      } else { node.properties.cdc_follow = "auto"; flash("follow: auto — mirror the downstream result when background is empty"); }
    }
    upSig = ""; refreshUpstream();
  }
  bar.append(btn("🗑", () => { boxes = []; sel = -1; commit(); }, "Clear all boxes"),
             btn("⌫", () => removeSel(), "Delete selected box"),
             btn("▲", () => reorder(1), "Move box forward (drawn later, on top)"),
             btn("▼", () => reorder(-1), "Move box backward (drawn earlier, below)"),
             ovBtn, ovSl, followBtn);
  syncOvBtn();
  let flashTimer = null;
  const HINT_OPS = "drag: new/move/resize · Shift/Ctrl+drag: new box over others · Alt+click: cycle overlapping · Del/right-click: remove · Esc: deselect · wheel: zoom · middle/Space+drag: pan · dbl-click empty: fit · Ctrl+wheel: graph zoom";
  const baseHint = () => {
    const [dw, dh] = dims();
    const srcs = [...new Set([eff.srcW, eff.srcH])].filter((x) => x !== "widget");
    const ds = latentDs();
    const frameWarn = (dw % ds || dh % ds)
      ? ` · ⚠ not ÷${ds}: latent renders ${Math.floor(dw / ds) * ds}×${Math.floor(dh / ds) * ds}`
      : "";
    return `${dw}×${dh}${srcs.length ? ` (${srcs.join("/")})` : ""} · ${boxes.length} box${boxes.length === 1 ? "" : "es"}` + (sel >= 0 ? ` · #${sel + 1}` : "")
      + (() => { const c = boxes.map((b, i) => (b.metadata?.character && b.metadata?.type !== "text" ? i + 1 : 0)).filter(Boolean); return c.length ? ` · ★ ${c.join(", ")}` : ""; })()
      + frameWarn
      + ` · ${HINT_OPS}`;
  };
  const hint = el("div", { textContent: HINT_OPS },
    { flex: "0 0 auto", fontSize: "10px", opacity: 0.55, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
  const flash = (msg) => { hint.textContent = msg; hint.style.opacity = 0.95; clearTimeout(flashTimer); flashTimer = setTimeout(() => { hint.textContent = baseHint(); hint.style.opacity = 0.55; flashTimer = null; }, 4000); };
  // flex-basis 0 + min sizes 0: the wrap's size never depends on the canvas inside it (no feedback loop)
  const wrap = el("div", {}, { flex: "1 1 0", minHeight: "60px", minWidth: "0", position: "relative", overflow: "hidden" });
  const canvas = el("canvas", { tabIndex: 0 }, { outline: "none", cursor: "crosshair", background: "#202020",
    position: "absolute", left: "0px", top: "0px", maxWidth: "none", maxHeight: "none" });
  wrap.append(canvas);

  const panel = el("div", {}, { flex: "0 0 auto", display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 6px", alignItems: "center" });
  const inStyle = { background: "#222", color: "#ddd", border: "1px solid #555", borderRadius: "3px", padding: "1px 4px", minWidth: 0 };
  const typeSel = el("select", {}, inStyle);
  for (const t of ["obj", "text"]) typeSel.append(el("option", { value: t, textContent: t }));
  const textIn = el("textarea", { rows: 2, placeholder: "rendered text (type=text). Real newlines are kept." }, { ...inStyle, resize: "vertical" });
  const descIn = el("textarea", { rows: 2, placeholder: "description" }, { ...inStyle, resize: "none" });
  const swatch = { width: "28px", height: "20px", padding: 0, border: "none", background: "none" };
  // display colour: editor/preview only, never in prompt elements
  const dispIn = el("input", { type: "color", title: "Box colour in the editor/preview (not sent to the prompt)" }, swatch);
  const dispRow = el("div", {}, { display: "flex", gap: "6px", alignItems: "center" });
  const usePal = el("input", { type: "checkbox", title: "Send a colour palette for this box to the prompt (color_palette)" });
  const usePalLab = el("label", {}, { display: "flex", gap: "3px", alignItems: "center", cursor: "pointer" });
  usePalLab.append(usePal, el("span", { textContent: "use colour palette in prompt" }));
  dispRow.append(dispIn, el("span", { textContent: "box colour" }, { opacity: 0.6 }), usePalLab);
  const palRow = el("div", {}, { display: "none", gap: "4px" });
  const colorIn = el("input", { type: "color", title: "First prompt palette colour" }, swatch);
  const palIn = el("input", { type: "text", placeholder: "prompt colours: #RRGGBB, #RRGGBB … (max 5)" }, { ...inStyle, flex: 1 });
  palRow.append(colorIn, palIn);
  const charIn = el("input", { type: "checkbox", title: "Label this box as a character for MOSS (adds its number to the character_boxes output)" });
  const charLab = el("label", {}, { display: "flex", gap: "3px", alignItems: "center", cursor: "pointer" });
  charLab.append(charIn, el("span", { textContent: "★ character" }));
  const typeRow = el("div", {}, { display: "flex", gap: "8px", alignItems: "center" });
  typeRow.append(typeSel, charLab);
  const lab = (t) => el("span", { textContent: t }, { opacity: 0.8 });
  const palLab = lab("palette");
  panel.append(lab("type"), typeRow, lab("text"), textIn, lab("desc"), descIn, lab("colour"), dispRow, palLab, palRow);
  // dock-only controls (preset/batch/latent) live here so the node body stays small.
  // caption is NOT duplicated here: it lives on the node itself. Only per-box
  // descriptions (text/desc in the panel above) live in this editor.
  const comboOpts = (w) => {
    const o = w?.options;
    if (Array.isArray(o)) return o;
    if (o && Array.isArray(o.values)) return o.values;
    return [];
  };
  const genDiv = el("div", {}, { flex: "0 0 auto", display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 6px", alignItems: "center",
    borderTop: "1px solid #333", paddingTop: "4px" });
  const presetSel = el("select", { title: "Style preset: baked into the prompt caption" }, inStyle);
  const batchIn = el("input", { type: "number", min: 1, max: 4096, step: 1, title: "Batch size of the empty latent output" }, { ...inStyle, width: "64px" });
  const latentSel = el("select", { title: "Channels/downscale of the empty latent output" }, { ...inStyle, flex: 1 });
  const batchLatRow = el("div", {}, { display: "flex", gap: "6px", alignItems: "center" });
  batchLatRow.append(batchIn, latentSel);
  const canvasSel = el("select", { title: "summary.canvas: single, multi_panel or collage" }, inStyle);
  const presetLab = lab("preset"), canvasLab = lab("canvas"), batchLatLab = lab("batch·lat");
  genDiv.append(presetLab, presetSel, canvasLab, canvasSel, batchLatLab, batchLatRow);
  root.append(bar, hint, wrap, panel, genDiv);

  const fillSel = (sel, opts, cur) => {
    const list = opts.length ? opts : (cur != null ? [cur] : ["none"]);
    if (sel.options.length !== list.length || !list.every((v, i) => sel.options[i]?.value === v)) {
      sel.innerHTML = "";
      for (const t of list) sel.append(el("option", { value: t, textContent: t }));
    }
    if (cur != null && list.includes(cur) && document.activeElement !== sel) sel.value = cur;
  };
  function syncGen() {
    const pw = curPresetW(), lw = curLatentW(), bw = curBatchW();
    // legacy preset names stay valid on the widget but are only listed when currently selected
    const legacy = new Set(["unreal cinematic", "cgi render", "cgi", "unreal", "analog photo", "cinematic", "photograph"]);
    fillSel(presetSel, comboOpts(pw).filter((v) => !legacy.has(v) || v === pw?.value), pw?.value);
    const cw = curCanvasW();
    fillSel(canvasSel, comboOpts(cw).length ? comboOpts(cw) : ["single", "multi_panel", "collage"], cw?.value ?? "single");
    canvasSel.disabled = !cw || !!linkedInput("canvas");
    fillSel(latentSel, comboOpts(lw), lw?.value);
    if (bw && document.activeElement !== batchIn) batchIn.value = bw.value ?? 1;
    batchIn.disabled = !!linkedInput("batch_size");
    presetSel.disabled = !!linkedInput("style_preset");
    latentSel.disabled = !!linkedInput("latent_type");
  }
  batchIn.onchange = () => { const bw = curBatchW(); if (bw && !linkedInput("batch_size")) { const v = Math.max(1, Math.round(+batchIn.value) || 1); bw.value = v; batchIn.value = v; bw.callback?.(v); node.setDirtyCanvas?.(true, true); } };
  latentSel.onchange = () => { const lw = curLatentW(); if (lw && !linkedInput("latent_type")) { lw.value = latentSel.value; lw.callback?.(latentSel.value); node.setDirtyCanvas?.(true, true); } };
  presetSel.onchange = () => { const pw = curPresetW(); if (pw && !linkedInput("style_preset")) { pw.value = presetSel.value; pw.callback?.(presetSel.value); node.setDirtyCanvas?.(true, true); } };

  canvasSel.onchange = () => { const cw = curCanvasW(); if (cw && !linkedInput("canvas")) { cw.value = canvasSel.value; cw.callback?.(canvasSel.value); node.setDirtyCanvas?.(true, true); } };

  for (const i of [typeSel, textIn, descIn, palIn, colorIn, dispIn, usePal, charIn, presetSel, canvasSel, batchIn, latentSel]) {
    i.addEventListener("keydown", (e) => e.stopPropagation());
    i.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
  const meta = () => { const b = boxes[sel]; if (!b) return null; b.metadata ??= { type: "obj", text: "", desc: "", palette: [], use_palette: false }; return b.metadata; };
  typeSel.onchange = () => { const m = meta(); if (m) { m.type = typeSel.value; if (m.type === "text") m.character = false; commit(); } };
  charIn.onchange = () => { const m = meta(); if (m && m.type !== "text") { m.character = charIn.checked; commit(); } };
  textIn.oninput = () => { const m = meta(); if (m) { m.text = textIn.value; commit(); } };
  descIn.oninput = () => { const m = meta(); if (m) { m.desc = descIn.value; commit(); } };
  palIn.onchange = () => { const m = meta(); if (m) { m.palette = palIn.value.split(/[\s,]+/).filter((c) => /^#?[0-9a-f]{6}$/i.test(c)).map((c) => (c[0] === "#" ? c : "#" + c).toUpperCase()); commit(); } };
  colorIn.oninput = () => { const m = meta(); if (m) { const p = [...(m.palette || [])]; p[0] = colorIn.value.toUpperCase(); m.palette = p; commit(); } };
  dispIn.oninput = () => { const m = meta(); if (m) { m.display_color = dispIn.value.toUpperCase(); commit(); } };
  usePal.onchange = () => {
    const m = meta(); if (!m) return;
    m.use_palette = usePal.checked;
    if (m.use_palette && !(m.palette || []).length) m.palette = [(m.display_color || COLORS[0]).toUpperCase()]; // sensible start; editable
    commit();
  };

  function syncPanel() {
    const m = boxes[sel]?.metadata;
    for (const i of [typeSel, textIn, descIn, palIn, colorIn, dispIn, usePal, charIn]) i.disabled = !m;
    charIn.checked = !!m?.character && m?.type !== "text";
    charLab.style.display = m?.type === "text" ? "none" : "flex";
    typeSel.value = m?.type || "obj"; textIn.value = m?.text || ""; descIn.value = m?.desc || "";
    dispIn.value = boxColor(sel).slice(0, 7);
    usePal.checked = !!m?.use_palette;
    const showPal = !!m?.use_palette;
    palRow.style.display = showPal ? "flex" : "none"; palLab.style.display = showPal ? "" : "none";
    palIn.value = (m?.palette || []).join(", "); colorIn.value = (m?.palette?.[0] || boxColor(sel)).slice(0, 7);
    textIn.style.opacity = m?.type === "text" ? 1 : 0.5;
    if (!flashTimer) hint.textContent = baseHint();
    syncGen();
  }
  const boxColor = (i) => { const m = boxes[i]?.metadata; return (isHex(m?.display_color) && m.display_color) || COLORS[Math.max(0, i) % COLORS.length]; };

  function commit(redraw = true) {
    const dw = curDataW();
    if (dw) dw.value = JSON.stringify(boxes);
    node.setDirtyCanvas?.(true, true);
    if (redraw) { syncPanel(); draw(); }
  }
  function removeSel() { if (sel >= 0) { boxes.splice(sel, 1); sel = -1; commit(); } }
  function reorder(d) { // order matters (background first); ▲ moves later/front
    const j = sel + d; if (sel < 0 || j < 0 || j >= boxes.length) return;
    [boxes[sel], boxes[j]] = [boxes[j], boxes[sel]]; sel = j; commit();
  }

  // ---------- geometry ----------
  // View zoom/pan: z (1 = fit) and the image point (cx, cy) shown at the wrap centre.
  // Persisted in node.properties.cdc_view; reset when width/height change.
  const ZMIN = 1, ZMAX = 16;
  let view = { s: 1, cw: 1, ch: 1, aw: 1, ah: 1, ox: 0, oy: 0, dpr: 1, kx: 1, ky: 1 };
  const vz = () => {
    const [w, h] = dims(); let v = node.properties.cdc_view;
    if (!v || v.w !== w || v.h !== h || !(v.z >= ZMIN)) v = node.properties.cdc_view = { z: 1, cx: w / 2, cy: h / 2, w, h };
    return v;
  };
  const resetView = () => { node.properties.cdc_view = null; draw(); };
  const clampView = (v) => {
    const [w, h] = dims();
    v.z = Math.max(ZMIN, Math.min(ZMAX, v.z));
    if (v.z <= ZMIN + 1e-6) { v.z = 1; v.cx = w / 2; v.cy = h / 2; return; }
    v.cx = Math.max(0, Math.min(w, v.cx)); v.cy = Math.max(0, Math.min(h, v.cy));
  };
  function layout() {
    const [w, h] = dims();
    const aw = Math.max(20, wrap.clientWidth), ah = Math.max(20, wrap.clientHeight);
    const v = vz();
    const s = Math.min(aw / w, ah / h) * v.z;
    // the canvas fills the wrap; the image (w×h) is drawn at scale s with offset (ox, oy)
    const ox = aw / 2 - v.cx * s, oy = ah / 2 - v.cy * s;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(aw * dpr)), bh = Math.max(1, Math.round(ah * dpr));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    canvas.style.width = aw + "px"; canvas.style.height = ah + "px";
    canvas.style.left = "0px"; canvas.style.top = "0px";
    view = { s, cw: w * s, ch: h * s, aw, ah, ox, oy, dpr, kx: bw / aw, ky: bh / ah }; // per-axis backing-store scale
  }
  // client -> wrap CSS px (the dock itself may be scaled by the graph zoom)
  const toLocal = (e) => { const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * view.aw / Math.max(1e-6, r.width), (e.clientY - r.top) * view.ah / Math.max(1e-6, r.height)]; };
  const toImgRaw = (e) => { const [lx, ly] = toLocal(e); return [(lx - view.ox) / view.s, (ly - view.oy) / view.s]; };
  const toImg = (e) => { const [w, h] = dims(); const [x, y] = toImgRaw(e);
    return [Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))]; };

  function hit(px, py) {
    const tol = (HANDLE + 2) / view.s;
    // selected box handles first
    const order = sel >= 0 ? [sel, ...boxes.map((_, i) => i).reverse().filter((i) => i !== sel)] : boxes.map((_, i) => i).reverse();
    for (const i of order) {
      const b = boxes[i]; const x1 = b.x, y1 = b.y, x2 = b.x + b.width, y2 = b.y + b.height;
      const inX = px >= x1 - tol && px <= x2 + tol, inY = py >= y1 - tol && py <= y2 + tol;
      if (!inX || !inY) continue;
      let edge = "";
      if (Math.abs(py - y1) <= tol) edge += "n"; else if (Math.abs(py - y2) <= tol) edge += "s";
      if (Math.abs(px - x1) <= tol) edge += "w"; else if (Math.abs(px - x2) <= tol) edge += "e";
      if (edge) return { i, mode: "resize", edge };
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) return { i, mode: "move" };
    }
    return null;
  }
  const CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

  // ---------- drawing ----------
  function draw() {
    layout();
    const ctx = canvas.getContext("2d"); const { s, cw, ch } = view;
    ctx.setTransform(view.kx, 0, 0, view.ky, 0, 0);
    ctx.clearRect(0, 0, view.aw, view.ah);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, view.aw, view.ah); ctx.clip();
    ctx.translate(view.ox, view.oy); // image space * s from here; handles stay HANDLE screen px
    const bgI = node.properties.cdc_overlay ? freshBg() : null;
    if (bgI) {
      ctx.fillStyle = "#111"; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = node.properties.cdc_opacity;
      const [sx, sy, sw, sh] = bgI.rect;
      // The crop rect maps onto the image's OUTPUT size (bgI.w x bgI.h), exactly like Python does (a non-uniform
      // map here is real: e.g. "scale dimensions" with crop disabled stretches). The output itself is placed
      // into the canvas only if its aspect matches width/height; otherwise it is fitted and letterboxed.
      const outAR = bgI.w / bgI.h, canAR = cw / ch, err = Math.abs(outAR / canAR - 1);
      let dx = 0, dy = 0, dw = cw, dh = ch;
      if (err > 0.005) {
        if (outAR > canAR) { dh = cw / outAR; dy = (ch - dh) / 2; } else { dw = ch * outAR; dx = (cw - dw) / 2; }
        const sig = `${bgI.w}x${bgI.h}|${dims().join("x")}`;
        if (sig !== lastMismatch) {
          lastMismatch = sig;
          console.debug(`[CordonCanvas] overlay aspect mismatch ${(err * 100).toFixed(2)}%: image output ${bgI.w}×${bgI.h} (${bgI.from}) vs canvas ${dims().join("×")} → letterboxed`);
        }
      } else lastMismatch = "";
      try { ctx.drawImage(bgI.img, sx, sy, Math.max(1, sw), Math.max(1, sh), dx, dy, dw, dh); } catch { ctx.drawImage(bgI.img, dx, dy, dw, dh); }
      ctx.globalAlpha = 1;
    }
    else {
      ctx.fillStyle = "#262626"; ctx.fillRect(0, 0, cw, ch);
      ctx.strokeStyle = "#333"; ctx.lineWidth = 1; const g = 64 * s;
      if (g > 4) { ctx.beginPath(); for (let x = g * Math.max(1, Math.floor(-view.ox / g)); x < Math.min(cw, view.aw - view.ox); x += g) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, ch); } for (let y = g * Math.max(1, Math.floor(-view.oy / g)); y < Math.min(ch, view.ah - view.oy); y += g) { ctx.moveTo(0, y + .5); ctx.lineTo(cw, y + .5); } ctx.stroke(); }
    }
    ctx.font = "11px sans-serif"; ctx.textBaseline = "top";
    boxes.forEach((b, i) => {
      const x = b.x * s, y = b.y * s, w = b.width * s, h = b.height * s, c = boxColor(i);
      ctx.fillStyle = c + (i === sel ? "40" : "20"); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = c; ctx.lineWidth = i === sel ? 2.5 : 1.5; ctx.setLineDash(b.metadata?.type === "text" ? [5, 3] : []);
      ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      const m = b.metadata || {};
      const tag = String(i + 1) + (m.type === "text" ? " T" : (m.character ? " ★" : ""));
      const tw = ctx.measureText(tag).width + 6;
      ctx.fillStyle = c; ctx.fillRect(x, y, tw, 14); ctx.fillStyle = "#000"; ctx.fillText(tag, x + 3, y + 1);
      const label = m.type === "text" && m.text ? `"${m.text}" ${m.desc || ""}` : (m.desc || "");
      if (label && w > 30) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.fillStyle = "#fff"; ctx.fillText(label, x + tw + 3, y + 1); ctx.restore(); }
      if (i === sel) {
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
        for (const [hx, hy] of [[x, y], [x + w / 2, y], [x + w, y], [x, y + h / 2], [x + w, y + h / 2], [x, y + h], [x + w / 2, y + h], [x + w, y + h]]) {
          ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE); ctx.strokeRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
        }
      }
    });
    ctx.restore();
  }

  // ---------- interaction ----------
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    const h = hit(...toImg(e)); if (h) { sel = h.i; removeSel(); }
  });
  let pan = null, spaceDown = false;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) { // pan
      e.stopPropagation(); e.preventDefault(); canvas.focus();
      const v = vz(); pan = { l: toLocal(e), cx: v.cx, cy: v.cy, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; return;
    }
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault(); canvas.focus();
    const [px, py] = toImg(e);
    if (e.altKey) { // cycle through boxes under cursor
      const under = boxes.map((b, i) => i).filter((i) => { const b = boxes[i]; return px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height; }).reverse();
      if (under.length) { const k = under.indexOf(sel); sel = under[(k + 1) % under.length]; } else sel = -1;
      syncPanel(); draw(); return;
    }
    const h = (e.shiftKey || e.ctrlKey || e.metaKey) ? null : hit(px, py);
    if (h) { sel = h.i; drag = { ...h, sx: px, sy: py, orig: { ...boxes[h.i] } }; }
    else {
      boxes.push({ x: Math.round(px), y: Math.round(py), width: 0, height: 0, metadata: { type: "obj", text: "", desc: "", palette: [], use_palette: false, character: false, display_color: COLORS[boxes.length % COLORS.length] } });
      sel = boxes.length - 1; drag = { i: sel, mode: "create", sx: px, sy: py, orig: { ...boxes[sel] } };
    }
    canvas.setPointerCapture(e.pointerId); syncPanel(); draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pan) {
      e.stopPropagation();
      const v = vz(), [lx, ly] = toLocal(e);
      v.cx = pan.cx - (lx - pan.l[0]) / view.s; v.cy = pan.cy - (ly - pan.l[1]) / view.s;
      clampView(v); draw(); return;
    }
    if (spaceDown && !drag) { canvas.style.cursor = "grab"; return; }
    const [px, py] = toImg(e);
    if (!drag) { const h = (e.shiftKey || e.ctrlKey || e.metaKey) ? null : hit(px, py); canvas.style.cursor = h ? (h.mode === "move" ? "move" : CURSORS[h.edge]) : "crosshair"; return; }
    e.stopPropagation();
    const [W_, H_] = dims(); const b = boxes[drag.i], o = drag.orig; const dx = px - drag.sx, dy = py - drag.sy;
    if (drag.mode === "move") {
      b.x = Math.round(Math.max(0, Math.min(W_ - o.width, o.x + dx))); b.y = Math.round(Math.max(0, Math.min(H_ - o.height, o.y + dy)));
    } else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.width, y2 = o.y + o.height;
      if (drag.mode === "create") { x1 = drag.sx; y1 = drag.sy; x2 = px; y2 = py; }
      else { const ed = drag.edge; if (ed.includes("w")) x1 = o.x + dx; if (ed.includes("e")) x2 = o.x + o.width + dx; if (ed.includes("n")) y1 = o.y + dy; if (ed.includes("s")) y2 = o.y + o.height + dy; }
      const nx = Math.max(0, Math.min(x1, x2)), ny = Math.max(0, Math.min(y1, y2));
      b.x = Math.round(nx); b.y = Math.round(ny);
      b.width = Math.round(Math.min(W_, Math.max(x1, x2)) - nx); b.height = Math.round(Math.min(H_, Math.max(y1, y2)) - ny);
    }
    draw();
  });
  const endDrag = (e) => {
    if (pan) { pan = null; try { canvas.releasePointerCapture(e.pointerId); } catch {} canvas.style.cursor = spaceDown ? "grab" : "crosshair"; node.setDirtyCanvas?.(true, false); return; }
    if (!drag) return;
    const b = boxes[drag.i];
    if (drag.mode === "create" && (b.width < MIN_PX || b.height < MIN_PX)) { boxes.splice(drag.i, 1); sel = -1; }
    drag = null; try { canvas.releasePointerCapture(e.pointerId); } catch {}
    commit();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); removeSel(); }
    else if (e.key === "Escape") { sel = -1; syncPanel(); draw(); }
    else if (e.key === " ") { e.preventDefault(); e.stopPropagation(); if (!spaceDown) { spaceDown = true; if (!drag) canvas.style.cursor = "grab"; } }
  });
  canvas.addEventListener("keyup", (e) => {
    if (e.key === " ") { e.preventDefault(); e.stopPropagation(); spaceDown = false; if (!pan) canvas.style.cursor = "crosshair"; }
  });
  canvas.addEventListener("blur", () => { spaceDown = false; });
  canvas.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener("dblclick", (e) => {
    if (hit(...toImg(e))) return;
    e.preventDefault(); e.stopPropagation(); resetView();
  });
  // wheel: zoom the box editor toward the cursor; Ctrl+wheel is left alone so the graph zooms.
  canvas.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    const v = vz(); const [lx, ly] = toLocal(e); const [ix, iy] = toImgRaw(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    v.z = Math.max(ZMIN, Math.min(ZMAX, v.z * Math.exp(-dy * 0.0015)));
    const s2 = Math.min(view.aw / dims()[0], view.ah / dims()[1]) * v.z;
    v.cx = ix + (view.aw / 2 - lx) / s2; v.cy = iy + (view.ah / 2 - ly) / s2;
    clampView(v); draw();
  }, { passive: false });

  // ---------- docked editor (canvas + prompt fields), Kijai-style, own code ----------
  // Always canvas-docked under the node — follows node drag AND viewport as part of
  // the canvas, at the node z-layer (never above menus/dialogs). Drag the title bar
  // to move it; near any node edge it snaps flush to that edge, in place.
  // The editor size is independent of node.size.
  cdcInjectCSS();
  migrateDockGeom(node);
  node.properties.cdc_open ??= true;
  node.properties.cdc_min ??= false;
  const dock = el("div", { className: "cdc-dock" }, {});
  const head = el("div", { className: "cdc-head" }, {});
  const titleText = el("span", { textContent: "Cordon Canvas" }, { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
  const minBtn = el("button", { className: "cdc-btn", textContent: "—", title: "Minimize editor" }, {});
  const closeBtn = btn("✕", () => setOpen(false, true));
  closeBtn.className = "cdc-btn";
  closeBtn.title = "Hide editor window";
  head.append(titleText, minBtn, closeBtn);
  const body = el("div", { className: "cdc-body" }, {});
  root.style.flex = "1 1 auto";
  root.style.minHeight = "0";
  body.append(root);
  dock.append(head, body);
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const h = el("div", { className: "cdc-rsz " + dir }, {});
    h.addEventListener("pointerdown", (e) => startDockResize(e, dir));
    dock.append(h);
  }
  // let wheel reach the graph, except over fields that actually consume it
  dock.addEventListener("wheel", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const ta = t.closest("textarea");
    if (ta && ta.scrollHeight > ta.clientHeight + 1) { e.stopPropagation(); return; }
    const inp = t.closest("input, select");
    if (inp && document.activeElement === inp && (inp.tagName === "SELECT" || inp.type === "number")) e.stopPropagation();
  }, { passive: true });
  dock.addEventListener("pointerdown", () => { titleText.textContent = node.title || "Cordon Canvas"; }, true);
  for (const b of [minBtn, closeBtn]) {
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("mousedown", (e) => e.stopPropagation());
  }
  node._cdcDock = dock; node._cdcSig = ""; node._cdcHostEl = null; node._cdcHostId = null;
  cdcLive.add(node);
  const flushDock = () => { try { window.dispatchEvent(new MouseEvent("mouseup")); } catch {} };
  function saveDockGeom() {
    if (node.properties.cdc_min) return;
    if (dock.offsetWidth < CDC_DOCK_MINW || dock.offsetHeight < CDC_DOCK_MINH) return; // transient mid-reparent read
    const g = node.properties.cdc_dockGraph;
    if (g) { g.w = dock.offsetWidth; g.h = dock.offsetHeight; }
  }
  function syncMin() {
    dock.classList.toggle("min", !!node.properties.cdc_min);
    minBtn.textContent = node.properties.cdc_min ? "▢" : "—";
    if (!node.properties.cdc_min) requestAnimationFrame(draw);
  }
  function syncLock() {
    dock.classList.toggle("locked", !!(node.flags && node.flags.pinned));
  }
  function n_CdcSigReset() { node._cdcSig = ""; node._cdcHostEl = null; node._cdcHostId = null; }
  function startDockResize(e, dir) {
    if (e.button !== 0 || node.flags?.pinned) return;
    e.preventDefault(); e.stopPropagation();
    const scale = app.canvas ? (app.canvas.ds.scale || 1) : 1;
    const sx = e.clientX, sy = e.clientY, w0 = dock.offsetWidth, h0 = dock.offsetHeight;
    const g0 = (node.properties.cdc_dockGraph ??= { x: 0, y: (node.size?.[1] ?? 120) + 6, w: 440, h: 560 });
    const gx0 = g0.x, gy0 = g0.y;
    cdcDrag(e, e.currentTarget, (me) => {
      const dx = (me.clientX - sx) / scale, dy = (me.clientY - sy) / scale;
      let w = w0, h = h0, gx = gx0, gy = gy0;
      if (dir.includes("e")) w = w0 + dx;
      if (dir.includes("s")) h = h0 + dy;
      if (dir.includes("w")) { w = w0 - dx; gx = gx0 + dx; }
      if (dir.includes("n")) { h = h0 - dy; gy = gy0 + dy; }
      if (w < CDC_DOCK_MINW) { if (dir.includes("w")) gx -= (CDC_DOCK_MINW - w); w = CDC_DOCK_MINW; }
      if (h < CDC_DOCK_MINH) { if (dir.includes("n")) gy -= (CDC_DOCK_MINH - h); h = CDC_DOCK_MINH; }
      g0.x = gx; g0.y = gy; g0.w = Math.round(w); g0.h = Math.round(h); n_CdcSigReset(); cdcPlace(node);
      draw();
    }, () => { saveDockGeom(); flushDock(); });
  }
  minBtn.addEventListener("click", () => { node.properties.cdc_min = !node.properties.cdc_min; syncMin(); flushDock(); });
  function setOpen(open, persist) {
    node.properties.cdc_open = open;
    dock.style.display = open ? "" : "none";
    try { openBtn.textContent = open ? "Hide editor" : "Show editor"; } catch {}
    if (open) { syncMin(); cdcWake(); requestAnimationFrame(draw); }
    if (persist) flushDock();
  }
  closeBtn.addEventListener("click", () => setOpen(false, true));
  head.addEventListener("pointerdown", (e) => {
    if (e.target === minBtn || e.target === closeBtn || e.button !== 0) return;
    if (node.flags?.pinned) return; // node pinned → dock locked
    e.preventDefault();
    const sx0 = e.clientX, sy0 = e.clientY;
    const scale = app.canvas?.ds.scale || 1;
    const g0 = (node.properties.cdc_dockGraph ??= { x: 0, y: (node.size?.[1] ?? 120) + 6, w: 440, h: 560 });
    const gx0 = g0.x, gy0 = g0.y;
    const gw = g0.w, gh = g0.h;
    let snap = false;
    cdcDrag(e, head, (me) => {
      let gx = gx0 + (me.clientX - sx0) / scale, gy = gy0 + (me.clientY - sy0) / scale;
      // Snap flush to any node edge, in place: only the perpendicular axis is pulled in,
      // so the dock stays where it was put along the edge. Corners snap on both axes.
      const nw = node.size?.[0] ?? 0, nh = node.size?.[1] ?? 120;
      const gap = 6, tol = 26 / scale;
      snap = false;
      if (Math.abs(gy - (nh + gap)) < tol) { gy = nh + gap; snap = true; } // below
      if (Math.abs(gy + gh + gap) < tol) { gy = -gap - gh; snap = true; } // above
      if (Math.abs(gx - (nw + gap)) < tol) { gx = nw + gap; snap = true; } // right
      if (Math.abs(gx + gw + gap) < tol) { gx = -gap - gw; snap = true; } // left
      dock.classList.toggle("snap", snap);
      g0.x = gx; g0.y = gy;
      n_CdcSigReset(); cdcPlace(node);
    }, () => {
      dock.classList.remove("snap");
      saveDockGeom(); flushDock();
    });
  });
  window.addEventListener("resize", cdcWake);

  const openBtn = btn("Hide editor", () => setOpen(dock.style.display === "none", true));
  openBtn.title = "Show or hide the bounding-box editor window";
  const stub = el("div", {}, { display: "flex", gap: "6px", alignItems: "center", width: "100%" });
  stub.append(openBtn, el("span", { textContent: "editor follows the node" }, { opacity: 0.65, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }));
  const dom = node.addDOMWidget("cordon_editor", "cordon_canvas", stub, {
    serialize: false, hideOnZoom: false, getMinHeight: () => 28,
  });
  dom.computeSize = () => [280, 32];

  document.body.appendChild(dock);
  syncMin(); syncLock();
  cdcInstallWakes(); cdcPlace(node); cdcWake();
  dock.style.display = node.properties.cdc_open !== false ? "" : "none";
  try { openBtn.textContent = node.properties.cdc_open !== false ? "Hide editor" : "Show editor"; } catch {}
  titleText.textContent = node.title || "Cordon Canvas";

  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  node._cdcRO = ro;
  try {
    node._visObs = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) draw(); });
    node._visObs.observe(dock);
  } catch {}
  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    try { ro.disconnect(); } catch {}
    try { node._visObs?.disconnect(); } catch {}
    try { window.removeEventListener("resize", cdcWake); } catch {}
    cdcLive.delete(node);
    try { dock.remove(); } catch {}
    IMG_LISTENERS.delete(onImg);
    return onRemoved?.apply(this, arguments);
  };

  // ---------- width/height reactivity ----------
  // widthW/heightW are captured at creation; the live widgets are re-looked-up on every
  // resolve so the live view keeps working even if the frontend recreates widget objects
  // (reload, widget<->input conversion).
  const curWidthW = () => node.widgets?.find((w) => w.name === "width") ?? widthW;
  const curHeightW = () => node.widgets?.find((w) => w.name === "height") ?? heightW;
  const curDataW = () => node.widgets?.find((w) => w.name === "box_data") ?? dataW;
  const curLastW = () => node.widgets?.find((w) => w.name === "last_incoming") ?? lastW;
  const curBatchW = () => node.widgets?.find((w) => w.name === "batch_size") ?? batchW;
  const curLatentW = () => node.widgets?.find((w) => w.name === "latent_type") ?? latentW;
  const curPresetW = () => node.widgets?.find((w) => w.name === "style_preset") ?? presetW;
  const curCanvasW = () => node.widgets?.find((w) => w.name === "canvas") ?? canvasW;
  function findDesc(obj, key) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, key); if (d) return d; }
    return null;
  }
  // Widget hooks that survive frontend re-inits: if the frontend replaces our wrapped
  // callback or redefines the value accessor after us (widget re-init, Vue re-render),
  // the re-watch below detects the loss and re-installs, instead of going deaf.
  function watchValue(w) {
    if (!w) return;
    if (w.callback?.__cdcWrapped !== true) {
      const cb = w.callback;
      const wrapped = function () { const r = cb?.apply(this, arguments); queueResolve(); return r; };
      wrapped.__cdcWrapped = true;
      try { w.callback = wrapped; } catch { /* callback + poll still cover it */ }
    }
    const d = findDesc(w, "value");
    if (!d || d.configurable === false) return; // can't wrap; callback + poll still cover it
    if (w.__cdcGet && d.get === w.__cdcGet && d.set === w.__cdcSet) return; // ours intact
    const prevGet = d.get, prevSet = d.set;
    let store = ("value" in d) ? d.value : undefined;
    const get = function () { return prevGet ? prevGet.call(this) : store; };
    const set = function (v) { if (prevSet) prevSet.call(this, v); else store = v; queueResolve(); };
    try {
      Object.defineProperty(w, "value", { configurable: true, enumerable: true, get, set });
      w.__cdcGet = get; w.__cdcSet = set;
    } catch { /* fall back to callback + poll */ }
  }
  watchValue(widthW); watchValue(heightW);
  const domSeen = new WeakSet(); // DOM inputs already listened to (elements are re-scanned)
  function watchDomInputs() {
    // Belt and braces: listen to the widget DOM inputs directly, in case a frontend
    // updates the value without going through the patched widget.value setter first.
    // Re-scans because re-renders can replace the elements (stale ones fail isConnected).
    for (const w of [curWidthW(), curHeightW()]) {
      if (!w) continue;
      const known = w.__cdcDomEls;
      if (known && known.length && known.every((i) => i.isConnected)) continue;
      const els = new Set();
      for (const cand of [w.element, w.inputEl, w.domElement]) {
        if (cand instanceof Element) {
          if (/^(INPUT|SELECT|TEXTAREA)$/.test(cand.tagName)) els.add(cand);
          else cand.querySelectorAll?.("input,select,textarea").forEach((i) => els.add(i));
        }
      }
      if (!els.size) continue;
      w.__cdcDomEls = [...els];
      for (const i of els) {
        if (domSeen.has(i)) continue;
        domSeen.add(i);
        i.addEventListener("input", queueResolve, { passive: true });
        i.addEventListener("change", queueResolve);
      }
    }
  }
  watchDomInputs();

  function slotWidgetName(i) { return typeof i?.widget === "string" ? i.widget : i?.widget?.name; }
  function linkedInput(name) { return node.inputs?.find((i) => (i.name === name || slotWidgetName(i) === name) && i.link != null); }
  // Coerce widget values: primitives and int constants sometimes carry numeric strings.
  const numVal = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") { const n = +v; if (Number.isFinite(n)) return n; }
    return NaN;
  };
  function resolveLinked(name) {
    const g = node.graph || app.graph;
    const inp = linkedInput(name);
    if (!inp) return { v: null, linked: false };
    const isNumW = (w) => w && Number.isFinite(numVal(w?.value));
    let link = getLink(g, inp.link); const seen = new Set();
    while (link) {
      const { id: oid, slot: oslot } = linkOrigin(link);
      if (oid == null || seen.has(oid)) break;
      seen.add(oid);
      const src = g?.getNodeById?.(oid) ?? g?.getNodeById?.(+oid) ?? g?.getNodeById?.(String(oid));
      if (!src) break;
      const ws = (src.widgets || []).filter((w) => w && w.type !== "hidden" && !w.hidden);
      const outName = src.outputs?.[oslot]?.name;
      const outType = src.outputs?.[oslot]?.type;
      const kind = nodeKind(src);
      if ((kind === UNI_LOAD || kind === UNI_RESIZE || kind === UNI_RATIO || kind === RES_SELECTOR) && (outName === "width" || outName === "height")) {
        const st = kind === UNI_RATIO ? uniRatioSize(src)
          : kind === RES_SELECTOR ? resolutionSelectorState(src)
          : sizeStateOf(src);
        if (st === undefined || st === "pending") return { v: null, linked: true, pending: true, via: kind };
        if (!st) return { v: null, linked: true, via: kind };
        return { v: outName === "width" ? st.w : st.h, linked: true, via: kind };
      }
      // Any int-ish source: same-named widget, output-named widget, "value" widget,
      // single-widget nodes (PrimitiveInt/Float, int constants), or the sole numeric widget.
      const lname = String(name).toLowerCase();
      const oname = outName != null ? String(outName).toLowerCase() : "";
      const isIntW = (w) => isNumW(w) && Number.isInteger(numVal(w.value)) && !String(w.name).includes(".");
      let pick = ws.find((w) => isNumW(w) && String(w.name).toLowerCase() === lname);
      if (!pick && oname) pick = ws.find((w) => isNumW(w) && String(w.name).toLowerCase() === oname);
      if (!pick) pick = ws.find((w) => isNumW(w) && String(w.name).toLowerCase() === "value");
      if (!pick && ws.length === 1 && isNumW(ws[0])) pick = ws[0];
      if (!pick) { const ints = ws.filter(isIntW); if (ints.length === 1) pick = ints[0]; }
      if (!pick && (outType === "INT" || outType === "FLOAT" || outType === "NUMBER") && ws.length === 1 && isNumW(ws[0])) pick = ws[0];
      const pickFed = pick && (src.inputs || []).some((i) => i.link != null && (i.name === pick.name || slotWidgetName(i) === pick.name));
      if (pick && !pickFed) {
        watchUpstream(src);
        return { v: Math.round(numVal(pick.value)), linked: true, widget: pick, srcNode: src };
      }
      // follow passthroughs (reroute, or the input feeding the picked/converted widget)
      let next = null;
      if (src.type === "Reroute" || (src.inputs || []).length === 1) next = src.inputs?.[0];
      else if (pick) next = src.inputs?.find((i) => i.link != null && (i.name === pick.name || slotWidgetName(i) === pick.name));
      if (!next || next.link == null) break;
      link = getLink(g, next.link);
    }
    return { v: null, linked: true }; // linked but not resolvable pre-run
  }
  function resolveOne(name, widget) {
    const r = resolveLinked(name);
    if (!r.linked) return { v: widgetNum(widget), src: "widget" };
    const via = r.via ? ` ${r.via.replace(/Node$/, "")}` : "";
    if (r.v > 0) return { v: r.v, src: "linked" + via };
    if (r.pending) return { v: (name === "width" ? eff.w : eff.h) || widgetNum(widget), src: `linked${via}, pending` };
    if (runDims[name === "width" ? "w" : "h"]) return { v: runDims[name === "width" ? "w" : "h"], src: "linked, last run" };
    return { v: widgetNum(widget), src: "linked, unresolved" };
  }
  function applyDims(nw, nh) {
    // Keep each box's offset from the canvas centre. If that would leave the canvas
    // (1:1 full of boxes -> 9:16), scale the whole set around the centre so nothing leaks.
    const prev = node.properties.cdc_dims;
    const pw = Array.isArray(prev) ? prev[0] : 0, ph = Array.isArray(prev) ? prev[1] : 0;
    if (pw > 0 && ph > 0 && (pw !== nw || ph !== nh) && boxes.length && !drag) {
      const dx = (nw - pw) / 2, dy = (nh - ph) / 2;
      const cx = nw / 2, cy = nh / 2;
      let s = 1;
      for (const b of boxes) {
        const x = b.x + dx, y = b.y + dy, w = +b.width, h = +b.height;
        const ox = x + w / 2 - cx, oy = y + h / 2 - cy;
        const needX = Math.abs(ox) + w / 2, needY = Math.abs(oy) + h / 2;
        if (needX > 1e-6 && cx > 0) s = Math.min(s, cx / needX);
        if (needY > 1e-6 && cy > 0) s = Math.min(s, cy / needY);
      }
      for (const b of boxes) {
        const x = b.x + dx, y = b.y + dy, w = +b.width, h = +b.height;
        const bw = w * s, bh = h * s;
        const ox = (x + w / 2 - cx) * s, oy = (y + h / 2 - cy) * s;
        b.x = Math.round(cx + ox - bw / 2);
        b.y = Math.round(cy + oy - bh / 2);
        b.width = Math.max(1, Math.round(bw));
        b.height = Math.max(1, Math.round(bh));
        if (b.x < 0) { b.width += b.x; b.x = 0; }
        if (b.y < 0) { b.height += b.y; b.y = 0; }
        if (b.x + b.width > nw) b.width = Math.max(1, nw - b.x);
        if (b.y + b.height > nh) b.height = Math.max(1, nh - b.y);
      }
      const dw = curDataW();
      if (dw) dw.value = JSON.stringify(boxes);
    }
    node.properties.cdc_dims = [nw, nh];
  }
  let resolving = false, resolveQueued = false;
  function resolveDims() {
    if (resolving || drag) return;
    resolving = true;
    try {
      const a = resolveOne("width", curWidthW()), b = resolveOne("height", curHeightW());
      const changed = a.v !== eff.w || b.v !== eff.h || a.src !== eff.srcW || b.src !== eff.srcH;
      if (!changed) return;
      const sizeChanged = a.v !== eff.w || b.v !== eff.h;
      // shift from the last real size only; a guessed size must not move boxes
      const unresolved = /unresolved|pending/.test(a.src + b.src);
      if (sizeChanged && !unresolved) applyDims(a.v, b.v);
      eff = { w: a.v, h: b.v, srcW: a.src, srcH: b.src };
      syncPanel(); draw();
      if (sizeChanged) node.setDirtyCanvas?.(true, true);
    } catch (e) { console.warn("[CordonCanvas] resolveDims", e); }
    finally { resolving = false; }
  }
  function queueResolve() {
    if (resolveQueued) return; resolveQueued = true;
    queueMicrotask(() => { resolveQueued = false; resolveDims(); });
  }

  // reload from widget value after graph load (configure sets widget values after creation)
  const onConfigure = node.onConfigure;
  node.onConfigure = function (info) {
    const r = onConfigure?.apply(this, arguments);
    // one-time migration from the old BBoxCanvas (bbc_*) property keys
    for (const [o, n] of [["bbc_open", "cdc_open"], ["bbc_min", "cdc_min"],
        ["bbc_overlay", "cdc_overlay"], ["bbc_opacity", "cdc_opacity"], ["bbc_follow", "cdc_follow"],
        ["bbc_dims", "cdc_dims"]]) {
      if (node.properties[n] === undefined && node.properties[o] !== undefined) {
        node.properties[n] = node.properties[o];
        try { delete node.properties[o]; } catch {}
      }
    }
    migrateDockGeom(node);
    if (!Array.isArray(info?.properties?.cdc_dims)) delete node.properties.cdc_dims; // old workflow: boxes are at saved width/height
    if (node.properties.cdc_follow === undefined) node.properties.cdc_follow = "auto";
    hideWidget(curDataW()); hideWidget(curLastW());
    for (const w of [curBatchW(), curLatentW(), curPresetW(), curCanvasW()]) hideWidget(w);
    boxes = migrateBoxes(parse(curDataW()?.value)); sel = -1;
    { const dw = curDataW(); if (dw && boxes.length) dw.value = JSON.stringify(boxes); } // persist migration
    watchValue(curWidthW()); watchValue(curHeightW()); watchDomInputs();
    eff = { w: 0, h: 0, srcW: "widget", srcH: "widget" }; // re-resolve; centre-lock only if cdc_dims differs
    // Workflow reload: honour saved dock geometry, then re-place.
    node.properties.cdc_open ??= true;
    try {
      cdcInstallWakes();
      n_CdcSigReset(); syncMin(); syncLock();
      cdcPlace(node); cdcWake();
      dock.style.display = node.properties.cdc_open !== false ? "" : "none";
      try { openBtn.textContent = node.properties.cdc_open !== false ? "Hide editor" : "Show editor"; } catch {}
    } catch {}
    setOpen(node.properties.cdc_open !== false, false);
    syncPanel();
    setTimeout(() => { watchValue(curWidthW()); watchValue(curHeightW()); watchDomInputs(); resolveDims(); refreshUpstream(); }, 0); // after the whole graph (links, primitives) is configured
    return r;
  };

  // ---------- upstream image (no execution needed) ----------
  // Links may be objects ({id, origin_id, ...}) or arrays ([id, origin_id, origin_slot, ...]);
  // the graph may keep them in a Map or a plain object, keyed by number or string.
  function linkOrigin(l) { return Array.isArray(l) ? { id: l[1], slot: l[2] } : { id: l?.origin_id, slot: l?.origin_slot }; }
  function linkTargetId(l) { return Array.isArray(l) ? l[3] : l?.target_id; }
  function getLink(g, id) {
    const L = g?.links; if (!L || id == null) return null;
    if (typeof L.get === "function") return L.get(id) ?? L.get(String(id)) ?? L.get(+id) ?? null;
    return L[id] ?? L[String(id)] ?? null;
  }
  function parseAnnotated(v) {
    let type = "input", name = String(v).trim();
    const m = name.match(/^(.*?)\s*\[(input|output|temp)\]$/);
    if (m) { name = m[1]; type = m[2]; }
    const k = name.lastIndexOf("/");
    return { filename: k >= 0 ? name.slice(k + 1) : name, subfolder: k >= 0 ? name.slice(0, k) : "", type };
  }
  // ---------- upstream image chain (no execution needed) ----------
  // One wrapper per upstream widget, fanning out to every canvas watching it, so two
  // Cordon canvases following the same Primitive/size node both update live.
  // Re-wraps if the frontend replaces a wrapped callback after us (same deafness class
  // as watchValue); the fan-out set survives because it lives on the widget entry.
  const WATCHED = new WeakMap(); // widget -> { fns: Set<fn>, nodes: Set<node> }
  function watchUpstream(src) { // chain onto upstream widget callbacks (runtime only; their files are untouched)
    for (const w of src?.widgets || []) {
      let e = WATCHED.get(w);
      if (!e) {
        e = { fns: new Set(), nodes: new Set() };
        WATCHED.set(w, e);
      }
      if (w.callback?.__cdcUpWrapped !== true) {
        const cb = w.callback;
        const wrapped = function () {
          const r = cb?.apply(this, arguments);
          for (const fn of [...e.fns]) { try { fn(); } catch {} }
          return r;
        };
        wrapped.__cdcUpWrapped = true;
        try { w.callback = wrapped; } catch { /* poll still covers it */ }
      }
      if (e.nodes.has(node)) continue;
      e.nodes.add(node);
      e.fns.add(() => { if (cdcLive.has(node)) setTimeout(() => { resolveDims(); refreshUpstream(); }, 0); });
    }
  }
  const wv = (n, name) => n?.widgets?.find((w) => w.name === name)?.value;
  function subParams(n, prefix) {
    const p = {};
    for (const w of n?.widgets || []) if (String(w.name).startsWith(prefix + ".")) p[w.name.slice(prefix.length + 1)] = w.value;
    return p;
  }
  function imageUrlFromWidget(src) {
    const w = src.widgets?.find((w) => (w.name === "image" || w.name === "upload") && typeof w.value === "string" && w.value);
    if (!w) return null;
    const f = parseAnnotated(w.value);
    // prefer the node's own preview src when it is the same file (carries a cache-buster after re-upload)
    const im = src.imgs?.[0]?.src;
    if (im) {
      try {
        const q = new URL(im, "http://x").searchParams;
        if (q.get("filename") === f.filename && (q.get("subfolder") || "") === f.subfolder && (q.get("type") || "input") === f.type) return im;
      } catch { /* fall through */ }
    }
    return api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}&type=${f.type}&subfolder=${encodeURIComponent(f.subfolder)}`);
  }
  // Image info flowing out of a link: {url, entry, state} | "pending" | null (unknown)
  function linkImageInfo(link, depth = 0) {
    const g = node.graph || app.graph;
    if (!link || depth > 24) return null;
    const { id: oid } = linkOrigin(link);
    const src = oid == null ? null : (g?.getNodeById?.(oid) ?? g?.getNodeById?.(+oid) ?? g?.getNodeById?.(String(oid)));
    return src ? nodeImageInfo(src, depth + 1) : null;
  }
  function inputImageInfo(n, inputName, depth) {
    const g = node.graph || app.graph;
    const inp = n.inputs?.find((i) => i.name === inputName && i.link != null);
    return inp ? linkImageInfo(getLink(g, inp.link), depth) : null;
  }
  function sizeOf(info) { return info && info !== "pending" && info.state ? [info.state.w, info.state.h] : null; }
  function nodeImageInfo(src, depth = 0) {
    if (!src || depth > 24) return null;
    watchUpstream(src);
    const kind = nodeKind(src);
    const resizeOf = (base, prefix) => { // UniResize/UniLoad resize_type step on top of base info
      if (base === "pending" || !base) return base;
      if (base.pendingImg || !base.entry?.ready) return { ...base, state: null, pendingImg: true };
      if (!base.state) return base;
      const mode = wv(src, prefix), p = subParams(src, prefix), adh = wv(src, "adhere_to_multiple");
      let match = null;
      if (mode === "match size") { const mi = inputImageInfo(src, `${prefix}.match`, depth); if (mi === "pending" || mi?.pendingImg) return { ...base, state: null, pendingImg: true }; match = sizeOf(mi); if (!match) return { ...base, state: null }; }
      const st = kind === UNI_LOAD ? uniLoadState(base.state.w, base.state.h, mode, p, adh, match) : applyResize(base.state, mode, p, adh, match);
      return { ...base, state: st };
    };
    if (kind === UNI_LOAD) {
      const url = imageUrlFromWidget(src); if (!url) return null;
      const entry = cachedImage(url);
      if (!entry.ready) return entry.failed ? null : { url, entry, state: null, pendingImg: true };
      return resizeOf({ url, entry, state: initState(entry.img.naturalWidth, entry.img.naturalHeight) }, "resize_type");
    }
    if (kind === UNI_RESIZE) return resizeOf(inputImageInfo(src, "image", depth), "resize_type");
    // Resize Image/Mask (dynamic combo, same mode strings as UniResize)
    if (kind === "ResizeImageMaskNode") return resizeOf(inputImageInfo(src, "input", depth), "resize_type");
    // stock resize nodes (nodes.py / comfy_extras): transform the base image state
    if (kind === "ImageScale" || kind === "ImageScaleBy" || kind === "ImageScaleToTotalPixels" ||
        kind === "ImageScaleToMaxDimension" || kind === "ResizeAndPadImage") {
      const base = inputImageInfo(src, "image", depth);
      if (base === "pending" || !base) return base;
      if (base.pendingImg || !base.entry?.ready) return { ...base, state: null, pendingImg: true };
      if (!base.state) return base;
      const st = base.state, num = (k, d) => (Number.isFinite(+wv(src, k)) ? +wv(src, k) : d);
      let W = 0, H = 0, crop = "disabled";
      if (kind === "ImageScale") { W = Math.max(0, Math.round(num("width", 0))); H = Math.max(0, Math.round(num("height", 0))); crop = wv(src, "crop") || "disabled"; }
      else if (kind === "ImageScaleBy") { const m = num("scale_by", 1); W = Math.round(st.w * m); H = Math.round(st.h * m); }
      else if (kind === "ImageScaleToTotalPixels") {
        const steps = Math.max(1, Math.round(num("resolution_steps", 1)));
        const s = Math.sqrt(Math.trunc(num("megapixels", 1) * 1024 * 1024) / Math.max(1, st.w * st.h));
        W = Math.round(st.w * s / steps) * steps; H = Math.round(st.h * s / steps) * steps;
      } else if (kind === "ImageScaleToMaxDimension") {
        const L = Math.max(1, Math.round(num("largest_size", 512)));
        if (st.h > st.w) { W = Math.round(st.w / st.h * L); H = L; }
        else if (st.w > st.h) { H = Math.round(st.h / st.w * L); W = L; }
        else { W = H = L; }
      } else { W = Math.max(1, Math.round(num("target_width", st.w))); H = Math.max(1, Math.round(num("target_height", st.h))); } // ResizeAndPadImage: exact padded canvas
      if (W <= 0 && H <= 0) return base;
      if (kind === "ImageScale") {
        if (W <= 0) W = Math.max(1, Math.round(st.w * H / st.h));
        else if (H <= 0) H = Math.max(1, Math.round(st.h * W / st.w));
      } else if (W <= 0 || H <= 0) return base;
      return { ...base, state: upscale(st, W, H, crop) };
    }
    const url = imageUrlFromWidget(src) || src.imgs?.[0]?.src;
    if (url) {
      const entry = cachedImage(url);
      if (!entry.ready) return entry.failed ? null : { url, entry, state: null, pendingImg: true };
      return { url, entry, state: initState(entry.img.naturalWidth, entry.img.naturalHeight) };
    }
    // passthrough: reroute / single-image-input nodes
    const ins = (src.inputs || []).filter((i) => i.link != null && (i.type === "IMAGE" || i.type === "*" || src.type === "Reroute" || (src.inputs || []).length === 1));
    if (ins.length !== 1) return null;
    return linkImageInfo(getLink(node.graph || app.graph, ins[0].link), depth);
  }
  function uniRatioSize(src) {
    watchUpstream(src);
    const mode = wv(src, "size_by"), p = subParams(src, "size_by");
    let ref = null;
    if (mode === "match size" || mode === "scale by multiplier") {
      const mi = inputImageInfo(src, "size_by.match", 0);
      if (mi === "pending" || mi?.pendingImg) return "pending";
      ref = sizeOf(mi); if (!ref) return null;
    }
    const r = uniRatioSolve(mode, wv(src, "aspect_ratio"), String(wv(src, "multiple") ?? "32"), p, ref);
    return r ? { w: r[0], h: r[1] } : null;
  }
  function resolutionSelectorState(src) {
    watchUpstream(src);
    return resolutionSelectorSize(wv(src, "aspect_ratio"), wv(src, "megapixels"), wv(src, "multiple"));
  }
  // size state for width/height outputs: state | "pending" (image still loading) | null (unknown)
  function sizeStateOf(src) {
    const i = nodeImageInfo(src);
    if (i === "pending" || i?.pendingImg) return "pending";
    return i?.state || null;
  }
  function backgroundInfo() {
    const g = node.graph || app.graph;
    const inp = node.inputs?.find((i) => i.name === "background" && i.link != null);
    if (!inp) return null;
    const i = linkImageInfo(getLink(g, inp.link));
    return i === "pending" ? null : i;
  }
  // ---------- downstream follow mirror (no graph edge, so no dependency cycle) ----------
  // BFS forward from this canvas through output links. Any image-showing node found there
  // necessarily ran *after* this canvas, so mirroring its preview is the cycle-free way to
  // "use the SaveImage image" on the next iteration: queue once, the result appears here,
  // draw more boxes, queue again. Editor overlay only — never a backend tensor.
  function downstreamImageCandidates() {
    const g = node.graph || app.graph;
    const out = [];
    if (!g?.getNodeById) return out;
    const seen = new Set([node.id]);
    const queue = [{ id: node.id, depth: 0 }];
    const targetOf = (linkId) => {
      const l = getLink(g, linkId);
      if (!l) return null;
      return linkTargetId(l);
    };
    while (queue.length && out.length < 32) {
      const cur = queue.shift();
      if (cur.depth > 32) continue;
      const n = cur.depth === 0 ? node : g.getNodeById(cur.id);
      if (!n) continue;
      for (const o of n.outputs || []) {
        for (const lid of o.links || []) {
          const tid = targetOf(lid);
          if (tid == null || seen.has(tid)) continue;
          seen.add(tid);
          const t = g.getNodeById(tid);
          if (!t) continue;
          if (t.id !== node.id) {
            const hasImg = !!(t.imgs && t.imgs.length);
            // record image-capable nodes (Save/Preview) plus pass-throughs already traversed;
            // only nodes actually showing an image are candidates for the button cycle.
            if (hasImg || /save|preview|image/i.test(t.type || nodeKind(t) || "")) {
              out.push({ id: t.id, title: t.title || String(t.id), kind: (nodeKind(t) || t.type || "node").replace(/Node$/, ""), hasImg });
            }
          }
          queue.push({ id: tid, depth: cur.depth + 1 });
        }
      }
    }
    return out;
  }
  function followNodeImage(t) {
    const im = t?.imgs?.[0];
    if (!im) return null;
    const url = typeof im === "string" ? im : im.src;
    if (url) {
      const entry = cachedImage(url);
      if (entry.failed) return null;
      if (!entry.ready) return { url, entry, state: null, pendingImg: true, label: `${(nodeKind(t) || t.type || "node").replace(/Node$/, "")} ${t.title || t.id}` };
      const w = entry.img.naturalWidth, h = entry.img.naturalHeight;
      if (!w || !h) return null;
      return { url, entry, state: { w, h, rect: [0, 0, w, h] }, label: `${(nodeKind(t) || t.type || "node").replace(/Node$/, "")} ${t.title || t.id}` };
    }
    // already-loaded Image element without a cacheable src
    if (im.complete && im.naturalWidth) {
      const w = im.naturalWidth, h = im.naturalHeight;
      return { url: "", entry: { img: im, ready: true }, state: { w, h, rect: [0, 0, w, h] }, label: `${(nodeKind(t) || t.type || "node").replace(/Node$/, "")} ${t.title || t.id}` };
    }
    return null;
  }
  function updateFollow() {
    const g = node.graph || app.graph;
    try { followCands = downstreamImageCandidates(); } catch { followCands = []; }
    const mode = node.properties.cdc_follow ?? "auto";
    followInfo = null;
    if (mode === "off" || hasBackgroundLink() || !g) { updateFollowBtn(); return; }
    if (typeof mode === "number") {
      const t = g.getNodeById?.(mode);
      const fi = t ? followNodeImage(t) : null;
      // A pinned node with no image yet (not run) keeps state null so the poll retries after it runs.
      if (fi && (fi.state || fi.pendingImg)) followInfo = fi;
      else if (t) followInfo = { url: "", entry: { ready: false }, state: null, pendingImg: true, label: `${t.title || mode}` };
    } else {
      for (const c of followCands) {
        if (!c.hasImg) continue;
        const t = g.getNodeById?.(c.id);
        const fi = t ? followNodeImage(t) : null;
        if (fi && fi.state) { followInfo = fi; break; }
        if (fi && fi.pendingImg && !followInfo) followInfo = fi;
      }
    }
    updateFollowBtn();
  }
  let upSig = "";
  function refreshUpstream() {
    let info = null; try { info = backgroundInfo(); } catch (e) { console.warn("[CordonCanvas] upstream", e); }
    try { updateFollow(); } catch (e) { console.warn("[CordonCanvas] follow", e); }
    const sig = info ? `${info.url}|${info.entry?.ready}|${info.state ? info.state.w + "x" + info.state.h + ":" + info.state.rect.map((v) => v.toFixed(1)).join(",") : "-"}` : "";
    const fsig = followInfo ? `${followInfo.label}|${followInfo.url}|${followInfo.entry?.ready}|${followInfo.state ? followInfo.state.w + "x" + followInfo.state.h : "-"}` : `|cands:${followCands.filter((c) => c.hasImg).map((c) => c.id).join(",")}`;
    const full = sig + "\n" + fsig;
    if (full === upSig) return;
    upSig = full; upInfo = info; draw();
  }
  const onImg = () => { resolveDims(); refreshUpstream(); };
  IMG_LISTENERS.add(onImg);

  const poll = setInterval(() => {
    if (!node.graph) return;
    watchValue(curWidthW()); watchValue(curHeightW()); watchDomInputs(); // catch recreated widgets
    resolveDims(); refreshUpstream();
  }, 800);
  const onGraphChanged = () => setTimeout(() => { resolveDims(); refreshUpstream(); }, 0);
  try { api.addEventListener("graphChanged", onGraphChanged); } catch {}
  const onRemoved2 = node.onRemoved;
  node.onRemoved = function () { clearInterval(poll); IMG_LISTENERS.delete(onImg); try { api.removeEventListener("graphChanged", onGraphChanged); } catch {} return onRemoved2?.apply(this, arguments); };
  const onConn = node.onConnectionsChange;
  node.onConnectionsChange = function () { const r = onConn?.apply(this, arguments); setTimeout(() => { resolveDims(); refreshUpstream(); }, 0); return r; };

  const onExecuted = node.onExecuted;
  node.onExecuted = function (out) {
    const r = onExecuted?.apply(this, arguments);
    const d = out?.dims;
    if (Array.isArray(d) && d.length >= 2) { runDims.w = Math.round(+d[0]) || null; runDims.h = Math.round(+d[1]) || null; }
    resolveDims(); // scale existing boxes first, then (maybe) replace from upstream at run dims
    if (out?.input_bboxes && out?.upstream_changed?.[0]) {
      boxes = migrateBoxes(JSON.parse(JSON.stringify(out.input_bboxes)), false); sel = -1;
      const lw = curLastW();
      if (lw) lw.value = JSON.stringify(out.input_bboxes);
      // The replacement boxes are expressed in the backend run dims: re-base the
      // centre-lock so the next canvas resize shifts from here, not from stale dims.
      if (runDims.w && runDims.h) node.properties.cdc_dims = [runDims.w, runDims.h];
      commit();
    }
    const im = out?.background_images?.[0];
    if (im) {
      const img = new Image();
      img.onload = () => { bgImg = img; draw(); };
      img.src = api.apiURL(`/view?filename=${encodeURIComponent(im.filename)}&type=${im.type}&subfolder=${encodeURIComponent(im.subfolder || "")}&rand=${Math.random()}`);
    } else { bgImg = null; draw(); }
    return r;
  };

  resolveDims();
  syncPanel();
  requestAnimationFrame(() => draw());
}

app.registerExtension({
  name: "cordoncanvas.CordonCanvas",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_ID) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };
  },
});
