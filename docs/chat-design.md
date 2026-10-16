# In-app wrap chat: design

A chat panel inside the viewer. The user brings their own Anthropic (later OpenAI) key, describes a wrap, and the model designs it, renders it on the 3D car, looks, fixes, and hands back a PNG that already passes Tesla's rules. Everything runs in the user's browser: no server, no hosting cost, the key never leaves the device except to go to the provider.

## The car and its template

The car is **whatever is selected in the viewer's car dropdown**, never assumed. Every dropdown id is also a folder in Tesla's [custom-wraps](https://github.com/teslamotors/custom-wraps) repo, and the template is always:

```
https://raw.githubusercontent.com/teslamotors/custom-wraps/master/<car id>/template.png
```

| Dropdown | Car id | Template |
|---|---|---|
| Model Y (2025+) Premium | `modely-2025-premium` | 1024 × 1024 |
| Model Y (2025+) Performance | `modely-2025-performance` | 1024 × 1024 |
| Model Y (2025+) Standard | `modely-2025-base` | 1024 × 1024 |
| Model Y L | `modely-l` | 1024 × 1024 |
| Model Y (original) | `modely` | 1024 × 1024 |
| Model 3 (2024+) Standard & Premium | `model3-2024-base` | 1024 × 1024 |
| Model 3 (2024+) Performance | `model3-2024-performance` | 1024 × 1024 |
| Model 3 (original) | `model3` | 1024 × 1024 |
| Cybertruck | `cybertruck` | **1024 × 768** |

(Sizes read from the PNG headers on 2026-10-16. Tesla also publishes `models-2021`, `models-2025-plaid` and `modelx-2021`, but the viewer's engine doesn't paint wraps on S / X, so they aren't offered.)

- The export is always the **selected car's template size**, never a hard-coded 1024 × 1024.
- Fetch the template at chat start and re-fetch when the user switches cars; keep a fingerprint of it. If Tesla changes a template, anything precomputed for that car (surface transforms) is invalidated and the car falls back to canvas-only layers until it is recalibrated.
- **Switching cars mid-conversation:** the design document is in surface terms, so it can be recompiled for the new car where that car has the same surfaces. The model is told the car changed and re-renders before continuing; there is no silent carry-over.
- Tesla's rules, from the repo README: PNG, 512–1024 px per side (template size recommended), **no larger than 1 MB**, file name of letters, digits, underscores, dashes and spaces up to 30 characters. The app exports under **1,000,000 bytes** so the file passes whichever definition of "1 MB" Tesla uses (the viewer's current validator allows up to 1,048,576 bytes and should be tightened to match).

## What changes compared with the one-shot skill

`tesla-wrap-skill` was built to get a wrap right **without ever seeing it on the car**. Most of its bulk exists to stand in for that missing view: prose orientation rules, hand-marked ground edges, calibration photos of the in-car screen, "flag as unverified" caveats, and a geometry validator. In the app the model can just look. So the skill's knowledge splits three ways:

### Becomes code (the model never has to think about it)

| Skill rule | In the app |
|---|---|
| Composite through the ORIGINAL template alpha byte for byte; keep gap pixels; never scale or threshold masks | The compositor always does this. The model can't produce a file that breaks it, so the rule leaves the prompt. |
| `check_wrap.py` (size, dims, alpha, gaps, 20 panels) | Guaranteed by construction; `WrapCheck.validate` still runs on export as a belt-and-braces check. Not a model step. |
| `fit_size.py` color ladder (lossless first, then 256 → 4 colors, keep the most frequent exact colors, no dither, alpha untouched) | Ported to JS and run automatically on export, with the cap raised from the skill's 700 KB to Tesla's 1 MB. Most designs will now pass losslessly. |
| Filename rules (1–30 chars, letters/digits/space/_/-) | The model proposes a name; the app sanitizes it. |
| Panel-by-panel orientation table (rotate 90° CW on canvas-left, CCW on canvas-right, hood and bumper 180°, trunk upright…) | Replaced by **car views** (below): the model draws on a picture of the car as a camera sees it, and the app warps that onto the template. There is no orientation to reason about, and no rotated-text bugs on the first try. |
| Panel ID map (`modely-2025-premium-panel-ids.png`, `panel-map.json`) | Computed in the browser from the selected car's template (same 4-connected-cores + nearest-core fringe method), so it works for every car in the dropdown. |

### Stays as model knowledge (short system prompt)

These are judgement, and the render does not replace them:

- **Themed requests:** research first; take exact colors from the official guide; use official logo files as published, never redrawn or recolored; official typeface or the closest and say so. If assets can't be had, build from the official colors and say what was missing. (Trimmed from the skill almost word for word.)
- **Never mirror text or logos.**
- **Edits preserve approved details.**

### Dropped (the 3D render makes it redundant)

- `ground-edge-reference.png`, the calibration photos, `make_calibration_wrap.py`: they were evidence for orientation. The car is now the evidence.
- Every "open / unverified, flag it to the user" caveat (mirror caps, spoiler strip/lip split): render the close-up and look instead.
- "Look at the final image at full size and zoom in on text and seams": replaced by renders of the car.
- The placement manifest (axes, fit anchors, angles per panel).
- "Default to Model Y 2025 Premium, never ask" and the pinned Model Y template: the car is whatever the dropdown says, and its template comes live from Tesla's repo.
- The 700 KB delivery cap: the app uses Tesla's 1 MB.
- Hedged language about what a 2D mask can prove.
- The Model Y seam facts (`seam-adjacency.md`: door pairs share a baseline, pillar 5 → 15 is one strip, the bumper is upside down relative to the hood, the rear quarters never touch the trunk face). A car view shows all of this directly: both doors are one picture, the bumper is drawn the way it faces, and the drawing guide shows where each panel ends.

## The model's working surface: car views

The key design choice: **the model does not paint the raw template atlas.** That layout is sideways, split and upside down in places, which is where nearly all one-shot failures came from. Instead it draws on **pictures of the car** as five fixed cameras see it, and the app warps each drawing onto the template.

```json
{
  "name": "Sunset_Stripe",
  "base":   { "color": "#0b2545" },
  "layers": [
    { "surface": "left",  "svg": "<svg viewBox='0 0 2208 557'>…the driver side as seen, front of the car to the LEFT…</svg>" },
    { "surface": "right", "svg": "…the passenger side as seen, front to the RIGHT…" },
    { "surface": "front", "svg": "…the nose, head on…" },
    { "surface": "rear",  "svg": "…the back…" },
    { "surface": "top",   "svg": "…from above: hood, roof rails, trunk lid…" },
    { "surface": "canvas", "svg": "<svg viewBox='0 0 1024 1024'>…the template itself, for patterns…</svg>" }
  ]
}
```

- **Views:** `left`, `right`, `front`, `rear`, `top`. Each has a fixed size per car (the car cropped tight) and a **guide** image at that size: the car's outline, the areas this view paints in light grey with panel outlines, areas other views paint paler. The model draws in the guide's coordinates; what it draws upright reads upright on the car, across door gaps and around curves.
- **Who paints what:** every small patch of every panel belongs to exactly one view, the one that sees it most face-on. So the doors belong to the side views, the hood to the top view, and a bumper's corners to the side views while its middle belongs to the front view. Ownership boundaries are smooth curves. Patches no camera sees (the underside, inside the wheel arches) only get the base.
- **How it's built:** `tools/calibrate.mjs` renders Gray-code stripe textures through the viewer's own engine from each camera, stripes and their inverse, and reads back which template pixel every screen pixel shows; lighting and reflections cancel out. This is the skill's calibration-grid idea, which failed from photos of the in-car screen because of glare. Here it reads 99.5%+ of the car's pixels cleanly, down to single-pixel stripes. All five views use one camera distance, so a panel's apparent size is comparable between views. Results are stored per car as `calib/<car>.json` (a 4 × 4-pixel grid of screen positions per view plus ownership, about 200–250 KB), built once and committed. If Tesla changes a template, its fingerprint no longer matches and the car falls back to canvas layers until recalibrated.
- `canvas` layers remain for designs that really are template-shaped (an all-over camo or pattern), and `base` fills every panel.
- Raster art (photos, generated images, uploaded logos) goes in as `<image href="data:…">` inside a layer's SVG.

**Why SVG:** both Claude and GPT write it fluently, it is tiny, it rasterizes crisply in the browser at any size, and **edits are cheap**: changing a color or moving text is a patch to one layer, not a redraw of the whole PNG.

## Tools

| Tool | Returns | Notes |
|---|---|---|
| `get_car()` | The dropdown's current car: id, name, template size, and its views, each with its size, a sentence on what it looks at and which way the front is, and its guide image | Called at the start and again whenever the user switches cars (the app injects a "car changed" note). |
| `set_design(doc)` | Text only: compile errors, a cheap validation summary (coverage, any art clipped at a surface edge) | Full replace. |
| `edit_design(ops)` | Same | JSON-patch on layers, so small fixes cost few tokens. |
| `render(views, paint?)` | Screenshots | Default `three_quarter`, `rear_right`, `top`: together they show both sides, the hood, roof and trunk. Close-ups (`focus: "trunk"`, `"mirror_left"`…) for checking text and logos. Sent at about 1024 px wide JPEG to keep image tokens down. |
| `search_web(query)` / `fetch(url)` | Text | For themed requests. Use the provider's built-in web search where it exists (Anthropic `web_search`; OpenAI Responses `web_search`). Browser `fetch` of logo files usually fails on CORS, so the UI also offers **"attach a logo"** and the model asks for it when it can't fetch one. |
| `generate_image(prompt)` | asset id | Optional, OpenAI keys only (`gpt-image`). Interior artwork only; masking keeps its silhouette from mattering. |
| `finish(summary)` | – | App runs the export pipeline and shows the PNG with a Download button. |

## The loop

1. **Ask only what's missing.** The car comes from the dropdown, so never ask which car. If the request is clear, start.
2. **Research** if themed.
3. **`set_design`**, then **`render`** the default three views and look.
4. **Fix and re-render** only the views that changed. Budget: up to 3 self-correction rounds, then show the user where it stands and ask.
5. **`finish`** → export: compile at the selected car's template size, composite through that template's alpha, run the color ladder until under 1,000,000 bytes, sanitize the name, run `WrapCheck.validate`, show the file. The final message is one or two sentences about the design; no byte counts or panel counts (kept from the skill's delivery rule).

## User feedback channel

The existing **annotate** tool gets a **Send to chat** button: the user circles a problem on the frozen frame and it arrives as an image message ("move this up", with the circle). This replaces describing problems in words, which was the slowest part of iterating with the skill.

## Keys, providers, cost

- **Anthropic first.** Browser calls need the `anthropic-dangerous-direct-browser-access: true` header. Use prompt caching on the system prompt + `get_car` result. Default to a Sonnet-tier model; let the user pick.
- **OpenAI second**, via the Responses API (also callable from the browser). One adapter interface: messages in, tool calls out.
- Key stored in `localStorage` only if the user ticks "remember on this device"; otherwise memory only. A plain note in the UI: the key goes from your browser to the provider and nowhere else.
- Each render round sends a few images (roughly a few thousand input tokens). Show a running token count per conversation so users aren't surprised.

## Status

**Step 1 done** (`compose.js`, wired into `index.html` as `WrapCheck.preview(doc)` / `WrapCheck.export(doc)`):

- Loads the dropdown car's template from Tesla's repo (cached, SHA-256 fingerprinted).
- Composes `base` + `canvas` layers at the template's own size. Output alpha = template alpha × art alpha: a fully painted panel keeps the template's alpha byte for byte (verified on all 9 cars, 0 differing pixels after a decode round trip), and anything the design leaves transparent shows the car's paint.
- Its own PNG encoder (a canvas premultiplies and rounds, so it can't write exact bytes): adaptive row filters + the browser's deflate.
- `fit_size` ported: lossless first, then 256 → 4 colors, most frequent exact colors kept exact, no dither. Per-pixel noise on every car (1.2–1.75 MB lossless) came in under 1,000,000 bytes at 16–192 colors in 2–6 s; ordinary designs are 30–125 KB and never reach the ladder.
- File names: accents dropped, other characters become word breaks, words joined with `_`, cut at a word boundary to 30.
- Validator: warns between 1,000,000 and 1,048,576 bytes; "artwork outside the panels" now means outside the template's alpha (it used to count art on the template's seam lines, which are on the car).
- Raster art goes in as `<image href="data:…">` inside a layer (SVG drawn as an image can't load external URLs).

**Step 2 done** (`tools/calibrate.mjs` + `tools/calibrate-page.js` → `calib/<car>.json`; car-view layers and `guide()` in `compose.js`; `WrapCheck.surfaces()` / `WrapCheck.guide(view)`):

- All 9 cars calibrated, 60–100 s each, 126–228 KB per car. 98–100% of decoded screen pixels land on a real panel.
- A test design with one word per view, rendered on every car: LEFT / RIGHT / FRONT / REAR read upright from their sides on all 9; side words span both doors; stripes follow the body; ownership boundaries between views are smooth.
- Not covered by any of the five cameras: 8–26% of each car's template cells (undersides, wheel-arch liners, inner edges; the Cybertruck is highest at 26%, not yet inspected). Those only get the base. Two diagonal cameras would cover most of it if it turns out to matter.
- Known artifact: thin slivers the front or rear camera barely sees can pick up that view's art at their edges (seen at the Model Y L tailgate).
- Recalibrate with `node tools/calibrate.mjs [car ...]` when Tesla changes a template (the fingerprint check catches it) or a pack changes.

## Build order

1. ~~Template loader for the dropdown car + export pipeline (JS port of `fit_size`, 1 MB) + canvas-only layers, working for every car, tested by hand with no model.~~ Done.
2. ~~Auto-calibration → car views for every car; view compiler.~~ Done.
3. Chat panel + Anthropic adapter + `get_car` / `set_design` / `edit_design` / `render` / `finish`.
4. Annotate → Send to chat.
5. Web search, logo attach.
6. OpenAI adapter, image generation.

## Open questions

- Should the MCP server reuse the same design-document format, so Claude Code gets the same surfaces?
