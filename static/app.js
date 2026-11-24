// Run Viewer — one run of DATASETS: map, camera (+ depth, CV engine boxes), charts and a timebar on one clock.
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PAL = ["#4aa3ff", "#ffb020", "#30d158", "#ff6b8b", "#b48cff", "#2dd4bf", "#f472b6", "#a3e635"];
const COLORS = {
  MANUAL: "#6b7280", HOLD: "#f59e0b", LOITER: "#14b8a6", GUIDED: "#3b82f6", AUTO: "#22c55e", ACRO: "#a855f7", STEERING: "#eab308",
  RTL: "#ef4444", SMART_RTL: "#ef4444", INITIALISING: "#374151", ARMED: "#ef4444",
  AUTO_HOLD: "#f59e0b", AUTO_TASK: "#22c55e", KILLED: "#ef4444", BOOT: "#374151", HANDED_OVER: "#06b6d4",
  DECLARED: "#a855f7", READY: "#3b82f6", RUNNING: "#22c55e", COURSE_VALID: "#4b5563", CONNECTED: "#374151", DISCONNECTED: "#1f2937",
};
const BUOY = { red: "#ff4040", green: "#30d158", blue: "#3b82ff", white: "#f5f5f5", black: "#9aa0a6", yellow: "#ffd60a", orange: "#ff9f0a", grey: "#7c8591", gray: "#7c8591", unknown: "#c084fc" };
function hashColor(s) {   // a stable hex colour per value (hex, so a "14" / "40" alpha suffix stays valid)
  let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; const H = Math.abs(h) % 360 / 60, C = 0.55 * 0.9, X = C * (1 - Math.abs(H % 2 - 1)), m = 0.45 - C / 2;
  const [r, g, b] = H < 1 ? [C, X, 0] : H < 2 ? [X, C, 0] : H < 3 ? [0, C, X] : H < 4 ? [0, X, C] : H < 5 ? [X, 0, C] : [C, 0, X];
  return "#" + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}
const laneColor = v => COLORS[v] || COLORS[String(v).split("/")[0]] || COLORS[String(v).replace(/^CUSTOM_/, "")] || hashColor(v);
function bsearch(a, x) { let lo = 0, hi = a.length - 1; if (!a.length || x < a[0]) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= x) lo = m; else hi = m - 1; } return lo; }
const sgt = t => new Date((t + 8 * 3600) * 1000).toISOString().slice(11, 21);
const sgtDate = t => new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10);
function rel(t) { const d = t - B.t0, s = Math.abs(d); return (d < 0 ? "-" : "+") + String(Math.floor(s / 60)).padStart(2, "0") + ":" + (s % 60).toFixed(1).padStart(4, "0"); }
const dur = s => s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`;
function dpr(cv) { const r = cv.getBoundingClientRect(), k = window.devicePixelRatio || 1; const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return k; }
async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); }
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const fname = what => `${B ? B.run : "run"}_${what}_${B ? sgt(T).replace(/[:.]/g, "") : ""}`;

// ---------------------------------------------------------------- tooltips and pop-ups
const tip = $("#tip");
function showTip(x, y, html) { tip.innerHTML = html; tip.style.display = "block"; const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(x + 14, innerWidth - w - 6) + "px"; tip.style.top = (y + 16 + h > innerHeight ? y - h - 10 : y + 16) + "px"; }
function hideTip() { tip.style.display = "none"; }
document.addEventListener("mouseover", e => { const el = e.target.closest("[data-tip]"); if (el && !(e.target instanceof HTMLCanvasElement)) showTip(e.clientX, e.clientY, esc(el.dataset.tip)); });
document.addEventListener("mousemove", e => { const el = e.target.closest("[data-tip]"); if (el && !(e.target instanceof HTMLCanvasElement) && tip.style.display === "block") showTip(e.clientX, e.clientY, esc(el.dataset.tip)); });
document.addEventListener("mouseout", e => { if (e.target.closest("[data-tip]")) hideTip(); });
function popup(html) { $("#modalCard").innerHTML = `<button class="x" onclick="closeModal()" data-tip="Close (Esc)">✕</button>` + html; $("#modal").classList.add("show"); hideTip(); }
function closeModal() { $("#modal").classList.remove("show"); }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
const kvTable = o => `<table class="kv">${Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`).join("")}</table>`;

// ---------------------------------------------------------------- resizable tiles (gutters); sizes kept per browser
function loadSize(k) { try { return localStorage.getItem("logview_" + k) || ""; } catch (e) { return ""; } }
function saveSize(k, v) { try { v ? localStorage.setItem("logview_" + k, v) : localStorage.removeItem("logview_" + k); } catch (e) { } }
function makeGutter(g, { start, move, end, reset }) {
  g.addEventListener("mousedown", e => {
    e.preventDefault(); e.stopPropagation(); const x0 = e.clientX, y0 = e.clientY, s0 = start(); g.classList.add("drag"); document.body.style.userSelect = "none";
    const mm = ev => move(ev.clientX - x0, ev.clientY - y0, s0);
    const up = () => { window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", up); g.classList.remove("drag"); document.body.style.userSelect = ""; end && end(); afterResize(); };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", up);
  });
  g.addEventListener("dblclick", () => { reset(); afterResize(); });
}
let resizeTimer = 0;
function afterResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { charts.forEach(c => c.dirty = true); redrawAll(); cam.drawOverlay(); cam.renderDepth(); drawScale(); }, 16); }
function setupGutters() {
  const main = $("main"), mapT = $("#mapTile"), camT = $("#camTile");
  makeGutter($("#gCols"), { start: () => $(".col").getBoundingClientRect().width, move: (dx, dy, w0) => { main.style.setProperty("--colL", clamp(w0 + dx, 300, main.clientWidth - 320) + "px"); afterResize(); }, end: () => saveSize("colL", main.style.getPropertyValue("--colL")), reset: () => { main.style.removeProperty("--colL"); saveSize("colL", ""); } });
  makeGutter($("#gMapCam"), { start: () => mapT.getBoundingClientRect().height, move: (dx, dy, h0) => { const tot = mapT.parentElement.clientHeight; mapT.style.flex = `0 0 ${clamp(h0 + dy, 120, tot - 170)}px`; camT.style.flex = "1 1 auto"; afterResize(); }, end: () => saveSize("mapH", mapT.style.flex), reset: () => { mapT.style.flex = ""; camT.style.flex = ""; saveSize("mapH", ""); } });
  makeGutter($("#gFoot"), { start: () => TB.cv.getBoundingClientRect().height, move: (dx, dy, h0) => { document.documentElement.style.setProperty("--tbH", clamp(h0 - dy, 70, innerHeight * 0.6) + "px"); afterResize(); }, end: () => saveSize("tbH", document.documentElement.style.getPropertyValue("--tbH")), reset: () => { document.documentElement.style.removeProperty("--tbH"); saveSize("tbH", ""); } });
  const c = loadSize("colL"), m = loadSize("mapH"), t = loadSize("tbH");
  if (c) main.style.setProperty("--colL", c); if (m) { mapT.style.flex = m; camT.style.flex = "1 1 auto"; } if (t) document.documentElement.style.setProperty("--tbH", t);
  new ResizeObserver(afterResize).observe(MV.cv);
}

// ---------------------------------------------------------------- state
let RUNS = [], B = null, MAP = [], ENG = [], T = 0, VIEW = [0, 1], playing = false, speed = 1, lastTick = 0;
const charts = [];
function setView(v0, v1) {
  const span = Math.max(1, v1 - v0), full = B.t1 - B.t0 + 20;
  if (span > full) { v0 = B.t0 - 10; v1 = B.t1 + 10; }
  VIEW = [v0, v0 + Math.min(span, full)]; charts.forEach(c => c.dirty = true); $("#viewInfo").textContent = `view ${dur(VIEW[1] - VIEW[0])}`; redrawAll();
}
function setTime(t, opts = {}) {
  T = clamp(t, B.t0, B.t1);
  if (!opts.keepView && (T < VIEW[0] || T > VIEW[1])) { const s = VIEW[1] - VIEW[0]; setView(T - s / 2, T + s / 2); }
  if (!opts.fromVideo) cam.syncVideo();
  redrawAll(); cam.timeChanged();
}

// ---------------------------------------------------------------- charts
const GROUPS = [
  ["speed", "Speed", "m/s"], ["heading", "Heading", "deg"], ["commands", "Commands (thrust / yaw ...)", ""], ["outputs", "Servo outputs", "µs"],
  ["path", "Path following", "m"], ["gnss", "GNSS", ""], ["perception", "Perception: buoys in view", ""],
];
class Chart {
  constructor(id, title, unit, series) {
    this.series = series; this.title = title; this.unit = unit; this.dirty = true; this.hidden = new Set();
    const el = document.createElement("section"); el.className = "tile chart"; el.id = "chart_" + id;
    el.innerHTML = `<div class="hd"><span class="title">${esc(title)}</span><span class="legend"></span><span class="tools">
      <button data-tip="Taller / shorter.">↕</button><button data-tip="Expand this chart (Esc to close).">⤢</button>
      <button data-tip="Save the chart as a PNG.">PNG</button><button data-tip="Save the visible window as CSV.">CSV</button></span></div><div class="bd"><canvas></canvas></div>`;
    $("#charts").appendChild(el); this.el = el;
    const gut = document.createElement("div"); gut.className = "gutter gh"; gut.dataset.tip = "Drag to resize this chart; double-click to reset."; $("#charts").appendChild(gut);
    makeGutter(gut, { start: () => el.offsetHeight, move: (dx, dy, h0) => { el.style.height = clamp(h0 + dy, 70, 900) + "px"; this.dirty = true; this.draw(); }, end: () => saveSize("chart_" + id, el.style.height), reset: () => { el.style.height = "150px"; saveSize("chart_" + id, ""); this.dirty = true; this.draw(); } });
    const sz = loadSize("chart_" + id); if (sz) el.style.height = sz; this.cv = $("canvas", el); this.bg = document.createElement("canvas");
    const lg = $(".legend", el);
    series.forEach((s, i) => { s.color = s.color || PAL[i % PAL.length]; const l = document.createElement("label"); l.dataset.tip = `${s.label}${s.unit ? " (" + s.unit + ")" : ""}: click to show / hide`; l.innerHTML = `<input type="checkbox" checked><i style="background:${s.color}"></i>${esc(s.label)}`; $("input", l).onchange = e => { e.target.checked ? this.hidden.delete(s.key) : this.hidden.add(s.key); this.dirty = true; this.draw(); }; lg.appendChild(l); });
    const [bTall, bExp, bPng, bCsv] = $$(".tools button", el);
    bTall.onclick = () => { el.style.height = el.offsetHeight > 200 ? "150px" : "300px"; this.dirty = true; requestAnimationFrame(() => this.draw()); };
    bExp.onclick = () => toggleExpand(el); bPng.onclick = () => this.cv.toBlob(b => download(b, fname(id) + ".png"));
    bCsv.onclick = () => this.csv();
    this.bindMouse();
  }
  xy() { const k = dpr(this.cv), W = this.cv.width, H = this.cv.height, L = 44 * k, R = 8 * k, Tp = 6 * k, Bt = 16 * k; return { k, W, H, L, R, Tp, Bt, x: t => L + (t - VIEW[0]) / (VIEW[1] - VIEW[0]) * (W - L - R), t: x => VIEW[0] + (x - L) / (W - L - R) * (VIEW[1] - VIEW[0]) }; }
  drawBg() {
    const g = this.xy(), { k, W, H, L, R, Tp, Bt } = g; this.bg.width = W; this.bg.height = H; const c = this.bg.getContext("2d");
    c.fillStyle = "#171b21"; c.fillRect(0, 0, W, H);
    let lo = Infinity, hi = -Infinity; const vis = this.series.filter(s => !this.hidden.has(s.key));
    for (const s of vis) { const i0 = Math.max(0, bsearch(s.t, VIEW[0])), i1 = Math.min(s.t.length - 1, bsearch(s.t, VIEW[1]) + 1); for (let i = i0; i <= i1; i++) { const v = s.v[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } } }
    if (!isFinite(lo)) { lo = 0; hi = 1; } if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; } const pad = (hi - lo) * 0.08; lo -= pad; hi += pad; this.lo = lo; this.hi = hi;
    const y = v => Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - Bt); this.y = y;
    c.font = `${10 * k}px -apple-system,Arial`; c.fillStyle = "#8b95a3"; c.strokeStyle = "#262c35"; c.lineWidth = 1;
    const step = niceStep((hi - lo) / 4); for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { const yy = y(v); c.beginPath(); c.moveTo(L, yy); c.lineTo(W - R, yy); c.stroke(); c.fillText(fmtNum(v), 4 * k, yy + 3 * k); }
    const ts = niceStep((VIEW[1] - VIEW[0]) / 6); for (let t = Math.ceil(VIEW[0] / ts) * ts; t <= VIEW[1]; t += ts) { const xx = g.x(t); c.beginPath(); c.moveTo(xx, Tp); c.lineTo(xx, H - Bt); c.stroke(); c.fillText(sgt(t).slice(0, ts < 1 ? 10 : 8), xx - 20 * k, H - 4 * k); }
    // FCU mode tint under the plot
    for (const sp of (B.lanes["FCU mode"] || [])) { if (sp.t1 < VIEW[0] || sp.t0 > VIEW[1]) continue; c.fillStyle = laneColor(sp.v) + "14"; const a = g.x(Math.max(sp.t0, VIEW[0])), b = g.x(Math.min(sp.t1, VIEW[1])); c.fillRect(a, Tp, b - a, H - Tp - Bt); }
    for (const s of vis) {
      c.strokeStyle = s.color; c.lineWidth = 1.4 * k; c.beginPath(); let pen = false;
      const i0 = Math.max(0, bsearch(s.t, VIEW[0])), i1 = Math.min(s.t.length - 1, bsearch(s.t, VIEW[1]) + 1);
      const n = i1 - i0, step = Math.max(1, Math.floor(n / (W - L - R)));          // min / max per pixel column when dense
      for (let i = i0; i <= i1; i += step) {
        if (step === 1) { const v = s.v[i]; if (v == null) { pen = false; continue; } const X = g.x(s.t[i]), Y = y(v); pen ? c.lineTo(X, Y) : c.moveTo(X, Y); pen = true; continue; }
        let mn = Infinity, mx = -Infinity; for (let j = i; j < Math.min(i + step, i1 + 1); j++) { const v = s.v[j]; if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }
        if (!isFinite(mn)) { pen = false; continue; } const X = g.x(s.t[i]); pen ? c.lineTo(X, y(mn)) : c.moveTo(X, y(mn)); c.lineTo(X, y(mx)); pen = true;
      }
      c.stroke();
    }
    c.fillStyle = "#8b95a3"; if (this.unit) c.fillText(this.unit, W - R - 30 * k, Tp + 10 * k);
    this.dirty = false;
  }
  draw() {
    if (!B) return; const g = this.xy(); if (this.dirty || this.bg.width !== g.W || this.bg.height !== g.H) this.drawBg();
    const c = this.cv.getContext("2d"); c.drawImage(this.bg, 0, 0);
    const x = g.x(T); c.strokeStyle = "#ffd23f"; c.setLineDash([5 * g.k, 4 * g.k]); c.lineWidth = 1.2 * g.k; c.beginPath(); c.moveTo(x, g.Tp); c.lineTo(x, g.H - g.Bt); c.stroke(); c.setLineDash([]);
    for (const s of this.series) { if (this.hidden.has(s.key)) continue; const i = bsearch(s.t, T); if (i < 0 || s.v[i] == null || T - s.t[i] > 2) continue; c.fillStyle = s.color; c.beginPath(); c.arc(x, this.y(s.v[i]), 3 * g.k, 0, 7); c.fill(); }
  }
  valuesAt(t) { return this.series.filter(s => !this.hidden.has(s.key)).map(s => { const i = bsearch(s.t, t); const v = i >= 0 && t - s.t[i] < 2 ? s.v[i] : null; return `<span style="color:${s.color}">■</span> ${esc(s.label)}: <b>${v == null ? "–" : fmtNum(v)}</b>${s.unit ? " " + s.unit : ""}`; }).join("\n"); }
  bindMouse() { bindTimeCanvas(this.cv, () => this.xy(), (t, e) => showTip(e.clientX, e.clientY, `<b>${sgt(t)}</b>  (${rel(t)})\n` + this.valuesAt(t))); }
  csv() {
    const ts = this.series[0].t, i0 = Math.max(0, bsearch(ts, VIEW[0])), i1 = bsearch(ts, VIEW[1]);
    const rows = ["utc_unix,sgt," + this.series.map(s => s.key).join(",")];
    for (let i = i0; i <= i1; i++) rows.push([ts[i], sgt(ts[i]), ...this.series.map(s => { const j = s.t === ts ? i : bsearch(s.t, ts[i]); return j >= 0 ? (s.v[j] ?? "") : ""; })].join(","));
    download(new Blob([rows.join("\n")], { type: "text/csv" }), fname(this.title.split(" ")[0].toLowerCase()) + ".csv");
  }
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-9)))); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
function fmtNum(v) { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); }

// shared mouse handling for anything with a time axis: click / drag = scrub, wheel = zoom, shift-drag or right-drag = pan, dblclick = whole run
function bindTimeCanvas(cv, geo, onHover, onClick) {
  let drag = null;
  cv.addEventListener("mousedown", e => { const g = geo(), x = e.offsetX * g.k; drag = { pan: e.shiftKey || e.button === 2, x0: x, v: [...VIEW], moved: false }; if (!drag.pan && !(onClick && onClick(g.t(x), e, true))) setTime(g.t(x), { keepView: true }); });
  cv.addEventListener("contextmenu", e => e.preventDefault());
  window.addEventListener("mouseup", () => drag = null);
  cv.addEventListener("mousemove", e => {
    const g = geo(), x = e.offsetX * g.k;
    if (drag) { drag.moved = true; if (drag.pan) { const dt = (x - drag.x0) / (g.W - g.L - g.R) * (drag.v[1] - drag.v[0]); setView(drag.v[0] - dt, drag.v[1] - dt); } else setTime(g.t(x), { keepView: true }); }
    if (x >= g.L) onHover(g.t(x), e, x, e.offsetY * g.k); else hideTip();
  });
  cv.addEventListener("mouseleave", hideTip);
  cv.addEventListener("wheel", e => { e.preventDefault(); const g = geo(), t = g.t(e.offsetX * g.k), f = Math.exp((e.deltaY || e.deltaX) * 0.0015); setView(t - (t - VIEW[0]) * f, t + (VIEW[1] - t) * f); }, { passive: false });
  cv.addEventListener("dblclick", () => setView(B.t0 - 5, B.t1 + 5));
}

// ---------------------------------------------------------------- timebar
const TB = { cv: $("#timebar"), rows: [] };
function tbGeo() { const k = dpr(TB.cv), W = TB.cv.width, H = TB.cv.height, L = 104 * k, R = 8 * k; return { k, W, H, L, R, x: t => L + (t - VIEW[0]) / (VIEW[1] - VIEW[0]) * (W - L - R), t: x => VIEW[0] + (x - L) / (W - L - R) * (VIEW[1] - VIEW[0]) }; }
function drawTimebar() {
  if (!B) return; const g = tbGeo(), { k, W, H, L } = g, c = TB.cv.getContext("2d");
  c.fillStyle = "#171b21"; c.fillRect(0, 0, W, H); c.font = `${10.5 * k}px -apple-system,Arial`; TB.rows = [];
  const lanes = Object.keys(B.lanes).filter(n => B.lanes[n].length);
  const rows = [...lanes.map(n => ({ kind: "lane", name: n })), { kind: "events", name: "events" }, ...B.cams.map(cm => ({ kind: "cam", name: "camera " + cm.name.slice(9, 15), cam: cm }))];
  const ovH = 14 * k, axH = 14 * k, rh = Math.min(18 * k, (H - ovH - axH - 4 * k) / rows.length);
  let y = axH;
  const ts = niceStep((VIEW[1] - VIEW[0]) / 8); c.fillStyle = "#8b95a3";
  for (let t = Math.ceil(VIEW[0] / ts) * ts; t <= VIEW[1]; t += ts) { const x = g.x(t); c.fillRect(x, axH - 4 * k, 1, 4 * k); c.fillText(sgt(t).slice(0, ts < 1 ? 10 : 8), x + 2 * k, 10 * k); }
  for (const r of rows) {
    r.y0 = y; r.y1 = y + rh; TB.rows.push(r);
    c.fillStyle = "#8b95a3"; c.fillText(r.name, 4 * k, y + rh * 0.7);
    c.fillStyle = "#1d222a"; c.fillRect(L, y + 1, W - L - g.R, rh - 2);
    if (r.kind === "lane") for (const sp of B.lanes[r.name]) { if (sp.t1 < VIEW[0] || sp.t0 > VIEW[1]) continue; const a = Math.max(L, g.x(sp.t0)), b = Math.min(W - g.R, g.x(sp.t1)); c.fillStyle = laneColor(sp.v); c.fillRect(a, y + 2, Math.max(1, b - a), rh - 4); if (b - a > 40 * k) { c.fillStyle = "#fff"; c.save(); c.beginPath(); c.rect(a, y, b - a, rh); c.clip(); c.fillText(sp.v, a + 3 * k, y + rh * 0.7); c.restore(); } }
    if (r.kind === "events") for (const ev of B.events) { if (ev.t < VIEW[0] || ev.t > VIEW[1]) continue; c.fillStyle = { boat: "#4aa3ff", mission: "#ffb020", operator: "#b48cff" }[ev.src] || "#ccc"; c.fillRect(g.x(ev.t) - 0.5 * k, y + 2, 1.5 * k, rh - 4); }
    if (r.kind === "cam") {
      const ft = r.cam.obs_t; c.fillStyle = "#2b5a8a";
      for (let i = 0; i < ft.length; i++) { const t = ft[i]; if (t < VIEW[0] || t > VIEW[1]) continue; c.fillRect(g.x(t), y + 3, Math.max(1, k), rh - 6); }
      const v = r.cam.video; if (v && v.ts) { c.fillStyle = "#3d7cc0"; c.fillRect(Math.max(L, g.x(v.ts[0])), y + rh - 4, Math.max(1, g.x(v.ts[v.ts.length - 1]) - g.x(v.ts[0])), 2); }
      c.fillStyle = "#ffd23f"; const fr = r.cam.frames; for (const sf of r.cam.depth_frames || []) { const f = fr.find(f => f.svo === sf); if (f && f.t >= VIEW[0] && f.t <= VIEW[1]) c.fillRect(g.x(f.t) - 0.5 * k, y + 1, 1.5 * k, 4 * k); }
    }
    y += rh;
  }
  // overview strip (whole run, the view window as a box)
  const oy = H - ovH, ox = t => L + (t - B.t0) / (B.t1 - B.t0) * (W - L - g.R); TB.ov = { y: oy, x: ox, t: x => B.t0 + (x - L) / (W - L - g.R) * (B.t1 - B.t0) };
  c.fillStyle = "#8b95a3"; c.fillText("whole run", 4 * k, oy + ovH * 0.75); c.fillStyle = "#1d222a"; c.fillRect(L, oy + 2, W - L - g.R, ovH - 4);
  for (const sp of (B.lanes["mission state"] || B.lanes["FCU mode"] || [])) { c.fillStyle = laneColor(sp.v) + "aa"; c.fillRect(ox(sp.t0), oy + 4, Math.max(1, ox(sp.t1) - ox(sp.t0)), ovH - 8); }
  c.strokeStyle = "#4aa3ff"; c.lineWidth = 1.5 * k; c.strokeRect(ox(VIEW[0]), oy + 1, Math.max(3, ox(VIEW[1]) - ox(VIEW[0])), ovH - 2);
  c.fillStyle = "#ffd23f"; c.fillRect(ox(T) - k, oy, 2 * k, ovH);
  const x = g.x(T); c.strokeStyle = "#ffd23f"; c.setLineDash([5 * k, 4 * k]); c.lineWidth = 1.3 * k; c.beginPath(); c.moveTo(x, axH); c.lineTo(x, oy); c.stroke(); c.setLineDash([]);
}
(function bindTimebar() {
  let ovDrag = null;
  TB.cv.addEventListener("mousedown", e => { const g = tbGeo(), y = e.offsetY * g.k, x = e.offsetX * g.k; if (TB.ov && y >= TB.ov.y) { ovDrag = { x0: x, v: [...VIEW] }; const t = TB.ov.t(x); if (t < VIEW[0] || t > VIEW[1]) { const s = VIEW[1] - VIEW[0]; setView(t - s / 2, t + s / 2); ovDrag.v = [...VIEW]; } e.stopImmediatePropagation(); } }, true);
  window.addEventListener("mousemove", e => { if (!ovDrag) return; const g = tbGeo(), x = (e.clientX - TB.cv.getBoundingClientRect().left) * g.k; const dt = TB.ov.t(x) - TB.ov.t(ovDrag.x0); setView(ovDrag.v[0] + dt, ovDrag.v[1] + dt); });
  window.addEventListener("mouseup", () => ovDrag = null);
  bindTimeCanvas(TB.cv, tbGeo, (t, e, x, y) => {
    const r = TB.rows.find(r => y >= r.y0 && y < r.y1); if (!r) { hideTip(); return; }
    const g = tbGeo(), tol = 4 * g.k / (g.W - g.L - g.R) * (VIEW[1] - VIEW[0]);
    if (r.kind === "lane") { const sp = B.lanes[r.name].find(s => t >= s.t0 && t < s.t1); showTip(e.clientX, e.clientY, sp ? `<b>${esc(r.name)}: ${esc(sp.v)}</b>\n${sgt(sp.t0)} → ${sgt(sp.t1)}\n${dur(sp.t1 - sp.t0)}\nclick: details` : `${esc(r.name)}: –`); }
    else if (r.kind === "events") { const near = B.events.filter(ev => Math.abs(ev.t - t) < tol * 2); showTip(e.clientX, e.clientY, near.length ? near.slice(0, 6).map(ev => `<b>${sgt(ev.t)}</b> [${ev.src}] ${esc(ev.text)}`).join("\n") + (near.length > 6 ? `\n… ${near.length - 6} more` : "") : `<b>${sgt(t)}</b>\nno event here (the ticks are events; click one)`); }
    else { const f = r.cam.frames[bsearch(r.cam.obs_t, t)]; showTip(e.clientX, e.clientY, f && Math.abs(f.t - t) < 1 ? `<b>camera ${esc(r.cam.name)}</b>\nframe ${f.svo} · ${f.buoys.length} buoys · ${esc(f.status)}\nyellow ticks = frames with recorded AGX depth` : `no camera frame here`); }
  }, (t, e) => {
    const g = tbGeo(), y = e.offsetY * g.k, r = TB.rows.find(r => y >= r.y0 && y < r.y1); if (!r) return false;
    if (r.kind === "lane") { const sp = B.lanes[r.name].find(s => t >= s.t0 && t < s.t1); if (sp && e.detail >= 1 && e.altKey) { popup(`<h2>${esc(r.name)}: ${esc(sp.v)}</h2>` + kvTable({ from: sgt(sp.t0), to: sgt(sp.t1), duration: dur(sp.t1 - sp.t0) }) + `<p><button onclick="setTime(${sp.t0});closeModal()">Go to start</button> <button onclick="setView(${sp.t0 - 5},${sp.t1 + 5});closeModal()">Zoom to it</button></p>`); return true; } }
    if (r.kind === "events") { const tol = 4 * g.k / (g.W - g.L - g.R) * (VIEW[1] - VIEW[0]); const near = B.events.filter(ev => Math.abs(ev.t - t) < tol * 2); if (near.length) { setTime(near[0].t, { keepView: true }); popup(`<h2>Events at ${sgt(near[0].t)}</h2><table>${near.map(ev => `<tr><td>${sgt(ev.t)}</td><td>${esc(ev.src)}</td><td>${esc(ev.text)}</td></tr>`).join("")}</table>`); return true; } }
    return false;
  });
  TB.cv.addEventListener("dblclick", e => { const g = tbGeo(), y = e.offsetY * g.k, t = g.t(e.offsetX * g.k), r = TB.rows.find(r => y >= r.y0 && y < r.y1); if (r && r.kind === "lane") { const sp = B.lanes[r.name].find(s => t >= s.t0 && t < s.t1); if (sp) { popup(`<h2>${esc(r.name)}: ${esc(sp.v)}</h2>` + kvTable({ from: sgt(sp.t0), to: sgt(sp.t1), duration: dur(sp.t1 - sp.t0), "time in run": rel(sp.t0) }) + `<p><button onclick="setTime(${sp.t0});closeModal()">Go to start</button> <button onclick="setView(${sp.t0 - 5},${sp.t1 + 5});closeModal()">Zoom to it</button></p>`); } } });
})();

// ---------------------------------------------------------------- map
const MV = { cv: $("#map"), s: 6, cn: 0, ce: 0, follow: true, layers: { track: true, replay: true, obstacles: true, young: false, path: true, dets: true, bound: true, fov: true, alldets: false }, hits: [] };
const LAYER_TIPS = { obstacles: "Depth obstacles on the map (grey squares: the guard's depth clusters).", young: "Internal buoys below the ghost filter (min sightings): dashed rings - in the lab replay only.", track: "The boat's track (coloured by FCU mode); brighter = already driven.", replay: "The selected map (menu on the left) at this moment: buoys coloured, faint = stale.", path: "The planned path and the carrot (look-ahead point) at this moment.", dets: "Camera detections with a range, placed on the map from the frame's pose (last 10 s).", alldets: "Show every ranged camera detection of the run, not just the last 10 s.", bound: "The course boundary.", fov: "The camera's field of view (about 110°)." };
function buildLayerToggles() { const el = $("#mapLayers"); el.innerHTML = ""; for (const k of Object.keys(MV.layers)) { const l = document.createElement("label"); l.dataset.tip = LAYER_TIPS[k]; l.innerHTML = `<input type="checkbox" ${MV.layers[k] ? "checked" : ""}>${k === "alldets" ? "all dets" : k}`; $("input", l).onchange = e => { MV.layers[k] = e.target.checked; drawMap(); }; el.appendChild(l); } }
let MAPT = [];
function mapAt(t) { if (!MAP.length) return null; const i = bsearch(MAPT, t); return MAP[Math.max(0, i)]; }
function boatAt(t) { const tr = B.track; if (!tr.length) return null; const i = Math.max(0, bsearch(B.trackT, t)); return tr[i]; }
function mapFit() { const tr = B.track; if (!tr.length) return; let n0 = 1e9, n1 = -1e9, e0 = 1e9, e1 = -1e9; for (const p of tr) { n0 = Math.min(n0, p[1]); n1 = Math.max(n1, p[1]); e0 = Math.min(e0, p[2]); e1 = Math.max(e1, p[2]); } const r = MV.cv.getBoundingClientRect(); MV.cn = (n0 + n1) / 2; MV.ce = (e0 + e1) / 2; MV.s = Math.min(r.width / Math.max(10, e1 - e0 + 10), r.height / Math.max(10, n1 - n0 + 10)); drawMap(); }
function drawMap() {
  if (!B) return; const cv = MV.cv, k = dpr(cv), W = cv.width, H = cv.height, c = cv.getContext("2d"); MV.hits = [];
  const bp = boatAt(T); if (MV.follow && bp) { MV.cn = bp[1]; MV.ce = bp[2]; }
  const X = e => W / 2 + (e - MV.ce) * MV.s * k, Y = n => H / 2 - (n - MV.cn) * MV.s * k;
  c.fillStyle = "#0e1318"; c.fillRect(0, 0, W, H);
  const gs = niceStep(80 / MV.s); c.strokeStyle = "#1c2430"; c.lineWidth = 1;          // grid
  for (let e = Math.floor((MV.ce - W / 2 / MV.s / k) / gs) * gs; X(e) < W; e += gs) { c.beginPath(); c.moveTo(X(e), 0); c.lineTo(X(e), H); c.stroke(); }
  for (let n = Math.floor((MV.cn - H / 2 / MV.s / k) / gs) * gs; Y(n) > 0; n += gs) { c.beginPath(); c.moveTo(0, Y(n)); c.lineTo(W, Y(n)); c.stroke(); }
  const fr = MV.layers.replay || MV.layers.path || MV.layers.bound ? mapAt(T) : null;
  if (fr && MV.layers.bound && (fr.bnd || []).length > 1) { c.strokeStyle = "#5b6574"; c.setLineDash([6 * k, 4 * k]); c.lineWidth = 1.5 * k; c.beginPath(); fr.bnd.forEach((p, i) => i ? c.lineTo(X(p[1]), Y(p[0])) : c.moveTo(X(p[1]), Y(p[0]))); if (fr.bnd.length > 2) c.closePath(); c.stroke(); c.setLineDash([]); }
  if (MV.layers.track && B.track.length) {                // the track: past solid, future faint
    const tr = B.track; c.lineWidth = 2 * k; let last = null;
    for (let i = 1; i < tr.length; i++) { const p = tr[i - 1], q = tr[i]; if (q[0] - p[0] > 5) continue; const fut = q[0] > T; c.strokeStyle = laneColor(q[4] || "MANUAL") + (fut ? "40" : "ff"); c.beginPath(); c.moveTo(X(p[2]), Y(p[1])); c.lineTo(X(q[2]), Y(q[1])); c.stroke(); }
  }
  if (fr && MV.layers.replay) for (const e of fr.ent) {
    const [id, kind, col, n, ee, state, src, light, nobs, sig] = e; if (n == null) continue; const x = X(ee), y = Y(n), obs = kind === "obstacle";
    if (state === "young") { if (!MV.layers.young) continue; c.strokeStyle = (BUOY[col] || "#c084fc") + "99"; c.setLineDash([2 * k, 2 * k]); c.lineWidth = k; c.beginPath(); c.arc(x, y, 4 * k, 0, 7); c.stroke(); c.setLineDash([]); MV.hits.push({ x, y, r: 6 * k, html: `<b>young ${esc(kind)} #${id}</b> ${esc(col)}\nonly ${nobs} sighting(s): below the ghost filter, not on the boat's map`, pop: { kind, id, colour: col, state: "young (internal)", observations: nobs, north_m: n, east_m: ee } }); continue; }
    if (obs && !MV.layers.obstacles) continue;
    c.globalAlpha = state === "tracked" || state === "confirmed" ? 1 : 0.45; c.fillStyle = obs ? "#5b6574" : (BUOY[col] || "#c084fc"); c.strokeStyle = "#000";
    const r = (obs ? 3 : 5) * k; c.beginPath(); obs ? c.rect(x - r, y - r, 2 * r, 2 * r) : c.arc(x, y, r, 0, 7); c.fill(); c.stroke(); c.globalAlpha = 1;
    if (light && light !== "?") { c.strokeStyle = BUOY[light] || "#fff"; c.lineWidth = 2 * k; c.beginPath(); c.arc(x, y, r + 3 * k, 0, 7); c.stroke(); }
    MV.hits.push({ x, y, r: r + 3 * k, html: `<b>${esc(kind)} #${id}</b> ${esc(col || "")}\nstate ${esc(state)} · source ${esc(src)}\nobservations ${nobs ?? "?"} · σ ${sig ?? "?"} m${light && light !== "?" ? "\nlamp " + esc(light) : ""}`, pop: { kind, id, colour: col, state, source: src, lamp: light, observations: nobs, sigma_m: sig, north_m: n, east_m: ee } });
  }
  if (fr && MV.layers.path) {
    if ((fr.path || []).length > 1) { c.strokeStyle = "#4aa3ff"; c.lineWidth = 1.5 * k; c.setLineDash([4 * k, 3 * k]); c.beginPath(); fr.path.forEach((p, i) => { const n = p.x_n ?? p[0], e = p.y_e ?? p[1]; i ? c.lineTo(X(e), Y(n)) : c.moveTo(X(e), Y(n)); }); c.stroke(); c.setLineDash([]); }
    if (fr.carrot) { const n = fr.carrot.x_n ?? fr.carrot[0], e = fr.carrot.y_e ?? fr.carrot[1]; c.fillStyle = "#ff9f0a"; c.beginPath(); c.arc(X(e), Y(n), 4 * k, 0, 7); c.fill(); MV.hits.push({ x: X(e), y: Y(n), r: 6 * k, html: "<b>carrot</b>\nthe look-ahead point the boat steers to" }); }
    for (const gt of fr.gates || []) { const a = gt.a || gt.left, b = gt.b || gt.right; if (a && b) { c.strokeStyle = "#30d158"; c.lineWidth = 2 * k; c.beginPath(); c.moveTo(X(a.y_e ?? a[1]), Y(a.x_n ?? a[0])); c.lineTo(X(b.y_e ?? b[1]), Y(b.x_n ?? b[0])); c.stroke(); } }
  }
  if (MV.layers.dets) for (const cm of B.cams) for (const f of cm.frames) {
    if (f.t > T || (!MV.layers.alldets && f.t < T - 10)) continue;
    for (const b of f.buoys) { if (!b.xy) continue; const x = X(b.xy[1]), y = Y(b.xy[0]); c.fillStyle = (BUOY[b.colour] || "#c084fc") + "aa"; c.beginPath(); c.arc(x, y, 2.2 * k, 0, 7); c.fill(); if (f.t > T - 1) MV.hits.push({ x, y, r: 5 * k, html: `<b>camera detection</b> ${esc(b.colour)} ${(+b.confidence || 0).toFixed(2)}\nrange ${b.range_m ? b.range_m.toFixed(1) + " m" : "–"} · bearing ${b.bearing_deg?.toFixed(1)}°\n${sgt(f.t)}`, pop: { colour: b.colour, confidence: b.confidence, range_m: b.range_m, bearing_deg: b.bearing_deg, lamp: b.led?.colour, frame: f.svo, time: sgt(f.t) } }); }
  }
  if (bp) {                                                  // the boat + camera FOV
    const x = X(bp[2]), y = Y(bp[1]), h = (bp[3] ?? 0) * Math.PI / 180;
    if (MV.layers.fov) { c.fillStyle = "#ffd23f18"; c.beginPath(); c.moveTo(x, y); c.arc(x, y, 25 * MV.s * k, h - Math.PI / 2 - 0.96, h - Math.PI / 2 + 0.96); c.closePath(); c.fill(); }
    c.save(); c.translate(x, y); c.rotate(h); c.fillStyle = "#ffd23f"; c.strokeStyle = "#000"; c.lineWidth = k; c.beginPath(); c.moveTo(0, -9 * k); c.lineTo(5 * k, 6 * k); c.lineTo(0, 3 * k); c.lineTo(-5 * k, 6 * k); c.closePath(); c.fill(); c.stroke(); c.restore();
    MV.hits.push({ x, y, r: 8 * k, html: `<b>boat</b> ${sgt(bp[0])}\nheading ${bp[3]?.toFixed(1)}° · mode ${esc(bp[4])}\nN ${bp[1].toFixed(1)} m · E ${bp[2].toFixed(1)} m` });
  }
  // scale bar + north arrow
  const sb = niceStep(100 / MV.s); c.fillStyle = "#cfd6df"; c.font = `${11 * k}px -apple-system,Arial`; c.fillRect(10 * k, H - 14 * k, sb * MV.s * k, 3 * k); c.fillText(`${sb} m`, 10 * k, H - 18 * k);
  c.fillText("N ↑", W - 28 * k, 16 * k);
  if (!B.track.length) { c.fillStyle = "#8b95a3"; c.fillText("no position data in this run", 12 * k, 20 * k); }
}
(function bindMap() {
  const cv = MV.cv; let drag = null;
  cv.addEventListener("mousedown", e => { drag = { x: e.clientX, y: e.clientY, n: MV.cn, e: MV.ce, moved: false }; });
  window.addEventListener("mouseup", e => { if (drag && !drag.moved) { const k = devicePixelRatio || 1, r = cv.getBoundingClientRect(), x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k; const h = MV.hits.filter(h => Math.hypot(h.x - x, h.y - y) < h.r).pop(); if (h && h.pop && e.target === cv) popup(`<h2>Map item</h2>` + kvTable(h.pop)); } drag = null; });
  window.addEventListener("mousemove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) { drag.moved = true; MV.follow = false; $("#mapFollow").classList.remove("on"); } MV.ce = drag.e - dx / MV.s; MV.cn = drag.n + dy / MV.s; drawMap(); });
  cv.addEventListener("mousemove", e => { if (drag) return; const k = devicePixelRatio || 1, x = e.offsetX * k, y = e.offsetY * k; const h = MV.hits.filter(h => Math.hypot(h.x - x, h.y - y) < h.r).pop(); h ? showTip(e.clientX, e.clientY, h.html + (h.pop ? "\nclick: details" : "")) : hideTip(); });
  cv.addEventListener("mouseleave", hideTip);
  cv.addEventListener("wheel", e => { e.preventDefault(); const f = Math.exp(-e.deltaY * 0.0015); const r = cv.getBoundingClientRect(); const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2; const e0 = MV.ce + mx / MV.s, n0 = MV.cn - my / MV.s; MV.s = clamp(MV.s * f, 0.2, 200); if (!MV.follow) { MV.ce = e0 - mx / MV.s; MV.cn = n0 + my / MV.s; } drawMap(); }, { passive: false });
  $("#mapFollow").onclick = e => { MV.follow = !MV.follow; e.target.classList.toggle("on", MV.follow); drawMap(); };
  $("#mapFit").onclick = () => { MV.follow = false; $("#mapFollow").classList.remove("on"); mapFit(); };
})();

// ---------------------------------------------------------------- map source + the mapping lab
const MAPS = {};
async function setMapSource(src) {
  $("#mapSrc").value = src;
  if (src === "none") { MAP = []; MAPT = []; drawMap(); return; }
  if (src === "lab") { MAP = MAPS.lab || []; MAPT = MAP.map(f => f.t); drawMap(); return; }
  if (!MAPS[src]) MAPS[src] = await getJSON(`/api/map?rel=${encodeURIComponent(B.rel)}&src=${src}`);
  MAP = MAPS[src]; MAPT = MAP.map(f => f.t); drawMap();
}
function fillMapSrc() {
  const opts = [...(B.map_sources || []).map(s => [s, s === "boat" ? "boat map (recorded)" : "operator map (recorded)"]), ["lab", "lab replay" + (LAB.result ? "" : " (run the lab)")], ["none", "no map"]];
  $("#mapSrc").innerHTML = opts.map(([v, l]) => `<option value="${v}" ${v === "lab" && !LAB.result ? "disabled" : ""}>${esc(l)}</option>`).join("");
}
$("#mapSrc").onchange = e => setMapSource(e.target.value);

const LAB = { knobs: null, presets: [], cur: { name: "deployed (course profile)", overrides: {}, use_guard: true }, result: null, auto: true, timer: 0, busy: false };
function labVal(k) { return k.key in LAB.cur.overrides ? LAB.cur.overrides[k.key] : k.deployed; }
function labTruthKey() { return "truth_" + (B ? B.run : ""); }
async function openLab() {
  if (!B) return; $("#lab").style.display = "flex"; $("#labRun").textContent = B.run; LAB.switched = false;
  if (!LAB.knobs) { LAB.knobs = await getJSON("/api/maplab/knobs"); }
  LAB.presets = await getJSON("/api/maplab/presets");
  renderLab(); if (!LAB.result) labRun();
}
function renderLab() {
  const K = LAB.knobs.knobs, groups = [...new Set(K.map(k => k.group))], P = LAB.presets, cur = LAB.cur;
  const isBuiltin = P.find(p => p.name === cur.name)?.builtin;
  let truth = ""; try { truth = localStorage.getItem("logview_" + labTruthKey()) || ""; } catch (e) { }
  $("#labBd").innerHTML = `
    <div class="labrow"><span class="muted">preset</span><select id="labPreset" data-tip="Load a preset (its knob values and the guard setting).">${P.map(p => `<option ${p.name === cur.name ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <button id="labSave" data-tip="Save the current knobs as a preset (presets/mapping/<name>.json); you can come back to it on any run.">Save as…</button>
      <button id="labDel" ${isBuiltin ? "disabled" : ""} data-tip="Delete this preset (the two built-in ones cannot be deleted).">Delete</button></div>
    <div id="labSaveRow" class="labrow" style="display:none"><input id="labName" placeholder="preset name" style="flex:1"><input id="labNote" placeholder="note (optional)" style="flex:1"><button id="labSaveOk">Save</button></div>
    <div class="muted" style="margin:2px 0 6px">${esc(P.find(p => p.name === cur.name)?.note || "")}${Object.keys(cur.overrides).length ? ` · <b style="color:#ffd23f">${Object.keys(cur.overrides).length} knob(s) changed</b>` : ""}</div>
    <div class="labrow"><label data-tip="Also replay the ZED guard's depth clusters from the boat's own log (sqlite), as on the boat: they become grey obstacles and can fuse depth into buoys."><input type="checkbox" id="labGuard" ${cur.use_guard ? "checked" : ""}> use the guard's depth obstacles</label></div>
    <div class="labrow"><label data-tip="How many buoys were really on the course in view (count them on the camera). Drawn as a green line in the chart; kept for this run in this browser.">buoys really there <input type="number" id="labTruth" min="0" step="1" style="width:60px" value="${esc(truth)}"></label>
      <label data-tip="Re-run the replay automatically half a second after a knob changes."><input type="checkbox" id="labAuto" ${LAB.auto ? "checked" : ""}> auto-run</label><button id="labRunBtn" data-tip="Replay this run's camera detections through the boat's mapping code with these knobs.">▶ Run</button><span class="muted" id="labStatus"></span></div>
    <div class="statchips" id="labStats"></div>
    <canvas id="labSpark" data-tip=""></canvas>
    ${groups.map(g => `<details ${["Association", "Ghost filter", "Detections", "Merge pass"].includes(g) ? "open" : ""}><summary>${esc(g)}</summary>${K.filter(k => k.group === g).map(k => knobRow(k)).join("")}</details>`).join("")}
    <p class="muted">The replay runs today's mapping code (MASTER_SCRIPTS ${esc(LAB.knobs.profile)}) on the camera's logged detections, so it is close to, not identical with, the boat's recorded map (the boat's live timing, the guard's extra logic). Compare with "boat map (recorded)".</p>`;
  $("#labPreset").onchange = e => { const p = LAB.presets.find(p => p.name === e.target.value); LAB.cur = { name: p.name, overrides: { ...(p.overrides || {}) }, use_guard: p.use_guard !== false }; renderLab(); labRun(); };
  $("#labSave").onclick = () => { $("#labSaveRow").style.display = "flex"; $("#labName").focus(); };
  $("#labSaveOk").onclick = async () => { const name = $("#labName").value.trim(); if (!name) return; const r = await fetch("/api/maplab/presets", { method: "POST", body: JSON.stringify({ name, note: $("#labNote").value, overrides: LAB.cur.overrides, use_guard: LAB.cur.use_guard, truth: $("#labTruth").value }) }); const j = await r.json(); if (!r.ok) { $("#labStatus").textContent = j.error; return; } LAB.presets = await getJSON("/api/maplab/presets"); LAB.cur.name = j.saved; renderLab(); };
  $("#labDel").onclick = async () => { await fetch(`/api/maplab/presets/delete?name=${encodeURIComponent(cur.name)}`, { method: "POST" }); LAB.presets = await getJSON("/api/maplab/presets"); LAB.cur = { name: LAB.presets[0].name, overrides: {}, use_guard: true }; renderLab(); labRun(); };
  $("#labGuard").onchange = e => { LAB.cur.use_guard = e.target.checked; labChanged(); };
  $("#labTruth").oninput = e => { try { localStorage.setItem("logview_" + labTruthKey(), e.target.value); } catch (er) { } drawSpark(); labStats(); };
  $("#labAuto").onchange = e => LAB.auto = e.target.checked;
  $("#labRunBtn").onclick = labRun;
  $$(".krow").forEach(row => {
    const k = K.find(k => k.key === row.dataset.key), r = $("input[type=range]", row), nn = $("input[type=number]", row), cb = $("input[type=checkbox]", row);
    const set = v => { if (String(v) === String(k.deployed)) delete LAB.cur.overrides[k.key]; else LAB.cur.overrides[k.key] = v; row.classList.toggle("changed", k.key in LAB.cur.overrides); labChanged(); };
    if (cb) cb.onchange = () => set(cb.checked);
    if (r) { r.oninput = () => { nn.value = r.value; set(k.type === "int" ? parseInt(r.value) : parseFloat(r.value)); }; nn.onchange = () => { r.value = nn.value; set(k.type === "int" ? parseInt(nn.value) : parseFloat(nn.value)); }; }
    $(".rs", row).onclick = () => { delete LAB.cur.overrides[k.key]; renderLab(); labChanged(); };
  });
  labStats(); drawSpark();
}
function knobRow(k) {
  const v = labVal(k), ch = k.key in LAB.cur.overrides, tip = `${k.tip} Deployed: ${k.deployed}. (${k.key})`;
  const ctl = k.type === "bool" ? `<input type="checkbox" ${v ? "checked" : ""}><span></span>` : `<input type="range" min="${k.min}" max="${k.max}" step="${k.step}" value="${v ?? 0}"><input type="number" min="${k.min}" max="${k.max}" step="${k.step}" value="${v ?? 0}">`;
  return `<div class="krow ${ch ? "changed" : ""}" data-key="${esc(k.key)}"><label data-tip="${esc(tip)}">${esc(k.label)}</label>${ctl}<span class="rs" data-tip="Back to the deployed value (${esc(k.deployed)}).">↺</span></div>`;
}
function labChanged() { const n = Object.keys(LAB.cur.overrides).length; $("#labStatus").textContent = n ? `${n} changed` : ""; if (LAB.auto) { clearTimeout(LAB.timer); LAB.timer = setTimeout(labRun, 500); } }
async function labRun() {
  if (!B || LAB.busy) { LAB.again = true; return; } LAB.busy = true; LAB.again = false; $("#labStatus").textContent = "replaying…";
  try {
    const r = await fetch(`/api/maplab/run?rel=${encodeURIComponent(B.rel)}`, { method: "POST", body: JSON.stringify({ overrides: LAB.cur.overrides, use_guard: LAB.cur.use_guard }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    LAB.result = j; MAPS.lab = j.snaps.map(sn => ({ t: sn.t, ent: sn.ent, boat: null }));
    if (!MAPS.boat && (B.map_sources || []).includes("boat")) MAPS.boat = await getJSON(`/api/map?rel=${encodeURIComponent(B.rel)}&src=boat`);
    fillMapSrc(); const curSrc = $("#mapSrc").value;
    if (!LAB.switched || curSrc === "lab") { LAB.switched = true; await setMapSource("lab"); } else $("#mapSrc").value = curSrc;   // switch once; then follow the user's choice
    $("#labStatus").textContent = `${j.stats.seconds} s`; labStats(); drawSpark();
  } catch (e) { $("#labStatus").textContent = "error: " + e.message; }
  LAB.busy = false; if (LAB.again) labRun();
}
function boatCounts() { return (MAPS.boat || []).map(f => [f.t, f.ent.filter(e => e[1] === "buoy" && e[5] === "tracked").length]); }
function labStats() {
  const el = $("#labStats"); if (!el) return; const s = LAB.result?.stats; if (!s) { el.innerHTML = ""; return; }
  const bc = boatCounts(), bEnd = bc.length ? bc[bc.length - 1][1] : null; let truth = ""; try { truth = localStorage.getItem("logview_" + labTruthKey()) || ""; } catch (e) { }
  const col = Object.entries(s.by_colour).map(([c, n]) => `<span data-tip="Mapped buoys of this colour at the end (incl. stale)"><b style="color:${BUOY[c] || "#c084fc"}">●</b> ${c} ${n}</span>`).join("");
  el.innerHTML = `<span data-tip="Buoys on the lab map at the end of the run (tracked + stale)."><b>${s.buoys_final}</b> buoys (lab)</span>` +
    (bEnd != null ? `<span data-tip="The boat's own recorded map at the end of the run (tracked buoys)."><b>${bEnd}</b> on the boat's map</span>` : "") +
    (truth ? `<span data-tip="Your count of the buoys really there." style="border-color:#30d158">truth ${truth} · lab ${s.buoys_final - truth >= 0 ? "+" : ""}${s.buoys_final - truth}</span>` : "") + col +
    `<span data-tip="Most buoys on the lab map at any moment.">max ${s.max_visible}</span><span data-tip="Buoys still below the ghost filter at the end (internal).">young ${s.young_final}</span>` +
    `<span data-tip="Buoys merged by the merge pass.">merged ${s.merged}</span><span data-tip="Depth obstacles (with the guard's depth on).">obstacles ${s.obstacles}</span>` +
    `<span data-tip="Camera detections fed to the map / frames.">${s.items} dets / ${s.frames} fr</span>`;
}
function drawSpark() {
  const cv = $("#labSpark"); if (!cv || !LAB.result) return; const k = dpr(cv), W = cv.width, H = cv.height, c = cv.getContext("2d"); c.clearRect(0, 0, W, H);
  const S = LAB.result.series, bc = boatCounts(); let truth = NaN; try { truth = parseFloat(localStorage.getItem("logview_" + labTruthKey())); } catch (e) { }
  const t0 = Math.min(S[0]?.[0] ?? B.t0, bc[0]?.[0] ?? Infinity), t1 = Math.max(S[S.length - 1]?.[0] ?? B.t1, bc[bc.length - 1]?.[0] ?? -Infinity);
  const ymax = Math.max(5, ...S.map(s => s[1] + s[2] * (MV.layers.young ? 1 : 0)), ...bc.map(b => b[1]), isFinite(truth) ? truth : 0) * 1.1;
  const X = t => 30 * k + (t - t0) / Math.max(1, t1 - t0) * (W - 36 * k), Y = v => H - 12 * k - v / ymax * (H - 18 * k);
  c.font = `${9 * k}px -apple-system,Arial`; c.fillStyle = "#8b95a3"; c.fillText(String(Math.round(ymax)), 2 * k, 10 * k); c.fillText("0", 2 * k, H - 12 * k);
  const line = (pts, col, dash) => { c.strokeStyle = col; c.lineWidth = 1.5 * k; c.setLineDash(dash || []); c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.stroke(); c.setLineDash([]); };
  if (bc.length) line(bc, "#ffb020"); line(S.map(s => [s[0], s[1]]), "#4aa3ff");
  if (isFinite(truth)) line([[t0, truth], [t1, truth]], "#30d158", [5 * k, 4 * k]);
  c.strokeStyle = "#ffd23f"; c.setLineDash([3 * k, 3 * k]); c.beginPath(); c.moveTo(X(T), 0); c.lineTo(X(T), H); c.stroke(); c.setLineDash([]);
  c.fillStyle = "#4aa3ff"; c.fillText("lab", W - 70 * k, 10 * k); c.fillStyle = "#ffb020"; c.fillText("boat", W - 50 * k, 10 * k); c.fillStyle = "#30d158"; c.fillText("truth", W - 26 * k, 10 * k);
  cv.dataset.tip = "Buoys on the map over the run: blue = the lab replay, orange = the boat's recorded map, dashed green = your count of the buoys really there; yellow = now.";
}
$("#btnLab").onclick = openLab;
$("#labClose").onclick = () => $("#lab").style.display = "none";
(function dragLab() { const hd = $("#labHd"), el = $("#lab"); let d = null; hd.addEventListener("mousedown", e => { if (e.target.closest("button")) return; const r = el.getBoundingClientRect(); d = { x: e.clientX - r.left, y: e.clientY - r.top }; e.preventDefault(); }); window.addEventListener("mousemove", e => { if (!d) return; el.style.left = clamp(e.clientX - d.x, 0, innerWidth - 100) + "px"; el.style.top = clamp(e.clientY - d.y, 0, innerHeight - 40) + "px"; el.style.right = "auto"; }); window.addEventListener("mouseup", () => d = null); })();

// ---------------------------------------------------------------- camera
const TURBO = [[48, 18, 59], [70, 107, 227], [41, 187, 236], [32, 235, 166], [122, 254, 94], [205, 236, 52], [253, 186, 48], [243, 112, 24], [195, 40, 3], [122, 4, 3]];
function turbo(x) { x = clamp(x, 0, 1) * (TURBO.length - 1); const i = Math.floor(x), f = x - i, a = TURBO[i], b = TURBO[Math.min(i + 1, TURBO.length - 1)]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
const cam = {
  v: $("#video"), ov: $("#ov"), dcv: $("#depthCv"), cm: null, idx: null, eye: "left", view: "image", frame: -1, boxes: {}, pending: {}, depth: null, depthKey: "", poll: null,
  enabled: new Set(["recorded"]), base: "recorded",
  auto: true,
  setSession(name) {
    this.resumeBuf = this.buf?.on || false;                       // a depth buffer follows to the next recording
    if (this.buf?.on) this.bufToggle(false);
    this.cm = B.cams.find(c => c.name === name) || null; this.idx = null; this.boxes = {}; this.depth = null; this.frame = -1; this.v.removeAttribute("src"); this.v.load();
    this.byFrame = new Map((this.cm?.frames || []).map(f => [f.svo, f])); this.prepare();
    if (this.auto) $("#camSel").value = "auto"; else if (this.cm) $("#camSel").value = this.cm.name;
  },
  // the recording that covers time t (its first .. last frame, + 1.5 s), else null
  sessionAt(t) { return B.cams.find(c => c.obs_t.length && t >= c.obs_t[0] - 0.5 && t <= c.obs_t[c.obs_t.length - 1] + 1.5) || null; },
  followTime() {
    if (!this.auto || !B || B.cams.length < 2) return;
    const s = this.sessionAt(T); if (s && s !== this.cm) this.setSession(s.name);
  },
  async prefetchOthers() {                                        // cache the run's other recordings in the background, one at a time
    for (const c of B.cams) {
      if (c === this.cm || !c.svo) continue; const run = B.rel;
      for (let k = 0; k < 600; k++) {
        if (!B || B.rel !== run) return;
        const st = await getJSON(`/api/video/status?rel=${encodeURIComponent(run)}&cam=${encodeURIComponent(c.name)}&eye=left&start=1`).catch(() => ({ state: "error" }));
        if (st.state === "ready" || st.state === "error" || st.state === "none") break;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  },
  msg(html) { $("#camMsg").innerHTML = html || ""; $("#camMsg").style.display = html ? "flex" : "none"; },
  async prepare() {
    clearTimeout(this.poll); const cm = this.cm; if (!cm) { this.msg("no camera in this run"); return; }
    if (!cm.svo) { this.msg("this session has no stereo recording (.svo2): only the recorded detections exist"); return; }
    const st = await getJSON(`/api/video/status?rel=${encodeURIComponent(B.rel)}&cam=${encodeURIComponent(cm.name)}&eye=${this.eye}&start=1`);
    if (cm !== this.cm) return;
    if (st.state === "ready") { if (!this.prefetched) { this.prefetched = true; this.prefetchOthers(); } if (this.resumeBuf) { this.resumeBuf = false; setTimeout(() => this.bufToggle(true), 50); } this.idx = st.index; this.v.src = `/media?rel=${encodeURIComponent(B.rel)}&cam=${encodeURIComponent(cm.name)}&eye=${this.eye}`; this.msg(""); this.v.onloadedmetadata = () => { this.shown = -1; this.syncVideo(); }; this.v.onseeked = () => this.drawOverlay(); this.v.onerror = () => this.msg(`the browser could not play the cached video (${esc(this.v.error?.message || this.v.error?.code)})`); this.timeChanged(); return; }
    if (st.state === "error") { this.msg(`video cache failed: ${esc(st.error)} <button onclick="cam.prepare()">Retry</button>`); return; }
    const pct = st.total ? Math.round(100 * st.done / st.total) : 0;
    this.msg(`<div>Preparing the ${this.eye} camera video (first open of this recording only): ${esc(st.state)} ${st.done || 0} / ${st.total || "?"} frames</div><div class="bar"><div style="width:${pct}%"></div></div><div class="muted">The .svo2 is decoded once into a cached MP4 beside it; afterwards scrubbing is instant.</div>`);
    this.poll = setTimeout(() => this.prepare(), 600);
  },
  frameAt(t) { if (!this.idx) return -1; const ts = this.idx.ts; let i = bsearch(ts, t); if (i < 0) { if (ts.length && ts[0] - t < 0.05) i = 0; else return -1; } if (t - this.idx.ts[i] > 1.0 && i === this.idx.ts.length - 1) return -1; return i; },
  syncVideo() {
    // the recordings hold the observer's frames (often ~2 fps, irregular), so the viewer's clock is the master and the video is
    // stepped to the frame recorded at or before the current time (never played as a 15 fps video)
    if (!this.idx || !this.v.src || this.v.readyState < 1) return; const i = this.frameAt(T);
    if (!this.v.paused) this.v.pause(); if (i < 0) return;
    const want = (i + 0.5) / this.idx.fps; if (this.shown !== i || Math.abs(this.v.currentTime - want) > 0.5 / this.idx.fps) { this.shown = i; this.v.currentTime = want; }
  },
  videoTime() { return null; },
  timeChanged() {
    this.followTime();
    const i = this.frameAt(T), out = i < 0;
    $("#camWrap").style.opacity = out ? 0.35 : 1;
    const spans = () => B.cams.filter(c => c.obs_t.length).map(c => `${sgt(c.obs_t[0]).slice(0, 8)}–${sgt(c.obs_t[c.obs_t.length - 1]).slice(0, 8)}`).join(", ");
    if (this.idx) { const f = this.byFrame.get(i); $("#camStatus").textContent = out ? `no camera recording at ${sgt(T).slice(0, 8)} — this run's recordings: ${spans()}` : (B.cams.length > 1 ? `rec ${B.cams.indexOf(this.cm) + 1}/${B.cams.length} · ` : "") + `frame ${i} / ${this.idx.ts.length} · ${sgt(this.idx.ts[i])}${f ? " · " + f.status + " · " + f.buoys.length + " buoys" : ""}`; }
    if (i !== this.frame) { this.frame = i; if (this.view !== "image") { this.depth = this.dCache.get(i) || null; this.renderDepth(); } this.requestExtras(); }   // never the old frame's depth
    this.drawOverlay();
  },
  requestExtras() {
    clearTimeout(this.extrasTimer); if (this.frame < 0) return;
    if (this.view !== "image" && this.eye === "left") this.wantDepth(this.frame);
    this.extrasTimer = setTimeout(() => {
      const i = this.frame; if (playing && i !== this.frame) return;
      for (const e of this.enabled) if (e !== "recorded" && !playing) this.fetchBoxes(e, i);
    }, playing ? 0 : 180);
  },
  // ---- depth: one page-side cache (frame -> depth) per session / source / mode; the server's sliding buffer when "Buffer depth" is on
  dKey() { return `${this.cm?.name}|${$("#depthSrc").value}|${$("#stereoMode").value}`; },
  dCache: new Map(), dCacheKey: "", dPending: new Set(), buf: { on: false, st: null },
  resetDepth() { this.dCache = new Map(); this.dPending = new Set(); this.dCacheKey = this.dKey(); this.depth = null; this.depthKey = ""; },
  wantDepth(i) {
    if (this.dCacheKey !== this.dKey()) this.resetDepth();
    const hit = this.dCache.get(i); if (hit) { this.depth = hit; this.renderDepth(); }
    else { this.renderDepth(); if (this.buf.on || !playing || (this.cm.depth_frames || []).includes(i)) this.fetchDepth(i); }
    if (this.buf.on) for (let j = i + 1; j <= Math.min(i + 8, (this.idx?.ts.length || 0) - 1); j++) if (!this.dCache.has(j)) this.fetchDepth(j, true);
  },
  async fetchDepth(i, prefetch = false) {
    const key = this.dKey(), pk = key + "|" + i; if (this.dPending.has(pk) || this.dCache.has(i)) return; this.dPending.add(pk);
    const [src, mode] = [$("#depthSrc").value, $("#stereoMode").value];
    try {
      const r = await fetch(`/api/depth?rel=${encodeURIComponent(B.rel)}&cam=${encodeURIComponent(this.cm.name)}&frame=${i}&src=${src}&mode=${mode}${this.buf.on ? "&buf=1" : ""}`);
      if (key !== this.dKey()) return;
      if (r.status === 204) return;                                   // not in the buffer yet: the status poll asks again
      if (r.status === 202) { const st = await r.json(); if (!prefetch) { this.depthNote = `preparing the right eye for stereo: ${st.done || 0} / ${st.total || "?"}`; this.renderDepth(); setTimeout(() => { this.dPending.delete(pk); if (this.frame === i) this.fetchDepth(i); }, 700); } return; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); if (i === this.frame) { this.depthNote = `depth: ${j.error || "none"}`; this.renderDepth(); } return; }
      const info = JSON.parse(r.headers.get("X-Depth-Info") || "{}"); const buf = await r.arrayBuffer();
      if (key !== this.dKey()) return;                                // the session / source / mode changed while this was in flight
      const d = { mm: new Uint16Array(buf), w: info.w, h: info.h, info, frame: i, cam: this.cm.name };
      this.dCache.set(i, d); if (this.dCache.size > 160) { const far = [...this.dCache.keys()].sort((a, b) => Math.abs(b - this.frame) - Math.abs(a - this.frame))[0]; this.dCache.delete(far); }
      if (i === this.frame) { this.depth = d; this.depthNote = ""; this.renderDepth(); }
    } finally { this.dPending.delete(pk); }
  },
  async bufToggle(on) {
    this.buf.on = on; $("#btnBuf").classList.toggle("on", on); clearInterval(this.buf.timer);
    if (!on) { fetch("/api/depthbuf/stop", { method: "POST" }).catch(() => { }); this.buf.st = null; $("#btnBuf").textContent = "⚡ Buffer depth"; this.resetDepth(); this.renderDepth(); return; }
    if (this.view === "image") { $("#viewSel").value = "blend"; this.view = "blend"; }
    this.resetDepth(); this.buf.sent = -1;
    const poll = async () => {
      if (!this.buf.on || !this.cm) return;
      const q = `rel=${encodeURIComponent(B.rel)}&cam=${encodeURIComponent(this.cm.name)}&src=${$("#depthSrc").value}&mode=${$("#stereoMode").value}&cursor=${Math.max(0, this.frame)}`;
      const r = await fetch(`/api/depthbuf?${q}`, { method: "POST" }).catch(() => null); if (!r) return;
      const st = await r.json().catch(() => ({}));
      if (r.status === 202) { $("#btnBuf").textContent = `⚡ preparing ${st.done || 0}/${st.total || "?"}`; return; }
      this.buf.st = st; const ahead = Math.max(0, (st.ready_upto ?? -1) - Math.max(0, this.frame));
      $("#btnBuf").textContent = `⚡ ${ahead} ahead`; $("#btnBuf").dataset.tip = `Depth buffer: ${st.have || 0} frames ready in the window ${st.window?.[0]}–${st.window?.[1]} (${st.src}, ${st.mode}); ${ahead} consecutive frames ready ahead of the cursor. Click to stop and drop it.${st.error ? " ERROR: " + st.error : ""}`;
      if (this.frame >= 0 && !this.dCache.has(this.frame)) this.fetchDepth(this.frame);
      for (let j = this.frame + 1; j <= Math.min(this.frame + 8, st.ready_upto ?? -1); j++) if (!this.dCache.has(j)) this.fetchDepth(j, true);
    };
    poll(); this.buf.timer = setInterval(poll, 400); this.renderDepth();
  },
  key(e, i) { return `${this.cm.name}|${e}|${e === "lamp" ? this.base : ""}|${i}`; },
  async fetchBoxes(e, i) {
    const k = this.key(e, i); if (this.boxes[k] || this.pending[k]) return; this.pending[k] = true; this.drawOverlay();
    try { const r = await getJSON(`/api/detect?rel=${encodeURIComponent(B.rel)}&cam=${encodeURIComponent(this.cm.name)}&frame=${i}&engine=${e}&base=${this.base}`); this.boxes[k] = r; }
    catch (err) { this.boxes[k] = { boxes: [], error: String(err.message || err) }; }
    delete this.pending[k]; this.drawOverlay(); renderEngineBar();
  },
  renderDepth() {
    const okEye = this.eye === "left";
    const show = this.view !== "image" && okEye; $("#depthScale").style.display = show ? "flex" : "none"; drawScale();
    let d = this.depth; if (d && (d.frame !== this.frame || d.cam !== this.cm?.name)) d = null;     // never draw another frame's depth
    $("#depthNote").textContent = this.view === "image" ? "" : !okEye ? "depth is in the left (as the boat saw it) geometry: pick that eye" : d ? `${d.info.source}${d.info.valid_pct != null ? " · " + d.info.valid_pct + " % valid" : ""}` : (this.depthNote || (this.frame < 0 ? "no camera frame here" : this.buf.on ? "buffering depth…" : playing ? "playing: depth only on frames with recorded AGX depth — press ⚡ Buffer depth for every frame" : "computing depth…")); this.dcv.style.display = show && d ? "block" : "none"; this.v.style.visibility = this.view === "depth" && d ? "hidden" : "visible";
    if (!show || !d) { this.placeLayers(); return; }
    this.dcv.width = d.w; this.dcv.height = d.h; const c = this.dcv.getContext("2d"), im = c.createImageData(d.w, d.h), lo = +$("#dMin").value, hi = +$("#dMax").value;
    for (let p = 0; p < d.mm.length; p++) { const z = d.mm[p] / 1000; const o = p * 4; if (!z) { im.data[o + 3] = this.view === "blend" ? 0 : 255; continue; } const [r, g, b] = turbo((z - lo) / (hi - lo)); im.data[o] = r; im.data[o + 1] = g; im.data[o + 2] = b; im.data[o + 3] = 255; }
    c.putImageData(im, 0, 0); this.dcv.style.opacity = this.view === "blend" ? 0.6 : 1; this.placeLayers();
  },
  rect() { const wr = $("#camWrap").getBoundingClientRect(), W = this.idx?.w || 2208, H = this.idx?.h || 1242; const s = Math.min(wr.width / W, wr.height / H); const w = W * s, h = H * s; return { x: (wr.width - w) / 2, y: (wr.height - h) / 2, w, h, s, W, H }; },
  placeLayers() { const r = this.rect(); for (const el of [this.ov, this.dcv]) { el.style.left = r.x + "px"; el.style.top = r.y + "px"; el.style.width = r.w + "px"; el.style.height = r.h + "px"; el.style.position = "absolute"; } this.v.style.width = r.w + "px"; this.v.style.height = r.h + "px"; },
  currentBoxes() {
    const out = []; const i = this.frame; if (i < 0 || !this.cm) return out;
    for (const e of this.enabled) {
      let bx; if (e === "recorded") { const f = this.byFrame.get(i); bx = f ? recordedBoxes(f) : []; } else bx = (this.boxes[this.key(e, i)] || {}).boxes || [];
      const eng = ENG.find(x => x.name === e); bx.forEach(b => out.push({ ...b, engine: e, engColour: eng?.colour }));
    }
    return out;
  },
  drawOverlay() {
    this.placeLayers(); const r = this.rect(), k = devicePixelRatio || 1, cv = this.ov; cv.width = Math.round(r.w * k); cv.height = Math.round(r.h * k);
    const c = cv.getContext("2d"), s = r.s * k; c.clearRect(0, 0, cv.width, cv.height); this.hitBoxes = [];
    if (!$("#boxesOn")?.checked) return;
    if (this.eye !== "left") { c.fillStyle = "#ffd23f"; c.font = `${11 * k}px -apple-system,Arial`; c.fillText("boxes are drawn on the 'left (as the boat saw it)' eye only", 8 * k, 16 * k); return; }
    c.font = `${11 * k}px -apple-system,Arial`; c.lineWidth = 2 * k;
    const labels = $("#labelsOn")?.checked;
    for (const b of this.currentBoxes()) {
      const off = b.engine === "lamp" && /none/.test(b.cls);
      const [x1, y1, x2, y2] = b.bbox.map(v => v * s); c.globalAlpha = off ? 0.35 : 1; c.strokeStyle = b.colour || b.engColour; c.lineWidth = (off ? 1 : 2) * k; if (b.engine !== "recorded") c.setLineDash([6 * k, 3 * k]); c.strokeRect(x1, y1, x2 - x1, y2 - y1); c.setLineDash([]);
      if (labels && !off) { const lab = b.label || b.cls; const tw = c.measureText(lab).width + 6 * k; c.fillStyle = "rgba(0,0,0,.65)"; c.fillRect(x1, y1 - 14 * k, tw, 14 * k); c.fillStyle = b.colour || b.engColour; c.fillText(lab, x1 + 3 * k, y1 - 3 * k); }
      c.globalAlpha = 1;
      this.hitBoxes.push({ b, x1: x1 / k, y1: y1 / k, x2: x2 / k, y2: y2 / k });
    }
    const pend = Object.keys(this.pending).filter(kk => kk.endsWith("|" + this.frame)).length; if (pend) { c.fillStyle = "#ffd23f"; c.fillText(`running ${pend} engine(s)…`, 8 * k, 16 * k); }
  },
  async build(eye) { this.eye = eye; this.setSession(this.cm?.name); },
};
function recordedBoxes(f) { return f.buoys.filter(b => b.bbox).map(b => ({ bbox: b.bbox, cls: b.colour, conf: b.confidence, colour: BUOY[b.colour] || "#ffcc00", label: `${b.colour} ${(+b.confidence || 0).toFixed(2)}${b.range_m ? " " + b.range_m.toFixed(1) + "m" : ""}${b.led?.colour ? " lamp:" + b.led.colour : ""}`, extra: { range_m: b.range_m, bearing_deg: b.bearing_deg, elev_deg: b.elev_deg, bearing_only: b.bearing_only, reason: b.reason, forward_m: b.forward_m, right_m: b.right_m, lamp_colour: b.led?.colour, lamp_pattern: b.led?.pattern, lamp_track: b.led?.track, frame_status: f.status } })); }
function drawScale() {
  const cv = $("#dBar"), k = devicePixelRatio || 1, r = cv.getBoundingClientRect(); cv.width = Math.max(40, r.width) * k; cv.height = Math.max(60, r.height) * k; const c = cv.getContext("2d"), W = cv.width, H = cv.height;
  const lo = +$("#dMin").value, hi = +$("#dMax").value; c.clearRect(0, 0, W, H);
  for (let y = 0; y < H; y++) { const [r1, g, b] = turbo(1 - y / H); c.fillStyle = `rgb(${r1},${g},${b})`; c.fillRect(0, y, 14 * k, 1); }
  c.fillStyle = "#cfd6df"; c.font = `${10 * k}px -apple-system,Arial`; const st = niceStep((hi - lo) / 5);
  for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) { const y = H - (v - lo) / (hi - lo) * H; c.fillRect(14 * k, y, 4 * k, 1); c.fillText(fmtNum(v), 19 * k, clamp(y + 3 * k, 9 * k, H - 2 * k)); }
}
$("#dBar").style.width = "46px";
["dMin", "dMax"].forEach(id => $("#" + id).addEventListener("input", () => cam.renderDepth()));
$("#camBody").addEventListener("mousemove", e => {
  if (!cam.idx) return; const r = cam.ov.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; if (x < 0 || y < 0 || x > r.width || y > r.height) { hideTip(); return; }
  const hb = (cam.hitBoxes || []).filter(h => x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2).pop(); let html = "";
  if (hb) html += `<b>${esc(hb.b.engine)}</b>: ${esc(hb.b.label || hb.b.cls)}\nconfidence ${hb.b.conf != null ? (+hb.b.conf).toFixed(3) : "–"}\nclick: all details\n`;
  if (cam.depth && cam.view !== "image") { const px = Math.floor(x / r.width * cam.depth.w), py = Math.floor(y / r.height * cam.depth.h); const z = cam.depth.mm[py * cam.depth.w + px] / 1000; html += `depth <b>${z ? z.toFixed(2) + " m" : "none"}</b> (${esc(cam.depth.info.source)})`; }
  html ? showTip(e.clientX, e.clientY, html.trim()) : hideTip();
});
$("#camBody").addEventListener("mouseleave", hideTip);
$("#camBody").addEventListener("click", e => {
  const r = cam.ov.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; const hb = (cam.hitBoxes || []).filter(h => x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2).pop();
  if (hb) popup(`<h2>${esc(hb.b.engine)}: ${esc(hb.b.label || hb.b.cls)}</h2>` + kvTable({ class: hb.b.cls, confidence: hb.b.conf, box_px: hb.b.bbox.map(v => Math.round(v)).join(", "), frame: cam.frame, time: sgt(cam.idx.ts[cam.frame]), ...(hb.b.extra || {}) }));
});
function renderEngineBar() {
  const el = $("#engineBar"); const was = $("#boxesOn")?.checked ?? true;
  el.innerHTML = `<label data-tip="Draw detection boxes on the image (solid = recorded on the boat, dashed = run here)."><input type="checkbox" id="boxesOn" ${was ? "checked" : ""}><b>boxes</b></label><label data-tip="Draw the text labels on the boxes (hover a box for its label either way)."><input type="checkbox" id="labelsOn" ${($("#labelsOn")?.checked ?? true) ? "checked" : ""}>labels</label>` +
    ENG.map(e => `<label data-tip="${esc(e.description + (e.available ? "" : " — NOT AVAILABLE: " + e.reason) + (e.name !== "recorded" ? " Runs when paused; results are kept per frame." : ""))}"><input type="checkbox" data-eng="${e.name}" ${cam.enabled.has(e.name) ? "checked" : ""} ${e.available ? "" : "disabled"}><span class="sw" style="background:${e.colour}"></span>${esc(e.label)}</label>`).join("") +
    `<label data-tip="The boxes the lamp reader looks above."><span class="muted">lamp on</span><select id="lampBase">${ENG.filter(e => e.kind === "detector").map(e => `<option value="${e.name}" ${cam.base === e.name ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select></label>` +
    `<button id="btnRerun" data-tip="Run the ticked engines on this frame again.">↻</button>`;
  $("#boxesOn").onchange = () => cam.drawOverlay(); $("#labelsOn").onchange = () => cam.drawOverlay();
  $$("[data-eng]", el).forEach(i => i.onchange = () => { i.checked ? cam.enabled.add(i.dataset.eng) : cam.enabled.delete(i.dataset.eng); cam.requestExtras(); cam.drawOverlay(); });
  $("#lampBase").onchange = e => { cam.base = e.target.value; cam.requestExtras(); cam.drawOverlay(); };
  $("#btnRerun").onclick = () => { for (const k of Object.keys(cam.boxes)) if (k.endsWith("|" + cam.frame)) delete cam.boxes[k]; cam.requestExtras(); };
}
$("#camSel").onchange = e => { if (e.target.value === "auto") { cam.auto = true; cam.followTime(); $("#camSel").value = "auto"; } else { cam.auto = false; cam.setSession(e.target.value); } };
$("#eyeSel").onchange = e => cam.build(e.target.value);
$("#viewSel").onchange = e => { cam.view = e.target.value; cam.depth = cam.dCache.get(cam.frame) || null; cam.renderDepth(); cam.requestExtras(); };
$("#depthSrc").onchange = () => { cam.resetDepth(); cam.requestExtras(); };
$("#stereoMode").onchange = () => { cam.resetDepth(); cam.requestExtras(); };
$("#btnBuf").onclick = () => cam.bufToggle(!cam.buf.on);
new ResizeObserver(() => { cam.drawOverlay(); drawScale(); }).observe($("#camBody"));

// ---------------------------------------------------------------- save PNG
async function saveCam() {
  if (!cam.idx) return; const W = cam.idx.w, H = cam.idx.h, cv = document.createElement("canvas"); cv.width = W; cv.height = H; const c = cv.getContext("2d");
  if (cam.view !== "depth" || !cam.depth) c.drawImage(cam.v, 0, 0, W, H); else { c.fillStyle = "#000"; c.fillRect(0, 0, W, H); }
  if (cam.view !== "image" && cam.depth) { c.globalAlpha = cam.view === "blend" ? 0.6 : 1; c.drawImage(cam.dcv, 0, 0, W, H); c.globalAlpha = 1; const sb = $("#dBar"); c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(W - 90, 20, 80, H * 0.5 + 20); c.drawImage(sb, W - 85, 30, 70, H * 0.5); }
  c.drawImage(cam.ov, 0, 0, W, H);
  c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(0, H - 34, W, 34); c.fillStyle = "#fff"; c.font = "22px -apple-system,Arial"; c.fillText(`${B.run} · ${cam.cm.name} · frame ${cam.frame} · ${sgtDate(T)} ${sgt(cam.idx.ts[cam.frame] || T)} SGT · ${cam.view}`, 10, H - 10);
  cv.toBlob(b => download(b, fname("camera") + ".png"));
}
$$("[data-save]").forEach(b => b.onclick = () => { const w = b.dataset.save; if (w === "map") MV.cv.toBlob(x => download(x, fname("map") + ".png")); else if (w === "timebar") TB.cv.toBlob(x => download(x, fname("timebar") + ".png")); else if (w === "cam") saveCam(); });

// ---------------------------------------------------------------- expand tiles
function toggleExpand(el) {
  const on = !el.classList.contains("expanded");
  $$(".expanded").forEach(x => { x.classList.remove("expanded"); x.style.cssText = x.dataset.css || ""; });
  if (on) { el.dataset.css = el.style.cssText; el.classList.add("expanded"); Object.assign(el.style, { position: "fixed", inset: "3vh 3vw", zIndex: 950, height: "auto" }); $("#expandBack").classList.add("show"); }
  else $("#expandBack").classList.remove("show");
  setTimeout(() => { charts.forEach(c => c.dirty = true); redrawAll(); cam.drawOverlay(); cam.renderDepth(); }, 30);
}
$("#expandBack").onclick = () => { $$(".expanded").forEach(x => toggleExpand(x)); };
$$("[data-expand]").forEach(b => b.onclick = () => toggleExpand($("#" + b.dataset.expand)));

// ---------------------------------------------------------------- run list, events, info, help
function runsTable(filter = "", cat = "", cv = false, sortK = "run", dir = 1) {
  const cols = [["kind", "Kind", "run = a paired run folder (motion + camera + operator); console = a boat-console session log (csv / events / tlog)"], ["category", "Category", "1_incomplete · 2_simulation · 3_venue (a_good / b_weak / c_static_tests) · 4_pool"], ["run", "Run", "folder name: local start time + mission (+ _CV)"], ["cv", "CV", "CV = good for vision training"], ["motion", "Motion", "boat = the boat's own log; ocs = the shore hub only; pose-only = the camera frames' pose"], ["dur_s", "s", "boat run length (s)"], ["dist_m", "m", "distance driven (m)"], ["frames", "frames", "camera frames logged"], ["frames_with_buoys", "w/ buoys", "frames with at least one buoy"], ["ranged_buoys", "ranged", "buoy detections with a depth range"], ["lamp_reads", "lamp", "lamp colour reads"], ["svo_GB", "GB", "stereo recording size"]];
  let rows = RUNS.filter(r => (!filter || (r.run + r.mission + r.note + r.category).toLowerCase().includes(filter.toLowerCase())) && (!cat || r.category.startsWith(cat) || r.kind === cat) && (!cv || r.cv));
  rows.sort((a, b) => { const x = a[sortK], y = b[sortK]; return (isNaN(+x) || isNaN(+y) ? String(x).localeCompare(String(y)) : (+x) - (+y)) * dir; });
  return `<table><tr>${cols.map(([k, l, t]) => `<th data-sort="${k}" data-tip="${esc(t)} — click to sort" style="cursor:pointer">${l}</th>`).join("")}</tr>` +
    rows.map(r => `<tr class="pick" data-rel="${esc(r.path)}" data-tip="${esc(r.note || r.mission)}">${cols.map(([k]) => `<td>${esc(k === "category" ? r[k].replace(/^\d_/, "") : r[k])}</td>`).join("")}</tr>`).join("") + `</table><p class="muted">${rows.length} runs</p>`;
}
function openRuns() {
  let st = { f: "", c: "", cv: false, k: "run", d: 1 };
  const cats = [...new Set(RUNS.map(r => r.category))].sort();
  popup(`<h2>Runs</h2><p><input id="rf" placeholder="search name / mission / note" data-tip="Filter by text."> <select id="rc" data-tip="Category"><option value="">all categories</option><option value="run">runs only</option><option value="console">console sessions only</option>${cats.map(c => `<option>${esc(c)}</option>`).join("")}</select> <label data-tip="Only runs tagged CV (good for vision training)."><input type="checkbox" id="rcv"> CV only</label></p><div id="rt"></div>`);
  const draw = () => { $("#rt").innerHTML = runsTable(st.f, st.c, st.cv, st.k, st.d); $$("#rt tr.pick").forEach(tr => tr.onclick = () => { closeModal(); loadRun(tr.dataset.rel); }); $$("#rt th").forEach(th => th.onclick = () => { st.d = st.k === th.dataset.sort ? -st.d : 1; st.k = th.dataset.sort; draw(); }); };
  $("#rf").oninput = e => { st.f = e.target.value; draw(); }; $("#rc").onchange = e => { st.c = e.target.value; draw(); }; $("#rcv").onchange = e => { st.cv = e.target.checked; draw(); }; draw();
}
$("#btnRuns").onclick = openRuns;
$("#btnLink").onclick = () => { if (B) { shareLink(); showTip(innerWidth / 2, 60, "Link to this moment copied (also in the address bar)."); setTimeout(hideTip, 1500); } };
$("#btnEvents").onclick = () => {
  if (!B) return; popup(`<h2>Events (${B.events.length})</h2><p><input id="ef" placeholder="filter" data-tip="Filter the events by text."></p><div id="et"></div>`);
  const draw = f => { $("#et").innerHTML = `<table><tr><th>SGT</th><th>run time</th><th>source</th><th>text</th></tr>${B.events.filter(e => !f || e.text.toLowerCase().includes(f)).map(e => `<tr class="pick" data-t="${e.t}" data-tip="click: jump here"><td>${sgt(e.t)}</td><td>${rel(e.t)}</td><td>${esc(e.src)}</td><td>${esc(e.text)}</td></tr>`).join("")}</table>`; $$("#et tr.pick").forEach(tr => tr.onclick = () => { setTime(+tr.dataset.t); closeModal(); }); };
  $("#ef").oninput = e => draw(e.target.value.toLowerCase()); draw("");
};
$("#btnInfo").onclick = () => { if (B) popup(`<h2>${esc(B.run)}</h2>` + kvTable({ category: B.info.category, mission: B.info.mission, note: B.info.note, motion: B.info.motion, start: `${sgtDate(B.t0)} ${sgt(B.t0)} SGT`, length: dur(B.t1 - B.t0), "map origin": B.co?.join(", ") }) + `<h2 style="margin-top:12px">run.json</h2><pre style="white-space:pre-wrap;font:11px var(--mono)">${esc(JSON.stringify(B.runjson, null, 1))}</pre>`); };
$("#btnHelp").onclick = () => popup(`<h2>Run Viewer</h2><table class="kv">
<tr><td><kbd>Space</kbd></td><td>play / pause</td></tr><tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>one camera frame (0.1 s without camera); <kbd>Shift</kbd> 1 s, <kbd>Alt</kbd> 10 s</td></tr>
<tr><td><kbd>+</kbd> <kbd>-</kbd></td><td>faster / slower</td></tr><tr><td><kbd>Esc</kbd></td><td>close a pop-up or an expanded tile</td></tr>
<tr><td>charts, timebar</td><td>click / drag = move the time · wheel = zoom time · Shift-drag or right-drag = pan · double-click = whole run</td></tr>
<tr><td>timebar</td><td>hover a lane for its span · double-click a lane for details · click an event tick for the events there · drag the blue box in "whole run" to pan</td></tr>
<tr><td>map</td><td>wheel = zoom · drag = pan (turns Follow off) · hover / click items for details</td></tr>
<tr><td>camera</td><td>tick engines to draw their boxes (other than "recorded" they run when paused) · hover / click a box · depth: choose the view, edit the scale limits, hover for a pixel's depth</td></tr>
<tr><td>⤢ ⭳ CSV</td><td>expand a tile · save it as PNG · a chart's visible window as CSV</td></tr></table>
<p class="muted" id="dbg"></p><p class="muted">Times: local SGT (UTC+8). Data: RobotX/DATASETS. CV engines: _tools/logview/engines/*.py + engines.json.</p>`);

$("#btnQuit").onclick = () => {
  popup(`<h2>Close the Run Viewer?</h2><p>This stops the logview server process. Video caches and engine results stay on disk; start it again with <kbd>./run.sh</kbd>.</p>
  <p><button id="qYes" style="border-color:#ff4d4f">Stop the server</button> <button onclick="closeModal()">Cancel</button></p>`);
  $("#qYes").onclick = async () => {
    playing = false; try { cam.v.pause(); } catch (e) { }
    try { await fetch("/api/quit", { method: "POST" }); } catch (e) { }
    document.body.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#8b95a3;font:14px -apple-system,Arial">
      <div style="font-size:18px;color:#e6e9ee">Run Viewer stopped</div><div>The server process has exited. You can close this tab.</div>
      <div>To start again: <code>DATASETS/_tools/logview/run.sh</code></div></div>`;
    setTimeout(() => window.close(), 300);
  };
};

// ---------------------------------------------------------------- load a run
async function loadRun(relPath) {
  $("#runName").textContent = "loading " + relPath + " …"; playing = false; $("#btnPlay").textContent = "▶";
  B = await getJSON(`/api/run?rel=${encodeURIComponent(relPath)}`); MAP = []; MAPT = []; B.trackT = B.track.map(p => p[0]);
  if (!location.hash.includes(encodeURIComponent(relPath)) && !location.hash.includes(relPath)) location.hash = "rel=" + encodeURIComponent(relPath);
  $("#runName").textContent = B.run; $("#runChips").innerHTML = `<span class="chip" data-tip="Category">${esc(B.info.category || "")}</span> <span class="chip" data-tip="Mission / preset">${esc(B.info.mission || "")}</span>` + (B.info.cv_tag ? ` <span class="chip cv" data-tip="Tagged good for CV training">CV</span>` : "") + (B.info.note ? ` <span class="chip" data-tip="${esc(B.info.note)}">note</span>` : "");
  // charts
  charts.length = 0; $("#charts").innerHTML = "";
  const S = B.series, meta = B.series_meta;
  for (const [g, title, unit] of GROUPS) {
    let ser = [];
    if (g === "perception") B.cams.forEach((c, i) => c.obs_t.length && ser.push({ key: "obs_" + i, label: "buoys " + c.name.slice(9, 15), t: c.obs_t, v: c.obs_n }));
    else ser = Object.entries(meta).filter(([k, m]) => m[0] === g && S[k]).map(([k, m]) => ({ key: k, label: m[1], unit: m[2], t: S.t, v: S[k] }));
    if (ser.length) charts.push(new Chart(g, title, unit, ser));
  }
  if (!charts.length) $("#charts").innerHTML = `<div class="tile" style="padding:12px" class="muted">No boat telemetry in this run (camera / operator data only).</div>`;
  // camera
  $("#camSel").innerHTML = (B.cams.length > 1 ? `<option value="auto">auto: follow the time (${B.cams.length} recordings)</option>` : "") +
    B.cams.map(c => `<option value="${esc(c.name)}">${esc(c.name)} · ${c.frames.length} fr${c.obs_t.length ? " · " + sgt(c.obs_t[0]).slice(0, 8) + "–" + sgt(c.obs_t[c.obs_t.length - 1]).slice(0, 8) : ""}</option>`).join("");
  cam.auto = B.cams.length > 1; cam.prefetched = false;
  cam.setSession(B.cams[0]?.name);
  T = B.t0; VIEW = [B.t0 - 5, B.t1 + 5];
  setView(VIEW[0], VIEW[1]); MV.follow = true; $("#mapFollow").classList.add("on"); mapFit(); MV.follow = true;
  const firstCam = B.cams.find(c => c.obs_t.length); setTime(firstCam ? firstCam.obs_t[0] : B.t0, { keepView: true });
  for (const k of Object.keys(MAPS)) delete MAPS[k]; LAB.result = null; fillMapSrc();
  if ($("#lab").style.display !== "none") { $("#labRun").textContent = B.run; renderLab(); labRun(); }
  setMapSource((B.map_sources || [])[0] || "none");
  const hp = new URLSearchParams(location.hash.slice(1));          // shareable state: #rel=..&t=<unix>&view=..&src=..&eng=a,b&zoom=<s>
  if (hp.get("view")) { $("#viewSel").value = hp.get("view"); cam.view = hp.get("view"); cam.renderDepth(); }
  if (hp.get("src")) $("#depthSrc").value = hp.get("src");
  if (hp.get("eng")) { hp.get("eng").split(",").forEach(e => cam.enabled.add(e)); renderEngineBar(); }
  if (hp.get("t")) { const t = +hp.get("t"); setTime(t); if (hp.get("zoom")) setView(t - +hp.get("zoom") / 2, t + +hp.get("zoom") / 2); }
}
function shareLink() { const p = new URLSearchParams({ rel: B.rel, t: T.toFixed(2), view: cam.view, src: $("#depthSrc").value, eng: [...cam.enabled].join(",") }); location.hash = p.toString(); navigator.clipboard?.writeText(location.href).catch(() => { }); }
function redrawAll() { if (!B) return; charts.forEach(c => c.draw()); drawTimebar(); drawMap(); if (LAB.result && $("#lab").style.display !== "none") drawSpark(); const ct = `${sgtDate(T)} ${sgt(T)} SGT · ${rel(T)} / ${dur(B.t1 - B.t0)}`; $("#clock").textContent = ct; }

// ---------------------------------------------------------------- playback
function step(dir, e) {
  if (!B) return; let dt = e?.altKey ? 10 : e?.shiftKey ? 1 : 0;
  if (!dt && cam.idx) { const i = cam.frameAt(T); if (i >= 0 && i + dir >= 0 && i + dir < cam.idx.ts.length) { setTime(cam.idx.ts[i + dir] + 1e-4, { keepView: false }); return; } }
  setTime(T + dir * (dt || 0.1));
}
function togglePlay() { if (!B) return; playing = !playing; $("#btnPlay").textContent = playing ? "⏸" : "▶"; lastTick = performance.now(); cam.syncVideo(); if (!playing) cam.requestExtras(); }
$("#btnPlay").onclick = togglePlay; $("#btnBack").onclick = e => step(-1, e); $("#btnFwd").onclick = e => step(1, e);
$("#speed").onchange = e => { speed = +e.target.value; cam.syncVideo(); };
$("#btnResetView").onclick = () => setView(B.t0 - 5, B.t1 + 5);
document.addEventListener("keydown", e => {
  if (e.target.matches("input,select,textarea")) return;
  if (e.key === "Escape") { closeModal(); $$(".expanded").forEach(x => toggleExpand(x)); }
  else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(1, e); } else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1, e); }
  else if (e.key === "+" || e.key === "=") { const s = $("#speed"); s.selectedIndex = Math.min(s.options.length - 1, s.selectedIndex + 1); s.onchange({ target: s }); }
  else if (e.key === "-") { const s = $("#speed"); s.selectedIndex = Math.max(0, s.selectedIndex - 1); s.onchange({ target: s }); }
});
let lastMap = 0;
function tick(now) {
  if (playing && B) {
    const vt = cam.videoTime(); let t;
    if (vt != null && cam.frameAt(T) >= 0) t = vt; else t = T + (now - lastTick) / 1000 * speed;
    if (cam.buf.on && cam.view !== "image" && cam.idx) {        // wait for the depth buffer like a video player waits for data
      const nf = cam.frameAt(t), ready = cam.buf.st?.ready_upto ?? -1;
      if (nf > cam.frame && (nf > ready || !cam.dCache.has(nf))) { if (!cam.dCache.has(nf) && nf <= ready) cam.fetchDepth(nf); t = T; $("#depthNote").textContent = "buffering depth…"; }
    }
    if (t >= B.t1) { t = B.t1; togglePlay(); }
    T = t; if (T > VIEW[1]) { const s = VIEW[1] - VIEW[0]; setView(T - s * 0.1, T + s * 0.9); }
    cam.syncVideo();
    charts.forEach(c => c.draw()); drawTimebar(); if (now - lastMap > 50) { drawMap(); lastMap = now; }
    $("#clock").textContent = `${sgtDate(T)} ${sgt(T)} SGT · ${rel(T)} / ${dur(B.t1 - B.t0)} · ×${speed}`; cam.timeChanged();
  }
  lastTick = now; requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
window.addEventListener("resize", () => { charts.forEach(c => c.dirty = true); redrawAll(); cam.drawOverlay(); });

// a pasted link (#rel=..&t=..) opens that run / moment in an already open tab too
window.addEventListener("hashchange", () => { const h = new URLSearchParams(location.hash.slice(1)), r = h.get("rel"); if (r && RUNS.some(x => x.path === r) && (!B || B.rel !== r || h.get("t"))) { closeModal(); loadRun(r); } });

// ---------------------------------------------------------------- start
(async () => {
  buildLayerToggles(); setupGutters();
  [RUNS, ENG] = await Promise.all([getJSON("/api/runs"), getJSON("/api/engines")]); renderEngineBar();
  const h = new URLSearchParams(location.hash.slice(1)).get("rel");
  if (h && RUNS.some(r => r.path === h)) loadRun(h); else openRuns();
})();
