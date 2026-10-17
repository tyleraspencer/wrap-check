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

The model works on two things with equal weight: **the exact PNG it would deliver** (the artifact the user uploads) and **the 3D car** (the best way to see whether the PNG is right).

| Tool | Returns | Notes |
|---|---|---|
| `get_car()` | The dropdown's car: id, name, template size, Tesla's rules; its views (size, what each camera looks at) with their guide images; Tesla's template; the panel map image and table | Called at the start and when the user switches cars (the app adds a "car changed" note). |
| `study_car()` | A labelled texture on the 3D car (panel colours and IDs, an arrow to the car's up, "ABC 123" written the way the table says reads upright, a 64 px grid) from all 8 angles and from above, plus close-ups of the small panels | The skill's calibration photos, done through the real engine for any car. Cached in IndexedDB per car and template fingerprint. |
| `set_design(doc)` / `edit_design(ops)` | The exact exported PNG (same pipeline as delivery), plus checks: Tesla's rules, coverage per panel, art drawn where its view doesn't paint or off the car, raster images that get enlarged | Also puts the design on the 3D car as a draft. `edit_design` ops: `patch_svg` (find/replace in one layer), `replace_layer`, `insert_layer`, `remove_layer`, `move_layer`, `set_base`, `set_name`. |
| `inspect_png(panels \| box, zoom)` | An enlarged crop of the PNG, pixel for pixel, with panel outlines and IDs | The skill's "zoom in on text, logos and seams". |
| `render(views?, focus?, angle?)` | Sharp photos (the engine enlarged up to 4096 px for the shot). `focus`: a close-up of those panels | Close-ups from a calibrated camera are cropped exactly from the calibration; from another `angle`, the panels are found by showing them white on black for a moment. |
| `compare_view(view)` | The drawing beside the car seen from that view's own calibrated camera, and the car with blocks flagged where its edges are much softer than drawn (yellow) or in different places (red) | Edges, not colours, so lighting mostly cancels out. |
| `finish(name?)` | Exports, puts the PNG in the wrap input on the left (preview, Tesla checks, download, share) and shows it in the chat | |
| `web_search` | Anthropic's server tool (`web_search_20260209`) | Dropped automatically if the account has it turned off. |

Attachments (files, pasted images, annotations) get ids; images can be used as art with `<image href="att:3"/>` (`WrapCompose.setAsset`). The model sees a copy scaled to 1568 px; the art uses the full-resolution original, or the SVG itself.

## The loop

1. **Ask only what's missing.** The car comes from the dropdown, so never ask which car.
2. `get_car`, then `study_car` before placing anything directional. **Research** if themed.
3. `set_design`, look at **the PNG first** (and `inspect_png` on text, logos and seams), fix the file, then `render` the default views, `render` with `focus` on every panel with text, a logo or a seam crossing, and `compare_view` each car-view layer.
4. Up to 3 self-correction rounds, then show the user where it stands and ask.
5. `finish`, then one or two sentences about the design (no byte or panel counts).

## The panel map: the skill's per-car knowledge, computed for every car

`tesla-wrap-skill` hand-wrote, for the Model Y 2025 Premium only, which way each panel faces on the car (`panel-orientation.md`), its ground edges (`ground-edge-reference.png`) and which panels meet (`seam-adjacency.md`). `WrapCompose.panelMap(carId)` works the same facts out from the calibration for every car:

- **Who paints it:** the share of each panel each view owns, and how much no camera sees.
- **Orientation**, per view that paints a fair share of the panel: an affine fit from template to screen gives the canvas directions of the car's up, front and left, the ground-facing edge, the rotation that makes canvas text read upright (and, seen from above, from in front of or behind the car), and a warning where a panel looks mirrored or is seen nearly edge-on.
- **Orientation that turns across a panel** (big panels that wrap several faces, like most of the Cybertruck) is flagged; the panel map image draws small local arrows every 96 px.
- **Neighbours:** panels whose cells sit next to each other on screen, with the canvas points where their edges meet. Seen in only one view, a pair may just overlap on screen, so the model confirms with `study_car`.

Checked against the skill on the Model Y 2025 Premium: the bumper is upside down relative to the hood, canvas-up points to the front on the sides, upright text on the canvas-left doors is rotated about 90° clockwise and on the right about 90° counter-clockwise, the trunk is upright, the rear bumper corners' ground edges face outward, and 7|11, 8|12, 11|13, 3|7, 5→15, 6→16, 13|18 and 18|20 are found as neighbours.

## User feedback channel

Annotations are picked up automatically. While the user draws, the composer shows a live "Annotation on the car" chip; sending (or leaving annotate mode) attaches the frozen frame with the marks and a note naming the angle and saying the marks aren't part of the wrap. Files can be attached with the paperclip, pasted, or dropped on the chat.

## Keys, providers, cost

- **Anthropic.** Browser calls with `anthropic-dangerous-direct-browser-access: true`. Claude Opus 5.5 by default (Sonnet 5.5 and Haiku 5.5 in the picker), adaptive thinking with summaries shown, `fallbacks: "default"` (dropped automatically if refused), automatic prompt caching, streaming with `eager_input_streaming` and client-side validation of tool inputs. The history is only ever appended to, as preserved thinking requires.
- Key stored in `localStorage` only if the user ticks "Remember on this device"; otherwise memory only. The UI says the key goes from the browser to Anthropic and nowhere else, and explains how to get one.
- A running cost estimate per conversation, from the token counts Anthropic reports.
- OpenAI is not done.

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

**Steps 3–5 done** (`chat.js`; panel map, study texture, close-ups and checks in `compose.js`; capture hooks in `index.html`). Car-view warping now averages 2 × 2 samples per template pixel where the view is finer than the template (most of it: about 2.8 screen pixels per template pixel on the Model Y's sides), and reads a larger rasterization where a panel is seen at a glancing angle. Tested end to end against a stand-in engine and a mocked API; not yet against the real engine with a real key.

First live run: the browser paired the new `chat.js` with a cached old `compose.js`, so every car tool failed. `tools/build_site.py` now versions both script URLs by content hash, and the chat refuses to start (asking for a reload) if the `compose.js` it gets lacks what it needs.

## Build order

1. ~~Template loader for the dropdown car + export pipeline (JS port of `fit_size`, 1 MB) + canvas-only layers, working for every car, tested by hand with no model.~~ Done.
2. ~~Auto-calibration → car views for every car; view compiler.~~ Done.
3. ~~Chat panel + Anthropic adapter + `get_car` / `set_design` / `edit_design` / `render` / `finish`.~~ Done, plus `study_car`, `inspect_png`, `compare_view` and the computed panel map.
4. ~~Annotate → chat.~~ Done (automatic).
5. ~~Web search, logo attach.~~ Done.
6. OpenAI adapter, image generation.

## Open questions

- Should the MCP server reuse the same design-document format, so Claude Code gets the same surfaces?
