// Runs inside the viewer page (injected by tools/calibrate.mjs). Works out, for one camera view, where every template pixel
// lands on screen, by projecting Gray-code stripe textures through the engine: for each bit of the template x (then y), render
// the stripes and their inverse and compare. Lighting, reflections and paint add equally to both, so they cancel.
// The result is a grid over the template (one cell per `cell` × `cell` template pixels): each cell's mean screen position, and
// how many screen pixels show it (its apparent size; 0 = not visible from this camera).
window.Calibrate = (() => {
  const lum = (d, i) => d[i] + d[i + 1] + d[i + 2];
  const gray = n => n ^ (n >> 1);

  function texture(W, H, fn) {             // a full-coverage black/white texture at the template's size
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'), id = x.createImageData(W, H), d = id.data;
    for (let y = 0, j = 0; y < H; y++) for (let X = 0; X < W; X++, j += 4) { const v = fn(X, y) ? 255 : 0; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    x.putImageData(id, 0, 0);
    return c;
  }
  const frameData = async () => { for (let i = 0; i < 10; i++) { const f = await grabCopy(); if (f) return { d: f.getContext('2d').getImageData(0, 0, f.width, f.height).data, w: f.width, h: f.height }; } throw new Error('no engine frame'); };
  const differs = (a, b, min) => { let n = 0; for (let k = 0; k < a.length; k += 97) if (a[k] !== b[k] && ++n >= min) return true; return false; };
  async function shoot(c) {                // push a texture; the engine decodes it asynchronously, so wait until the frame changes, then holds
    const before = await frameData();
    setWrap(c);
    const t0 = Date.now();
    let changed = null;
    while (Date.now() - t0 < 15000) {
      const f = await frameData();
      if (!changed) { if (differs(f.d, before.d, 20) || Date.now() - t0 > 4000) changed = f; continue; }   // no change in 4 s: it looked the same
      if (!differs(f.d, changed.d, 1)) return f;
      changed = f;
    }
    throw new Error('the engine frame never changed to the new texture');
  }
  async function camera(cam) {
    send({ type: 'set_camera_auto_rotate', enabled: false });
    send({ type: 'set_camera_angle', horizontal: cam.horizontal, vertical: cam.vertical, distance: cam.distance });
    await sleep(2500);
  }

  // Wrapped-surface bounding box at this camera (to choose a distance that fits the car in the frame).
  async function extent(carId, cam) {
    const t = await WrapCompose.loadTemplate(carId);
    await camera(cam);
    const black = await shoot(texture(t.w, t.h, () => 0)), white = await shoot(texture(t.w, t.h, () => 1));
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < white.h; y++) for (let x = 0; x < white.w; x++) {
      const i = (y * white.w + x) * 4;
      if (lum(white.d, i) - lum(black.d, i) > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return { w: white.w, h: white.h, box: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1] };
  }

  async function view(carId, cam, cell) {
    const t = await WrapCompose.loadTemplate(carId), P = WrapCompose.panels(t), G = WrapCompose.cellPanels(t, cell);
    await camera(cam);
    const black = await shoot(texture(t.w, t.h, () => 0)), white = await shoot(texture(t.w, t.h, () => 1));
    const N = white.w * white.h, range = new Float32Array(N), ok = new Uint8Array(N), u = new Uint16Array(N), v = new Uint16Array(N);
    for (let p = 0; p < N; p++) { range[p] = lum(white.d, p * 4) - lum(black.d, p * 4); ok[p] = range[p] > 60 ? 1 : 0; }
    for (const [axis, size] of [['x', t.w], ['y', t.h]]) {
      const bits = Math.ceil(Math.log2(size)), g = new Uint16Array(N);
      for (let b = bits - 1; b >= 0; b--) {
        const pos = await shoot(texture(t.w, t.h, (X, y) => (gray(axis === 'x' ? X : y) >> b) & 1));
        const neg = await shoot(texture(t.w, t.h, (X, y) => !((gray(axis === 'x' ? X : y) >> b) & 1)));
        for (let p = 0; p < N; p++) {
          if (!ok[p]) continue;
          const d = lum(pos.d, p * 4) - lum(neg.d, p * 4);
          if (Math.abs(d) < 0.25 * range[p]) { ok[p] = 0; continue; }       // this bit is unreadable here: drop the pixel
          if (d > 0) g[p] |= 1 << b;
        }
      }
      const out = axis === 'x' ? u : v;
      for (let p = 0; p < N; p++) { let b = g[p], m = b >> 1; while (m) { b ^= m; m >>= 1; } out[p] = b; }   // Gray -> binary
    }
    // accumulate per grid cell, only from the panel that cell belongs to
    const sx = new Float64Array(G.cells.length), sy = new Float64Array(G.cells.length), n = new Uint32Array(G.cells.length);
    let decoded = 0, inGap = 0;
    for (let p = 0; p < N; p++) {
      if (!ok[p]) continue; decoded++;
      if (u[p] >= t.w || v[p] >= t.h) { inGap++; continue; }
      const id = P.labels[v[p] * t.w + u[p]], c = ((v[p] / cell) | 0) * G.gw + ((u[p] / cell) | 0);
      if (!id) { inGap++; continue; }
      if (G.cells[c] !== id) continue;
      sx[c] += p % white.w + 0.5; sy[c] += Math.floor(p / white.w) + 0.5; n[c]++;
    }
    const x = new Array(n.length).fill(-1), y = new Array(n.length).fill(-1);
    for (let c = 0; c < n.length; c++) if (n[c]) { x[c] = Math.round(sx[c] / n[c] * 4) / 4; y[c] = Math.round(sy[c] / n[c] * 4) / 4; }
    return { size: [white.w, white.h], decoded, inGap, x, y, n: Array.from(n) };
  }

  // A picture of the car at this camera with a checker wrap, for checking by eye.
  async function photo(carId) {
    const t = await WrapCompose.loadTemplate(carId);
    const f = await shoot(texture(t.w, t.h, (x, y) => ((x >> 5) + (y >> 5)) & 1));
    const c = document.createElement('canvas'); c.width = f.w; c.height = f.h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.d), f.w, f.h), 0, 0);
    return c.toDataURL('image/png');
  }

  return { extent, view, photo, camera };
})();
