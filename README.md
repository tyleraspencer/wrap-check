# Wrap Check

Preview a Tesla custom wrap on a 3D model of your car before you upload it, and let an LLM do the same check on its own designs.

* **Viewer** (`index.html`): pick a car, drop in a wrap PNG, orbit it. Checks Tesla's upload rules (PNG, ≤ 1 MB, 512–1024 px, file name) and how much art lands on printable panels.
* **MCP server** (`mcp/`): lets an LLM design a wrap, validate it, render it on the car from several angles, look at the result, fix it, and hand back the final PNG plus a link to the interactive viewer.

Cars: Model Y (2025+ Premium / Performance / Standard, Model Y L, original), Model 3 (2024+ Premium/Standard, Performance, original), Cybertruck.
Model S / X load in the engine but this build never paints a wrap on them, so they are not offered.

**Live viewer:** https://tyleraspencer.github.io/wrap-check/

## Run the viewer locally

Local runs need the per-car packs in `godot/packs/` (they are not stored in git). Build them once, or just use the live viewer:

```bash
python3 tools/build_site.py      # downloads + verifies the original pack, builds _site/ (viewer + packs)
node server.js                   # serves this folder; copy _site/godot/packs into godot/packs first
```

Each car loads its own 20–40 MB pack from `godot/packs/` on first use and caches it.

## Annotating the car view

Click **✎ Annotate** (bottom-left of the car view). The tools open upward as a column of icons and the car **freezes**: auto-rotate stops, drags, scrolling and pinching no longer move it, and the angle buttons lock until you press **Done**.
Tools, top to bottom: **Pen** (selected by default), **Box**, **Circle**, **Arrow**, **Text**. Then the current colour (click it for the other four, which fan out to the right), Undo, Clear, **Copy image** (paste it into an LLM chat), **Download**, and **Share** (phones).
Attach the picture with your wrap PNG so the LLM can see what to change. Everything is made in your browser; nothing is uploaded.

## URL options

| Parameter | Example | What it does |
|---|---|---|
| `car` | `?car=cybertruck` | Start on this car (ids: `modely-2025-premium`, `modely-2025-performance`, `modely-2025-base`, `modely-l`, `modely`, `model3-2024-base`, `model3-2024-performance`, `model3`, `cybertruck`) |
| `view` | `?view=rear_left` | Start from this camera angle: `front`, `front_left`, `left`, `rear_left`, `rear`, `rear_right`, `right`, `front_right`, `top`, `three_quarter`, or `rotate` (starts slowly rotating) |
| `touchGain` | `?touchGain=0.5` | Finger-drag sensitivity on touch screens (lower = slower, softer image) |

Share links use the `#fragment`, and `&view=` can be added to any of them: `#s=<id>.<key>&view=front`, `#car=cybertruck&ex=Camo_Blue&view=rear`.
The **Copy share link** button adds the angle you last picked automatically.

## Use it from an LLM (MCP)

Needs Node 20+ and Google Chrome (rendering is headless Chrome).

```bash
cd mcp && npm install
claude mcp add wrap-check -- node "$(pwd)/server.js"
```

Claude Desktop / other clients: add to the MCP config

```json
{ "mcpServers": { "wrap-check": { "command": "node", "args": ["/absolute/path/to/wrap-check/mcp/server.js"] } } }
```

Tools: `list_cars`, `get_template`, `validate_wrap`, `render_wrap`, `viewer_url`.
Then ask: *"Design a Model Y Premium wrap with a retro sunset gradient and check it."*

## Deployment

Pushing to `main` runs `.github/workflows/pages.yml`: it downloads the original pack (cached), checks its checksum, runs
`tools/build_packs.py` to make the per-car packs, and publishes `_site/` to GitHub Pages. No Tesla model data is committed to git.
The MCP server downloads packs from the live site on first use (override with `WRAPCHECK_HOSTED_URL`), so a clean checkout works.

## Rebuilding the packs

`tools/build_packs.py` slims the full visualizer pack (`godot/index.pck`, 284 MB) into one pack per car and bakes in the
fixes (no ground plane, flat backdrop, Model Y L script inheritance, Highland floor). Run:

```bash
python3 tools/build_packs.py godot/index.pck godot/packs
```

## Known limits

* The 3D engine renders a little darker and flatter than a real car; the page pre-compensates colour (toggle in the sidebar). Judge hue and placement, not brightness.
* The engine, its car meshes and the pack come from the open-source Tesla Wrap Studio project's build of Tesla's visualizer; the wrap templates are Tesla's (`teslamotors/custom-wraps`).
