#!/usr/bin/env node
// Wrap Check MCP server.
//
// Lets an LLM design a Tesla custom wrap, then check it on a 3D model of the car before handing it over:
//   list_cars     – the supported cars and their template sizes
//   get_template  – Tesla's template PNG for a car (white = printable panel) saved to disk
//   validate_wrap – Tesla's upload rules + how much of the art lands on printable panels
//   render_wrap   – renders the wrap on the car from several angles (returns images the model can look at)
//   viewer_url    – a link to the interactive viewer with the wrap already applied, for the user
//
// Two ways to run it:
//   node server.js                 stdio, for Claude Code / Claude Desktop (tools take local file paths)
//   node server.js --http          Streamable HTTP, for ChatGPT / claude.ai / any remote MCP client. Set:
//                                    PORT                 listen port (default 8080)
//                                    PUBLIC_URL           the https URL clients reach it at (used in links the tools return)
//                                    WRAPCHECK_TOKEN      required secret; send as 'Authorization: Bearer <t>' or use the URL /mcp/<t>
//                                  Remote clients have no shared disk, so tools take wrap_url or wrap_base64 instead of a path,
//                                  and return https links to the template, renders and viewer.
//
// Rendering drives headless Chrome against the local viewer (../index.html), so Chrome must be installed.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const viewerServer = require('../server.js');

const WORK = path.join(os.tmpdir(), 'wrap-check');
const DIRS = { templates: path.join(WORK, 'templates'), renders: path.join(WORK, 'renders'), wraps: path.join(WORK, 'wraps'), packs: path.join(os.homedir(), '.cache', 'wrap-check', 'packs') };
const HOSTED = (process.env.WRAPCHECK_HOSTED_URL || 'https://tyleraspencer.github.io/wrap-check').replace(/\/$/, '');
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
const REMOTE = process.argv.includes('--http');
const PORT = +process.env.PORT || 8080;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TOKEN = process.env.WRAPCHECK_TOKEN || '';
const log = (...a) => console.error('[wrap-check]', ...a);   // stdout belongs to the MCP protocol

// Car packs are built by CI and hosted on GitHub Pages. If they are not in the working tree, fetch them once and cache them.
const inflight = {};
async function fetchPack(reqPath) {
  const m = reqPath.match(/^\/godot\/packs\/([\w.-]+\.(?:pck|json))$/);
  if (!m) return null;
  const dest = path.join(DIRS.packs, m[1]);
  if (fs.existsSync(dest)) return dest;
  return (inflight[dest] ??= (async () => {
    fs.mkdirSync(DIRS.packs, { recursive: true });
    log(`downloading ${m[1]} from ${HOSTED} (first use only)`);
    const r = await fetch(`${HOSTED}${reqPath}`);
    if (!r.ok) throw new Error(`${r.status} fetching ${HOSTED}${reqPath}`);
    fs.writeFileSync(dest + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(dest + '.part', dest);
    return dest;
  })().finally(() => delete inflight[dest]));
}

// ---------- viewer (static server + headless Chrome), started lazily ----------
let baseUrl, browser;
const pages = {};   // 'viewer' (3D engine) and 'check' (validation only, no engine)

async function ensureServer() {
  if (baseUrl) return baseUrl;
  const want = +process.env.WRAPCHECK_PORT || 8123;
  for (const port of [want, 0]) {
    try {
      const s = await viewerServer.start(port, { extraDirs: { '/__wraps/': DIRS.wraps }, onMiss: fetchPack });
      baseUrl = `http://127.0.0.1:${s.address().port}`; log('viewer at', baseUrl); return baseUrl;
    } catch (e) { if (port === 0) throw e; }
  }
}
async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  const attempts = [
    { channel: 'chrome', args: ['--ignore-gpu-blocklist'] },
    { channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] },   // bundled Chromium (Docker)
  ];
  let last;
  for (const a of attempts) {
    try { browser = await chromium.launch({ headless: true, ...a }); return browser; } catch (e) { last = e; }
  }
  throw new Error('Could not start Chrome (install Google Chrome, or run `npx playwright-core install chromium`): ' + last.message);
}
async function getPage(kind, car) {
  await ensureServer();
  const b = await ensureBrowser();
  if (pages[kind] && !pages[kind].isClosed()) return pages[kind];
  const page = await b.newPage({ viewport: kind === 'viewer' ? { width: 1280, height: 800 } : { width: 400, height: 300 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => log('page error:', e.message));
  const q = kind === 'viewer' ? `embed=1&car=${car}` : 'embed=1&noengine=1';
  await page.goto(`${baseUrl}/?${q}`);
  await page.waitForFunction(() => window.WrapCheck, null, { timeout: 30000 });
  pages[kind] = page;
  return page;
}

// ---------- helpers ----------
const CAR_IDS = ['modely-2025-premium', 'modely-2025-performance', 'modely-2025-base', 'modely-l', 'modely',
                 'model3-2024-base', 'model3-2024-performance', 'model3', 'cybertruck'];
const carEnum = z.enum(CAR_IDS);
const VIEWS = ['three_quarter', 'front', 'front_left', 'front_right', 'rear', 'rear_left', 'rear_right', 'left', 'right', 'top'];
const RAW = 'https://raw.githubusercontent.com/teslamotors/custom-wraps/master';
const text = t => ({ type: 'text', text: t });
const fail = msg => ({ isError: true, content: [text(msg)] });
// A wrap comes from a local path (stdio), or from wrap_url / wrap_base64 (remote clients have no shared disk).
const wrapInput = {
  ...(REMOTE ? {} : { path: z.string().optional().describe('Path to the wrap PNG') }),
  wrap_url: z.string().url().optional().describe('https URL of the wrap PNG'),
  wrap_base64: z.string().optional().describe('The wrap PNG, base64 encoded (no data: prefix). Keep it under 1 MB, as Tesla requires.'),
  name: z.string().optional().describe('File name to validate (e.g. "Sunset Fade.png"); defaults to the URL or path name, or wrap.png'),
};
const MAX_BYTES = 8 * 1024 * 1024;
const readWrap = async a => {
  if (a.wrap_base64) {
    const bytes = Buffer.from(a.wrap_base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (bytes.length > MAX_BYTES) throw new Error('wrap_base64 is far larger than Tesla allows (1 MB)');
    return { bytes, name: a.name || 'wrap.png' };
  }
  if (a.wrap_url) {
    const u = new URL(a.wrap_url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('wrap_url must be http(s)');
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${r.status} fetching ${a.wrap_url}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('wrap_url file is far larger than Tesla allows (1 MB)');
    return { bytes, name: a.name || decodeURIComponent(path.basename(u.pathname)) || 'wrap.png' };
  }
  if (a.path && !REMOTE) {
    const abs = path.resolve(a.path);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    return { bytes: fs.readFileSync(abs), name: a.name || path.basename(abs) };
  }
  throw new Error(REMOTE ? 'Give wrap_url or wrap_base64.' : 'Give path, wrap_url or wrap_base64.');
};
// Browser pages are shared, so two concurrent renders would fight over the camera and wrap. Run them one at a time.
let chain = Promise.resolve();
const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
const fileLink = (kind, rel) => REMOTE ? `${PUBLIC_URL}/files/${kind}/${rel}` : path.join(DIRS[kind], rel);
const summarize = (rows, stats) => {
  const bad = rows.some(r => r.level === 'bad'), warn = rows.some(r => r.level === 'warn');
  const icon = { ok: '✓', warn: '!', bad: '✗' };
  return `${bad ? 'FAIL — Tesla will reject this file' : warn ? 'PASS with warnings' : 'PASS'}\n` +
    rows.map(r => `  ${icon[r.level]} ${r.text}`).join('\n');
};

// ---------- server & tools ----------
const INSTRUCTIONS = `You can design Tesla custom wraps and check them on a 3D model of the car before handing them over.
Workflow:
1. Ask which car (list_cars) if the user has not said. Each car has its own template layout.
2. get_template(car) and design the wrap by painting inside the WHITE areas of that exact image, same pixel size. Leave everything else transparent.
   Respect Tesla's rules: PNG, 1 MB or less, 512-1024 px per side, file name of letters/numbers/spaces/_/- up to 30 characters.
   Layout tips (learned from testing on the Model Y Premium template; confirm on other cars in the render): the top-centre shape is the hood,
   the large middle area is the roof, the tall columns at left and right are the doors and rear quarters, and the strip at the top is a bumper.
   The side columns are laid out sideways, so TEXT THERE MUST BE ROTATED 90 DEGREES to read upright on the car (left column: clockwise,
   right column: counter-clockwise). Keep words short enough to stay inside the door columns, or the last letters land on the unpainted wheel arch.
   The validator cannot see upside-down or clipped text; only the renders can.
3. validate_wrap, then render_wrap and LOOK at every image. Check that text reads the right way round, logos land where intended, nothing important sits on a seam, and colours match the design. Fix the PNG and render again until it is right (a few rounds is normal).
4. Finish with: the final PNG path, the best render(s), and viewer_url so the user can orbit the car themselves.
The 3D viewer is slightly darker and less glossy than a real car: judge placement and hue, not absolute brightness. Do not claim the wrap is "verified" beyond what the renders show.`;
function createServer() {
const server = new McpServer({ name: 'wrap-check', version: '0.1.0' }, { instructions: INSTRUCTIONS + (REMOTE ? `
This is a remote server with no shared disk: pass the wrap as wrap_url (https link to the PNG) or wrap_base64, never a file path. Links it returns (template, renders, viewer) are https URLs.` : '') });

server.registerTool('list_cars', {
  description: 'List the Tesla models you can design and preview wraps for, with each car\'s id, template size and Tesla example wrap names.',
  inputSchema: {},
}, async () => {
  const page = await getPage('check');
  const list = await page.evaluate(() => WrapCheck.cars.map(c => ({ id: c.id, name: c.name, templateSize: c.templateSize.join('x'), examples: c.examples.slice(0, 5) })));
  return { content: [text(JSON.stringify(list, null, 1))] };
});

server.registerTool('get_template', {
  description: 'Get Tesla\'s official template PNG for a car (saved locally, or as an image and link on a remote server). In the template, OPAQUE WHITE areas are the printable body panels, black lines are panel seams, and transparent areas are not used by the car. Design the wrap by painting inside the white areas of this exact image (same pixel size) and export a PNG of the same size, with transparency outside the panels. Each car has a different layout, so always use the template for the car you are designing for.',
  inputSchema: { car: carEnum.describe('Car id from list_cars') },
}, async ({ car }) => {
  const file = path.join(DIRS.templates, `${car}.png`);
  if (!fs.existsSync(file)) {
    const r = await fetch(`${RAW}/${car}/template.png`);
    if (!r.ok) return fail(`Could not download the template (${r.status})`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  const dims = car === 'cybertruck' ? '1024x768' : '1024x1024';
  const where = fileLink('templates', `${car}.png`);
  const content = [text(`Template for ${car}: ${where} (${dims}). White = printable panels, black = seams. Keep artwork inside the white areas and output a PNG of exactly ${dims}.`)];
  if (REMOTE) content.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/png' });
  return { content };
});

server.registerTool('validate_wrap', {
  description: 'Check a wrap PNG against Tesla\'s upload rules (PNG, max 1 MB, 512–1024 px per side, file name rules) and report how much of the artwork lands on printable panels. Cheap and fast; run it before rendering.',
  inputSchema: { ...wrapInput, car: carEnum },
}, async ({ car, ...a }) => {
  try {
    const { bytes, name } = await readWrap(a);
    const r = await serial(async () => {
      const page = await getPage('check');
      return page.evaluate(([b64, n, c]) => WrapCheck.validate(b64, n, c), [bytes.toString('base64'), name, car]);
    });
    return { content: [text(summarize(r.rows, r.stats)), text(JSON.stringify(r.stats))] };
  } catch (e) { return fail(e.message); }
});

server.registerTool('render_wrap', {
  description: 'Render a wrap on the 3D model of a car and return screenshots from several angles. LOOK at the images before answering: check that text reads the right way round and is not split across panels, that logos sit where intended, that colours and contrast are as designed, and that nothing important falls on a seam. If something is wrong, fix the PNG and render again. NOTE: the 3D viewer is a little darker and less glossy than the real car, so judge hue and placement, not absolute brightness. The first call loads the car (~20–40 MB) and takes several seconds.',
  inputSchema: {
    ...wrapInput,
    car: carEnum,
    views: z.array(z.enum(VIEWS)).min(1).max(10).optional().describe('Camera angles. three_quarter is the usual front/driver-side hero shot; left and right are the car\'s own sides. Default: three_quarter, rear_right, front, rear, left, right.'),
    paint: z.enum(['PearlWhite', 'DiamondBlack', 'Quicksilver', 'MidnightSilver', 'DeepBlue', 'UltraRed']).optional().describe('Paint colour under transparent parts of the wrap (default PearlWhite)'),
  },
}, async ({ car, views = ['three_quarter', 'rear_right', 'front', 'rear', 'left', 'right'], paint = 'PearlWhite', ...a }) => {
  try {
    const { bytes, name } = await readWrap(a);
    return await serial(async () => {
    const page = await getPage('viewer', car);
    await page.evaluate(id => WrapCheck.setCar(id), car);
    await page.evaluate(c => WrapCheck.setPaint(c), paint);
    const v = await page.evaluate(([b64, n]) => WrapCheck.setWrap(b64, n), [bytes.toString('base64'), name]);
    const hash = createHash('sha1').update(bytes).update(car).digest('hex').slice(0, 10);
    const outDir = path.join(DIRS.renders, hash); fs.mkdirSync(outDir, { recursive: true });
    const content = [text(`Rendered ${name} on ${car} (paint ${paint}).\n${summarize(v.rows, v.stats)}`)];
    for (const view of views) {
      await page.evaluate(w => WrapCheck.camera(w), view);
      const png = await page.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(outDir, `${view}.png`), png);
      content.push(text(`${view}: ${fileLink('renders', `${hash}/${view}.png`)}`), { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    }
    return { content };
    });
  } catch (e) { return fail('Render failed: ' + e.message); }
});

server.registerTool('viewer_url', {
  description: 'Get a link to the interactive 3D viewer with this wrap already applied, so the user can orbit, zoom and try different paint colours. Give this link to the user together with the final PNG path. The link works while this MCP server is running.',
  inputSchema: { ...wrapInput, car: carEnum },
}, async ({ car, ...a }) => {
  try {
    const { bytes } = await readWrap(a);
    const base = REMOTE ? PUBLIC_URL : await ensureServer();
    const id = createHash('sha1').update(bytes).digest('hex').slice(0, 12) + '.png';
    fs.writeFileSync(path.join(DIRS.wraps, id), bytes);
    return { content: [text(`${base}/?car=${car}&wrap=/__wraps/${id}`)] };
  } catch (e) { return fail(e.message); }
});

return server;
}

process.on('exit', () => { try { browser && browser.close(); } catch {} });

if (!REMOTE) {
  await createServer().connect(new StdioServerTransport());
  log('ready');
} else {
  if (!TOKEN) { console.error('WRAPCHECK_TOKEN is required with --http (this server renders on your compute; do not run it open).'); process.exit(1); }
  const internal = await ensureServer();                 // the viewer, which render_wrap and viewer_url use
  const authed = (req, urlPath) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /i, '');
    return bearer === TOKEN || urlPath === `/mcp/${TOKEN}`;   // URL secret for clients (ChatGPT) that cannot send a header
  };
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    try {
      if (urlPath === '/healthz') return send(res, 200, { ok: true });

      if (urlPath === '/mcp' || urlPath.startsWith('/mcp/')) {
        if (!authed(req, urlPath)) return send(res, 401, { error: 'unauthorized' });
        if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
        // Stateless: a fresh server + transport per request, so any instance can answer any call.
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        return await transport.handleRequest(req, res);
      }

      // Templates and renders are served by unguessable path (renders are keyed by a hash of the wrap).
      const m = urlPath.match(/^\/files\/(templates|renders)\/([\w./-]+\.png)$/);
      if (m && !m[2].includes('..')) {
        const f = path.join(DIRS[m[1]], m[2]);
        if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return fs.createReadStream(f).pipe(res); }
        return send(res, 404, { error: 'not found' });
      }

      // Everything else is the viewer itself (so the viewer_url links work), proxied to the internal static server.
      const up = http.request(internal + req.url, { method: req.method, headers: { accept: req.headers.accept || '*/*' } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => send(res, 502, { error: 'viewer unavailable' }));
      up.end();
    } catch (e) {
      log('request error:', e.message);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  }).listen(PORT, '0.0.0.0', () => log(`remote MCP on :${PORT}  ->  ${PUBLIC_URL}/mcp   (token required)`));
}
