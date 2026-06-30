#!/usr/bin/env python3
"""
Helm — pipeline/gen_demo_data.py
--------------------------------------------------------------------------
Generates REAL-FORMAT, offline data packs for the map integrations, with no
GDAL/PIL/numpy — only the stdlib (zlib for PNG deflate). Everything is written
under web/data/ so the app renders genuine content with zero network at runtime
(the offline-first production model for a chartplotter).

Outputs:
  web/data/dem/{z}/{x}/{y}.png        Terrarium-encoded DEM (bathymetry + land)
  web/data/relief/{z}/{x}/{y}.png     Colour-relief raster (for the PMTiles pack)
  web/data/ais-fleet.geojson          Realistic AIS fleet around the region
  web/data/radar/manifest.json        + radar/{frame}/{z}/{x}/{y}.png  precip frames

The DEM is a smooth synthetic field shaped like the waters around Key West:
the Straits of Florida dropping off to the south, the shallow Florida Bay flats
to the north, a reef line, and the island chain as low land. It is invented,
not surveyed — NOT FOR NAVIGATION — but it is in exactly the format a real
Terrarium DEM / GFS-as-terrain export uses, so the integration code is identical
to production.
"""
import math, os, struct, zlib, json

ROOT = os.path.join(os.path.dirname(__file__), '..', 'web', 'data')

# ---- region (matches lab.js region) -------------------------------------
BBOX = (-81.95, 24.38, -81.55, 24.66)   # the visible region (AIS/radar)
CENTER = (-81.77, 24.52)
# DEM/relief cover the visible region plus a small margin. (Depth contours ship
# pre-baked as GeoJSON — see gen_contours — so the DEM no longer needs the large
# neighbour buffer the runtime maplibre-contour path required; it now feeds only
# the hillshade/value-encoded raster and the PMTiles relief pack.)
DEM_BBOX = (-82.02, 24.34, -81.52, 24.72)

# ---------------------------------------------------------------- web mercator
def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y

def pixel_to_lonlat(z, xt, yt, px, py, size=256):
    n = 2 ** z
    x = xt + px / size
    y = yt + py / size
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat

def tiles_for_bbox(z, bbox=BBOX):
    x0, y1 = lonlat_to_tile(bbox[0], bbox[1], z)
    x1, y0 = lonlat_to_tile(bbox[2], bbox[3], z)
    return [(z, x, y)
            for x in range(int(math.floor(x0)), int(math.floor(x1)) + 1)
            for y in range(int(math.floor(y0)), int(math.floor(y1)) + 1)]

# ---------------------------------------------------------------- PNG writer
def write_png(path, rgb, size=256, alpha=False):
    """rgb: flat bytes, RGB (or RGBA if alpha). 8-bit."""
    ch = 4 if alpha else 3
    raw = bytearray()
    stride = size * ch
    for row in range(size):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgb[row * stride:(row + 1) * stride])
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6 if alpha else 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)

# ---------------------------------------------------------------- bathymetry
# Irregular island chain: hand-placed keys of varied size/spacing along the ridge
# (centre lon, half-width°, height, lat-offset°) — organic, not evenly spaced.
_KEYS = [
    (-81.92, 0.018, 0.95, -0.002), (-81.865, 0.011, 0.72, 0.004),
    (-81.815, 0.026, 1.05, 0.0), (-81.758, 0.013, 0.80, -0.003),
    (-81.705, 0.020, 0.92, 0.003), (-81.648, 0.015, 0.70, -0.002),
    (-81.60, 0.024, 1.00, 0.001), (-81.556, 0.010, 0.60, 0.004),
]

def _fbm(lon, lat):
    """A little smooth pseudo-noise from incommensurate sines (organic texture)."""
    return (0.55 * math.sin(lon / 0.031 + 1.3) * math.cos(lat / 0.028)
            + 0.30 * math.sin((lon + lat) / 0.019 + 0.4)
            + 0.18 * math.sin(lat / 0.013 - 0.7) * math.sin(lon / 0.017))

def elevation(lon, lat):
    """Metres; negative = below sea level. Smooth, plausible, invented."""
    dn = lat - 24.55                       # distance N/S of the chain
    # land = strongest nearby key (varied widths/heights/offsets -> irregular)
    land = 0.0
    for cx, w, h, off in _KEYS:
        ridge = math.exp(-((lat - (24.55 + off)) ** 2) / (2 * 0.011 ** 2))
        bump = h * math.exp(-((lon - cx) ** 2) / (2 * w ** 2))
        land = max(land, ridge * bump)
    if land > 0.5:
        return (land - 0.5) / 0.5 * 5.0 + 0.3 + 0.4 * _fbm(lon * 2, lat * 2)

    n = _fbm(lon, lat)
    if dn >= 0:  # north — shallow Florida Bay flats: -2 m at the keys -> ~-4 m
        base = -2.0 - 2.0 * (1 - math.exp(-dn / 0.05))
        return min(-0.3, base + 0.7 * n)
    # south — reef crest then a steep drop into the Straits. Both branches meet
    # at -2 m at dn=0 (continuous) so contours don't pile into a seam line.
    d = -dn
    s0 = 1 / (1 + math.exp(0.06 / 0.02))                       # shelf value at d=0
    shelf = 118.0 * (1 / (1 + math.exp(-(d - 0.06) / 0.02)) - s0)
    base = -2.0 - 6.0 * (1 - math.exp(-d / 0.012)) - shelf
    return base + 1.6 * n * math.exp(-d / 0.05)

# ---------------------------------------------------------------- encoders
def terrarium_rgb(e):
    v = e + 32768.0
    v = max(0.0, min(65535.999, v))
    r = int(v // 256)
    rem = v - r * 256
    g = int(rem)
    b = int((rem - g) * 256)
    return r, g, b

# Smooth bathymetric gradient (depth in m -> RGB), interpolated between stops for
# a continuous "Windy"-style depth field rather than hard colour steps.
_BATHY = [
    (0,   (210, 232, 233)),   # shoreline — pale shell
    (2,   (156, 223, 235)),   # white sand flats
    (5,   (96,  196, 224)),
    (10,  (54,  158, 210)),
    (20,  (36,  120, 188)),
    (40,  (26,  86,  158)),
    (80,  (18,  56,  120)),
    (140, (11,  33,  82)),    # deep navy — the Straits
]
_LAND = [
    (0,  (164, 196, 168)),    # coastal green-grey
    (2,  (190, 200, 150)),
    (5,  (150, 132, 102)),    # tan
]

def _ramp(stops, x):
    if x <= stops[0][0]:
        return stops[0][1]
    for (x0, c0), (x1, c1) in zip(stops, stops[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0)
            # smoothstep for a softer, more organic transition
            t = t * t * (3 - 2 * t)
            return tuple(int(round(a + (b - a) * t)) for a, b in zip(c0, c1))
    return stops[-1][1]

def relief_rgb(e):
    """Continuous bathymetric colour: deep navy -> teal -> pale flats -> sand."""
    return _ramp(_LAND, e) if e >= 0 else _ramp(_BATHY, -e)

# ---------------------------------------------------------------- generators
def gen_field(kind, zmin, zmax):
    total = 0
    enc = terrarium_rgb if kind == 'dem' else relief_rgb
    sub = 'dem' if kind == 'dem' else 'relief'
    for z in range(zmin, zmax + 1):
        for (zz, xt, yt) in tiles_for_bbox(z, DEM_BBOX):
            buf = bytearray(256 * 256 * 3)
            i = 0
            for py in range(256):
                for px in range(256):
                    lon, lat = pixel_to_lonlat(z, xt, yt, px, py)
                    r, g, b = enc(elevation(lon, lat))
                    buf[i] = r; buf[i+1] = g; buf[i+2] = b; i += 3
            write_png(os.path.join(ROOT, sub, str(z), str(xt), f'{yt}.png'), bytes(buf))
            total += 1
    print(f'  {kind}: {total} tiles  (z{zmin}-{zmax})')
    return total

def gen_ais():
    """Realistic fleet: lanes + anchorage + a couple of close-CPA targets."""
    import random
    random.seed(42)
    names = ['Sea Fox','Conch Express','Marathon Maru','Reef Wanderer','Salty Paws',
             'Gulf Drifter','Island Time','Blue Horizon','Tortuga','Mallory Star',
             'Cayo Hueso','Sand Dollar','Windward','Leeward Bound','Dry Tortugas Ferry']
    feats = []
    mmsi = 367000000
    def push(lon, lat, sog, cog, cpa, name):
        nonlocal mmsi
        mmsi += 17
        feats.append({'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [round(lon, 5), round(lat, 5)]},
            'properties': {'mmsi': mmsi, 'name': name,
                'sog': round(sog, 1), 'cog': round(cog) % 360, 'cpa_nm': round(cpa, 2)}})
    # main shipping lane through the Straits (south, WSW->ENE), faster vessels
    for i in range(260):
        t = random.random()
        lon = -81.95 + t * 0.40 + random.uniform(-0.01, 0.01)
        lat = 24.44 - 0.03 * math.sin(t * math.pi) + random.uniform(-0.008, 0.008)
        push(lon, lat, random.uniform(8, 18), 70 + random.uniform(-15, 15),
             random.uniform(1.5, 6), random.choice(names))
    # inshore / channel traffic near the keys, slower
    for i in range(140):
        lon = CENTER[0] + random.uniform(-0.12, 0.12)
        lat = 24.55 + random.uniform(-0.03, 0.05)
        push(lon, lat, random.uniform(0, 9), random.uniform(0, 360),
             random.uniform(0.4, 3), random.choice(names))
    # anchorage cluster (near zero SOG)
    for i in range(40):
        lon = -81.80 + random.uniform(-0.02, 0.02)
        lat = 24.56 + random.uniform(-0.015, 0.015)
        push(lon, lat, random.uniform(0, 0.4), random.uniform(0, 360),
             random.uniform(0.2, 1.5), random.choice(names))
    # a few close-CPA threats (red)
    for i in range(8):
        lon = CENTER[0] + random.uniform(-0.06, 0.06)
        lat = 24.50 + random.uniform(-0.03, 0.03)
        push(lon, lat, random.uniform(6, 14), random.uniform(0, 360),
             random.uniform(0.05, 0.18), random.choice(names))
    fc = {'type': 'FeatureCollection',
          'metadata': {'note': 'Synthetic AIS demo fleet — NOT real traffic',
                       'count': len(feats)},
          'features': feats}
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, 'ais-fleet.geojson'), 'w') as f:
        json.dump(fc, f)
    print(f'  ais: {len(feats)} targets -> ais-fleet.geojson')

def gen_radar(zmin=9, zmax=11, nframes=6):
    """Synthetic precip cells drifting NE across the region, as RGBA tiles."""
    frames = []
    for fr in range(nframes):
        # storm centre drifts NE over time
        cx = -81.95 + 0.07 * fr
        cy = 24.40 + 0.045 * fr
        label = f't{fr}'
        for z in range(zmin, zmax + 1):
            for (zz, xt, yt) in tiles_for_bbox(z):
                buf = bytearray(256 * 256 * 4)
                i = 0; any_px = False
                for py in range(256):
                    for px in range(256):
                        lon, lat = pixel_to_lonlat(z, xt, yt, px, py)
                        d = math.hypot((lon - cx) / 0.10, (lat - cy) / 0.07)
                        inten = max(0.0, 1.0 - d) ** 1.5
                        # second cell
                        d2 = math.hypot((lon - cx + 0.12) / 0.06, (lat - cy - 0.05) / 0.05)
                        inten = max(inten, max(0.0, 1.0 - d2) ** 1.5 * 0.8)
                        if inten <= 0.02:
                            buf[i+3] = 0
                        else:
                            any_px = True
                            # green -> yellow -> red precip ramp
                            if inten < 0.4:   r, g, b = 60, 200, 80
                            elif inten < 0.7: r, g, b = 235, 210, 60
                            else:             r, g, b = 225, 70, 60
                            buf[i] = r; buf[i+1] = g; buf[i+2] = b
                            buf[i+3] = int(min(220, 60 + inten * 180))
                        i += 4
                # only write non-empty tiles to keep the pack small
                if any_px:
                    write_png(os.path.join(ROOT, 'radar', label, str(z), str(xt),
                                           f'{yt}.png'), bytes(buf), alpha=True)
        frames.append({'id': label, 'minutes': (fr - (nframes - 2)) * 10})
    manifest = {'tilejson_template': 'radar/{frame}/{z}/{x}/{y}.png',
                'minzoom': zmin, 'maxzoom': zmax,
                'frames': frames}
    with open(os.path.join(ROOT, 'radar', 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=0)
    print(f'  radar: {nframes} frames (z{zmin}-{zmax}) -> radar/manifest.json')

def gen_contours():
    """Pre-baked depth contours as GeoJSON (marching squares over the DEM field).
    This is how ENC charts ship depth contours (DEPCNT) — vectors, not computed
    at runtime: reliable, offline, label-ready, no per-frame DEM decode. The
    runtime maplibre-contour path (DemSource) stays available for live/3rd-party
    DEMs; see web/integrations/contour.js."""
    minlon, minlat, maxlon, maxlat = (-81.97, 24.40, -81.56, 24.66)
    nx, ny = 300, 200
    grid = [[elevation(minlon + (maxlon - minlon) * i / (nx - 1),
                        maxlat - (maxlat - minlat) * j / (ny - 1))
             for i in range(nx)] for j in range(ny)]

    def px(i, j):
        return (round(minlon + (maxlon - minlon) * i / (nx - 1), 5),
                round(maxlat - (maxlat - minlat) * j / (ny - 1), 5))

    def interp(p1, p2, v1, v2, L):
        if v2 == v1:
            t = 0.5
        else:
            t = (L - v1) / (v2 - v1)
        return (round(p1[0] + (p2[0] - p1[0]) * t, 5),
                round(p1[1] + (p2[1] - p1[1]) * t, 5))

    feats = []
    # Variable interval: fine detail in the navigable shallows, calmer deep lines
    # (a uniform 5 m interval bunches into scan-lines down the shelf).
    levels = list(range(-30, 1, 5)) + [-40, -50, -70, -90, -120]
    majors = {0, 10, 20, 30, 50, 70, 90, 120}   # depth values drawn as index lines
    for L in levels:
        segs = []
        for j in range(ny - 1):
            for i in range(nx - 1):
                # corners: tl, tr, br, bl
                tl, tr = grid[j][i], grid[j][i+1]
                br, bl = grid[j+1][i+1], grid[j+1][i]
                idx = (1 if tl > L else 0) | (2 if tr > L else 0) | \
                      (4 if br > L else 0) | (8 if bl > L else 0)
                if idx == 0 or idx == 15:
                    continue
                Ptl, Ptr = px(i, j), px(i+1, j)
                Pbr, Pbl = px(i+1, j+1), px(i, j+1)
                top = lambda: interp(Ptl, Ptr, tl, tr, L)
                right = lambda: interp(Ptr, Pbr, tr, br, L)
                bottom = lambda: interp(Pbl, Pbr, bl, br, L)
                left = lambda: interp(Ptl, Pbl, tl, bl, L)
                e = {1: (left, top), 2: (top, right), 3: (left, right),
                     4: (right, bottom), 6: (top, bottom), 7: (left, bottom),
                     8: (bottom, left), 9: (bottom, top), 11: (right, top),
                     12: (right, left), 13: (bottom, right), 14: (top, left)}
                if idx in (5, 10):  # saddles -> two segments
                    if idx == 5:
                        segs.append([left(), top()]); segs.append([right(), bottom()])
                    else:
                        segs.append([top(), right()]); segs.append([bottom(), left()])
                else:
                    a, bb = e[idx]
                    segs.append([a(), bb()])
        if segs:
            feats.append({'type': 'Feature',
                'geometry': {'type': 'MultiLineString', 'coordinates': segs},
                'properties': {'ele': L, 'depth_m': -L, 'level': 1 if -L in majors else 0}})
    fc = {'type': 'FeatureCollection',
          'metadata': {'note': 'Synthetic depth contours — NOT FOR NAVIGATION',
                       'interval_m': 5, 'levels': len(feats)},
          'features': feats}
    with open(os.path.join(ROOT, 'depth-contours.geojson'), 'w') as f:
        json.dump(fc, f)
    # Also emit the same lines as the base chart's S-57 DEPCNT layer (keyed on
    # VALDCO = value of depth contour, positive metres) so depth contours render
    # as first-class chart data, not just a Lab overlay.
    depcnt = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': f['geometry'],
         'properties': {'VALDCO': f['properties']['depth_m']}}
        for f in feats if f['properties']['ele'] < 0]}
    with open(os.path.join(ROOT, 'depcnt.geojson'), 'w') as f:
        json.dump(depcnt, f)
    nseg = sum(len(x['geometry']['coordinates']) for x in feats)
    print(f'  contours: {len(feats)} levels, {nseg} segments -> depth-contours.geojson + depcnt.geojson')


def gen_soundg():
    """S-57 SOUNDG: scattered depth soundings (DEPTH, positive metres) sampled
    from the DEM over the visible region — the base chart's spot-depth layer."""
    import random
    random.seed(7)
    minlon, minlat, maxlon, maxlat = (-81.97, 24.40, -81.56, 24.66)
    feats = []
    nx, ny = 26, 18
    for j in range(ny):
        for i in range(nx):
            lon = minlon + (maxlon - minlon) * (i + 0.5) / nx + random.uniform(-0.004, 0.004)
            lat = minlat + (maxlat - minlat) * (j + 0.5) / ny + random.uniform(-0.004, 0.004)
            e = elevation(lon, lat)
            if e >= -0.2:
                continue  # land / drying — no sounding
            feats.append({'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [round(lon, 5), round(lat, 5)]},
                'properties': {'DEPTH': round(-e, 1)}})
    fc = {'type': 'FeatureCollection',
          'metadata': {'note': 'Synthetic soundings — NOT FOR NAVIGATION'},
          'features': feats}
    with open(os.path.join(ROOT, 'soundg.geojson'), 'w') as f:
        json.dump(fc, f)
    print(f'  soundings: {len(feats)} spot depths -> soundg.geojson')

def gen_depare():
    """S-57 DEPARE (depth areas): filled depth-band polygons keyed on DRVAL1
    (shallow depth of the band) — the chart's blue depth gradient. Classifies a
    grid into bands and run-length-merges each row into rectangles (seamless,
    no gaps, far fewer polygons than per-cell)."""
    minlon, minlat, maxlon, maxlat = (-81.97, 24.40, -81.56, 24.66)
    nx, ny = 170, 115
    dx, dy = (maxlon - minlon) / nx, (maxlat - minlat) / ny
    edges = [0, 2, 5, 10, 15, 20, 30, 40, 60, 80, 120, 1e9]

    def band(depth):
        for k in range(len(edges) - 1):
            if edges[k] <= depth < edges[k + 1]:
                return edges[k]
        return edges[-2]

    feats = []
    for j in range(ny):
        latT, latB = maxlat - j * dy, maxlat - (j + 1) * dy
        run_start, run_band = None, None
        def flush(i_end):
            nonlocal run_start, run_band
            if run_start is None:
                return
            lonL = round(minlon + run_start * dx, 5)
            lonR = round(minlon + i_end * dx, 5)
            feats.append({'type': 'Feature',
                'geometry': {'type': 'Polygon', 'coordinates': [[
                    [lonL, round(latT, 5)], [lonR, round(latT, 5)],
                    [lonR, round(latB, 5)], [lonL, round(latB, 5)], [lonL, round(latT, 5)]]]},
                'properties': {'DRVAL1': run_band}})
            run_start, run_band = None, None
        for i in range(nx):
            e = elevation(minlon + (i + 0.5) * dx, (latT + latB) / 2)
            b = None if e >= -0.2 else band(-e)
            if b != run_band:
                flush(i)
                if b is not None:
                    run_start, run_band = i, b
        flush(nx)
    fc = {'type': 'FeatureCollection',
          'metadata': {'note': 'Synthetic depth areas — NOT FOR NAVIGATION'},
          'features': feats}
    with open(os.path.join(ROOT, 'depare.geojson'), 'w') as f:
        json.dump(fc, f)
    print(f'  depare: {len(feats)} depth-area polygons -> depare.geojson')


def gen_places():
    """S-57-ish points of interest the base chart's places layer expects
    (kind + name): marinas, anchorages, fuel, etc. around Key West."""
    pts = [
        (-81.807, 24.566, 'marina',    'Key West Bight Marina'),
        (-81.730, 24.566, 'marina',    'Stock Island Marina'),
        (-81.800, 24.558, 'fuel',      'Conch Harbor Fuel'),
        (-81.795, 24.555, 'anchorage', 'Wisteria Anchorage'),
        (-81.760, 24.575, 'anchorage', 'Cow Key Anchorage'),
        (-81.811, 24.561, 'dinghy',    'A&B Dinghy Dock'),
        (-81.804, 24.563, 'chandlery', 'West Marine'),
        (-81.806, 24.565, 'water',     'Bight Water Point'),
    ]
    fc = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lo, la]},
         'properties': {'kind': k, 'name': n}} for (lo, la, k, n) in pts]}
    with open(os.path.join(ROOT, 'places.geojson'), 'w') as f:
        json.dump(fc, f)
    print(f'  places: {len(pts)} POIs -> places.geojson')


def gen_wind():
    """Wind field points (dir_deg, speed_kt) the base chart's wind layer rotates
    into arrows — a smooth prevailing SE breeze veering across the region."""
    minlon, minlat, maxlon, maxlat = BBOX
    feats = []
    nx, ny = 12, 9
    for j in range(ny):
        for i in range(nx):
            lon = minlon + (maxlon - minlon) * i / (nx - 1)
            lat = minlat + (maxlat - minlat) * j / (ny - 1)
            d = 120 + 30 * math.sin((lon + 81.8) / 0.2) + 12 * math.cos((lat - 24.5) / 0.15)
            spd = 12 + 4 * math.sin((lon + 81.7) / 0.18) + 3 * math.cos((lat - 24.5) / 0.2)
            feats.append({'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [round(lon, 4), round(lat, 4)]},
                'properties': {'dir_deg': round(d) % 360, 'speed_kt': round(spd, 1)}})
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(os.path.join(ROOT, 'wind_points.geojson'), 'w') as f:
        json.dump(fc, f)
    print(f'  wind: {len(feats)} field points -> wind_points.geojson')


if __name__ == '__main__':
    print('Generating offline demo data under web/data/ ...')
    gen_field('dem', 9, 12)
    gen_field('relief', 10, 12)
    gen_ais()
    gen_radar()
    gen_contours()
    gen_soundg()
    gen_depare()
    gen_places()
    gen_wind()
    # derived binary packs (pure-stdlib, no GDAL/tippecanoe)
    import subprocess
    here = os.path.dirname(__file__)
    subprocess.run(['python3', os.path.join(here, 'make_pmtiles.py'),
                    os.path.join(ROOT, 'relief'),
                    os.path.join(ROOT, 'key-west-sat.pmtiles')], check=True)
    subprocess.run(['python3', os.path.join(here, 'make_geotiff.py')], check=True)
    print('done — full offline demo pack under web/data/.')
