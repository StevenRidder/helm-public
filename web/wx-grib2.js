// wx-grib2.js — a small, dependency-free GRIB2 reader (simple packing).  WX epic · WX-12.
// ----------------------------------------------------------------------------------------------
// Decodes a GRIB2 file (edition 2) entirely in the browser so a user-exported PredictWind GRIB can
// be imported DEVICE-LOCALLY — never uploaded, never sent to the engine/backend, excluded from sync
// (PredictWind GRIB is ECMWF/AROME/UKMO-derived, "internal use only"; see docs/WEATHER.md). No npm,
// no WASM: a hand-written section + bit reader. Pure, node + browser, self-tested:
//   node web/wx-grib2.js --test
//
// Supports: Grid Definition Template 3.0 (regular lat/lon) and Data Representation Template 5.0
// (simple packing) with or without a bitmap. Other packings (complex 5.2/5.3, JPEG2000 5.40,
// PNG 5.41) are reported `unsupported` with the header still parsed — we show what we can and say
// what we can't, never inventing values.
//
// Value reconstruction (simple packing): Y = (R + X·2^E) / 10^D
//   R = reference value (IEEE f32), E = binary scale, D = decimal scale, X = the nbits-packed int.
(function (root) {
  'use strict';

  // GRIB2 stores signed lat/lon and scale factors as SIGN-MAGNITUDE (high bit = negative), not 2's
  // complement — get these wrong and a southern-hemisphere GRIB lands in the wrong place.
  function smInt(raw, bits) {
    var signbit = 1 << (bits - 1);
    return (raw & signbit) ? -(raw & (signbit - 1)) : raw;
  }
  function readSM(dv, off, nbytes) {
    var raw = nbytes === 4 ? dv.getUint32(off) : dv.getUint16(off);
    return smInt(raw, nbytes * 8);
  }

  // Parameter names by (discipline, category, number) — just the marine-relevant few we render.
  var PARAMS = {
    '0.2.2': { name: 'UGRD', long: 'u-wind', unit: 'm/s' },
    '0.2.3': { name: 'VGRD', long: 'v-wind', unit: 'm/s' },
    '0.2.1': { name: 'WIND', long: 'wind speed', unit: 'm/s' },
    '0.2.0': { name: 'WDIR', long: 'wind direction', unit: '°' },
    '0.2.22': { name: 'GUST', long: 'wind gust', unit: 'm/s' },
    '0.3.1': { name: 'PRMSL', long: 'pressure MSL', unit: 'Pa' },
    '0.0.0': { name: 'TMP', long: 'temperature', unit: 'K' },
    '10.0.3': { name: 'HTSGW', long: 'sig wave height', unit: 'm' },
    '10.0.5': { name: 'WVHGT', long: 'wind wave height', unit: 'm' },
  };
  function paramInfo(discipline, cat, num) {
    return PARAMS[discipline + '.' + cat + '.' + num] || { name: 'p' + discipline + '_' + cat + '_' + num, long: 'parameter', unit: '' };
  }

  // Read `nbits`-bit big-endian unsigned ints sequentially from `bytes` starting at byte `start`.
  function bitReader(bytes, start) {
    var bitpos = start * 8;
    return function (nbits) {
      var v = 0;
      for (var i = 0; i < nbits; i++) {
        var b = bytes[bitpos >> 3] || 0;
        v = (v << 1) | ((b >> (7 - (bitpos & 7))) & 1);
        bitpos++;
      }
      return v >>> 0;
    };
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('parseGrib2: expected ArrayBuffer/Uint8Array');
  }

  function parseMessage(bytes, msgStart, dv) {
    var discipline = bytes[msgStart + 6], edition = bytes[msgStart + 7];
    if (edition !== 2) return { error: 'not GRIB edition 2 (got ' + edition + ')', skip: 16 };
    // total length is an 8-byte int; the high 4 bytes are ~always 0 for these files.
    var totalLen = dv.getUint32(msgStart + 8) * 4294967296 + dv.getUint32(msgStart + 12);
    var msg = { discipline: discipline, edition: 2, _len: totalLen };
    // Bound the walk by the ACTUAL buffer, not just the message's claimed length — a truncated /
    // corrupt GRIB (partial download, half-written export) must degrade honestly, not read past the
    // end and throw an opaque RangeError.
    var end = Math.min(msgStart + totalLen, bytes.length);
    var sp = msgStart + 16, dataStart = 0, dataLen = 0, bitmapPresent = false, bitmap = null;
    while (sp + 5 <= end) {
      if (bytes[sp] === 0x37 && bytes[sp + 1] === 0x37 && bytes[sp + 2] === 0x37 && bytes[sp + 3] === 0x37) break; // "7777"
      var secLen = dv.getUint32(sp), secNum = bytes[sp + 4];
      if (secLen < 5 || sp + secLen > end) break;           // section claims to run past the buffer -> stop
      if (secNum === 3) {                                   // grid definition
        var gdt = dv.getUint16(sp + 12);
        msg.gridTemplate = gdt;
        if (gdt === 0) {                                    // regular lat/lon
          msg.grid = {
            ni: dv.getUint32(sp + 30), nj: dv.getUint32(sp + 34),
            la1: readSM(dv, sp + 46, 4) * 1e-6, lo1: readSM(dv, sp + 50, 4) * 1e-6,
            la2: readSM(dv, sp + 55, 4) * 1e-6, lo2: readSM(dv, sp + 59, 4) * 1e-6,
            di: readSM(dv, sp + 63, 4) * 1e-6, dj: readSM(dv, sp + 67, 4) * 1e-6,
            scanMode: bytes[sp + 71],
          };
        } else { msg.unsupported = 'grid template ' + gdt + ' (only 3.0 lat/lon)'; }
      } else if (secNum === 4) {                            // product definition
        var pdt = dv.getUint16(sp + 7);
        if (pdt === 0 || pdt === 8) {                       // analysis/forecast or accumulation
          msg.param = paramInfo(discipline, bytes[sp + 9], bytes[sp + 10]);
        } else { msg.param = { name: 'pdt' + pdt, long: 'parameter', unit: '' }; }
      } else if (secNum === 5) {                            // data representation
        msg.dataTemplate = dv.getUint16(sp + 9);
        msg.numPoints = dv.getUint32(sp + 5);
        if (msg.dataTemplate === 0) {
          msg.refValue = dv.getFloat32(sp + 11);
          msg.binScale = readSM(dv, sp + 15, 2);
          msg.decScale = readSM(dv, sp + 17, 2);
          msg.nbits = bytes[sp + 19];
        } else { msg.unsupported = 'data template ' + msg.dataTemplate + ' (only 5.0 simple packing)'; }
      } else if (secNum === 6) {                            // bitmap
        var ind = bytes[sp + 5];
        if (ind === 0) { bitmapPresent = true; bitmap = { start: sp + 6 }; }
        else if (ind !== 255) { msg.unsupported = 'predefined bitmap ' + ind; }
      } else if (secNum === 7) {                            // data
        dataStart = sp + 5; dataLen = secLen - 5;
      }
      sp += secLen;
    }

    // Decode the values (simple packing) unless something is unsupported.
    if (!msg.unsupported && msg.dataTemplate === 0 && msg.grid && dataStart) {
      var n = msg.grid.ni * msg.grid.nj;                    // grid is authoritative — caps a corrupt numPoints
      var read = bitReader(bytes, dataStart);
      var pow2E = Math.pow(2, msg.binScale), pow10D = Math.pow(10, -msg.decScale);
      var vals = new Float64Array(n);
      var bm = bitmapPresent ? bitReader(bytes, bitmap.start) : null;
      for (var i = 0; i < n; i++) {
        if (bm && bm(1) === 0) { vals[i] = NaN; continue; }   // masked -> NODATA (never faked)
        var X = msg.nbits > 0 ? read(msg.nbits) : 0;
        vals[i] = (msg.refValue + X * pow2E) * pow10D;
      }
      msg.values = vals;
    } else {
      msg.values = null;
    }
    return { msg: msg, skip: totalLen };
  }

  // PUBLIC — parse a whole GRIB2 file (which may concatenate several messages).
  function parseGrib2(input) {
    var bytes = toBytes(input);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var messages = [], errors = [], pos = 0, len = bytes.length;
    while (pos + 16 <= len) {
      if (!(bytes[pos] === 0x47 && bytes[pos + 1] === 0x52 && bytes[pos + 2] === 0x49 && bytes[pos + 3] === 0x42)) { // "GRIB"
        pos++; continue;                                    // tolerate leading junk; resync on the magic
      }
      var r = parseMessage(bytes, pos, dv);
      if (r.error) { errors.push(r.error); pos += r.skip || 16; continue; }
      messages.push(r.msg);
      pos += r.skip || 16;
    }
    return { messages: messages, errors: errors };
  }

  // Convenience: turn a decoded lat/lon message into the field-<layer>.json-ish grid the renderer
  // wants — { nx, ny, west, north, east, south, values(row-major N->S), unit }. Honours scan mode
  // bit-2 (j scans positive = south->north) by flipping rows so row 0 is always north.
  function nlon(x) { return x > 180 ? x - 360 : x; }       // many GRIBs use 0..360 — fold to -180..180
  function messageToField(msg) {
    if (!msg.grid || !msg.values) return null;
    var g = msg.grid, nx = g.ni, ny = g.nj;
    var north = Math.max(g.la1, g.la2), south = Math.min(g.la1, g.la2);
    var lo1 = nlon(g.lo1), lo2 = nlon(g.lo2);
    var west = Math.min(lo1, lo2), east = Math.max(lo1, lo2);
    var jPositive = (g.scanMode & 0x40) !== 0;              // bit-2: +j (south -> north)
    var iNeg = (g.scanMode & 0x80) !== 0;                  // bit-1: -i (east -> west)
    var out = new Float64Array(nx * ny);
    for (var j = 0; j < ny; j++) {
      var srcRow = jPositive ? (ny - 1 - j) : j;            // make row 0 = north
      for (var i = 0; i < nx; i++) {
        var srcCol = iNeg ? (nx - 1 - i) : i;
        out[j * nx + i] = msg.values[srcRow * nx + srcCol];
      }
    }
    return { nx: nx, ny: ny, west: west, north: north, east: east, south: south,
             values: out, unit: msg.param ? msg.param.unit : '', param: msg.param ? msg.param.name : '' };
  }

  var api = { parseGrib2: parseGrib2, messageToField: messageToField, paramInfo: paramInfo, _smInt: smInt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HelmGrib2 = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));


// ---- self-test: `node web/wx-grib2.js --test` ----------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  var G = module.exports, fails = 0;
  function ok(c, m) { if (c) console.log('  ok   ', m); else { fails++; console.log('  FAIL ', m); } }
  // sign-magnitude decode
  ok(G._smInt(0x80000005, 32) === -5, 'sign-magnitude: high bit = negative');
  ok(G._smInt(5, 32) === 5, 'sign-magnitude: positive');
  // round-trip a synthetic GRIB2 authored by the python sibling, if present (the strong test lives
  // in pipeline/test_grib_import via node); here just assert the parser runs on a non-GRIB buffer.
  var r = G.parseGrib2(new Uint8Array([1, 2, 3, 4]));
  ok(r.messages.length === 0, 'non-GRIB buffer yields no messages (no crash)');
  // a GRIB header claiming a huge length but with no body must NOT throw (truncated/corrupt file).
  var trunc = new Uint8Array(16); trunc.set([0x47, 0x52, 0x49, 0x42]); trunc[7] = 2; trunc[15] = 0xFF;
  var safe = true; try { G.parseGrib2(trunc); } catch (e) { safe = false; }
  ok(safe, 'truncated GRIB (claimed length > buffer) degrades without throwing');
  console.log(fails ? ('\nGRIB2 TESTS: ' + fails + ' FAILED') : '\nGRIB2 TESTS: all passed');
  process.exit(fails ? 1 : 0);
}
