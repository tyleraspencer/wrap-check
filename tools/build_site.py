"""Assemble the static site (what GitHub Pages serves) into _site/.

The model pack is NOT stored in this repo. This script downloads the original, verifies its checksum, and slims it
into per-car packs with tools/build_packs.py.

usage: python3 tools/build_site.py [--pck path/to/original/index.pck] [--out _site] [--cache .cache]
"""
import argparse, hashlib, os, shutil, subprocess, sys, urllib.request

PACK_URL = 'https://lfs.tesla-wrap.com/index.pck'
PACK_MD5 = '8bd6f34bb77c29bdc33a432b205aa5d1'          # md5 of the original 283,843,184-byte pack
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument('--pck'); ap.add_argument('--out', default='_site'); ap.add_argument('--cache', default='.cache')
a = ap.parse_args()
out, cache = (p if os.path.isabs(p) else os.path.join(ROOT, p) for p in (a.out, a.cache))

def md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()

pck = a.pck or os.path.join(cache, 'index.pck')
if not os.path.exists(pck):
    os.makedirs(os.path.dirname(pck), exist_ok=True)
    print('downloading', PACK_URL, flush=True)
    req = urllib.request.Request(PACK_URL, headers={'User-Agent': 'wrap-check-build/1.0 (+https://github.com/tyleraspencer/wrap-check)'})
    with urllib.request.urlopen(req) as r, open(pck + '.part', 'wb') as f: shutil.copyfileobj(r, f, 1 << 20)
    os.replace(pck + '.part', pck)
got = md5(pck)
if got != PACK_MD5:
    sys.exit(f'checksum mismatch for {pck}: got {got}, expected {PACK_MD5}. The source pack changed; the pack builder must be re-checked before deploying.')
print('pack verified', got, flush=True)

shutil.rmtree(out, ignore_errors=True)
os.makedirs(os.path.join(out, 'godot'))
subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build_packs.py'), pck, os.path.join(out, 'godot', 'packs')], check=True)
for f in ('index.html', 'compose.js', 'chat.js', 'icon.svg', 'icon-192.png', 'apple-touch-icon.png'):
    shutil.copy(os.path.join(ROOT, f), out)
for f in ('index.html', 'index.js', 'index.wasm', 'index.png'):
    shutil.copy(os.path.join(ROOT, 'godot', f), os.path.join(out, 'godot', f))
shutil.copytree(os.path.join(ROOT, 'calib'), os.path.join(out, 'calib'))     # car-view calibration (tools/calibrate.mjs)
# Version the scripts by content, so a browser or CDN can never pair a new index.html or chat.js with an old compose.js.
page = open(os.path.join(out, 'index.html'), encoding='utf-8').read()
for f in ('compose.js', 'chat.js'):
    tag = f'src="{f}"'
    if tag not in page: sys.exit(f'index.html has no {tag}; update the cache-busting step in tools/build_site.py')
    page = page.replace(tag, f'src="{f}?v={hashlib.sha256(open(os.path.join(out, f), "rb").read()).hexdigest()[:10]}"')
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(page)
open(os.path.join(out, '.nojekyll'), 'w').close()
total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
print(f'site ready in {out}: {total / 1e6:.0f} MB')
