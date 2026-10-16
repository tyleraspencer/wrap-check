// Wrap composer: turns a design document into a Tesla-ready PNG for whichever car is selected.
//
//   WrapCompose.loadTemplate(carId)         Tesla's template.png for that car (teslamotors/custom-wraps), decoded and cached
//   WrapCompose.compose(doc, carId)         design document -> RGBA at the template's size, cut to the template's panels
//   WrapCompose.exportWrap(doc, carId)      compose + encode + fit under Tesla's 1 MB + a valid file name
//
//   WrapCompose.surfaces(carId)             the car views a design can be drawn on (from calib/<car>.json), with their sizes
//   WrapCompose.guide(carId, view)          a picture of which panels a view paints, at that view's size, to draw over
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
      cal.ownerOf = await inflate(cal.owner);                          // per cell: 1 + index into cal.order, 0 = no view
      cal.weightOf = await inflate(cal.weights);                       // per cell, per view: softened ownership, 0..255
      for (const v of Object.values(cal.views)) {                      // per cell: screen x, y (in quarter pixels), 0xffff = not visible
        const q = new Uint16Array((await inflate(v.xy)).buffer), n = q.length / 2;
        v.X = new Float32Array(n); v.Y = new Float32Array(n);
        for (let c = 0; c < n; c++) { v.X[c] = q[2 * c] === 0xffff ? -1 : q[2 * c] / 4; v.Y[c] = q[2 * c + 1] === 0xffff ? -1 : q[2 * c + 1] / 4; }
      }
      cal.grid = cellPanels(t, cal.cell);
      return cal;
    })();
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
  // place it appears on screen (bilinear, alpha-weighted).
  function warpView(cal, t, name, img) {
    const v = cal.views[name], vi = cal.order.indexOf(name) + 1, cw = v.crop[2] - v.crop[0], ch = v.crop[3] - v.crop[1];
    const c = new OffscreenCanvas(cw, ch), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, cw, ch);
    const src = x.getImageData(0, 0, cw, ch).data, out = new ImageData(t.w, t.h), d = out.data, P = panels(t);
    for (let y = 0; y < t.h; y++) for (let X = 0; X < t.w; X++) {
      const a = y * t.w + X, id = P.labels[a]; if (!id) continue;
      if (ownerAt(cal, id, X, y) !== vi) continue;
      const at = locate(cal, v, id, X, y); if (!at) continue;
      const px = at[0] - v.crop[0] - 0.5, py = at[1] - v.crop[1] - 0.5, x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      let r = 0, g = 0, b = 0, al = 0;
      for (const [ox, oy, wt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
        const qx = x0 + ox, qy = y0 + oy; if (qx < 0 || qy < 0 || qx >= cw || qy >= ch || !wt) continue;
        const k = (qy * cw + qx) * 4, w2 = wt * src[k + 3];
        r += src[k] * w2; g += src[k + 1] * w2; b += src[k + 2] * w2; al += w2;
      }
      if (al <= 0) continue;
      const j = a * 4; d[j] = r / al; d[j + 1] = g / al; d[j + 2] = b / al; d[j + 3] = al;
    }
    return out;
  }

  // A drawing aid for one view, at that view's size: the car as that camera sees it. Areas this view paints are light grey with
  // dark panel outlines; areas another view paints are paler with grey outlines; white is not on the car. Anything drawn outside
  // the light grey areas is ignored.
  async function guide(carId, name) {
    const cal = await loadCalibration(carId);
    if (cal.error) throw new Error(cal.error);
    const v = cal.views[name]; if (!v) throw new Error(`No "${name}" view; views: ${Object.keys(cal.views).join(', ')}`);
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
        if (inTri(x + 0.5, y + 0.5, pts[0], pts[1], pts[2]) || inTri(x + 0.5, y + 0.5, pts[0], pts[2], pts[3])) { id[y * cw + x] = pid * 2 + pass; own[y * cw + x] = pass; }
    }
    const img = new ImageData(cw, ch), d = img.data;
    for (let p = 0; p < id.length; p++) {
      const k = p * 4, x = p % cw, edge = id[p] && ((x > 0 && id[p - 1] !== id[p]) || (x < cw - 1 && id[p + 1] !== id[p]) || (p >= cw && id[p - cw] !== id[p]) || (p < id.length - cw && id[p + cw] !== id[p]));
      const [r, g, b] = !id[p] ? [255, 255, 255] : edge ? (own[p] ? [40, 40, 40] : [170, 170, 170]) : own[p] ? [214, 220, 228] : [242, 242, 242];
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
    }
    const c = new OffscreenCanvas(cw, ch); c.getContext('2d').putImageData(img, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  // ---------- design document -> RGBA ----------
  async function rasterSvg(svg, w, h) {
    let s = String(svg).trim();
    if (!/^<svg[\s>]/i.test(s)) throw new Error('A layer\'s svg must start with <svg');
    if (!/xmlns=/.test(s.slice(0, s.indexOf('>')))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('That SVG could not be drawn (check that it is valid XML)')); img.src = url; });
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }

  async function compose(doc, carId) {
    const t = await loadTemplate(carId);
    const { w, h } = t;
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
    const draw = async svg => x.drawImage(await rasterSvg(svg, w, h), 0, 0, w, h);    // every layer spans the whole template
    if (doc.base) {
      if (doc.base.color) { x.fillStyle = doc.base.color; x.fillRect(0, 0, w, h); }
      else if (doc.base.svg) await draw(doc.base.svg);
      else throw new Error('base needs color or svg');
    }
    for (const [i, l] of (doc.layers || []).entries()) {
      if (!l.svg) throw new Error(`layer ${i}: missing svg`);
      const surface = l.surface || 'canvas';
      if (surface === 'canvas') { await draw(l.svg); continue; }
      const cal = await loadCalibration(carId);
      if (cal.error) throw new Error(`layer ${i}: ${cal.error}`);
      if (!cal.views[surface]) throw new Error(`layer ${i}: no "${surface}" view for this car; use one of ${Object.keys(cal.views).join(', ')} or canvas`);
      const v = cal.views[surface], warped = warpView(cal, t, surface, await rasterSvg(l.svg));
      const tmp = new OffscreenCanvas(w, h); tmp.getContext('2d').putImageData(warped, 0, 0);
      x.drawImage(tmp, 0, 0);
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
    return { w, h, rgba: out, template: t };
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

  async function exportWrap(doc, carId) {
    const { w, h, rgba, template } = await compose(doc, carId);
    const { blob, info } = await fitToCap(rgba, w, h);
    return { blob, name: fileName(doc.name), w, h, ...info, template: { url: template.url, sha256: template.sha256 } };
  }

  window.WrapCompose = { CAP, loadTemplate, panels, cellPanels, loadCalibration, surfaces, guide, compose, encodePng, fitToCap, fileName, exportWrap };
})();
