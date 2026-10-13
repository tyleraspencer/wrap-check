"""Build slim per-car Godot packs from the full Tesla visualizer pack.

usage: python3 tools/build_packs.py <full index.pck> <out dir>
"""
import hashlib, os, re, struct, sys

SRC, OUT = sys.argv[1], sys.argv[2]
data = open(SRC, 'rb').read()
assert data[:4] == b'GDPC'
HDR = data[4:20]                                   # pack version + engine version, copied through
p = 20 + 64
count, = struct.unpack('<I', data[p:p+4]); p += 4
F = {}                                             # path -> (offset, size)
for _ in range(count):
    l, = struct.unpack('<I', data[p:p+4]); p += 4
    name = data[p:p+l].rstrip(b'\0').decode(); p += l
    off, size = struct.unpack('<QQ', data[p:p+16]); p += 32
    F[name] = (off, size)
blob = lambda n: data[F[n][0]:F[n][0] + F[n][1]]

# --- scenes: SceneManager maps every model id onto one of these paths
SCENE_PATHS = ['res://Ego/Cybertruck/Cybertruck.tscn', 'res://Ego/3_High/Model3_High.tscn',
               'res://Ego/v2023/Poppyseed/Poppyseed.tscn', 'res://Ego/Y_High/ModelY_High.tscn',
               'res://Ego/BayberryE41/BayberryE41.tscn', 'res://Ego/Bayberry/Bayberry.tscn']
PACKS = {   # pack name -> (car dir, car scene, model ids it serves)
    'bayberry':     ('res://Ego/Bayberry/',     'res://Ego/Bayberry/Bayberry.tscn',            ['modely-2025-premium', 'modely-2025-performance']),
    'bayberry-e41': ('res://Ego/BayberryE41/',  'res://Ego/BayberryE41/BayberryE41.tscn',      ['modely-2025-base']),
    'bayberry-e80': ('res://Ego/BayberryE80/',  'res://Ego/BayberryE80/BayberryE80.tscn',      ['modely-l']),
    'y-high':       ('res://Ego/Y_High/',       'res://Ego/Y_High/ModelY_High.tscn',           ['modely']),
    'poppyseed':    ('res://Ego/v2023/',        'res://Ego/v2023/Poppyseed/Poppyseed.tscn',    ['model3-2024-base', 'model3-2024-performance']),
    '3-high':       ('res://Ego/3_High/',       'res://Ego/3_High/Model3_High.tscn',           ['model3']),
    # Model S / X (Ego/S, S_Palladium, X, X_Palladium) load fine through the same aliasing trick, but this
    # engine build never paints a wrap on them (tested), so they are intentionally not packaged.
    'cybertruck':   ('res://Ego/Cybertruck/',   'res://Ego/Cybertruck/Cybertruck.tscn',        ['cybertruck']),
}
CAR_DIRS = [v[0] for v in PACKS.values()] + ['res://Ego/S/', 'res://Ego/S_Palladium/', 'res://Ego/X/', 'res://Ego/X_Palladium/', 'res://Ego/Semi/']
# some car scripts inherit from another car's script (E80's root script extends Bayberry's)
EXTRAS = {'bayberry-e80': ('res://Ego/Bayberry/Script/',)}
# per-pack file swaps (path -> source path in the full pack); none needed at the moment
SWAPS = {}
# per-pack text appends. Poppyseed's "Floor" (child 26 of the car root, read from the imported scene) is a baked ground-shadow
# slab for the asphalt we removed; the engine only auto-hides nodes named groundplane/ground_plane, so it renders as an opaque plate.
APPENDS = {'poppyseed': [('res://Ego/v2023/Poppyseed/Poppyseed.tscn', '\n[node name="Floor" parent="." index="26"]\nvisible = false\n')]}
ALWAYS_DROP = ('res://Energy/', 'res://editor_only/', 'res://Tesla-Wrap-Text/')

# --- patches baked into every pack: no ground plane, flat sky, no fog
def patched(n):
    b = blob(n)
    if n == 'res://main.tscn':
        t = b.decode()
        if 'visible = false' in t.split('GroundPlane')[1][:80]: return b      # already patched
        return t.replace('[node name="GroundPlane" type="MeshInstance" parent="."]\n', '[node name="GroundPlane" type="MeshInstance" parent="."]\nvisible = false\n').encode()
    if n == 'res://env/mobile.tres':
        g = 'Color( 0.847059, 0.847059, 0.847059, 1 )'; t = b.decode()
        if 'sun_energy' in t: return b                                   # already patched
        t2 = (t.replace('sky_top_color = Color( 0.690196, 0.690196, 0.690196, 1 )', 'sky_top_color = ' + g)
                .replace('sun_angle_max = 104.24', 'sun_angle_max = 104.24\nsun_energy = 0.0').replace('fog_enabled = true', 'fog_enabled = false'))
        return t2.encode()
    return b
STUB_RES = b'[gd_resource type="SpatialMaterial" format=2]\n\n[resource]\n'
STUB_SCENE = b'[gd_scene format=2]\n\n[node name="Stub" type="Spatial"]\n'
REF = re.compile(rb'res://[A-Za-z0-9_\-./+ ()]+')

def refs(n):
    out = set()
    for m in REF.findall(blob(n)):
        s = m.decode()
        for cut in (s, s.rstrip(' .)('), s.split(' ')[0]):
            if cut in F: out.add(cut); break
    return out

def allowed(n, own_dir):
    if n.startswith(ALWAYS_DROP) or '/Skins/' in n: return False   # built-in in-car wraps: we supply our own texture
    if n.startswith('res://Ego/') and any(n.startswith(d) for d in CAR_DIRS) and not n.startswith(own_dir): return False
    return True

def build(name, own_dir, scene, ids):
    keep, todo, dropped_refs = set(), [], set()
    roots = [n for n in F if not n.startswith(('res://Ego/', 'res://.import/')) and allowed(n, own_dir)]
    roots += [n for n in F if n.startswith(own_dir)]
    roots += [n for n in F if n.startswith('res://Ego/') and not any(n.startswith(d) for d in CAR_DIRS)]   # shared wheels/brakes
    todo = list(roots)
    while todo:
        n = todo.pop()
        if n in keep: continue
        if not allowed(n, own_dir): dropped_refs.add(n); continue
        keep.add(n)
        for r in refs(n): todo.append(r)
        for suffix in ('.import', '.remap'):
            if n + suffix in F: todo.append(n + suffix)
    files = {n: blob(n) if n not in ('res://main.tscn', 'res://env/mobile.tres') else patched(n) for n in keep}
    # any other car's scene / resource a kept file still references -> tiny stub; scene paths -> this car
    if os.environ.get('DEBUG_STUBS') == name:
        for n in sorted(dropped_refs): print('   stub:', n)
    for n in dropped_refs:
        if n in SCENE_PATHS: continue
        files[n] = STUB_SCENE if n.endswith('.tscn') else STUB_RES if n.endswith(('.tres', '.material')) else b''
    for dst, src in SWAPS.get(name, {}).items(): files[dst] = blob(src)
    for dst, extra in APPENDS.get(name, []): files[dst] = files[dst] + extra.encode()
    for sp in SCENE_PATHS: files[sp] = files[scene]          # alias: any model id loads this pack's car
    # write pack; aliased entries share one data blob
    out = bytearray(); table = []
    seen = {}
    names = sorted(files)
    entries_size = sum(4 + ((len(n.encode()) + 4) & ~3) + 32 for n in names)
    base = 20 + 64 + 4 + entries_size
    for n in names:
        b = files[n]; key = hashlib.md5(b).digest() + struct.pack('<Q', len(b))
        if key not in seen: seen[key] = base + len(out); out += b
        table.append((n, seen[key], len(b), hashlib.md5(b).digest()))
    hdr = bytearray(b'GDPC' + HDR + b'\0' * 64 + struct.pack('<I', len(table)))
    for n, off, size, md5 in table:
        nb = n.encode(); pl = (len(nb) + 4) & ~3          # null-terminated, padded to 4
        hdr += struct.pack('<I', pl) + nb + b'\0' * (pl - len(nb)) + struct.pack('<QQ', off, size) + md5
    assert len(hdr) == base, (len(hdr), base)
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, name + '.pck'), 'wb').write(bytes(hdr) + bytes(out))
    return len(files), len(hdr) + len(out)

import json
manifest = {}
for name, (d, scene, ids) in PACKS.items():
    n, size = build(name, (d,) + EXTRAS.get(name, ()), scene, ids)
    manifest[name] = {'bytes': size, 'models': ids}
    print(f'{name:14s} {n:5d} files  {size/1e6:6.1f} MB   serves {", ".join(ids)}')
open(os.path.join(OUT, 'manifest.json'), 'w').write(json.dumps(manifest, indent=1))
