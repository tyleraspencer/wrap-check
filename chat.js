// Design with Claude: a chat beside the car that designs wraps with the user's own Anthropic API key. The key goes from this browser
// straight to Anthropic and nowhere else, so the user pays for what they use and nothing runs on a server of ours.
//
// Claude designs with compose.js design documents for whichever car is selected, looks at the exact PNG it would deliver (the main
// artifact), checks it on the 3D car (sharp renders, close-ups of panels, its drawings compared with the car from the same camera),
// and when both look right puts the finished file in the wrap input on the left. See docs/chat-design.md.
(() => {
  if (new URLSearchParams(location.search).get('embed') === '1') return;
  const $ = id => document.getElementById(id);
  const API = 'https://api.anthropic.com/v1';
  // prices per million tokens: input, output, cache read, cache write (5 minutes)
  const MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', price: [4, 20, 0.2, 5], effort: 'high', fallbacks: true },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', price: [2, 10, 0.2, 2.5], effort: 'high', fallbacks: true },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', price: [0.1, 0.5, 0.01, 0.125], effort: 'medium', fallbacks: false },
  ];
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_SIDE = 1568;                          // images bigger than this are scaled down by the API anyway

  const S = {
    key: store.get('wc.key'), model: store.get('wc.model') || MODELS[0].id, messages: [], doc: null, version: 0, last: null,
    pending: [], nextAtt: 1, busy: false, ctl: null, cost: 0, studied: {}, car: null, carNote: null, noFallbacks: false, noSearch: false, live: null,
  };
  try { const d = JSON.parse(store.get('wc.design') || 'null'); if (d && d.doc) S.doc = d.doc; } catch {}

  // ---------------------------------------------------------------- system prompt and tools
  const SYSTEM = `You design Tesla Paint Shop wraps inside Wrap Check, a web page with a live 3D model of the user's car. You work in a chat panel beside the car. The user sees your messages, the car, and a wrap input on the left where the finished PNG goes.

# What you deliver
One PNG for the car selected in the page's car menu, built by the app's tools from a design document you write. The app guarantees Tesla's file rules: the car's template size, under 1 MB, the template's exact alpha so nothing paints outside the panels, and a valid file name. You never write PNG bytes yourself.
The PNG is the product: the user uploads exactly that file to their car. Its quality matters as much as how the 3D car looks, so check both, every round.

# The car
- The car is whatever the menu says. Never assume or ask which car it is. Call get_car at the start and whenever you're told the car changed. Call study_car once per car before you place anything directional (text, logos, numbers, arrows, stripes with a direction).
- Tesla's template is a flat atlas: each panel is cut out and laid flat, many of them sideways, upside down or split. get_car gives the template, a panel map image (IDs, arrows to the car's up) and a panel map table worked out from the 3D model. Per panel it says which camera view paints it, which canvas direction points up, to the front and to the car's left on the car, which edge faces the ground, how to rotate canvas text so it reads upright, and which panels meet on the car.
- study_car shows a labelled texture on the 3D car from every angle. Use it to confirm the table; where they disagree, trust what you see on the car, and remember it for the rest of the chat.

# Design document
{"name": "Sunset_Stripe", "base": {"color": "#0b2545"} or {"svg": "<svg…>"}, "layers": [{"surface": "left", "svg": "<svg…>"}, …]}
- Car-view layers (surface left, right, front, rear, top): you draw on a picture of the car as a fixed camera sees it, and the app warps the drawing onto the template. Draw at the view's own pixel size (viewBox "0 0 W H" from get_car) over its guide image: light grey is what this view paints (dark lines are panel edges), paler grey is painted by another view, and white is not the car and is ignored. What you draw upright reads upright on the car, across door gaps and around curves. So use car views for text, logos, numbers, stripes and anything directional; a word spanning two doors needs no seam maths.
- canvas layers are drawn straight onto the template (viewBox "0 0 <template W> <template H>"). Use them for all-over patterns, fills, gradients and textures where direction doesn't matter, and for parts no camera sees (the table lists them; only base and canvas layers reach those). For directional art on a canvas layer, rotate it as the panel map table says, and never mirror it.
- base paints everything first, then layers in order. Transparent areas show the car's own paint.
- Attachments can be used as art: <image href="att:3" x=".." y=".." width=".." height=".."/>. Don't enlarge raster images; set_design warns when one is enlarged, because it will look soft. Prefer SVG for logos and type.
- Write valid XML. Web fonts can't load, so use system fonts (Arial, Helvetica, Impact, Georgia, Courier New, Verdana) or generic families, or draw letters as paths. Say which font you used when it stands in for an official one.

# The loop, every round
1. set_design (the full document) or edit_design (small patches). The result is the exact PNG that would be delivered, plus checks. Look at the PNG first: panels missed or half painted, art cut at a panel edge or seam, a logo split where it shouldn't be, clipped text, soft or blocky raster art, stray marks. Use inspect_png to zoom in 3–4× on text, logos, seams and edges. Fix problems in the file before rendering.
2. render the car (default three_quarter, rear_right, top) and look at placement, proportions, continuity across seams and colours.
3. render with focus on every panel that has text, a logo or a seam crossing, and look at the close-up at full resolution: letters upright and not mirrored, edges sharp, nothing stretched, warped or cut.
4. compare_view for each car-view layer you used. It puts your drawing next to the car seen from that camera and marks where edges came out soft or displaced. Fix what it flags, unless you can see it's lighting or a reflection.
Iterate up to 3 rounds on your own. If it still isn't right, show the user where it stands and ask. Never call finish with a defect you know about.

# Judgement
- Ask only what's missing. If the request is clear, start.
- Themed requests (a brand, school, team, city, event, show): research first with web search; don't work from memory. Take exact colours from official guides and use the primary as the base. Use official logo files as published: no redrawing, tracing, regenerating, stretching or recolouring, except official one-colour variants. The browser can't download logo files, so ask the user to attach the official logo (SVG preferred), say exactly which file, and meanwhile build from the official colours. Use the official typeface if you can, otherwise the closest one, and say so. The user has permission to use the imagery they ask for, so add no licensing disclaimers.
- Never mirror text or logos. Keep letters and logos from being cut by a seam or panel edge unless the cut is deliberate. Use one baseline across a door pair.
- When editing, keep everything the user already approved and change only what they asked for.
- Name the file from the design (for example Navy_Orange_Stripes): letters, digits, _ - and spaces, at most 30 characters, and not a generic name like wrap or final.
- Photographic or generated art is interior artwork only; the template decides the shapes.

# The user's feedback
- The user can attach images, paste screenshots and annotate the 3D view. An annotation arrives as an image of the car with the user's coloured marks: the marks are notes, not part of the wrap. Use the angle named and the panel map to work out which panels they mean.
- When the user switches cars, you'll be told. Call get_car and study_car again and rebuild the design for the new car; car-view layers usually carry over, but check each view's size.

# Delivering
When the PNG, the renders, the close-ups and the comparisons all look right, call finish. It exports the file, puts it in the wrap input on the left, where the user can download or share it, and shows it in the chat. Then reply in one or two plain sentences about the design: its colours and where the main elements sit. Leave out byte counts, sizes, panel counts and validation details. Mention a reduced palette, an unverified placement or a missing official asset only if it matters.
Keep messages short; the user is watching the car. Between steps, say in a few words what you're doing.`;

  const SURFACES = ['canvas', 'left', 'right', 'front', 'rear', 'top'];
  const RENDER_VIEWS = ['front', 'front_left', 'left', 'rear_left', 'rear', 'rear_right', 'right', 'front_right', 'top', 'three_quarter'];
  const layerSchema = { type: 'object', properties: { surface: { type: 'string', enum: SURFACES }, svg: { type: 'string', description: 'A complete <svg> document' } }, required: ['surface', 'svg'], additionalProperties: false };
  const baseSchema = { type: 'object', properties: { color: { type: 'string' }, svg: { type: 'string' } }, additionalProperties: false };
  const TOOLS = [
    { name: 'get_car', description: 'The selected car: name, template size, Tesla\'s rules, its car views (size, what each camera looks at) with their guide images, Tesla\'s template, the panel map image and the panel map table. Call at the start and whenever the car changes.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'study_car', description: 'Shows a labelled texture on the 3D car (each panel a colour, its ID, an arrow to the car\'s up, "ABC 123" written the way the table says reads upright, a grid every 64 template px) from 8 angles and from above, plus close-ups of small panels. Use it to learn the car before placing directional art. Once per car.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'set_design', description: 'Replace the whole design document, export it through Tesla\'s template, and show it on the 3D car. Returns the exact PNG that would be delivered and checks (Tesla rules, coverage per panel, art drawn where its view doesn\'t paint, enlarged images).', input_schema: { type: 'object', properties: { design: { type: 'object', properties: { name: { type: 'string' }, base: baseSchema, layers: { type: 'array', items: layerSchema } }, required: ['name', 'layers'], additionalProperties: false } }, required: ['design'], additionalProperties: false } },
    { name: 'edit_design', description: 'Patch the current design and re-export (same result as set_design). Ops run in order. patch_svg replaces the exact text `find` (must occur once) with `replace` in layer `index`: cheapest for colour, position and text changes.', input_schema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', properties: {
      op: { type: 'string', enum: ['patch_svg', 'replace_layer', 'insert_layer', 'remove_layer', 'move_layer', 'set_base', 'set_name'] },
      index: { type: 'integer', description: 'Layer index (insert_layer: position to insert at; omit to append)' }, to: { type: 'integer', description: 'move_layer: new index' },
      find: { type: 'string' }, replace: { type: 'string' }, layer: layerSchema, base: baseSchema, name: { type: 'string' } }, required: ['op'], additionalProperties: false } } }, required: ['ops'], additionalProperties: false } },
    { name: 'inspect_png', description: 'An enlarged crop of the current output PNG, pixel for pixel (no smoothing), with thin cyan panel outlines and IDs. Give panels (IDs) or box [x0, y0, x1, y1] in template pixels; zoom 2–8 (default 4).', input_schema: { type: 'object', properties: { panels: { type: 'array', items: { type: 'integer' } }, box: { type: 'array', items: { type: 'number' } }, zoom: { type: 'integer' } }, additionalProperties: false } },
    { name: 'render', description: 'Sharp photos of the current design on the 3D car. views: camera angles (default three_quarter, rear_right, top). focus: panel IDs for a close-up at high resolution, framed on those panels, from `angle` if given, otherwise from the view that paints them.', input_schema: { type: 'object', properties: { views: { type: 'array', items: { type: 'string', enum: RENDER_VIEWS } }, focus: { type: 'array', items: { type: 'integer' } }, angle: { type: 'string', enum: RENDER_VIEWS } }, additionalProperties: false } },
    { name: 'compare_view', description: 'For a car view used by a layer: your drawing (all layers on that surface) beside the car seen from that same calibrated camera, and a third picture marking where the car\'s edges came out soft (yellow) or displaced (red) compared with the drawing, with a list of where.', input_schema: { type: 'object', properties: { view: { type: 'string', enum: ['left', 'right', 'front', 'rear', 'top'] } }, required: ['view'], additionalProperties: false } },
    { name: 'finish', description: 'Deliver: export the current design, put the PNG in the page\'s wrap input (preview, Tesla checks, download and share) and show it in the chat. Only when the PNG and the car both look right.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'File name without .png' } }, additionalProperties: false } },
  ];
  for (const t of TOOLS) t.eager_input_streaming = true;
  const tools = () => S.noSearch ? TOOLS : [...TOOLS, { type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
  const modelInfo = () => MODELS.find(m => m.id === S.model) || MODELS[0];

  // ---------------------------------------------------------------- UI
  const css = `
  #chat { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--panel); border-left: 1px solid var(--line); }
  #chatFab { display: none; position: fixed; right: 14px; bottom: calc(14px + env(safe-area-inset-bottom)); z-index: 25; place-items: center; padding: 12px 16px; border-radius: 999px; border: 0; background: var(--accent); color: #fff; font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.4); cursor: pointer; }
  .ch-head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--line); }
  .ch-head b { font-size: 14px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch-head select { width: auto; max-width: 150px; padding: 5px 6px; font-size: 12px; }
  .ch-cost { font-size: 11px; color: var(--dim); white-space: nowrap; }
  .ch-ib { flex: none; width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: #232327; color: var(--text); cursor: pointer; font-size: 15px; }
  .ch-ib:hover { border-color: #46464e; }
  .ch-menu { position: absolute; right: 10px; top: 46px; z-index: 5; background: #232327; border: 1px solid var(--line); border-radius: 10px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .ch-menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--text); padding: 8px 12px; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer; } .ch-menu button:hover { background: #2e2e34; }
  .ch-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .ch-key p, .ch-key li { color: var(--dim); font-size: 13px; } .ch-key b { color: var(--text); } .ch-key a { color: #8fb8ff; }
  .ch-key ol { padding-left: 18px; margin: 8px 0 14px; } .ch-key li { margin: 4px 0; }
  .ch-key input[type=password] { width: 100%; background: #232327; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: inherit; margin: 6px 0; }
  .ch-key label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--dim); margin: 6px 0 12px; }
  .ch-primary { background: var(--accent); border: 0; color: #fff; border-radius: 8px; padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer; } .ch-primary:disabled { opacity: .6; cursor: default; }
  .ch-err { color: var(--bad); font-size: 13px; } .ch-note { color: var(--dim); font-size: 12px; }
  .ch-msg { font-size: 13.5px; line-height: 1.5; overflow-wrap: anywhere; } .ch-msg p { margin: 0 0 6px; } .ch-msg p:last-child { margin: 0; }
  .ch-msg ul, .ch-msg ol { margin: 4px 0 6px; padding-left: 20px; } .ch-msg code { background: #26262b; padding: 1px 4px; border-radius: 4px; font-size: 12px; } .ch-msg a { color: #8fb8ff; }
  .ch-user { align-self: flex-end; max-width: 88%; background: #1c2740; border: 1px solid #2a3a5e; border-radius: 12px 12px 4px 12px; padding: 8px 11px; white-space: pre-wrap; }
  .ch-thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; } .ch-thumbs img { height: 64px; max-width: 120px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); cursor: zoom-in; background: #111; }
  .ch-think { font-size: 12px; color: var(--dim); } .ch-think summary { cursor: pointer; list-style: none; } .ch-think summary::before { content: '▸ '; } .ch-think[open] summary::before { content: '▾ '; }
  .ch-think div { white-space: pre-wrap; margin: 4px 0 0 12px; max-height: 220px; overflow-y: auto; }
  .ch-tool { font-size: 12px; color: var(--dim); border-left: 2px solid #3b3b43; padding: 2px 0 2px 9px; } .ch-tool.err { border-color: var(--bad); color: #ffb3b3; } .ch-tool.run::after { content: ' …'; }
  .ch-tool .ch-thumbs img { height: 72px; }
  .ch-final { border: 1px solid var(--ok); border-radius: 12px; padding: 10px; background: #15201a; } .ch-final img { width: 100%; border-radius: 8px; display: block; background: conic-gradient(#2a2a2e 25%, #222226 0 50%, #2a2a2e 0 75%, #222226 0) 0 0/16px 16px; cursor: zoom-in; }
  .ch-final .row { display: flex; gap: 8px; margin-top: 8px; align-items: center; } .ch-final .row span { flex: 1; font-size: 12px; color: var(--dim); word-break: break-all; }
  .ch-compose { border-top: 1px solid var(--line); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .ch-chips { display: flex; flex-wrap: wrap; gap: 6px; } .ch-chips:empty { display: none; }
  .ch-chip { display: flex; align-items: center; gap: 6px; background: #232327; border: 1px solid var(--line); border-radius: 8px; padding: 3px 4px 3px 3px; font-size: 12px; max-width: 100%; }
  .ch-chip img { width: 30px; height: 30px; object-fit: cover; border-radius: 5px; } .ch-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  .ch-chip.live { border-color: var(--accent); } .ch-chip button { background: none; border: 0; color: var(--dim); cursor: pointer; font-size: 14px; padding: 0 4px; }
  .ch-row { display: flex; gap: 6px; align-items: flex-end; }
  .ch-row textarea { flex: 1; resize: none; min-height: 40px; max-height: 180px; background: #232327; color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 10px; font: inherit; font-size: 14px; line-height: 1.35; }
  .ch-row textarea:focus { outline: none; border-color: var(--accent); }
  .ch-send { height: 40px; min-width: 40px; border-radius: 10px; border: 0; background: var(--accent); color: #fff; cursor: pointer; font-size: 16px; } .ch-send.stop { background: #3a3a42; }
  .ch-attach { height: 40px; width: 40px; border-radius: 10px; }
  #chat.drop-over { box-shadow: inset 0 0 0 2px var(--accent); }
  .ch-rail { display: none; }
  .chat-min #chat > :not(.ch-rail) { display: none; } .chat-min .ch-rail { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px 0; height: 100%; }
  .chat-min .ch-rail span { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 12px; color: var(--dim); cursor: pointer; }
  .ch-zoom { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.85); display: grid; place-items: center; cursor: zoom-out; } .ch-zoom img { max-width: 96vw; max-height: 94vh; image-rendering: auto; }
  @media (max-width: 760px) { #chat { display: none; } .chat-open #chat { display: flex; position: fixed; inset: 0; z-index: 30; border: 0; } #chatFab { display: grid; } .chat-open #chatFab { display: none; }
    .ch-row textarea { font-size: 16px; } .ch-head { padding-top: calc(10px + env(safe-area-inset-top)); } .ch-compose { padding-bottom: calc(10px + env(safe-area-inset-bottom)); } .chat-min #chat > :not(.ch-rail) { display: flex; } .ch-min { display: none; } }`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  const root = $('chat'); if (!root) return;
  root.innerHTML = `
    <div class="ch-rail"><button class="ch-ib" id="chExpand" aria-label="Open the chat" title="Open the chat">‹</button><span id="chExpand2">Design with Claude</span></div>
    <div class="ch-head"><b>Design with Claude</b><span class="ch-cost" id="chCost" title="Estimated cost of this conversation, from the token counts Anthropic reports"></span>
      <select id="chModel" aria-label="Model">${MODELS.map(m => `<option value="${m.id}">${m.name.replace('Claude ', '')}</option>`).join('')}</select>
      <button class="ch-ib" id="chMenuBtn" aria-label="Menu" title="Menu">⋯</button><button class="ch-ib ch-min" id="chMin" aria-label="Hide the chat" title="Hide the chat">›</button><button class="ch-ib" id="chClose" aria-label="Close the chat" style="display:none">✕</button></div>
    <div class="ch-menu" id="chMenu" hidden><button id="chNew">New chat (keeps the design)</button><button id="chForget">Forget my API key</button></div>
    <div class="ch-body" id="chBody"></div>
    <div class="ch-compose" id="chCompose" hidden>
      <div class="ch-chips" id="chChips"></div>
      <div class="ch-row"><button class="ch-ib ch-attach" id="chAttach" aria-label="Attach images or PDFs" title="Attach images or PDFs (or paste, or drop them here)">📎</button>
        <textarea id="chInput" rows="1" placeholder="Describe the wrap you want…"></textarea><button class="ch-send" id="chSend" aria-label="Send">➤</button></div>
      <input type="file" id="chFile" accept="image/*,application/pdf" multiple hidden>
    </div>`;
  $('chModel').value = modelInfo().id;
  $('chModel').onchange = () => { S.model = $('chModel').value; store.set('wc.model', S.model); };
  const body = $('chBody'), input = $('chInput');
  const scrollDown = () => { if (body.scrollHeight - body.scrollTop - body.clientHeight < 160) body.scrollTop = body.scrollHeight; };
  const add = (html, cls) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; };
  const zoom = src => { const z = document.createElement('div'); z.className = 'ch-zoom'; z.innerHTML = `<img src="${src}">`; z.onclick = () => z.remove(); document.body.appendChild(z); };
  body.addEventListener('click', e => { if (e.target.matches('.ch-thumbs img, .ch-final img')) zoom(e.target.src); });
  const md = t => {                                         // a little markdown: paragraphs, lists, **bold**, *italic*, `code`, [links](https://…)
    const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t.trim().split(/\n{2,}/).map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*•]\s+/.test(l))) return '<ul>' + lines.map(l => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('') + '</ul>';
      if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) return '<ol>' + lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('') + '</ol>';
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  };
  const money = () => { $('chCost').textContent = S.cost ? (S.cost < 0.01 ? '<$0.01' : '$' + S.cost.toFixed(2)) : ''; };

  // layout: hide to a rail on wide screens; a full-height sheet on phones
  const setMin = on => { document.body.classList.toggle('chat-min', on); store.set('wc.chatMin', on ? '1' : null); };
  $('chMin').onclick = () => setMin(true); $('chExpand').onclick = $('chExpand2').onclick = () => setMin(false);
  if (store.get('wc.chatMin')) setMin(true);
  const phone = matchMedia('(max-width: 760px)'), syncPhone = () => { $('chClose').style.display = phone.matches ? '' : 'none'; };
  phone.addEventListener('change', syncPhone); syncPhone();
  $('chatFab').onclick = () => { document.body.classList.add('chat-open'); setTimeout(() => input.focus(), 50); };
  $('chClose').onclick = () => document.body.classList.remove('chat-open');
  $('chMenuBtn').onclick = e => { e.stopPropagation(); $('chMenu').hidden = !$('chMenu').hidden; };
  document.addEventListener('click', e => { if (!$('chMenu').hidden && !$('chMenu').contains(e.target)) $('chMenu').hidden = true; });
  $('chForget').onclick = () => { $('chMenu').hidden = true; if (S.ctl) S.ctl.abort(); S.key = null; store.set('wc.key', null); keyScreen(); };
  $('chNew').onclick = () => { $('chMenu').hidden = true; if (S.busy) return; S.messages = []; S.studied = {}; S.cost = 0; money(); body.innerHTML = ''; hello(); };

  // ---------------------------------------------------------------- the key
  function keyScreen(err) {
    $('chCompose').hidden = true;
    body.innerHTML = `<div class="ch-key">
      <p><b>Describe a wrap and Claude designs it</b> for the car you've picked. It checks the PNG and the 3D car as it goes, then puts the finished file in the wrap input on the left.</p>
      <p>This uses <b>your own Claude API key</b>. You pay Anthropic directly for what you use; this site never sees your key or your bill. The running cost of each chat shows at the top.</p>
      <p><b>Getting a key</b> (a few minutes):</p>
      <ol><li>Sign in to the <a href="https://console.anthropic.com/" target="_blank" rel="noopener">Anthropic Console</a>. This is separate from a Claude.ai subscription.</li>
        <li>Add a few dollars of credit under <b>Billing</b>.</li>
        <li>Go to <b>API keys</b>, choose <b>Create key</b>, and copy it. It starts with <code>sk-ant-</code>.</li></ol>
      <input type="password" id="chKey" placeholder="Paste your API key (sk-ant-…)" autocomplete="off" spellcheck="false">
      <label><input type="checkbox" id="chRemember"> Remember on this device</label>
      <button class="ch-primary" id="chKeyGo">Start designing</button>
      <p class="ch-note">Your key goes from this browser straight to Anthropic and nowhere else. If you don't tick "Remember", it's forgotten when you close the page.</p>
      <div class="ch-err" id="chKeyErr">${err ? esc(err) : ''}</div></div>`;
    const go = async () => {
      const k = $('chKey').value.trim(); if (!k) return;
      $('chKeyGo').disabled = true; $('chKeyErr').textContent = '';
      try {
        const r = await fetch(API + '/models?limit=1', { headers: headers(k) });
        if (r.status === 401 || r.status === 403) throw new Error('Anthropic didn\'t accept that key. Check you copied all of it.');
        if (!r.ok) throw new Error(`Anthropic answered ${r.status}. Try again in a moment.`);
        S.key = k; if ($('chRemember').checked) store.set('wc.key', k);
        body.innerHTML = ''; hello();
      } catch (e) { $('chKeyErr').textContent = e.message === 'Failed to fetch' ? 'Couldn\'t reach Anthropic. Check your connection.' : e.message; $('chKeyGo').disabled = false; }
    };
    $('chKeyGo').onclick = go; $('chKey').onkeydown = e => { if (e.key === 'Enter') go(); };
  }
  function hello() {
    $('chCompose').hidden = false;
    add(md(`Tell me what you'd like on your **${WrapCheck.carName()}**: colours, a theme, a team, text, a pattern. Attach or paste pictures and logos, or draw on the car with the annotate tool and I'll see your marks.` + (S.doc ? `\n\nI still have your last design (**${S.doc.name || 'untitled'}**) if you want to keep working on it.` : '')), 'ch-msg');
  }

  // ---------------------------------------------------------------- attachments: files, paste, drop, annotations
  const readUrl = blob => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(blob); });
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image could not be read')); i.src = src; });
  const b64 = url => url.slice(url.indexOf(',') + 1);
  function fitCanvas(img, max) { const k = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * k)); c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * k)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c; }
  const hasAlpha = c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true; return false; };
  // What the model sees (scaled to at most 1568 px) and, for images, an art copy at full resolution (or the SVG itself) for att: hrefs.
  async function makeAttachment(file, label, note, annotation) {
    const id = String(S.nextAtt++), name = label || file.name || 'pasted image';
    if (file.type === 'application/pdf') return { id, name, kind: 'pdf', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(await readUrl(file)) } }, thumb: null, note };
    if (!file.type.startsWith('image/')) throw new Error(`${name}: only images and PDFs can be attached`);
    const url = await readUrl(file), img = await loadImg(url), svg = file.type === 'image/svg+xml';
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    const view = fitCanvas(img, MAX_SIDE), alpha = hasAlpha(view), vurl = alpha ? view.toDataURL('image/png') : view.toDataURL('image/jpeg', 0.9);
    let art = url, aw = w, ah = h;
    if (svg) { aw = ah = null; } else if (Math.max(w, h) > 4096) { const c = fitCanvas(img, 4096); art = c.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.92); aw = c.width; ah = c.height; }
    if (!annotation) WrapCompose.setAsset(id, art, aw, ah);
    return { id, name, kind: annotation ? 'annotation' : 'image', thumb: vurl, block: { type: 'image', source: { type: 'base64', media_type: alpha ? 'image/png' : 'image/jpeg', data: b64(vurl) } }, size: svg ? 'vector (SVG)' : `${w}×${h}`, note };
  }
  function chips() {
    const list = [...S.pending.map((a, i) => `<div class="ch-chip">${a.thumb ? `<img src="${a.thumb}" alt="">` : '📄'}<span title="${esc(a.name)}">${esc(a.name)}</span><button data-i="${i}" aria-label="Remove">✕</button></div>`)];
    if (S.live) list.push(`<div class="ch-chip live">✏️<span>Annotation on the car (${S.live.count} mark${S.live.count > 1 ? 's' : ''}), sent with your message</span></div>`);
    $('chChips').innerHTML = list.join('');
    $('chChips').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => { S.pending.splice(+b.dataset.i, 1); chips(); });
  }
  async function attachFiles(files) {
    for (const f of files) { try { S.pending.push(await makeAttachment(f)); } catch (e) { add(esc(e.message), 'ch-err'); } }
    chips();
  }
  $('chAttach').onclick = () => $('chFile').click();
  $('chFile').onchange = () => { attachFiles([...$('chFile').files]); $('chFile').value = ''; };
  input.addEventListener('paste', e => { const fs = [...(e.clipboardData && e.clipboardData.files || [])]; if (fs.length) { e.preventDefault(); attachFiles(fs); } });
  root.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); root.classList.add('drop-over'); });
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('drop-over'); });
  root.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); root.classList.remove('drop-over'); if (S.key) attachFiles([...e.dataTransfer.files]); });
  addEventListener('wrapcheck:markup', e => { S.live = e.detail.on && e.detail.count ? e.detail : null; chips(); });
  const annoNote = view => `Annotation from the 3D view at ${view}: the coloured marks (pen, boxes, circles, arrows, text) are the user's notes, drawn on a still of the car with the wrap it showed then. They are not part of the wrap.`;
  addEventListener('wrapcheck:annotation', e => {             // annotate closed with marks: the picture becomes an attachment
    const { blob, view } = e.detail;
    const p = blob.then(b => b && makeAttachment(new File([b], 'annotation.png', { type: 'image/png' }), `Annotation (${view})`, annoNote(view), true)).then(a => { if (a) { S.pending.push(a); chips(); } }).catch(() => {});
    S.annoWait = p; S.live = null; chips();
  });
  addEventListener('wrapcheck:car', e => { S.carNote = e.detail.car; if (S.busy) S.carChanged = true; });

  // ---------------------------------------------------------------- talking to Claude
  const headers = (key = S.key, beta) => Object.assign({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, beta ? { 'anthropic-beta': beta } : {});
  function usage(u) {
    if (!u) return; const p = (MODELS.find(m => m.id === S.lastModel) || modelInfo()).price;
    S.cost += ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6; money();
  }
  // One streamed request. Builds the assistant message exactly as sent (thinking blocks and all), and shows it as it arrives.
  async function call() {
    const m = modelInfo(), fb = m.fallbacks && !S.noFallbacks;
    const req = { model: m.id, max_tokens: 64000, stream: true, system: SYSTEM, tools: tools(), messages: S.messages,
      thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: m.effort }, cache_control: { type: 'ephemeral' } };
    if (fb) req.fallbacks = 'default';
    S.lastModel = m.id;
    let r;
    for (let attempt = 0; ; attempt++) {
      S.ctl = new AbortController();
      r = await fetch(API + '/messages', { method: 'POST', headers: headers(S.key, fb ? 'server-side-fallback-2026-07-01' : null), body: JSON.stringify(req), signal: S.ctl.signal });
      if (r.ok) break;
      const err = await r.json().catch(() => ({})), msg = (err.error && err.error.message) || '';
      if (r.status === 400 && fb && /fallback/i.test(msg)) { S.noFallbacks = true; return call(); }
      if (r.status === 400 && !S.noSearch && /web_search/i.test(msg)) { S.noSearch = true; return call(); }
      if (r.status === 401) { S.key = null; store.set('wc.key', null); throw Object.assign(new Error('Anthropic no longer accepts this API key.'), { key: true }); }
      if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 4) {
        const wait = Math.min(60, +(r.headers.get('retry-after') || 0) || 2 ** attempt * 3);
        const n = add(`${r.status === 429 ? 'Rate limited' : 'Anthropic is busy'}; trying again in ${wait} s…`, 'ch-tool'); await sleep(wait * 1000); n.remove(); continue;
      }
      throw new Error(msg || `Anthropic answered ${r.status}.`);
    }
    const blocks = [], ui = {}, out = { content: blocks, stop_reason: null, stop_details: null, model: null };
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', use = {};
    const show = (i, b) => {
      if (b.type === 'text') { ui[i] ||= add('', 'ch-msg'); ui[i].innerHTML = md(b.text); scrollDown(); }
      else if (b.type === 'thinking' && b.thinking) { if (!ui[i]) { ui[i] = add('<details class="ch-think"><summary>Thinking</summary><div></div></details>', ''); } ui[i].querySelector('div').textContent = b.thinking; scrollDown(); }
      else if (b.type === 'server_tool_use' && b.name === 'web_search') { ui[i] ||= add('', 'ch-tool'); ui[i].textContent = 'Searching the web' + (b.input && b.input.query ? `: ${b.input.query}` : ''); }
      else if (b.type === 'web_search_tool_result') { const res = Array.isArray(b.content) ? b.content : []; ui[i] ||= add('', 'ch-tool'); ui[i].innerHTML = res.length ? 'Read: ' + res.slice(0, 5).map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>`).join(', ') : 'The search found nothing usable.'; }
      else if (b.type === 'tool_use') { ui[i] ||= add('', 'ch-tool run'); ui[i].textContent = toolLabel(b.name); }
    };
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'message_start') { out.model = ev.message.model; use = { ...ev.message.usage }; }
        else if (ev.type === 'content_block_start') { const b = { ...ev.content_block }; if (b.type === 'tool_use' || b.type === 'server_tool_use') { b._json = ''; } blocks[ev.index] = b; show(ev.index, b); }
        else if (ev.type === 'content_block_delta') {
          const b = blocks[ev.index], d = ev.delta; if (!b) continue;
          if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
          else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
          else if (d.type === 'signature_delta') b.signature = d.signature;
          else if (d.type === 'input_json_delta') b._json += d.partial_json;
          else if (d.type === 'citations_delta') (b.citations ||= []).push(d.citation);
          show(ev.index, b);
        } else if (ev.type === 'content_block_stop') {
          const b = blocks[ev.index];
          if (b && '_json' in b) { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b._bad = b._json; b.input = {}; } delete b._json; show(ev.index, b); }
        } else if (ev.type === 'message_delta') { out.stop_reason = ev.delta.stop_reason; out.stop_details = ev.delta.stop_details || null; for (const [k, v] of Object.entries(ev.usage || {})) if (typeof v === 'number') use[k] = v; }   // counts here are totals for the request
        else if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'The stream failed.');
      }
    }
    out.ui = ui; usage(use);
    if (out.model && out.model !== m.id) add(`Answered by ${esc(out.model)} (Anthropic's fallback for this request).`, 'ch-note');
    return out;
  }
  const toolLabel = n => ({ get_car: 'Reading the car and its template', study_car: 'Studying the car', set_design: 'Building the PNG', edit_design: 'Updating the PNG', inspect_png: 'Zooming in on the PNG', render: 'Looking at the car', compare_view: 'Comparing the drawing with the car', finish: 'Delivering the wrap' }[n] || n);

  // The conversation loop: request, run the tools it asks for (one at a time: they share the 3D car), send every result back
  // in one message, until Claude stops. The history is only ever appended to.
  async function run() {
    S.busy = true; busyUi();
    try {
      for (let turn = 0; turn < 60; turn++) {
        const msg = await call(), content = msg.content.filter(Boolean).map(b => { const c = { ...b }; delete c._bad; return c; });
        S.messages.push({ role: 'assistant', content });
        if (msg.stop_reason === 'pause_turn') continue;
        if (msg.stop_reason === 'refusal') { add(`Claude declined this request${msg.stop_details && msg.stop_details.category ? ` (${esc(msg.stop_details.category)})` : ''}. Try rewording it.`, 'ch-err'); break; }
        const uses = msg.content.filter(b => b && b.type === 'tool_use');
        if (msg.stop_reason === 'max_tokens') { add('Claude ran out of room in that answer. Ask it to continue, or to make a smaller change.', 'ch-err'); if (uses.length) S.messages.push({ role: 'user', content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run: your answer was cut off at max_tokens, so this input may be incomplete.' })) }); break; }
        if (msg.stop_reason !== 'tool_use' || !uses.length) break;
        const results = [];
        for (const u of uses) {
          const row = msg.ui[msg.content.indexOf(u)] || add('', 'ch-tool run');
          if (!S.busy || S.stopped) { results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Stopped by the user.' }); continue; }
          results.push(await runTool(u, row));
        }
        if (S.carChanged) { S.carChanged = false; results.push({ type: 'text', text: carChangedNote() }); S.carNote = null; }
        S.messages.push({ role: 'user', content: results });
        if (S.stopped) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') add('Stopped.', 'ch-note');
      else if (e.key) keyScreen(e.message);
      else add(esc(e.message === 'Failed to fetch' ? 'Couldn\'t reach Anthropic. Check your connection and try again.' : e.message), 'ch-err');
    } finally { S.busy = false; S.stopped = false; S.ctl = null; busyUi(); }
  }
  const carChangedNote = () => `[The user switched the car to ${WrapCheck.carName()} (${WrapCheck.state().car}). Its template, panels and views are different: call get_car and study_car, then rebuild the design for this car.]`;
  function busyUi() { const b = $('chSend'); b.textContent = S.busy ? '■' : '➤'; b.classList.toggle('stop', S.busy); b.setAttribute('aria-label', S.busy ? 'Stop' : 'Send'); }

  async function sendMessage() {
    if (S.busy) { S.stopped = true; if (S.ctl) S.ctl.abort(); return; }
    const text = input.value.trim();
    if (S.live) { WrapCheck.closeAnnotate(); }
    if (S.annoWait) { await S.annoWait; S.annoWait = null; }
    if (!text && !S.pending.length) return;
    const atts = S.pending.splice(0); chips(); input.value = ''; autosize();
    const content = [];
    const first = !S.messages.length;
    if (first) content.push({ type: 'text', text: `[Selected car: ${WrapCheck.carName()} (${WrapCheck.state().car}).` + (S.doc ? ` The current design document from earlier, which the user may want to keep working on: ${JSON.stringify(S.doc).length < 60000 ? JSON.stringify(S.doc) : '(too long to include; it is still loaded, so edit_design works on it)'}` : '') + ']' });
    else if (S.carNote) { content.push({ type: 'text', text: carChangedNote() }); S.carNote = null; }
    for (const a of atts) { content.push(a.block); content.push({ type: 'text', text: `[Attachment att:${a.id}: ${a.name}${a.size ? `, ${a.size}` : ''}${a.kind === 'image' ? `. Usable as art: <image href="att:${a.id}" …/>` : ''}${a.note ? '. ' + a.note : ''}]` }); }
    if (text) content.push({ type: 'text', text });
    const u = add(esc(text || '(attachments)') + (atts.some(a => a.thumb) ? `<div class="ch-thumbs">${atts.filter(a => a.thumb).map(a => `<img src="${a.thumb}" alt="${esc(a.name)}">`).join('')}</div>` : ''), 'ch-msg ch-user');
    u.scrollIntoView({ block: 'end' });
    const last = S.messages[S.messages.length - 1];
    if (last && last.role === 'user') last.content.push(...content);        // the previous request was stopped before Claude answered
    else S.messages.push({ role: 'user', content });
    S.car = WrapCheck.state().car;
    run();
  }
  $('chSend').onclick = sendMessage;
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(180, input.scrollHeight + 2) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });

  // ---------------------------------------------------------------- tools
  const blobUrl = async (blob) => readUrl(blob);
  const imgBlock = (url, media) => ({ type: 'image', source: { type: 'base64', media_type: media || url.slice(5, url.indexOf(';')), data: b64(url) } });
  const canvasUrl = (c, max = MAX_SIDE, png) => { const s = Math.min(1, max / Math.max(c.width, c.height)); let d = c; if (s < 1) { d = document.createElement('canvas'); d.width = Math.round(c.width * s); d.height = Math.round(c.height * s); const x = d.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, d.width, d.height); } return png ? d.toDataURL('image/png') : d.toDataURL('image/jpeg', 0.9); };
  const toCanvas = async src => { const b = src instanceof Blob ? await createImageBitmap(src) : src; const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; c.getContext('2d').drawImage(b, 0, 0); return c; };
  const thumbs = (row, urls) => { if (urls.length) row.insertAdjacentHTML('beforeend', `<div class="ch-thumbs">${urls.map(u => `<img src="${u}" alt="">`).join('')}</div>`); scrollDown(); };
  const car = () => WrapCheck.state().car;
  async function needCar() {                               // tools that photograph the car wait for it to finish loading
    for (let i = 0; i < 120 && !WrapCheck.state().carLoaded; i++) await sleep(500);
    if (!WrapCheck.state().carLoaded) throw new Error('The 3D car has not finished loading; try again in a moment.');
  }
  // Crop a photo to the car (everything that differs from the background), with a margin.
  function cropCar(c, margin = 0.04) {
    const w = 320, h = Math.max(8, Math.round(w * c.height / c.width)), t = document.createElement('canvas'); t.width = w; t.height = h; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, bg = [d[0], d[1], d[2]]; let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let X = 0; X < w; X++) { const i = (y * w + X) * 4; if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 36) { if (X < x0) x0 = X; if (X > x1) x1 = X; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 <= x0) return c;
    const k = c.width / w, m = margin * c.width, bx0 = Math.max(0, x0 * k - m), by0 = Math.max(0, y0 * k - m), bx1 = Math.min(c.width, (x1 + 1) * k + m), by1 = Math.min(c.height, (y1 + 1) * k + m);
    return crop(c, [bx0, by0, bx1, by1]);
  }
  function crop(c, [x0, y0, x1, y1]) { const o = document.createElement('canvas'); o.width = Math.max(1, Math.round(x1 - x0)); o.height = Math.max(1, Math.round(y1 - y0)); o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height); return o; }
  function sheet(items, cols, cell) {                       // a contact sheet of labelled pictures
    const rows = Math.ceil(items.length / cols), c = document.createElement('canvas'); c.width = cols * cell; c.height = rows * cell; const x = c.getContext('2d');
    x.fillStyle = '#111'; x.fillRect(0, 0, c.width, c.height);
    items.forEach(({ img, label }, i) => {
      const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell, s = Math.min((cell - 8) / img.width, (cell - 28) / img.height);
      x.drawImage(img, cx + (cell - img.width * s) / 2, cy + 24 + (cell - 28 - img.height * s) / 2, img.width * s, img.height * s);
      x.fillStyle = '#fff'; x.font = '600 15px sans-serif'; x.fillText(label, cx + 6, cy + 17);
    });
    return c;
  }
  const calibrated = async () => { const c = await WrapCompose.loadCalibration(car()); return c.error ? null : c; };
  // Close-ups. From a calibrated camera the app already knows where every panel is on screen (calib/<car>.json), so one sharp shot
  // at that camera's own framing gives exact crops of any number of panels. From another angle, the panels are found by showing
  // them white on black for a moment.
  const CAL_S = 1.6;                                        // calibration frames are 2400 × 1500; shot at 3840 × 2400
  async function calibratedCrops(groups) {                  // groups: [{ ids, label }] -> [{ img, label }] using the view that paints most of each group
    const cal = await calibrated(), m = await WrapCompose.panelMap(car()); if (!cal) return null;
    const { gw, cells } = cal.grid, byView = {};
    for (const g of groups) {
      const tally = {}; for (const id of g.ids) { const p = m.panels.find(q => q.id === id); if (p && p.seenBy) for (const [v, k] of Object.entries(p.seenBy)) tally[v] = (tally[v] || 0) + k; }
      const view = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]; if (!view) continue;
      (byView[view[0]] ||= []).push(g);
    }
    const out = [];
    for (const [name, gs] of Object.entries(byView)) {
      const v = cal.views[name]; await WrapCheck.agent.camera(v.camera);
      const shot = await WrapCheck.agent.shot({ device: v.render.map(n => n * CAL_S) }), k = shot.height / v.render[1], sx = X => shot.width / 2 + (X - v.render[0] / 2) * k;
      for (const g of gs) {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const want = new Set(g.ids);
        for (let c = 0; c < cells.length; c++) if (want.has(cells[c]) && v.X[c] >= 0) { x0 = Math.min(x0, v.X[c]); x1 = Math.max(x1, v.X[c]); y0 = Math.min(y0, v.Y[c]); y1 = Math.max(y1, v.Y[c]); }
        if (x1 < x0) continue;
        const mx = (x1 - x0) * 0.2 + 16, my = (y1 - y0) * 0.2 + 16;
        out.push({ img: crop(shot, [Math.max(0, sx(x0 - mx)), Math.max(0, (y0 - my) * k), Math.min(shot.width, sx(x1 + mx)), Math.min(shot.height, (y1 + my) * k)]), label: `${g.label} (from the ${name} camera)`, ids: g.ids });
      }
    }
    return out;
  }
  async function closeUpAt(ids, angle) {                    // from a named angle: find the panels on screen, then crop
    await WrapCheck.agent.camera(angle);
    const shot = await WrapCheck.agent.shot({ S: 3 }), at = await WrapCheck.agent.locate(ids);
    if (!at) return { img: cropCar(shot), found: false };
    const k = shot.width / at.w, [x0, y0, x1, y1] = at.box.map(v => v * k), mx = (x1 - x0) * 0.18 + 12, my = (y1 - y0) * 0.18 + 12;
    return { img: crop(shot, [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(shot.width, x1 + mx), Math.min(shot.height, y1 + my)]), found: true };
  }

  // A small persistent cache for study_car's pictures (they only change when Tesla changes the template).
  const idb = (() => { let p; const open = () => p ??= new Promise((res, rej) => { const r = indexedDB.open('wrapcheck-chat', 1); r.onupgradeneeded = () => r.result.createObjectStore('study'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('study', mode), q = fn(t.objectStore('study')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
    return { get: k => tx('readonly', s => s.get(k)).catch(() => null), set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}) }; })();

  function checkDoc(d) {
    if (!d || typeof d !== 'object') throw new Error('design must be an object');
    if (!Array.isArray(d.layers)) throw new Error('design.layers must be an array');
    if (d.base && !d.base.color && !d.base.svg) throw new Error('base needs color or svg');
    d.layers.forEach((l, i) => {
      if (!l || !SURFACES.includes(l.surface)) throw new Error(`layer ${i}: surface must be one of ${SURFACES.join(', ')}`);
      if (typeof l.svg !== 'string' || !/^\s*<svg[\s>]/i.test(l.svg)) throw new Error(`layer ${i}: svg must be a complete <svg> document`);
      const bad = new DOMParser().parseFromString(l.svg, 'image/svg+xml').querySelector('parsererror');
      if (bad) throw new Error(`layer ${i}: the SVG is not valid XML: ${bad.textContent.split('\n').slice(0, 2).join(' ').slice(0, 200)}`);
    });
    return d;
  }
  function applyOps(doc, ops) {
    const d = JSON.parse(JSON.stringify(doc)); d.layers ||= [];
    const at = i => { if (!Number.isInteger(i) || i < 0 || i >= d.layers.length) throw new Error(`no layer ${i} (there are ${d.layers.length})`); return i; };
    for (const [n, o] of ops.entries()) {
      try {
        if (o.op === 'patch_svg') { const l = d.layers[at(o.index)], c = l.svg.split(o.find).length - 1; if (!o.find || c !== 1) throw new Error(`find text occurs ${c} times in layer ${o.index}; it must occur exactly once`); l.svg = l.svg.replace(o.find, () => o.replace ?? ''); }
        else if (o.op === 'replace_layer') d.layers[at(o.index)] = o.layer;
        else if (o.op === 'insert_layer') d.layers.splice(o.index == null ? d.layers.length : Math.max(0, Math.min(d.layers.length, o.index)), 0, o.layer);
        else if (o.op === 'remove_layer') d.layers.splice(at(o.index), 1);
        else if (o.op === 'move_layer') { const [l] = d.layers.splice(at(o.index), 1); d.layers.splice(Math.max(0, Math.min(d.layers.length, o.to)), 0, l); }
        else if (o.op === 'set_base') d.base = o.base;
        else if (o.op === 'set_name') d.name = o.name;
        else throw new Error('unknown op ' + o.op);
      } catch (e) { throw new Error(`op ${n} (${o.op}): ${e.message}`); }
    }
    return d;
  }
  // Export the design exactly as it would be delivered, put it on the car as a draft, and report what is wrong with the file.
  async function build(doc, row) {
    checkDoc(doc);
    const r = await WrapCompose.exportWrap(doc, car(), { stats: true }), url = await blobUrl(r.blob);
    const v = await WrapCheck.setWrap(b64(url), r.name);                          // validates and shows it on the car
    S.doc = doc; S.version++; S.last = { blob: r.blob, name: r.name, url, car: car() };
    store.set('wc.design', JSON.stringify({ car: car(), doc }));
    WrapCheck.draft(`Claude's draft v${S.version}: ${r.name.replace(/\.png$/, '')}`);
    thumbs(row, [url]);
    const L = [`Design v${S.version} exported for ${WrapCheck.carName()}: ${r.name}, ${r.w}×${r.h}, ${Math.round(r.bytes / 1024)} KB` + (r.reduced ? `, reduced to ${r.colors} colours to fit under 1 MB (look for banding in gradients and photos)` : ', lossless') + '. It is now on the 3D car.'];
    L.push('Tesla checks: ' + v.rows.map(x => `${x.level === 'ok' ? '✓' : x.level === 'warn' ? '!' : '✗'} ${x.text}`).join('; '));
    const part = r.coverage.filter(c => c.pct > 0 && c.pct < 97), none = r.coverage.filter(c => c.pct === 0);
    L.push(`Panel coverage: ${r.coverage.filter(c => c.pct >= 97).length} of ${r.coverage.length} fully painted` + (part.length ? `; partly: ${part.map(c => `P${c.id} ${c.pct}%`).join(', ')}` : '') + (none.length ? `; unpainted (car paint shows): ${none.map(c => 'P' + c.id).join(', ')}` : '') + '.');
    for (const l of r.layers) {
      const bits = [];
      if (l.surface !== 'canvas' && l.drawnPx) { if (l.otherViewPct >= 1) bits.push(`${l.otherViewPct}% of what you drew falls where another view paints, so it is lost`); if (l.offCarPct >= 1) bits.push(`${l.offCarPct}% is off the car`); }
      for (const im of l.images) if (im.scale > 1.15) bits.push(`${im.href} is enlarged ${im.scale}× (from ${im.natural.join('×')}), so it will look soft`);
      if (bits.length) L.push(`Layer ${l.layer} (${l.surface}): ${bits.join('; ')}.`);
    }
    L.push(`Layers now: ${doc.layers.map((l, i) => `${i} ${l.surface} (${(l.svg.length / 1024).toFixed(1)} KB)`).join(', ') || 'none'}.`);
    L.push('The image is the exact file. Check it first (panels, seams, edges, text), zoom in with inspect_png, then render the car.');
    return [{ type: 'text', text: L.join('\n') }, imgBlock(url, 'image/png')];
  }

  const TOOL_FNS = {
    async get_car(_, row) {
      const id = car(), t = await WrapCompose.loadTemplate(id), m = await WrapCompose.panelMap(id), sf = await WrapCompose.surfaces(id);
      const out = [], urls = [];
      const tpl = await toCanvas(await (await fetch(t.url)).blob()), map = await blobUrl(await WrapCompose.panelMapImage(id));
      const views = Object.entries(sf.views).map(([n, v]) => `${n}: ${v.width}×${v.height} px (viewBox "0 0 ${v.width} ${v.height}"); looks at ${v.looking}`);
      out.push({ type: 'text', text: [`Car: ${WrapCheck.carName()} (${id}). Template ${t.w}×${t.h} from Tesla's custom-wraps repo (opaque white = panel, darker opaque lines = seams on the car, transparent = gaps).`,
        `Tesla's rules (the app enforces them): PNG, ${t.w}×${t.h}, under 1 MB, file name of letters, digits, _ - and spaces up to 30 characters.`,
        sf.note ? `Car views: none (${sf.note}) — use canvas layers.` : `Car views (draw at these sizes; each has a guide image below, in this order):\n${views.join('\n')}`,
        'Panel map table (from the 3D model; confirm with study_car):', WrapCompose.panelMapText(m)].join('\n') });
      out.push({ type: 'text', text: 'Tesla\'s template:' }, imgBlock(canvasUrl(tpl, 1024, true)));
      out.push({ type: 'text', text: 'Panel map: tinted by the view that paints each part (left blue, right green, front orange, rear purple, top grey; red hatching = no camera sees it), panel IDs, big arrows to the car\'s up (FRONT on parts seen from above), small arrows for the local direction.' }, imgBlock(map, 'image/png'));
      urls.push(map);
      for (const n of Object.keys(sf.views)) { const g = await blobUrl(await WrapCompose.guide(id, n)); out.push({ type: 'text', text: `Guide for the ${n} view (${sf.views[n].width}×${sf.views[n].height}${sf.views[n].width > MAX_SIDE ? `, shown scaled down; draw at the full size` : ''}):` }, imgBlock(canvasUrl(await toCanvas(await (await fetch(g)).blob()), MAX_SIDE, true))); }
      thumbs(row, urls);
      return out;
    },
    async study_car(_, row) {
      await needCar();
      const id = car(), t = await WrapCompose.loadTemplate(id), key = `${id}:${t.sha256}:v1`;
      let cached = await idb.get(key);
      if (!cached) {
        const m = await WrapCompose.panelMap(id), tex = await WrapCompose.studyTexture(id), texC = await toCanvas(await tex.convertToBlob({ type: 'image/png' }));
        await WrapCheck.agent.begin('Claude is studying the car…');
        try {
          await WrapCheck.agent.show(WrapCheck.agent.texture(texC));
          const angles = [];
          for (const v of WrapCheck.views()) { row.textContent = `Studying the car: ${v.replace('_', ' ')}`; await WrapCheck.agent.camera(v); angles.push({ img: cropCar(await WrapCheck.agent.shot({ S: 1.5 })), label: v }); }
          row.textContent = 'Studying the car: close-ups of the small panels';
          const small = m.panels.filter(p => p.areaPct < 1.2 && p.view).slice(0, 12), close = (await calibratedCrops(small.map(p => ({ ids: [p.id], label: 'P' + p.id })))) || [];
          const ang = angles.map(a => canvasUrl(a.img));
          cached = { angles: ang, labels: angles.map(a => a.label), sheet: close.length ? canvasUrl(sheet(close, close.length > 6 ? 4 : 3, 400)) : null };
          await idb.set(key, cached);
        } finally { await WrapCheck.agent.end(); }
      }
      S.studied[id] = true; row.textContent = toolLabel('study_car');
      const out = [{ type: 'text', text: `The study texture on the 3D ${WrapCheck.carName()}: each panel a colour with its ID (P#), a red arrow to the car's up (FRONT on parts seen from above), "ABC 123" written as the panel map says reads upright, and a grid every 64 template px (heavier every 256). Check the table against these: where "ABC 123" reads backwards or sideways, or neighbours differ, trust the pictures. Your current design is back on the car.` }];
      cached.angles.forEach((u, i) => out.push({ type: 'text', text: `From ${cached.labels[i]}:` }, imgBlock(u)));
      if (cached.sheet) out.push({ type: 'text', text: 'Close-ups of the small panels:' }, imgBlock(cached.sheet));
      thumbs(row, cached.angles.slice(0, 4).concat(cached.sheet ? [cached.sheet] : []));
      return out;
    },
    async set_design(a, row) { return build(a.design, row); },
    async edit_design(a, row) { if (!S.doc) throw new Error('There is no design yet; use set_design first.'); if (!Array.isArray(a.ops) || !a.ops.length) throw new Error('ops must be a non-empty array'); return build(applyOps(S.doc, a.ops), row); },
    async inspect_png(a, row) {
      if (!S.last) throw new Error('Nothing exported yet; use set_design first.');
      if (S.last.car !== car()) throw new Error('The car changed since the last export; rebuild the design first.');
      const r = await WrapCompose.inspect(S.last.blob, car(), { panels: a.panels, box: a.box, zoom: Math.max(2, Math.min(8, a.zoom || 4)) });
      const c = await toCanvas(r.blob), url = canvasUrl(c, MAX_SIDE, true); thumbs(row, [url]);
      return [{ type: 'text', text: `Template x ${r.box[0]}–${r.box[2]}, y ${r.box[1]}–${r.box[3]} at ${r.zoom}×${c.width > MAX_SIDE || c.height > MAX_SIDE ? ' (scaled to fit; ask for a smaller area to see single pixels)' : ''}. Cyan lines are panel edges; grey checks are transparent.` }, imgBlock(url, 'image/png')];
    },
    async render(a, row) {
      await needCar();
      const views = (a.views && a.views.length ? a.views : a.focus && a.focus.length ? [] : ['three_quarter', 'rear_right', 'top']).slice(0, 5), out = [], urls = [];
      await WrapCheck.agent.begin();
      try {
        for (const v of views) { await WrapCheck.agent.camera(v); const u = canvasUrl(cropCar(await WrapCheck.agent.shot({ S: 2 }))); out.push({ type: 'text', text: `From ${v}:` }, imgBlock(u)); urls.push(u); }
        if (a.focus && a.focus.length) {
          const label = a.focus.map(i => 'P' + i).join(', ');
          if (a.angle) {
            const r = await closeUpAt(a.focus, a.angle), u = canvasUrl(r.img, MAX_SIDE);
            out.push({ type: 'text', text: `Close-up of ${label} from ${a.angle} (${r.img.width}×${r.img.height} px${r.found ? '' : '; the panels were not found on screen from here, so this is the whole car: try another angle'}):` }, imgBlock(u)); urls.push(u);
          } else {
            const crops = await calibratedCrops([{ ids: a.focus, label }]);
            if (!crops || !crops.length) throw new Error('No calibrated camera sees those panels; give an angle.');
            for (const c of crops) { const u = canvasUrl(c.img, MAX_SIDE); out.push({ type: 'text', text: `Close-up of ${c.label}, ${c.img.width}×${c.img.height} px:` }, imgBlock(u)); urls.push(u); }
          }
        }
      } finally { await WrapCheck.agent.end(); }
      thumbs(row, urls);
      return out;
    },
    async compare_view(a, row) {
      await needCar();
      const cal = await calibrated(); if (!cal) throw new Error('This car has no calibrated views.');
      const v = cal.views[a.view]; if (!v) throw new Error(`No ${a.view} view for this car.`);
      const layers = (S.doc && S.doc.layers || []).filter(l => l.surface === a.view); if (!layers.length) throw new Error(`No layer uses the ${a.view} view.`);
      const m = WrapCompose.viewMasks(cal, a.view), cw = m.cw, ch = m.ch;
      const draw = document.createElement('canvas'); draw.width = cw; draw.height = ch; const dx = draw.getContext('2d');
      for (const l of layers) { const svg = l.svg.replace(/((?:xlink:)?href\s*=\s*["'])att:([\w-]+)(["'])/g, (q, p1, i, p3) => p1 + ((WrapCompose.assets.get(i) || {}).url || '') + p3); const im = new Image(); im.src = URL.createObjectURL(new Blob([/xmlns=/.test(svg.slice(0, svg.indexOf('>'))) ? svg : svg.replace(/^\s*<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')], { type: 'image/svg+xml' })); await im.decode(); dx.drawImage(im, 0, 0, cw, ch); }
      let shot;
      await WrapCheck.agent.begin();
      try { await WrapCheck.agent.camera(v.camera); shot = await WrapCheck.agent.shot({ device: v.render }); } finally { await WrapCheck.agent.end(); }
      // the calibration's frame was render[0] × render[1]; the engine keeps the vertical field of view, so other sizes scale by height
      const k = shot.height / v.render[1], sx = X => shot.width / 2 + (X - v.render[0] / 2) * k, sy = Y => Y * k;
      const carC = document.createElement('canvas'); carC.width = cw; carC.height = ch; carC.getContext('2d').drawImage(shot, sx(v.crop[0]), sy(v.crop[1]), cw * k, ch * k, 0, 0, cw, ch);
      const res = compareEdges(draw, carC, m);
      const third = carC.cloneNode(); const tx = third.getContext('2d'); tx.drawImage(carC, 0, 0); tx.lineWidth = 3;
      for (const b of res.flags) { tx.strokeStyle = b.kind === 'soft' ? '#ffd400' : '#ff2a2a'; tx.strokeRect(b.x + 1.5, b.y + 1.5, b.s - 3, b.s - 3); }
      const guide = await toCanvas(await WrapCompose.guide(car(), a.view)); const dg = document.createElement('canvas'); dg.width = cw; dg.height = ch; const gx = dg.getContext('2d'); gx.drawImage(guide, 0, 0); gx.drawImage(draw, 0, 0);
      const stack = document.createElement('canvas'); stack.width = cw; stack.height = ch * 3 + 16; const sx2 = stack.getContext('2d'); sx2.fillStyle = '#000'; sx2.fillRect(0, 0, stack.width, stack.height);
      sx2.drawImage(dg, 0, 0); sx2.drawImage(carC, 0, ch + 8); sx2.drawImage(third, 0, 2 * ch + 16);
      const url = canvasUrl(stack); thumbs(row, [url]);
      const by = {}; for (const b of res.flags) { (by[b.panel] ||= { soft: 0, moved: 0, x: b.x, y: b.y }); by[b.panel][b.kind === 'soft' ? 'soft' : 'moved']++; }
      const L = [`The ${a.view} view, ${cw}×${ch} (drawing coordinates). Top: your drawing over the guide. Middle: the car from the same camera. Bottom: the car with flagged ${res.size}-px blocks (yellow: edges much softer than drawn; red: edges in different places than drawn).`,
        `${res.checked} blocks with drawn edges checked; ${res.flags.filter(f => f.kind === 'soft').length} soft, ${res.flags.filter(f => f.kind !== 'soft').length} displaced.` + (res.flags.length ? ' By panel: ' + Object.entries(by).map(([p, c]) => `P${p}: ${c.soft} soft, ${c.moved} displaced (first near drawing x ${c.x}, y ${c.y})`).join('; ') + '.' : ' Nothing flagged.'),
        'Lighting and reflections can cause flags on glossy curves; judge from the pictures.'];
      return [{ type: 'text', text: L.join('\n') }, imgBlock(url)];
    },
    async finish(a, row) {
      if (!S.doc) throw new Error('There is no design yet.');
      const doc = a.name ? { ...S.doc, name: a.name } : S.doc;
      const r = await WrapCompose.exportWrap(doc, car()), file = new File([r.blob], r.name, { type: 'image/png' }), url = await blobUrl(r.blob);
      S.doc = doc; store.set('wc.design', JSON.stringify({ car: car(), doc }));
      await WrapCheck.loadWrapFile(file); WrapCheck.draft('');
      const card = add(`<img src="${url}" alt="${esc(r.name)}"><div class="row"><span>${esc(r.name)} · ready to upload to your ${esc(WrapCheck.carName())}</span><button class="ch-primary" type="button">Download</button></div>`, 'ch-final');
      card.querySelector('button').onclick = () => { const l = document.createElement('a'); l.href = URL.createObjectURL(file); l.download = r.name; l.click(); };
      row.textContent = 'Delivered ' + r.name;
      if (phone.matches) document.body.classList.remove('chat-open');
      return [{ type: 'text', text: `Delivered ${r.name}: it is in the wrap input on the left (with Tesla's checks, download and share) and shown in the chat. Now tell the user about the design in one or two sentences.` }];
    },
  };
  async function runTool(u, row) {
    row.classList.add('run'); row.textContent = toolLabel(u.name);
    try {
      if (u._bad != null) throw new Error(`Your input for ${u.name} was not valid JSON, so nothing ran. Send it again. It began: ${String(u._bad).slice(0, 200)}`);
      const fn = TOOL_FNS[u.name]; if (!fn) throw new Error('Unknown tool ' + u.name);
      const content = await fn(u.input || {}, row);
      row.classList.remove('run');
      return { type: 'tool_result', tool_use_id: u.id, content };
    } catch (e) {
      row.classList.remove('run'); row.classList.add('err'); row.textContent = `${toolLabel(u.name)}: ${e.message}`;
      return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: String(e.message || e) };
    }
  }

  // Where the car's edges differ from the drawing's: Sobel edge strength on both, compared in blocks the view paints. Lighting
  // changes colours but not where edges are, so soft blocks (the drawing has edges, the car much weaker ones relative to the rest)
  // and displaced blocks (both have edges, in different places) are what get flagged.
  function compareEdges(draw, carC, m, size = 24) {
    const { cw, ch, own, id } = m, lum = c => { const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch).data, L = new Float32Array(cw * ch), A = new Float32Array(cw * ch); for (let i = 0; i < L.length; i++) { L[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]; A[i] = d[i * 4 + 3]; } return { L, A }; };
    const blur = L => { const o = new Float32Array(L.length); for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += L[(y + j) * cw + x + i]; o[y * cw + x] = s / 9; } return o; };
    const sobel = L => { const g = new Float32Array(L.length); for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) { const p = y * cw + x, gx = L[p - cw + 1] + 2 * L[p + 1] + L[p + cw + 1] - L[p - cw - 1] - 2 * L[p - 1] - L[p + cw - 1], gy = L[p + cw - 1] + 2 * L[p + cw] + L[p + cw + 1] - L[p - cw - 1] - 2 * L[p - cw] - L[p - cw + 1]; g[p] = Math.hypot(gx, gy); } return g; };
    const D = lum(draw), C = lum(carC), gd = sobel(blur(D.L)), gc = sobel(blur(C.L)), blocks = [];
    for (let by = 0; by + size <= ch; by += size) for (let bx = 0; bx + size <= cw; bx += size) {
      let n = 0, ed = 0, ec = 0, sdd = 0, scc = 0, sdc = 0, drawn = 0; const ids = {};
      for (let y = by; y < by + size; y++) for (let x = bx; x < bx + size; x++) { const p = y * cw + x; if (!own[p]) continue; n++; if (D.A[p] > 0) drawn++; ed += gd[p]; ec += gc[p]; ids[id[p]] = (ids[id[p]] || 0) + 1; }
      if (n < size * size * 0.6 || drawn < n * 0.3 || ed / n < 25) continue;
      const md = ed / n, mc = ec / n;
      for (let y = by; y < by + size; y++) for (let x = bx; x < bx + size; x++) { const p = y * cw + x; if (!own[p]) continue; const a = gd[p] - md, b = gc[p] - mc; sdd += a * a; scc += b * b; sdc += a * b; }
      blocks.push({ x: bx, y: by, s: size, ratio: ec / ed, corr: sdc / Math.sqrt(sdd * scc || 1), panel: +Object.entries(ids).sort((p, q) => q[1] - p[1])[0][0] });
    }
    const rs = blocks.map(b => b.ratio).sort((a, b) => a - b), med = rs[rs.length >> 1] || 1, flags = [];
    for (const b of blocks) { if (b.ratio / med < 0.45) flags.push({ ...b, kind: 'soft' }); else if (b.corr < 0.25) flags.push({ ...b, kind: 'moved' }); }
    return { size, checked: blocks.length, flags };
  }

  // ---------------------------------------------------------------- start
  if (S.key) hello(); else keyScreen();
})();
