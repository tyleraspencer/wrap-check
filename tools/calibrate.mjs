#!/usr/bin/env node
// Calibrates the car views a design can be drawn on, for each car in the viewer: where every template pixel appears on screen
// from five fixed cameras (left, right, front, rear, top). Writes calib/<car>.json, which compose.js uses to warp a drawing
// made on a view onto the template. Needs Google Chrome and the per-car packs in godot/packs (python3 tools/build_site.py).
//
//   node tools/calibrate.mjs                    every car
//   node tools/calibrate.mjs model3 cybertruck  just these
//   --debug <dir>                               also save each view's photo (checker wrap) and drawing guide there
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'mcp', 'package.json'));
const { chromium } = require('playwright-core');
const viewer = require(path.join(ROOT, 'server.js'));

const args = process.argv.slice(2);
const debugDir = args.includes('--debug') ? args.splice(args.indexOf('--debug'), 2)[1] : null;
const RENDER = { width: 2400, height: 1500 };
const CELL = 4;                         // template pixels per grid cell
const FILL = 0.92;                      // the car may fill at most this much of the frame in any view
// One distance for every view, so a panel's apparent size is comparable between views (that decides which view paints it), and
// far enough back that perspective doesn't blow up the near end of the car.
// horizontal: 0 = behind the car, 90 = its right side, 180 = in front, 270 = its left side. vertical: degrees above the horizon.
const VIEWS = {
  left:  { horizontal: 270, vertical: 0, looking: 'the car\'s left (driver) side; the front of the car is toward the left of the drawing' },
  right: { horizontal: 90, vertical: 0, looking: 'the car\'s right (passenger) side; the front of the car is toward the right of the drawing' },
  front: { horizontal: 180, vertical: 0, looking: 'the front of the car, head on; the car\'s left side is on the right of the drawing' },
  rear:  { horizontal: 0, vertical: 0, looking: 'the back of the car; the car\'s left side is on the left of the drawing' },
  top:   { horizontal: 270, vertical: 89, looking: 'straight down from above, lined up with the left view: the front of the car is toward the left of the drawing and its left side is at the bottom' },
};
const ORDER = Object.keys(VIEWS);

const s = await viewer.start(0);
const base = `http://127.0.0.1:${s.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: RENDER, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(`${base}/?embed=1&noengine=1`);
await page.waitForFunction(() => window.WrapCheck);
const cars = args.length ? args : await page.evaluate(() => WrapCheck.cars.map(c => c.id));
fs.mkdirSync(path.join(ROOT, 'calib'), { recursive: true });
if (debugDir) fs.mkdirSync(debugDir, { recursive: true });

for (const car of cars) {
  const t0 = Date.now();
  await page.goto(`${base}/?embed=1&car=${car}`);
  await page.waitForFunction(() => window.WrapCheck && WrapCheck.state().carLoaded, null, { timeout: 180000 });
  await page.evaluate(async () => {        // the engine can restart once while the page settles; wait for 3 quiet seconds
    let n = -1, since = Date.now();
    while (Date.now() - since < 3000) { const st = WrapCheck.state(), k = st.events.length + (st.carLoaded ? 0 : 1000); if (k !== n) { n = k; since = Date.now(); } await sleep(200); }
  });
  await page.addScriptTag({ path: path.join(ROOT, 'tools', 'calibrate-page.js') });
  const tpl = await page.evaluate(async c => { const t = await WrapCompose.loadTemplate(c); return { sha256: t.sha256, w: t.w, h: t.h, url: t.url }; }, car);
  const grid = await page.evaluate(async ([c, k]) => { const g = WrapCompose.cellPanels(await WrapCompose.loadTemplate(c), k); return { gw: g.gw, gh: g.gh, cells: Array.from(g.cells) }; }, [car, CELL]);

  // distance: the closest one at which the car fits in every view
  let distance = 6;
  for (let pass = 0; pass < 3; pass++) {
    let k = 0, touches = false;
    for (const v of Object.values(VIEWS)) {
      const e = await page.evaluate(([c, cm]) => Calibrate.extent(c, cm), [car, { ...v, distance }]);
      if (!e.box) throw new Error(`${car}: car not visible at distance ${distance}`);
      k = Math.max(k, (e.box[2] - e.box[0]) / (FILL * e.w), (e.box[3] - e.box[1]) / (FILL * e.h));
      touches ||= e.box[0] <= 0 || e.box[1] <= 0 || e.box[2] >= e.w || e.box[3] >= e.h;
    }
    const next = Math.round(Math.min(14, Math.max(3, touches ? distance * 1.3 : distance * k)) * 100) / 100;
    if (!touches && Math.abs(next - distance) / distance < 0.03) break;
    distance = next;
  }

  const views = {}, seen = {};
  for (const [name, v] of Object.entries(VIEWS)) {
    const camera = { horizontal: v.horizontal, vertical: v.vertical, distance };
    const r = await page.evaluate(([c, cm, k]) => Calibrate.view(c, cm, k), [car, camera, CELL]);
    views[name] = { camera, looking: v.looking, render: r.size };
    seen[name] = r;
    if (debugDir) {
      const png = await page.evaluate(c => Calibrate.photo(c), car);
      fs.writeFileSync(path.join(debugDir, `${car}-${name}-photo.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    console.log(`  ${car} ${name}: ${r.decoded} pixels decoded (${r.inGap} landed in gaps), ${r.n.filter(Boolean).length} cells seen`);
  }

  // Ownership: each cell is painted from the view where it looks biggest (smoothed over its 3 × 3 neighbourhood within the
  // panel, so ownership doesn't flicker), then tidied with a majority vote so patches have clean edges.
  const { gw, gh, cells } = grid, N = gw * gh;
  const nbrs = (c, f) => { const cx = c % gw, cy = (c - cx) / gw; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < gw && y < gh && cells[y * gw + x] === cells[c]) f(y * gw + x); } };
  const smooth = ORDER.map(name => { const n = seen[name].n, out = new Float32Array(N); for (let c = 0; c < N; c++) if (cells[c]) { let s = 0, k = 0; nbrs(c, o => { s += n[o]; k++; }); out[c] = s / k; } return out; });
  let owner = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (!cells[c]) continue;
    let best = 0, bv = 0;
    ORDER.forEach((name, i) => { if (seen[name].n[c] && smooth[i][c] > bv) { bv = smooth[i][c]; best = i + 1; } });
    owner[c] = best;
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = owner.slice();
    for (let c = 0; c < N; c++) {
      if (!owner[c]) continue;
      const votes = new Array(ORDER.length + 1).fill(0); nbrs(c, o => votes[owner[o]]++);
      const top = votes.indexOf(Math.max(...votes));
      if (top && top !== owner[c] && votes[top] >= 5 && seen[ORDER[top - 1]].n[c]) next[c] = top;
    }
    owner = next;
  }

  // Crop each view to what it paints (plus a margin), so a drawing's canvas is the car, not the empty frame.
  const order = [];
  for (const [i, name] of ORDER.entries()) {
    const r = seen[name], b = [1e9, 1e9, -1e9, -1e9];
    for (let c = 0; c < N; c++) if (owner[c] === i + 1) { b[0] = Math.min(b[0], r.x[c]); b[1] = Math.min(b[1], r.y[c]); b[2] = Math.max(b[2], r.x[c]); b[3] = Math.max(b[3], r.y[c]); }
    if (b[2] < 0) { delete views[name]; continue; }
    const m = 24, [W, H] = r.size;
    views[name].crop = [Math.max(0, Math.floor(b[0] - m)), Math.max(0, Math.floor(b[1] - m)), Math.min(W, Math.ceil(b[2] + m)), Math.min(H, Math.ceil(b[3] + m))];
    const xy = Buffer.alloc(N * 4);
    for (let c = 0; c < N; c++) {
      const ok = r.n[c] > 0;
      xy.writeUInt16LE(ok ? Math.round(r.x[c] * 4) : 0xffff, c * 4); xy.writeUInt16LE(ok ? Math.round(r.y[c] * 4) : 0xffff, c * 4 + 2);
    }
    views[name].xy = zlib.deflateSync(xy, { level: 9 }).toString('base64');
    order.push(name);
  }
  // re-index owners to the views that survived (a view that paints nothing is dropped)
  const remap = ORDER.map(name => order.indexOf(name) + 1);
  const ownerOut = Buffer.from(owner.map(o => (o ? remap[o - 1] : 0)));
  // Per-view ownership weights, softened across a few cells, so compose.js can decide ownership per pixel along smooth curves
  // instead of in cell-sized stair steps. One byte per view per cell, interleaved.
  const weights = Buffer.alloc(N * order.length);
  order.forEach((name, i) => {
    let w = new Float32Array(N); for (let c = 0; c < N; c++) w[c] = ownerOut[c] === i + 1 ? 1 : 0;
    for (let pass = 0; pass < 2; pass++) { const next = new Float32Array(N); for (let c = 0; c < N; c++) if (cells[c]) { let s = 0, k = 0; nbrs(c, o => { s += w[o]; k++; }); next[c] = s / k; } w = next; }
    for (let c = 0; c < N; c++) weights[c * order.length + i] = Math.round(w[c] * 255);
  });
  const cal = { version: 2, car, template: tpl, created: new Date().toISOString().slice(0, 10), cell: CELL, gw, gh, order,
    owner: zlib.deflateSync(ownerOut, { level: 9 }).toString('base64'), weights: zlib.deflateSync(weights, { level: 9 }).toString('base64'), views };
  const file = path.join(ROOT, 'calib', `${car}.json`);
  fs.writeFileSync(file, JSON.stringify(cal));

  const panelCells = cells.filter(Boolean).length, owned = Object.fromEntries(order.map((n, i) => [n, ownerOut.filter(o => o === i + 1).length]));
  const unowned = cells.reduce((a, id, c) => a + (id && !ownerOut[c] ? 1 : 0), 0);
  console.log(`${car}: distance ${distance}; cells owned ${JSON.stringify(owned)}; ${unowned} of ${panelCells} panel cells seen by no view; ` +
    `${(fs.statSync(file).size / 1024).toFixed(0)} KB; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (debugDir) for (const name of order) {
    const png = await page.evaluate(async ([c, n]) => { const b = await WrapCompose.guide(c, n); return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }); }, [car, name]);
    fs.writeFileSync(path.join(debugDir, `${car}-${name}-guide.png`), Buffer.from(png.split(',')[1], 'base64'));
  }
}
await browser.close();
s.close();
