// Wrap composer: turns a design document into a Tesla-ready PNG for whichever car is selected.
//
//   WrapCompose.loadTemplate(carId)         Tesla's template.png for that car (teslamotors/custom-wraps), decoded and cached
//   WrapCompose.compose(doc, carId)         design document -> RGBA at the template's size, cut to the template's panels
//   WrapCompose.exportWrap(doc, carId)      compose + encode + fit under Tesla's 1 MB + a valid file name
//
// A design document (step 1 supports base + canvas layers; car-surface layers come with calibration):
//   { name: 'Sunset_Fade',
//     base:   { color: '#0b2545' } | { svg: '<svg ...>' },              // optional; painted under every layer
//     layers: [ { surface: 'canvas', svg: '<svg ...>' }, ... ] }       // drawn in order, in the template's own pixel space
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
      if ((l.surface || 'canvas') !== 'canvas') throw new Error(`layer ${i}: surface "${l.surface}" is not available yet; use "canvas"`);
      if (!l.svg) throw new Error(`layer ${i}: missing svg`);
      await draw(l.svg);
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

  window.WrapCompose = { CAP, loadTemplate, compose, encodePng, fitToCap, fileName, exportWrap };
})();
