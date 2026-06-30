#!/usr/bin/env python3
"""
Helm — pipeline/make_pmtiles.py
--------------------------------------------------------------------------
Pack raster tiles into a single PMTiles v3 archive with no external tools
(the off-the-shelf path is `pmtiles convert` from an .mbtiles — see
make_pmtiles.sh — but that toolchain isn't always present). Pure stdlib:
Hilbert tile-id ordering + the v3 header/directory byte layout per
https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

Two inputs, auto-detected:
  • an .mbtiles file  → tiles + bounds + format are read straight from it
        (TMS y-rows are flipped back to XYZ on the way out)
  • a directory of {z}/{x}/{y}.png tiles

Usage:
  python3 pipeline/make_pmtiles.py web/data/fiji-sat.mbtiles web/data/fiji-sat.pmtiles
  python3 pipeline/make_pmtiles.py web/data/relief web/data/key-west-sat.pmtiles
  python3 pipeline/make_pmtiles.py <src> <out> --bbox W,S,E,N   # override header bounds
"""
import argparse, glob, gzip, hashlib, json, os, sqlite3, struct, sys

# ---- varint (unsigned LEB128) ------------------------------------------
def uvarint(n):
    out = bytearray()
    while True:
        b = n & 0x7f
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

# ---- Hilbert (z,x,y) -> tile id  (Wikipedia xy2d, full-side rotate) ------
def zxy_to_tileid(z, x, y):
    acc = 0
    for t in range(z):
        acc += (1 << t) * (1 << t)
    n = 1 << z
    d = 0
    s = n // 2
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = n - 1 - x
                y = n - 1 - y
            x, y = y, x
        s //= 2
    return acc + d

def serialize_directory(entries):
    """entries: sorted list of dicts {tile_id, offset, length, run_length}."""
    buf = bytearray()
    buf += uvarint(len(entries))
    last = 0
    for e in entries:
        buf += uvarint(e['tile_id'] - last)
        last = e['tile_id']
    for e in entries:
        buf += uvarint(e['run_length'])
    for e in entries:
        buf += uvarint(e['length'])
    for i, e in enumerate(entries):
        if i > 0 and e['offset'] == entries[i-1]['offset'] + entries[i-1]['length']:
            buf += uvarint(0)
        else:
            buf += uvarint(e['offset'] + 1)
    return bytes(buf)

def gz(b):
    return gzip.compress(b, mtime=0)

# ---- tile sources -------------------------------------------------------
def _load_dir(src):
    """Directory of {z}/{x}/{y}.png — returns (tiles, zset, bounds=None, fmt='png', metadata)."""
    paths = glob.glob(os.path.join(src, '*', '*', '*.png'))
    if not paths:
        print('no tiles under', src); sys.exit(1)
    tiles, zs = [], set()
    for p in paths:
        z = int(os.path.basename(os.path.dirname(os.path.dirname(p))))
        x = int(os.path.basename(os.path.dirname(p)))
        y = int(os.path.splitext(os.path.basename(p))[0])
        zs.add(z)
        tiles.append((zxy_to_tileid(z, x, y), z, x, y, open(p, 'rb').read()))
    return tiles, zs, None, 'png', {}

def _load_mbtiles(src):
    """.mbtiles (SQLite) — reads tiles, flips TMS y→XYZ, and lifts bounds+format from metadata."""
    con = sqlite3.connect(src); con.row_factory = sqlite3.Row
    meta = {r[0]: r[1] for r in con.execute('SELECT name, value FROM metadata')}
    fmt = (meta.get('format') or 'png').lower()
    tiles, zs = [], set()
    for r in con.execute('SELECT zoom_level z, tile_column x, tile_row ty, tile_data d FROM tiles'):
        z, x, ty = r['z'], r['x'], r['ty']
        y = (2 ** z - 1) - ty          # mbtiles stores TMS (y=0 south); PMTiles wants XYZ (y=0 north)
        zs.add(z)
        tiles.append((zxy_to_tileid(z, x, y), z, x, y, bytes(r['d'])))
    con.close()
    bounds = None
    if meta.get('bounds'):
        try:
            bounds = tuple(float(v) for v in meta['bounds'].split(','))
        except ValueError:
            bounds = None
    return tiles, zs, bounds, ('jpg' if fmt in ('jpg', 'jpeg') else fmt), meta

def _metadata_value(value):
    if value is None:
        return None
    if isinstance(value, (bool, int, float, list, dict)):
        return value
    text = str(value)
    stripped = text.strip()
    if stripped == "":
        return text
    if stripped.lower() in ("true", "false"):
        return stripped.lower() == "true"
    for parser in (int, float):
        try:
            if parser is int and any(c in stripped for c in ".eE"):
                continue
            return parser(stripped)
        except ValueError:
            pass
    if (stripped.startswith("{") and stripped.endswith("}")) or (stripped.startswith("[") and stripped.endswith("]")):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    return text

def _load_extra_metadata(path=None, raw=None):
    merged = {}
    if path:
        with open(path, 'r', encoding='utf-8') as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict):
            print('metadata file must contain a JSON object', file=sys.stderr); sys.exit(2)
        merged.update(loaded)
    if raw:
        loaded = json.loads(raw)
        if not isinstance(loaded, dict):
            print('--metadata-json must be a JSON object', file=sys.stderr); sys.exit(2)
        merged.update(loaded)
    return merged

def _bounds_list(bounds):
    if not bounds or len(bounds) != 4:
        return None
    return [float(v) for v in bounds]

def _tile_type(fmt):
    return {
        'mvt': 1,
        'pbf': 1,
        'png': 2,
        'jpg': 3,
        'jpeg': 3,
        'webp': 4,
        'avif': 5,
    }.get(fmt, 2)

def main(src, out, bbox=None, extra_metadata=None):
    tiles, zs, bounds, fmt, src_meta = (_load_mbtiles(src) if src.endswith('.mbtiles') else _load_dir(src))
    if bbox:
        bounds = bbox
    if not tiles:
        print('no tiles in', src); sys.exit(1)
    tiles.sort(key=lambda t: t[0])

    # concat tile data, dedup identical blobs (ocean tiles repeat hugely)
    data = bytearray()
    seen = {}
    entries = []
    for tid, z, x, y, blob in tiles:
        key = hashlib.sha256(blob).digest()
        if key in seen:
            off, ln = seen[key]
        else:
            off, ln = len(data), len(blob)
            data += blob
            seen[key] = (off, ln)
        entries.append({'tile_id': tid, 'offset': off, 'length': ln, 'run_length': 1})

    root = gz(serialize_directory(entries))
    meta_obj = {k: _metadata_value(v) for k, v in src_meta.items()}
    meta_obj.update({k: _metadata_value(v) for k, v in (extra_metadata or {}).items()})
    meta_obj.setdefault('name', os.path.basename(out))
    meta_obj.setdefault('type', 'raster')
    meta_obj['format'] = fmt
    meta_obj['minzoom'] = min(zs)
    meta_obj['maxzoom'] = max(zs)
    meta_obj.setdefault('attribution', 'Helm offline raster pack - NOT FOR NAVIGATION')

    HEADER = 127
    root_off = HEADER
    minz, maxz = min(zs), max(zs)
    if bounds and len(bounds) == 4:
        minlon, minlat, maxlon, maxlat = bounds
    else:
        print('WARN: no bounds in source — defaulting to Key West; pass --bbox to set them')
        minlon, minlat, maxlon, maxlat = -81.95, 24.38, -81.55, 24.66
    clon, clat = (minlon + maxlon) / 2.0, (minlat + maxlat) / 2.0
    meta_obj['bounds'] = _bounds_list((minlon, minlat, maxlon, maxlat))
    meta_obj['center'] = [clon, clat, (minz + maxz) // 2]
    meta = gz(json.dumps(meta_obj, sort_keys=True, separators=(',', ':')).encode())

    meta_off = root_off + len(root)
    leaf_off = meta_off + len(meta)
    leaf_len = 0
    data_off = leaf_off + leaf_len
    tile_type = _tile_type(fmt)

    h = bytearray(HEADER)
    h[0:7] = b'PMTiles'
    h[7] = 3
    struct.pack_into('<Q', h, 8, root_off)
    struct.pack_into('<Q', h, 16, len(root))
    struct.pack_into('<Q', h, 24, meta_off)
    struct.pack_into('<Q', h, 32, len(meta))
    struct.pack_into('<Q', h, 40, leaf_off)
    struct.pack_into('<Q', h, 48, leaf_len)
    struct.pack_into('<Q', h, 56, data_off)
    struct.pack_into('<Q', h, 64, len(data))
    struct.pack_into('<Q', h, 72, len(tiles))      # addressed tiles
    struct.pack_into('<Q', h, 80, len(entries))    # tile entries
    struct.pack_into('<Q', h, 88, len(seen))       # tile contents (unique)
    h[96] = 1            # clustered
    h[97] = 2            # internal compression: gzip
    h[98] = 1            # tile compression: none (png/jpg already compressed)
    h[99] = tile_type
    h[100] = minz
    h[101] = maxz
    struct.pack_into('<i', h, 102, int(minlon * 1e7))
    struct.pack_into('<i', h, 106, int(minlat * 1e7))
    struct.pack_into('<i', h, 110, int(maxlon * 1e7))
    struct.pack_into('<i', h, 114, int(maxlat * 1e7))
    h[118] = (minz + maxz) // 2
    struct.pack_into('<i', h, 119, int(clon * 1e7))
    struct.pack_into('<i', h, 123, int(clat * 1e7))

    with open(out, 'wb') as f:
        f.write(bytes(h)); f.write(root); f.write(meta); f.write(bytes(data))
    print(f'wrote {out}: {len(tiles)} tiles ({len(seen)} unique), z{minz}-{maxz}, fmt={fmt}, '
          f'bounds={minlon},{minlat},{maxlon},{maxlat}, '
          f'{(HEADER+len(root)+len(meta)+len(data))/1024:.0f} KB')

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src', nargs='?', default='web/data/relief')
    ap.add_argument('out', nargs='?', default='web/data/key-west-sat.pmtiles')
    ap.add_argument('--bbox', help='W,S,E,N override for PMTiles header and metadata')
    ap.add_argument('--metadata-file', help='JSON object merged into PMTiles metadata')
    ap.add_argument('--metadata-json', help='JSON object merged into PMTiles metadata')
    a = ap.parse_args()
    bbox = tuple(float(v) for v in a.bbox.split(',')) if a.bbox else None
    main(a.src, a.out, bbox, _load_extra_metadata(a.metadata_file, a.metadata_json))
