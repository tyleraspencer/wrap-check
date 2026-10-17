// Wrap composer: turns a design document into a Tesla-ready PNG for whichever car is selected.
//
//   WrapCompose.loadTemplate(carId)         Tesla's template.png for that car (teslamotors/custom-wraps), decoded and cached
//   WrapCompose.compose(doc, carId)         design document -> RGBA at the template's size, cut to the template's panels
//   WrapCompose.exportWrap(doc, carId)      compose + encode + fit under Tesla's 1 MB + a valid file name
//
//   WrapCompose.surfaces(carId)             the car views a design can be drawn on (from calib/<car>.json), with their sizes
//   WrapCompose.guide(carId, view)          a picture of which panels a view paints, at that view's size, to draw over
//
//   WrapCompose.panelMap(carId)             per panel: which view owns it, which way is up / front / ground on the canvas, how to
//                                           rotate upright text, and which panels it meets on the car (all from the calibration)
//   WrapCompose.panelMapImage(carId)        the template with panel outlines, IDs and an arrow to the car's up (or front) on each
//   WrapCompose.studyTexture(carId)         a texture that labels every panel on the car (ID, arrow, sample text, grid)
//   WrapCompose.panelTexture(carId, ids)    white on these panels, black elsewhere (finds them on screen from any camera)
//   WrapCompose.inspect(blob, carId, opt)   an enlarged crop of a wrap with panel outlines, pixels kept sharp
//   WrapCompose.setAsset(id, url, w, h)     an image a design can use as <image href="att:<id>"/>
//
// A design document:
//   { name: 'Sunset_Fade',
//     base:   { color: '#0b2545' } | { svg: '<svg ...>' },              // optional; painted under every layer
//     layers: [ { surface: 'left', svg: '<svg ...>' },                  // drawn on a view of the car: left, right, front, rear, top
//               { surface: 'canvas', svg: '<svg ...>' }, ... ] }        // or in the template's own pixel space
// A view layer is drawn as the car looks from that camera (upright, as seen); every template pixel that view owns is filled from
// the drawing at the spot where that pixel appears on screen, so what is drawn upright reads upright on the car. Each small
// patch of a panel belongs to exactly one view, the one that sees it most face-on, so a bumper's corners can belong to the
// side views and its middle to the front view.
// Anything a design leaves transparent shows the car's paint. Outside the template's panels nothing is ever drawn: the output's
// alpha is the template's alpha (times the art's), so the file always matches the car's layout exactly.
(() => {
  const RAW = 'https://raw.githubusercontent.com/teslamotors/custom-wraps/master';
  const CAP = 1_000_000;          // Tesla: "no larger than 1 MB". Stay under the decimal megabyte so either reading passes.
  const LADDER = [256, 192, 128, 96, 64, 48, 32, 24, 16, 12, 8, 6, 4];   // from tesla-wrap-skill/scripts/fit_size.py

  // ---------- templates ----------
  const templates = {};
  function loadTemplate(carId) {
    return templates[carId] ??= (async () => {
      const url = `${RAW}/${carId}/template.png`;
      const r = await fetch(url);
      if (!r.ok) { delete templates[carId]; throw new Error(`Could not fetch the ${carId} template (${r.status})`); }
      const bytes = await r.arrayBuffer();
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const w = bmp.width, h = bmp.height;
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      const px = x.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h), white = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i++) {
        alpha[i] = px[i * 4 + 3];                                            // alpha survives canvas decoding exactly
        white[i] = alpha[i] > 200 && px[i * 4] > 200 ? 1 : 0;                // opaque white = panel; the darker opaque lines are seams
      }
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      return { carId, url, w, h, alpha, white, sha256 };
    })().catch(e => { delete templates[carId]; throw e; });
  }

  // ---------- panels (tesla-wrap-skill's mask method) ----------
  // Cores are the 4-connected regions with alpha > 127; the faint anti-aliased fringe goes to the nearest core.
  function panels(t) {
    if (t.panels) return t.panels;
    const { w, h, alpha } = t, n = w * h, labels = new Int32Array(n), q = new Int32Array(n), list = [];
    const grow = (pn, p) => { const x = p % w, y = (p - x) / w; pn.pixels++; if (x < pn.bbox[0]) pn.bbox[0] = x; if (y < pn.bbox[1]) pn.bbox[1] = y; if (x >= pn.bbox[2]) pn.bbox[2] = x + 1; if (y >= pn.bbox[3]) pn.bbox[3] = y + 1; };
    const near = (p, f) => { const x = p % w; if (x > 0) f(p - 1); if (x < w - 1) f(p + 1); if (p >= w) f(p - w); if (p < n - w) f(p + w); };
    for (let s = 0; s < n; s++) {
      if (alpha[s] <= 127 || labels[s]) continue;
      const pn = { id: list.length + 1, pixels: 0, bbox: [w, h, 0, 0] }; list.push(pn);
      let head = 0, tail = 0; q[tail++] = s; labels[s] = pn.id;
      while (head < tail) { const p = q[head++]; grow(pn, p); near(p, o => { if (alpha[o] > 127 && !labels[o]) { labels[o] = pn.id; q[tail++] = o; } }); }
    }
    let head = 0, tail = 0;
    for (let p = 0; p < n; p++) if (labels[p]) q[tail++] = p;
    while (head < tail) { const p = q[head++]; near(p, o => { if (alpha[o] && !labels[o]) { labels[o] = labels[p]; grow(list[labels[p] - 1], o); q[tail++] = o; } }); }
    return t.panels = { labels, list };
  }

  // Grid cells over the template, each belonging to one panel (the panel at its centre, else the commonest one in it).
  function cellPanels(t, cell) {
    const key = 'cells' + cell; if (t[key]) return t[key];
    const P = panels(t), gw = Math.ceil(t.w / cell), gh = Math.ceil(t.h / cell), cells = new Int32Array(gw * gh);
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      const mx = Math.min(t.w - 1, cx * cell + (cell >> 1)), my = Math.min(t.h - 1, cy * cell + (cell >> 1));
      let id = P.labels[my * t.w + mx];
      if (!id) {
        const count = new Map();
        for (let y = cy * cell; y < Math.min(t.h, (cy + 1) * cell); y++) for (let x = cx * cell; x < Math.min(t.w, (cx + 1) * cell); x++) { const l = P.labels[y * t.w + x]; if (l) count.set(l, (count.get(l) || 0) + 1); }
        let best = 0; for (const [l, n] of count) if (n > best) { best = n; id = l; }
      }
      cells[cy * gw + cx] = id;
    }
    return t[key] = { gw, gh, cells };
  }

  // ---------- calibration: where each template cell appears from each car view (built by tools/calibrate.mjs) ----------
  const calibrations = {};
  const inflate = async b64 => new Uint8Array(await new Response(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  function loadCalibration(carId) {
    return calibrations[carId] ??= (async () => {
      const [t, r] = await Promise.all([loadTemplate(carId), fetch(`calib/${carId}.json`).catch(() => null)]);
      if (!r || !r.ok) return { error: `No car-view calibration for ${carId} yet; use canvas layers.` };
      const cal = await r.json();
      if (cal.template.sha256 !== t.sha256) return { error: `Tesla has changed the ${carId} template since it was calibrated; use canvas layers until it is recalibrated.` };
      cal.grid = cellPanels(t, cal.cell);
      cal.ownerOf = await inflate(cal.owner);                          // per cell: 1 + index into cal.order, 0 = no view
      cal.weightOf = await inflate(cal.weights);                       // per cell, per view: softened ownership, 0..255
      for (const v of Object.values(cal.views)) {                      // per cell: screen x, y (in quarter pixels), 0xffff = not visible
        const q = new Uint16Array((await inflate(v.xy)).buffer), n = q.length / 2;
        v.X = new Float32Array(n); v.Y = new Float32Array(n);
        for (let c = 0; c < n; c++) { v.X[c] = q[2 * c] === 0xffff ? -1 : q[2 * c] / 4; v.Y[c] = q[2 * c + 1] === 0xffff ? -1 : q[2 * c + 1] / 4; }
      }
      for (const v of Object.values(cal.views)) density(cal, v);
      return cal;
    })();
  }
  // How many screen pixels one template pixel spans in a view, per cell (from the distance to the next cell of the same panel).
  // Decides how finely a car-view drawing is rasterized before it is warped, and how much raster art gets enlarged.
  function density(cal, v) {
    const { gw, gh, cells } = cal.grid, N = gw * gh, S = new Float32Array(N), all = [];
    const step = (c, o) => cells[o] === cells[c] && v.X[o] >= 0 ? Math.hypot(v.X[o] - v.X[c], v.Y[o] - v.Y[c]) : 0;
    for (let c = 0; c < N; c++) {
      if (!cells[c] || v.X[c] < 0) continue;
      const s = Math.max(c % gw < gw - 1 ? step(c, c + 1) : 0, c + gw < N ? step(c, c + gw) : 0);
      if (s) { S[c] = s / cal.cell; all.push(S[c]); }
    }
    all.sort((a, b) => a - b); v.sMed = all[all.length >> 1] || 1;
    for (let c = 0; c < N; c++) if (cells[c] && v.X[c] >= 0 && !S[c]) S[c] = v.sMed;
    v.S = S;
  }

  async function surfaces(carId) {
    const cal = await loadCalibration(carId);
    if (cal.error) return { car: carId, views: {}, note: cal.error };
    const views = {};
    for (const [name, v] of Object.entries(cal.views)) views[name] = { width: v.crop[2] - v.crop[0], height: v.crop[3] - v.crop[1], looking: v.looking };
    return { car: carId, views };
  }

  // Where template pixel (x, y) of panel `id` appears on a view's screen: bilinear between the centres of the neighbouring cells
  // of the same panel that the view can see. Null if none can.
  function locate(cal, v, id, x, y) {
    const { gw, gh, cells } = cal.grid, C = cal.cell, gx = (x + 0.5) / C - 0.5, gy = (y + 0.5) / C - 0.5, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    let sx = 0, sy = 0, sw = 0;
    for (const [ox, oy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const cx = x0 + ox, cy = y0 + oy; if (cx < 0 || cy < 0 || cx >= gw || cy >= gh || w <= 0) continue;
      const c = cy * gw + cx; if (cells[c] !== id || v.X[c] < 0) continue;
      sx += v.X[c] * w; sy += v.Y[c] * w; sw += w;
    }
    if (sw > 1e-6) return [sx / sw, sy / sw];
    const c = Math.min(gh - 1, (y / C) | 0) * gw + Math.min(gw - 1, (x / C) | 0);
    return cells[c] === id && v.X[c] >= 0 ? [v.X[c], v.Y[c]] : null;
  }

  // Which view paints template pixel (x, y) of panel `id`: the one with the highest ownership weight, interpolated between the
  // neighbouring cells of the same panel, so the boundary between two views is a smooth curve. 1-based index into cal.order.
  function ownerAt(cal, id, x, y) {
    const { gw, gh, cells } = cal.grid, C = cal.cell, K = cal.order.length, gx = (x + 0.5) / C - 0.5, gy = (y + 0.5) / C - 0.5, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const acc = new Float32Array(K); let sw = 0;
    for (const [ox, oy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const cx = x0 + ox, cy = y0 + oy; if (cx < 0 || cy < 0 || cx >= gw || cy >= gh || w <= 0) continue;
      const c = cy * gw + cx; if (cells[c] !== id) continue;
      for (let k = 0; k < K; k++) acc[k] += w * cal.weightOf[c * K + k]; sw += w;
    }
    if (!sw) return cal.ownerOf[Math.min(gh - 1, (y / C) | 0) * gw + Math.min(gw - 1, (x / C) | 0)];
    let best = 0, bv = 0; for (let k = 0; k < K; k++) if (acc[k] > bv) { bv = acc[k]; best = k + 1; }
    return best;
  }

  // Warp a drawing made on a car view onto the template: every template pixel that view owns takes the drawing's color at the
  // place it appears on screen (bilinear, alpha-weighted). Most of a view shows the car finer than the template (2–3 screen pixels
  // per template pixel), so there each template pixel averages 2 × 2 samples across its footprint: edges stay crisp without
  // stair-steps. Where a panel is seen at a glancing angle the view is coarser than the template, so that part reads a copy of the
  // drawing rasterized larger, to keep its edges sharp.
  const MAX_LEVEL_PX = 16e6;
  function warpView(cal, t, name, img) {
    const v = cal.views[name], vi = cal.order.indexOf(name) + 1, cw = v.crop[2] - v.crop[0], ch = v.crop[3] - v.crop[1];
    const Ls = [1, 1.5, 2, 3, 4].filter(L => L === 1 || cw * ch * L * L <= MAX_LEVEL_PX), levels = new Map();
    const level = L => {
      if (!levels.has(L)) {
        const w = Math.round(cw * L), h = Math.round(ch * L), c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
        x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, w, h); levels.set(L, { L, w, h, d: x.getImageData(0, 0, w, h).data });
      }
      return levels.get(L);
    };
    const pick = s => Ls.find(L => s * L >= 0.9) || Ls[Ls.length - 1];        // the smallest scale where a drawing pixel is about one template pixel or less
    const out = new ImageData(t.w, t.h), d = out.data, P = panels(t), { gw } = cal.grid, C = cal.cell;
    const TAPS1 = [[0, 0]], TAPS4 = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];
    for (let y = 0; y < t.h; y++) for (let X = 0; X < t.w; X++) {
      const a = y * t.w + X, id = P.labels[a]; if (!id) continue;
      if (ownerAt(cal, id, X, y) !== vi) continue;
      const s = v.S[((y / C) | 0) * gw + ((X / C) | 0)] || v.sMed, lv = level(pick(s)), src = lv.d;
      let r = 0, g = 0, b = 0, al = 0, n = 0;
      for (const [tx, ty] of s >= 1.5 ? TAPS4 : TAPS1) {
        const at = locate(cal, v, id, X + tx, y + ty); if (!at) continue; n++;
        const px = (at[0] - v.crop[0]) * lv.L - 0.5, py = (at[1] - v.crop[1]) * lv.L - 0.5, x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
        for (const [ox, oy, wt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
          const qx = x0 + ox, qy = y0 + oy; if (qx < 0 || qy < 0 || qx >= lv.w || qy >= lv.h || !wt) continue;
          const k = (qy * lv.w + qx) * 4, w2 = wt * src[k + 3];
          r += src[k] * w2; g += src[k + 1] * w2; b += src[k + 2] * w2; al += w2;
        }
      }
      if (al <= 0 || !n) continue;
      const j = a * 4; d[j] = r / al; d[j + 1] = g / al; d[j + 2] = b / al; d[j + 3] = al / n;
    }
    return out;
  }

  // Which panel each pixel of a view shows (id), and whether this view paints it (own), at the view's size. Cached.
  function viewMasks(cal, name) {
    const v = cal.views[name]; if (v.masks) return v.masks;
    const vi = cal.order.indexOf(name) + 1, cw = v.crop[2] - v.crop[0], ch = v.crop[3] - v.crop[1], { gw, gh, cells } = cal.grid;
    const id = new Int32Array(cw * ch), own = new Uint8Array(cw * ch);
    const inTri = (px, py, a, b, c) => { const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (!d) return false; const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d, l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d; return l1 >= 0 && l2 >= 0 && l1 + l2 <= 1; };
    for (const pass of [0, 1]) for (let cy = 0; cy < gh - 1; cy++) for (let cx = 0; cx < gw - 1; cx++) {
      const q = [cy * gw + cx, cy * gw + cx + 1, (cy + 1) * gw + cx + 1, (cy + 1) * gw + cx], pid = cells[q[0]];
      if (!pid || q.some(c => cells[c] !== pid || v.X[c] < 0)) continue;
      if ((cal.ownerOf[q[0]] === vi ? 1 : 0) !== pass) continue;
      const pts = q.map(c => [v.X[c] - v.crop[0], v.Y[c] - v.crop[1]]);
      const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0])))), x1 = Math.min(cw - 1, Math.ceil(Math.max(...pts.map(p => p[0]))));
      const y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1])))), y1 = Math.min(ch - 1, Math.ceil(Math.max(...pts.map(p => p[1]))));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
        if (inTri(x + 0.5, y + 0.5, pts[0], pts[1], pts[2]) || inTri(x + 0.5, y + 0.5, pts[0], pts[2], pts[3])) { id[y * cw + x] = pid; own[y * cw + x] = pass; }
    }
    return v.masks = { cw, ch, id, own };
  }

  // A drawing aid for one view, at that view's size: the car as that camera sees it. Areas this view paints are light grey with
  // dark panel outlines; areas another view paints are paler with grey outlines; white is not on the car. Anything drawn outside
  // the light grey areas is ignored.
  async function guide(carId, name) {
    const cal = await loadCalibration(carId);
    if (cal.error) throw new Error(cal.error);
    if (!cal.views[name]) throw new Error(`No "${name}" view; views: ${Object.keys(cal.views).join(', ')}`);
    const { cw, ch, id: pid, own } = viewMasks(cal, name), id = pid.map((p, i) => p * 2 + own[i]);
    const img = new ImageData(cw, ch), d = img.data;
    for (let p = 0; p < id.length; p++) {
      const k = p * 4, x = p % cw, on = pid[p], edge = on && ((x > 0 && id[p - 1] !== id[p]) || (x < cw - 1 && id[p + 1] !== id[p]) || (p >= cw && id[p - cw] !== id[p]) || (p < id.length - cw && id[p + cw] !== id[p]));
      const [r, g, b] = !on ? [255, 255, 255] : edge ? (own[p] ? [40, 40, 40] : [170, 170, 170]) : own[p] ? [214, 220, 228] : [242, 242, 242];
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
    }
    const c = new OffscreenCanvas(cw, ch); c.getContext('2d').putImageData(img, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  // ---------- the panel map: what tesla-wrap-skill wrote by hand for one car, worked out from the calibration for every car ----------
  // Screen directions (x right, y down) of the car's up, front and left in each calibrated view; null = along the camera axis.
  const VIEW_DIRS = {
    left:  { up: [0, -1], front: [-1, 0], left: null },
    right: { up: [0, -1], front: [1, 0], left: null },
    front: { up: [0, -1], front: null, left: [1, 0] },
    rear:  { up: [0, -1], front: null, left: [-1, 0] },
    top:   { up: null, front: [-1, 0], left: [0, 1] },
  };
  const WORDS = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
  const angleOf = v => Math.atan2(v[1], v[0]) * 180 / Math.PI;                       // canvas degrees: 0 = right, 90 = down (clockwise)
  const toward = v => `canvas ${WORDS[((Math.round(angleOf(v) / 45) % 8) + 8) % 8]} (${Math.round(angleOf(v))}°)`;
  const turn = deg => { const a = Math.round(((deg % 360) + 540) % 360 - 180); return a === 0 ? 'upright as drawn (no rotation)' : a === 180 || a === -180 ? 'rotated 180°' : a > 0 ? `rotated ${a}° clockwise` : `rotated ${-a}° counter-clockwise`; };
  // Least-squares affine map from template (x, y) to screen (X, Y) over a set of cells: [[dX/dx, dX/dy], [dY/dx, dY/dy]].
  function fitJ(pts) {
    let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, n = 0; const bX = [0, 0, 0], bY = [0, 0, 0];
    for (const [x, y, X, Y] of pts) { Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; n++; bX[0] += x * X; bX[1] += y * X; bX[2] += X; bY[0] += x * Y; bY[1] += y * Y; bY[2] += Y; }
    const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], det3 = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(M); if (Math.abs(D) < 1e-9) return null;
    const solve = b => [0, 1].map(k => det3(M.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)))) / D);
    const [a, b] = solve(bX), [c, d] = solve(bY); return [[a, b], [c, d]];
  }
  const inv = J => { const D = J[0][0] * J[1][1] - J[0][1] * J[1][0]; return Math.abs(D) < 1e-12 ? null : [[J[1][1] / D, -J[0][1] / D], [-J[1][0] / D, J[0][0] / D]]; };
  const apply = (M, v) => { const r = [M[0][0] * v[0] + M[0][1] * v[1], M[1][0] * v[0] + M[1][1] * v[1]], l = Math.hypot(r[0], r[1]) || 1; return [r[0] / l, r[1] / l]; };

  // The car's up (or, seen from above, its front) on the canvas around template point (x, y): a fit over nearby cells of the same
  // panel that the same view paints. Big panels can wrap several faces of the car (the Cybertruck's is most of the truck), so one
  // direction per panel isn't enough there.
  function localDir(cal, t, x, y, R = 40) {
    const { gw, gh, cells } = cal.grid, C = cal.cell, c0 = Math.min(gh - 1, (y / C) | 0) * gw + Math.min(gw - 1, (x / C) | 0), id = cells[c0], o = cal.ownerOf[c0];
    if (!id || !o) return null;
    const name = cal.order[o - 1], v = cal.views[name], r = Math.ceil(R / C), cx0 = c0 % gw, cy0 = (c0 - cx0) / gw, pts = [];
    for (let j = cy0 - r; j <= cy0 + r; j++) for (let i = cx0 - r; i <= cx0 + r; i++) {
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue; const c = j * gw + i;
      if (cells[c] === id && cal.ownerOf[c] === o && v.X[c] >= 0) pts.push([i * C + C / 2, j * C + C / 2, v.X[c], v.Y[c]]);
    }
    const J = pts.length >= 8 && fitJ(pts), Ji = J && inv(J), dirs = VIEW_DIRS[name];
    if (!Ji || !dirs) return null;
    return dirs.up ? { view: name, dir: apply(Ji, dirs.up), label: 'UP' } : { view: name, dir: apply(Ji, dirs.front), label: 'FRONT' };
  }

  const panelMaps = {};
  function panelMap(carId) {
    return panelMaps[carId] ??= (async () => {
      const t = await loadTemplate(carId), P = panels(t), cal = await loadCalibration(carId);
      const out = { car: carId, template: { w: t.w, h: t.h, sha256: t.sha256 }, panels: P.list.map(p => ({ id: p.id, bbox: p.bbox, pixels: p.pixels, areaPct: +(100 * p.pixels / (t.w * t.h)).toFixed(2) })), neighbours: [] };
      if (cal.error) { out.note = cal.error; return out; }
      const { gw, cells } = cal.grid, C = cal.cell, N = cells.length, order = cal.order;
      const byId = new Map(out.panels.map(p => [p.id, p]));
      for (const p of out.panels) { p.cells = []; p.owned = Object.fromEntries(order.map(n => [n, 0])); p.unseen = 0; }
      for (let c = 0; c < N; c++) { const p = byId.get(cells[c]); if (!p) continue; p.cells.push(c); const o = cal.ownerOf[c]; if (o) p.owned[order[o - 1]]++; else p.unseen++; }
      for (const p of out.panels) {
        const n = p.cells.length || 1;
        p.seenBy = Object.fromEntries(Object.entries(p.owned).filter(([, k]) => k).map(([v, k]) => [v, Math.round(100 * k / n)]));
        p.unseenPct = Math.round(100 * p.unseen / n);
        const view = Object.entries(p.owned).sort((a, b) => b[1] - a[1])[0];
        p.view = view && view[1] ? view[0] : null;
        // Orientation as each view that paints a fair share of the panel sees it (a fender is seen from the side and from above).
        const cx = c => (c % gw) * C + C / 2, cy = c => Math.floor(c / gw) * C + C / 2;
        p.views = {};
        for (const name of order) {
          if (!(name === p.view || (p.seenBy[name] || 0) >= 15)) continue;
          const v = cal.views[name], vi = order.indexOf(name) + 1;
          let pts = p.cells.filter(c => cal.ownerOf[c] === vi && v.X[c] >= 0);
          if (pts.length < 6) pts = p.cells.filter(c => v.X[c] >= 0);
          const J = pts.length >= 3 && fitJ(pts.map(c => [cx(c), cy(c), v.X[c], v.Y[c]])), Ji = J && inv(J);
          if (!Ji) continue;
          const dirs = VIEW_DIRS[name] || {}, d = {}, o = { share: p.seenBy[name] || 0, dirs: d };
          for (const k of ['up', 'front', 'left']) if (dirs[k]) d[k] = apply(Ji, dirs[k]);
          const det = J[0][0] * J[1][1] - J[0][1] * J[1][0], skew = Math.abs(det) / (Math.hypot(J[0][0], J[1][0]) * Math.hypot(J[0][1], J[1][1]) || 1);
          if (skew < 0.35) { o.edgeOn = true; o.share = p.seenBy[name] || 0; }   // seen nearly edge-on here: the directions are unreliable
          o.mirrored = det < 0 && !o.edgeOn;
          o.canvas = Object.fromEntries(Object.entries(d).map(([k, vec]) => [k, toward(vec)]));
          if (d.up) {                                      // side, front and rear views: text reads upright as that camera sees it
            o.ground = toward([-d.up[0], -d.up[1]]);
            o.upright = { [`from the ${name === 'left' || name === 'right' ? name + ' side' : name}`]: angleOf(apply(Ji, [1, 0])) };
          } else o.upright = { 'from in front of the car': angleOf(apply(Ji, [0, 1])), 'from behind the car': angleOf(apply(Ji, [0, -1])) };     // seen from above
          if (name === p.view) {                           // where it sits, in the words of its main view
            const X = pts.reduce((s, c) => s + v.X[c], 0) / pts.length, Y = pts.reduce((s, c) => s + v.Y[c], 0) / pts.length;
            const u = (X - v.crop[0]) / (v.crop[2] - v.crop[0]), w = (Y - v.crop[1]) / (v.crop[3] - v.crop[1]), third = (f, a) => a[f < 0.34 ? 0 : f < 0.66 ? 1 : 2];
            const height = third(w, ['upper', 'middle', 'lower']);
            p.where = name === 'left' ? `car's left side, ${third(u, ['front', 'middle', 'rear'])}, ${height}`
              : name === 'right' ? `car's right side, ${third(1 - u, ['front', 'middle', 'rear'])}, ${height}`
              : name === 'front' ? `front of the car, ${third(u, ["car's right", 'centre', "car's left"])}, ${height}`
              : name === 'rear' ? `back of the car, ${third(u, ["car's left", 'centre', "car's right"])}, ${height}`
              : `top of the car, ${third(u, ['front', 'middle', 'rear'])}, ${third(w, ["car's right", 'centre', "car's left"])}`;
          }
          p.views[name] = o;
        }
        // Does the car's up (front, from above) turn a lot across the panel? Then one direction per panel would mislead.
        if (p.view) {
          const [bx0, by0, bx1, by1] = p.bbox, ang = []; const step = Math.max(24, Math.max(bx1 - bx0, by1 - by0) / 6);
          for (let yy = by0 + step / 2; yy < by1; yy += step) for (let xx = bx0 + step / 2; xx < bx1; xx += step) { if (P.labels[(yy | 0) * t.w + (xx | 0)] !== p.id) continue; const l = localDir(cal, t, xx, yy); if (l && l.view === p.view) ang.push(angleOf(l.dir)); }
          if (ang.length >= 3) { const m0 = ang[0], d = ang.map(a => Math.abs(((a - m0) % 360 + 540) % 360 - 180)); p.varies = Math.max(...d) > 40; }
          if (['left', 'right', 'front', 'rear'].filter(n => (p.seenBy[n] || 0) >= 20).length >= 2) p.varies = true;   // faces two sides
        }
        // The arrow and the study texture's sample text follow the main view, except that a panel seen mostly from above but also
        // well from a side (a fender, the spoiler) follows that side, where the car's up is what reads.
        const ok = Object.entries(p.views).filter(([, o]) => !o.edgeOn), side = ok.filter(([, o]) => o.dirs.up).sort((a, b) => b[1].share - a[1].share)[0];
        const pickV = p.view === 'top' && side && side[1].share >= 30 ? side : ok.find(([n]) => n === p.view) || side || ok[0];
        if (pickV) { p.dirs = pickV[1].dirs; p.upright = Object.values(pickV[1].upright)[0]; }
        delete p.cells; delete p.owned; delete p.unseen;
      }
      // Panels that meet on the car: cells of two panels close together on screen in some view (seams show as a few pixels' gap).
      const pairs = new Map();
      for (const name of order) {
        const v = cal.views[name], B = 8, grid = new Map(), key = (i, j) => i * 100000 + j;
        for (let c = 0; c < N; c++) if (cells[c] && v.X[c] >= 0) { const k = key((v.X[c] / B) | 0, (v.Y[c] / B) | 0); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(c); }
        for (let c = 0; c < N; c++) {
          if (!cells[c] || v.X[c] < 0) continue;
          const thr = Math.max(5, C * (v.S[c] || v.sMed) * 1.8), i0 = (v.X[c] / B) | 0, j0 = (v.Y[c] / B) | 0, r = Math.ceil(thr / B);
          for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) for (const o of grid.get(key(i, j)) || []) {
            if (cells[o] <= cells[c] || Math.hypot(v.X[o] - v.X[c], v.Y[o] - v.Y[c]) > thr) continue;
            const pk = cells[c] + ':' + cells[o]; let e = pairs.get(pk);
            if (!e) pairs.set(pk, e = { a: cells[c], b: cells[o], views: {}, ax: 0, ay: 0, bx: 0, by: 0, n: 0 });
            e.views[name] = (e.views[name] || 0) + 1; e.n++;
            e.ax += (c % gw) * C + C / 2; e.ay += Math.floor(c / gw) * C + C / 2; e.bx += (o % gw) * C + C / 2; e.by += Math.floor(o / gw) * C + C / 2;
          }
        }
      }
      for (const e of pairs.values()) {
        if (e.n < 25) continue;                          // a handful of stray cells (reflections, misreads) is not a seam
        out.neighbours.push({ a: e.a, b: e.b, seenIn: Object.keys(e.views).sort((p, q) => e.views[q] - e.views[p]), strength: e.n,
          aNear: [Math.round(e.ax / e.n), Math.round(e.ay / e.n)], bNear: [Math.round(e.bx / e.n), Math.round(e.by / e.n)] });
      }
      out.neighbours.sort((p, q) => p.a - q.a || q.strength - p.strength);
      return out;
    })().catch(e => { delete panelMaps[carId]; throw e; });
  }

  // The panel map as text, for a model to read.
  function panelMapText(m) {
    const L = [`Template ${m.template.w} × ${m.template.h}. ${m.panels.length} panels. Canvas directions: up = toward y 0, right = toward larger x; angles clockwise from canvas right.`];
    if (m.note) L.push('Note: ' + m.note);
    for (const p of m.panels) {
      const s = [`P${p.id}: bbox x ${p.bbox[0]}–${p.bbox[2]}, y ${p.bbox[1]}–${p.bbox[3]}; ${p.areaPct}% of the template`];
      if (p.where) s.push(p.where + ' (guessed from the ' + p.view + ' view)');
      if (p.varies) s.push('ORIENTATION VARIES across this panel (it wraps several faces of the car): use the local arrows on the panel map image, or car-view layers, not one rotation for the whole panel');
      if (p.seenBy) s.push('painted by view: ' + (Object.entries(p.seenBy).map(([v, k]) => `${v} ${k}%`).join(', ') || 'none') + (p.unseenPct ? `; no camera sees ${p.unseenPct}% (base color only there)` : ''));
      for (const [name, o] of Object.entries(p.views || {})) {
        const dir = Object.entries(o.canvas).map(([k, v]) => `car ${k === 'up' ? 'up (sky)' : k === 'front' ? 'front' : 'left side'} → ${v}`).join(', ');
        if (o.edgeOn) { s.push(`the ${name} view sees it nearly edge-on (directions there unreliable)`); continue; }
        s.push(`in the ${name} view: ${dir}` + (o.ground ? `; ground-facing edge toward ${o.ground.replace(/^canvas /, 'canvas ')}` : '') + '; canvas text reads upright ' + Object.entries(o.upright).map(([k, a]) => `${k} when ${turn(a)}`).join(', or ') + (o.mirrored ? '; WARNING: looks mirrored on the car here, so canvas text may read backwards; check a close-up first' : ''));
      }
      L.push(s.join('. ') + '.');
    }
    if (m.neighbours.length) {
      L.push('Panels that probably meet on the car (next to each other on screen; their edges near these canvas points). Confirm with study_car before relying on one:');
      for (const e of m.neighbours) L.push(`P${e.a} (${e.aNear}) ↔ P${e.b} (${e.bNear}), seen in ${e.seenIn.join(', ')}` + (e.seenIn.length < 2 ? ' (one view only: may just overlap on screen; check on the car)' : ''));
    }
    return L.join('\n');
  }

  // A label point well inside each panel (the cell farthest from the panel's edge) and how far that is, in template pixels.
  function labelPoints(t) {
    if (t.labelPts) return t.labelPts;
    const C = 4, { gw, gh, cells } = cellPanels(t, C), dist = new Int32Array(cells.length).fill(-1), q = [];
    for (let c = 0; c < cells.length; c++) { const x = c % gw, y = (c - x) / gw; if (!cells[c] || x === 0 || y === 0 || x === gw - 1 || y === gh - 1 || cells[c - 1] !== cells[c] || cells[c + 1] !== cells[c] || cells[c - gw] !== cells[c] || cells[c + gw] !== cells[c]) { if (cells[c]) { dist[c] = 0; q.push(c); } } }
    for (let h = 0; h < q.length; h++) { const c = q[h], x = c % gw; for (const o of [x > 0 ? c - 1 : -1, x < gw - 1 ? c + 1 : -1, c - gw, c + gw]) if (o >= 0 && o < cells.length && cells[o] === cells[c] && dist[o] < 0) { dist[o] = dist[c] + 1; q.push(o); } }
    const best = new Map();
    for (let c = 0; c < cells.length; c++) if (cells[c] && (!best.has(cells[c]) || dist[c] > best.get(cells[c]).d)) best.set(cells[c], { d: dist[c], x: (c % gw) * C + C / 2, y: Math.floor(c / gw) * C + C / 2 });
    return t.labelPts = new Map([...best].map(([id, b]) => [id, { x: b.x, y: b.y, r: (b.d + 0.5) * C }]));
  }

  const VIEW_TINT = { left: [96, 150, 235], right: [80, 190, 120], front: [240, 150, 60], rear: [170, 110, 220], top: [150, 150, 160] };
  function drawArrow(x, cx, cy, d, len, label, color) {
    const ex = cx + d[0] * len, ey = cy + d[1] * len, a = Math.atan2(d[1], d[0]), hs = Math.max(5, len * 0.28);
    x.save(); x.strokeStyle = color; x.fillStyle = color; x.lineWidth = Math.max(2, len * 0.08); x.lineCap = 'round';
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(ex - d[0] * hs * 0.6, ey - d[1] * hs * 0.6); x.stroke();
    x.beginPath(); x.moveTo(ex, ey); x.lineTo(ex - hs * Math.cos(a - 0.5), ey - hs * Math.sin(a - 0.5)); x.lineTo(ex - hs * Math.cos(a + 0.5), ey - hs * Math.sin(a + 0.5)); x.closePath(); x.fill();
    if (label) { const f = Math.max(8, len * 0.3); x.font = `700 ${f}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = f * 0.25; x.strokeStyle = '#fff'; const lx = ex + d[0] * f * 1.2, ly = ey + d[1] * f * 1.2; x.strokeText(label, lx, ly); x.fillText(label, lx, ly); }
    x.restore();
  }

  // The template, tinted by the view that paints each part (left blue, right green, front orange, rear purple, top grey; red hatching:
  // no camera sees it), with dark panel outlines, each panel's ID, a big arrow to the car's up (FRONT on panels seen from above),
  // and small arrows every 96 px for the local direction (red: up, blue: front, as seen from above).
  async function panelMapImage(carId) {
    const t = await loadTemplate(carId), m = await panelMap(carId), P = panels(t), cal = await loadCalibration(carId), { w, h } = t;
    const img = new ImageData(w, h), d = img.data, C = cal.cell || 4;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, id = P.labels[i], k = i * 4; if (!id) { d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = 255; continue; }
      const edge = (x > 0 && P.labels[i - 1] !== id) || (x < w - 1 && P.labels[i + 1] !== id) || (y > 0 && P.labels[i - w] !== id) || (y < h - 1 && P.labels[i + w] !== id);
      const o = cal.error ? 0 : cal.ownerOf[((y / C) | 0) * cal.grid.gw + ((x / C) | 0)], tint = o ? VIEW_TINT[cal.order[o - 1]] : ((x + y) >> 2) & 1 ? [235, 80, 80] : [250, 210, 210];
      const c = edge ? [20, 20, 24] : tint.map(v => Math.round(v * 0.55 + 255 * 0.45));
      d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
    }
    const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d'); x.putImageData(img, 0, 0);
    if (!cal.error) for (let yy = 48; yy < h; yy += 96) for (let xx = 48; xx < w; xx += 96) {      // small arrows: the local direction
      const l = localDir(cal, t, xx, yy); if (l) drawArrow(x, xx - l.dir[0] * 9, yy - l.dir[1] * 9, l.dir, 18, '', l.label === 'UP' ? 'rgba(150,20,20,.7)' : 'rgba(20,20,150,.7)');
    }
    const pts = labelPoints(t);
    for (const p of m.panels) {
      const lp = pts.get(p.id); if (!lp) continue;
      const f = Math.max(10, Math.min(30, lp.r * 0.9));
      x.font = `800 ${f}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = f * 0.22; x.strokeStyle = '#fff'; x.fillStyle = '#000';
      x.strokeText(String(p.id), lp.x, lp.y); x.fillText(String(p.id), lp.x, lp.y);
      const dir = p.dirs && (p.dirs.up || p.dirs.front);
      if (dir) drawArrow(x, lp.x + dir[0] * f * 0.7, lp.y + dir[1] * f * 0.7, dir, Math.max(12, Math.min(40, lp.r * 1.1)), p.dirs.up ? 'UP' : 'FRONT', '#c01818');
    }
    return cv.convertToBlob({ type: 'image/png' });
  }

  // A texture that labels the car, for looking at on the 3D model: each panel a distinct color, its ID, an arrow to the car's up
  // (or front), "ABC 123" written the way the panel map says reads upright, and a grid every 64 template pixels (heavier every 256).
  async function studyTexture(carId) {
    const t = await loadTemplate(carId), m = await panelMap(carId), P = panels(t), { w, h } = t, pts = labelPoints(t);
    const cv = new OffscreenCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true });
    const hue = id => (id * 137.508) % 360;
    const base = x.createImageData(w, h), d = base.data;
    const rgb = m.panels.reduce((o, p) => { const c = new OffscreenCanvas(1, 1), cx = c.getContext('2d'); cx.fillStyle = `hsl(${hue(p.id)} 70% 64%)`; cx.fillRect(0, 0, 1, 1); o[p.id] = cx.getImageData(0, 0, 1, 1).data; return o; }, {});
    for (let i = 0; i < P.labels.length; i++) { const id = P.labels[i], k = i * 4; if (!id) continue; const c = rgb[id]; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255; }
    x.putImageData(base, 0, 0);
    x.save(); x.strokeStyle = 'rgba(0,0,0,.35)';
    for (let g = 64; g < Math.max(w, h); g += 64) { x.lineWidth = g % 256 ? 1 : 3; x.beginPath(); x.moveTo(g, 0); x.lineTo(g, h); x.moveTo(0, g); x.lineTo(w, g); x.stroke(); }
    x.restore();
    for (const p of m.panels) {
      const lp = pts.get(p.id); if (!lp) continue;
      const deg = p.upright || 0, f = Math.max(6, lp.r * 0.36), rad = deg * Math.PI / 180;
      x.save(); x.translate(lp.x, lp.y); x.rotate(rad); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#111';
      x.font = `800 ${f * 1.25}px sans-serif`; x.fillText('P' + p.id, 0, -f * 0.75); x.font = `700 ${f}px sans-serif`; x.fillText('ABC 123', 0, f * 0.6); x.restore();
      const dir = p.dirs && (p.dirs.up || p.dirs.front), len = Math.max(8, lp.r * 0.45);      // arrow to the left of the text
      if (dir) drawArrow(x, lp.x - Math.cos(rad) * lp.r * 1.0 - dir[0] * len / 2, lp.y - Math.sin(rad) * lp.r * 1.0 - dir[1] * len / 2, dir, len, p.dirs.up ? 'UP' : 'FRONT', '#b00000');
    }
    const out = x.getImageData(0, 0, w, h), o = out.data;              // keep everything inside its own panel
    for (let i = 0; i < P.labels.length; i++) if (!P.labels[i]) o[i * 4 + 3] = 0;
    x.putImageData(out, 0, 0);
    return cv;
  }

  // White on the given panels and black everywhere else, at the template's size: shown on the car from any camera, the difference
  // from an all-black texture is exactly where those panels are on screen.
  async function panelTexture(carId, ids) {
    const t = await loadTemplate(carId), P = panels(t), on = new Set(ids), cv = new OffscreenCanvas(t.w, t.h), x = cv.getContext('2d'), img = x.createImageData(t.w, t.h), d = img.data;
    for (let i = 0; i < P.labels.length; i++) { const v = on.has(P.labels[i]) ? 255 : 0, k = i * 4; d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255; }
    x.putImageData(img, 0, 0); return cv;
  }

  // An enlarged crop of a wrap (a PNG blob or canvas at the template's size) with thin panel outlines and IDs, drawn pixel for
  // pixel (no smoothing) so softness in the file shows as it is. opt: { panels: [ids] } or { box: [x0, y0, x1, y1] }, zoom.
  async function inspect(src, carId, opt = {}) {
    const t = await loadTemplate(carId), P = panels(t), { w, h } = t;
    let box = opt.box;
    if (!box && opt.panels && opt.panels.length) { box = [w, h, 0, 0]; for (const id of opt.panels) { const p = P.list[id - 1]; if (!p) throw new Error(`No panel ${id}`); box = [Math.min(box[0], p.bbox[0]), Math.min(box[1], p.bbox[1]), Math.max(box[2], p.bbox[2]), Math.max(box[3], p.bbox[3])]; } }
    box = box || [0, 0, w, h]; const pad = 8;
    let [x0, y0, x1, y1] = [Math.max(0, Math.floor(box[0]) - pad), Math.max(0, Math.floor(box[1]) - pad), Math.min(w, Math.ceil(box[2]) + pad), Math.min(h, Math.ceil(box[3]) + pad)];
    const bw = x1 - x0, bh = y1 - y0; if (bw < 2 || bh < 2) throw new Error('That area is empty');
    const zoom = Math.max(1, Math.min(opt.zoom || 4, Math.floor(1600 / Math.max(bw, bh)) || 1));
    const bmp = src instanceof Blob ? await createImageBitmap(src) : src;
    const cv = new OffscreenCanvas(bw * zoom, bh * zoom), x = cv.getContext('2d');
    x.fillStyle = '#808080'; x.fillRect(0, 0, cv.width, cv.height);
    for (let yy = 0; yy < bh; yy += 8) for (let xx = 0; xx < bw; xx += 8) if (((xx + yy) >> 3) & 1) { x.fillStyle = '#9a9a9a'; x.fillRect(xx * zoom, yy * zoom, 8 * zoom, 8 * zoom); }      // checker shows transparency
    x.imageSmoothingEnabled = false; x.drawImage(bmp, x0, y0, bw, bh, 0, 0, bw * zoom, bh * zoom);
    x.fillStyle = 'rgba(0,229,255,.9)';
    for (let y = y0; y < y1; y++) for (let X = x0; X < x1; X++) { const i = y * w + X, id = P.labels[i]; if ((X > 0 && P.labels[i - 1] !== id) || (y > 0 && P.labels[i - w] !== id)) x.fillRect((X - x0) * zoom, (y - y0) * zoom, Math.max(1, zoom >> 2), Math.max(1, zoom >> 2)); }
    const pts = labelPoints(t); x.font = '700 14px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const [id, lp] of pts) if (lp.x >= x0 && lp.x < x1 && lp.y >= y0 && lp.y < y1) { x.lineWidth = 4; x.strokeStyle = '#000'; x.fillStyle = '#00e5ff'; x.strokeText('P' + id, (lp.x - x0) * zoom, (lp.y - y0) * zoom); x.fillText('P' + id, (lp.x - x0) * zoom, (lp.y - y0) * zoom); }
    return { blob: await cv.convertToBlob({ type: 'image/png' }), box: [x0, y0, x1, y1], zoom };
  }

  // ---------- design document -> RGBA ----------
  // Images a design may draw: attachments the user gave (logos, photos), used in a layer's SVG as <image href="att:<id>"/>.
  // SVG drawn as an image can't load anything external, so they are swapped for their data URLs before drawing.
  const assets = new Map();
  const setAsset = (id, url, w, h) => assets.set(String(id), { url, w, h });
  const withAssets = s => s.replace(/((?:xlink:)?href\s*=\s*["'])att:([\w-]+)(["'])/g, (m, a, id, b) => { const x = assets.get(id); if (!x) throw new Error(`No attachment att:${id}`); return a + x.url + b; });
  async function rasterSvg(svg) {
    let s = String(svg).trim();
    if (!/^<svg[\s>]/i.test(s)) throw new Error('A layer\'s svg must start with <svg');
    if (!/xmlns=/.test(s.slice(0, s.indexOf('>')))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    if (/xlink:href/.test(s) && !/xmlns:xlink=/.test(s.slice(0, s.indexOf('>')))) s = s.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    s = withAssets(s);
    const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('That SVG could not be drawn (check that it is valid XML)')); img.src = url; });
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }

  // Raster images in a layer that will be enlarged on the template (and so look soft). Ignores transforms, so it is a guide.
  async function imageScales(svg, unitsToTemplate) {
    const out = [];
    for (const m of String(svg).matchAll(/<image\b[^>]*>/gi)) {
      const tag = m[0], at = k => { const r = tag.match(new RegExp(`\\s${k}\\s*=\\s*["']([^"']*)["']`)); return r && r[1]; };
      const href = at('href') || at('xlink:href') || '', w = parseFloat(at('width')), h = parseFloat(at('height'));
      if (!(w > 0 && h > 0)) continue;
      let nw, nh, a = href.match(/^att:([\w-]+)$/);
      if (a && assets.get(a[1])) ({ w: nw, h: nh } = assets.get(a[1]));
      else if (/^data:image\//.test(href)) { try { const b = await createImageBitmap(await (await fetch(href)).blob()); nw = b.width; nh = b.height; } catch { continue; } }
      else continue;
      const k = Math.max(w * unitsToTemplate / nw, h * unitsToTemplate / nh);
      out.push({ href: a ? href : 'embedded image', natural: [nw, nh], scale: +k.toFixed(2) });
    }
    return out;
  }
  const viewBoxOf = svg => { const head = String(svg).slice(0, String(svg).indexOf('>')), vb = head.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/), w = head.match(/\swidth\s*=\s*["']([\d.]+)/), h = head.match(/\sheight\s*=\s*["']([\d.]+)/); return vb ? [+vb[1], +vb[2]] : w && h ? [+w[1], +h[1]] : null; };

  // opts.stats: also report, per layer, art drawn where its view does not paint (another view owns it, or it is off the car)
  // and raster images that get enlarged.
  async function compose(doc, carId, opts = {}) {
    const t = await loadTemplate(carId);
    const { w, h } = t, stats = [];
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
    const draw = async svg => x.drawImage(await rasterSvg(svg), 0, 0, w, h);    // every layer spans the whole template
    if (doc.base) {
      if (doc.base.color) { x.fillStyle = doc.base.color; x.fillRect(0, 0, w, h); }
      else if (doc.base.svg) await draw(doc.base.svg);
      else throw new Error('base needs color or svg');
    }
    for (const [i, l] of (doc.layers || []).entries()) {
      if (!l.svg) throw new Error(`layer ${i}: missing svg`);
      const surface = l.surface || 'canvas', vb = viewBoxOf(l.svg);
      if (surface === 'canvas') {
        await draw(l.svg);
        if (opts.stats) stats.push({ layer: i, surface, images: await imageScales(l.svg, vb ? w / vb[0] : 1) });
        continue;
      }
      const cal = await loadCalibration(carId);
      if (cal.error) throw new Error(`layer ${i}: ${cal.error}`);
      if (!cal.views[surface]) throw new Error(`layer ${i}: no "${surface}" view for this car; use one of ${Object.keys(cal.views).join(', ')} or canvas`);
      const img = await rasterSvg(l.svg), warped = warpView(cal, t, surface, img);
      const tmp = new OffscreenCanvas(w, h); tmp.getContext('2d').putImageData(warped, 0, 0);
      x.drawImage(tmp, 0, 0);
      if (opts.stats) {
        const m = viewMasks(cal, surface), v = cal.views[surface], r = new OffscreenCanvas(m.cw, m.ch), rx = r.getContext('2d', { willReadFrequently: true });
        rx.drawImage(img, 0, 0, m.cw, m.ch); const a = rx.getImageData(0, 0, m.cw, m.ch).data;
        let drawn = 0, mine = 0, other = 0, off = 0;
        for (let p = 0; p < m.id.length; p++) { if (a[p * 4 + 3] < 24) continue; drawn++; if (!m.id[p]) off++; else if (m.own[p]) mine++; else other++; }
        const pct = n => drawn ? +(100 * n / drawn).toFixed(1) : 0;
        stats.push({ layer: i, surface, drawnPx: drawn, paintedPct: pct(mine), otherViewPct: pct(other), offCarPct: pct(off),
          images: await imageScales(l.svg, (vb ? m.cw / vb[0] : 1) / v.sMed) });
      }
    }
    const art = x.getImageData(0, 0, w, h).data;
    // Cut to the template. Alpha = template alpha × art alpha, so a fully painted panel keeps the template's alpha byte for byte
    // (including its anti-aliased edges) and gaps stay fully transparent. Transparent pixels are stored as 0,0,0,0.
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < t.alpha.length; i++, j += 4) {
      const a = t.alpha[i] === 255 ? art[j + 3] : Math.round(t.alpha[i] * art[j + 3] / 255);
      if (!a) continue;
      out[j] = art[j]; out[j + 1] = art[j + 1]; out[j + 2] = art[j + 2]; out[j + 3] = a;
    }
    return { w, h, rgba: out, template: t, stats };
  }

  // ---------- PNG encoder (exact bytes: a canvas would premultiply and round them) ----------
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf, c = 0xffffffff) => { for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return c; };
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
    return out;
  }
  function filterRows(rgba, w, h) {           // per-row adaptive filter (minimum sum of absolute differences), as libpng does
    const stride = w * 4, out = new Uint8Array(h * (stride + 1)), cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
    const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    for (let y = 0; y < h; y++) {
      const row = y * stride, prev = row - stride;
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const o = cand[f]; let sum = 0;
        for (let i = 0; i < stride; i++) {
          const v = rgba[row + i], a = i >= 4 ? rgba[row + i - 4] : 0, b = y ? rgba[prev + i] : 0, c = y && i >= 4 ? rgba[prev + i - 4] : 0;
          const r = (f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)) & 255;
          o[i] = r; sum += r < 128 ? r : 256 - r;
          if (sum >= bestSum) break;
        }
        if (sum < bestSum) { bestSum = sum; best = f; }
      }
      out[y * (stride + 1)] = best;
      out.set(cand[best], y * (stride + 1) + 1);        // the winner never broke out early, so its row is complete
    }
    return out;
  }
  async function encodePng(rgba, w, h) {
    const zlib = new Uint8Array(await new Response(new Blob([filterRows(rgba, w, h)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);      // 8-bit RGBA, no interlace
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))];
    return new Blob(parts, { type: 'image/png' });
  }

  // ---------- fit under the cap (port of fit_size.py) ----------
  // Reduce the colors of the visible pixels step by step; the most frequent exact colors (flat and brand colors) stay exact,
  // there is no dithering, and alpha and gaps are untouched. Median cut runs on a 5-bit-per-channel histogram so it stays fast.
  function reduceColors(rgba, colors) {
    const bins = new Map(), exact = new Map();              // 15-bit bin -> [count, sumR, sumG, sumB]; exact color -> count
    for (let j = 0; j < rgba.length; j += 4) {
      if (!rgba[j + 3]) continue;
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2], key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3), e = r << 16 | g << 8 | b;
      const s = bins.get(key); if (s) { s[0]++; s[1] += r; s[2] += g; s[3] += b; } else bins.set(key, [1, r, g, b]);
      exact.set(e, (exact.get(e) || 0) + 1);
    }
    // median cut over the bins, weighted by pixel count
    const items = [...bins.values()].map(([n, r, g, b]) => [r / n, g / n, b / n, n]);
    let boxes = [items];
    while (boxes.length < colors) {
      let bi = -1, bestScore = 0, axis = 0;
      boxes.forEach((box, i) => {
        if (box.length < 2) return;
        const lo = [255, 255, 255], hi = [0, 0, 0]; let n = 0;
        for (const it of box) { for (let k = 0; k < 3; k++) { if (it[k] < lo[k]) lo[k] = it[k]; if (it[k] > hi[k]) hi[k] = it[k]; } n += it[3]; }
        const ranges = hi.map((v, k) => v - lo[k]), ax = ranges.indexOf(Math.max(...ranges)), score = ranges[ax] * Math.sqrt(n);
        if (score > bestScore) { bestScore = score; bi = i; axis = ax; }
      });
      if (bi < 0) break;
      const box = boxes[bi].sort((p, q) => p[axis] - q[axis]);
      const total = box.reduce((s, it) => s + it[3], 0);
      let acc = 0, cut = 1;
      for (; cut < box.length - 1; cut++) { acc += box[cut - 1][3]; if (acc >= total / 2) break; }
      boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
    }
    const palette = boxes.map(box => { let n = 0, r = 0, g = 0, b = 0; for (const it of box) { n += it[3]; r += it[0] * it[3]; g += it[1] * it[3]; b += it[2] * it[3]; } return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]; });
    // keep the most frequent exact colors exact: each claims its nearest unclaimed palette entry
    const d2 = (p, r, g, b) => (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
    const claimed = new Set(), keep = [...exact.entries()].sort((p, q) => q[1] - p[1]).slice(0, Math.max(1, colors >> 2));
    for (const [e] of keep) {
      const r = e >> 16, g = e >> 8 & 255, b = e & 255;
      let bi = -1, bd = Infinity;
      palette.forEach((p, i) => { if (!claimed.has(i)) { const d = d2(p, r, g, b); if (d < bd) { bd = d; bi = i; } } });
      if (bi >= 0) { palette[bi] = [r, g, b]; claimed.add(bi); }
    }
    // map every visible pixel to its nearest palette color (exact palette colors map to themselves)
    const exactIdx = new Map(palette.map((p, i) => [p[0] << 16 | p[1] << 8 | p[2], i])), nearest = new Map();
    const out = new Uint8ClampedArray(rgba);
    for (let j = 0; j < out.length; j += 4) {
      if (!out[j + 3]) continue;
      const r = out[j], g = out[j + 1], b = out[j + 2], e = r << 16 | g << 8 | b;
      let i = exactIdx.get(e) ?? nearest.get(e);
      if (i === undefined) { let bd = Infinity; palette.forEach((p, k) => { const d = d2(p, r, g, b); if (d < bd) { bd = d; i = k; } }); nearest.set(e, i); }
      const p = palette[i]; out[j] = p[0]; out[j + 1] = p[1]; out[j + 2] = p[2];
    }
    return out;
  }

  async function fitToCap(rgba, w, h, cap = CAP) {
    let blob = await encodePng(rgba, w, h);
    const info = { initialBytes: blob.size, reduced: false, colors: null, steps: [] };
    if (blob.size >= cap) {
      info.reduced = true;
      for (const colors of LADDER) {
        blob = await encodePng(reduceColors(rgba, colors), w, h);
        info.steps.push([colors, blob.size]);
        if (blob.size < cap) { info.colors = colors; break; }
      }
      if (blob.size >= cap) throw new Error(`Could not get under ${cap} bytes even at ${LADDER.at(-1)} colors`);
    }
    info.bytes = blob.size;
    return { blob, info };
  }

  // ---------- file name (Tesla: letters, digits, _, -, space; 30 characters max) ----------
  function fileName(name) {
    // accents dropped; anything else not allowed becomes a word break; words joined with underscores (as the skill prefers)
    const words = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\.png$/i, '')
      .split(/[^A-Za-z0-9-]+/).filter(Boolean);
    let s = '';
    for (const word of words) { const next = s ? `${s}_${word}` : word; if (next.length > 30) break; s = next; }   // shorten at a word boundary
    if (!s && words.length) s = words[0].slice(0, 30);
    return (s || 'Custom_Wrap') + '.png';
  }

  async function exportWrap(doc, carId, opts = {}) {
    const { w, h, rgba, template, stats } = await compose(doc, carId, opts);
    const { blob, info } = await fitToCap(rgba, w, h);
    const r = { blob, name: fileName(doc.name), w, h, ...info, template: { url: template.url, sha256: template.sha256 } };
    if (opts.stats) {                                // how much of each panel the design paints (the rest shows the car's paint)
      const P = panels(template), all = new Uint32Array(P.list.length + 1), got = new Uint32Array(P.list.length + 1);
      for (let i = 0; i < P.labels.length; i++) { const id = P.labels[i]; if (!id || template.alpha[i] < 128) continue; all[id]++; if (rgba[i * 4 + 3] > 127) got[id]++; }
      r.layers = stats; r.coverage = P.list.map(p => ({ id: p.id, pct: all[p.id] ? Math.round(100 * got[p.id] / all[p.id]) : 0 }));
    }
    return r;
  }

  window.WrapCompose = { CAP, loadTemplate, panels, cellPanels, loadCalibration, surfaces, guide, viewMasks, compose, encodePng, fitToCap, fileName, exportWrap,
    panelMap, panelMapText, panelMapImage, studyTexture, panelTexture, inspect, setAsset, assets };
})();
