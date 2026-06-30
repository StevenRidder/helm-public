// wx-scene-webgpu.js — WX-19 phase 4: WebGPU render path for the Environmental Scene (primary target).
// ------------------------------------------------------------------------------------------------
// Decodes + colourises each prepared helm-wxv1 field tile ON THE GPU (WGSL), returning a colourised
// ImageBitmap that the existing MapLibre raster layer composites — so WebGPU does the per-pixel work
// while MapLibre keeps correct z-order (field under chart symbols) and per-tile LOD/overzoom. This
// sidesteps the WebGPU<->MapLibre compositing traps (an on-top overlay would cover symbols; a canvas
// source would lose zoom resolution): GPU shading + MapLibre compositing, best of both.
//
// Feature-detected. HelmWxScene uses this when navigator.gpu is present (and HELM_WX_WEBGPU !== false);
// otherwise it falls back to the CPU colourise (the WebGL/MapLibre path), which stays the default-safe
// renderer. v1 = scalar colour field. Particle advection in a WebGPU compute pass is a documented
// follow-on; the canvas particle engine continues to drive wind/current for now.
(function (global) {
  'use strict';

  function supported() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

  var devP = null;        // Promise<{device, format}>
  function device() {
    if (devP) return devP;
    if (!supported()) { devP = Promise.reject(new Error('WebGPU unavailable')); return devP; }
    devP = navigator.gpu.requestAdapter().then(function (ad) {
      if (!ad) throw new Error('no WebGPU adapter');
      return ad.requestDevice();
    }).then(function (dev) {
      return { device: dev, format: navigator.gpu.getPreferredCanvasFormat() };
    });
    return devP;
  }

  // GPU decode (helm-wxv1: rgb = 24-bit value, a = NODATA) + ramp LUT lookup, drawn to a full tile.
  var WGSL = [
    'struct P { scale: f32, offset: f32, rmin: f32, rspan: f32 };',
    '@group(0) @binding(0) var src: texture_2d<f32>;',
    '@group(0) @binding(1) var s: sampler;',
    '@group(0) @binding(2) var ramp: texture_2d<f32>;',
    '@group(0) @binding(3) var<uniform> u: P;',
    'struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };',
    '@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {',
    '  var p = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));',
    '  var o: VO; o.pos = vec4<f32>(p[i], 0.0, 1.0);',
    '  o.uv = vec2<f32>((p[i].x+1.0)*0.5, (1.0-p[i].y)*0.5); return o;',   // y-flip: texture row 0 = north
    '}',
    '@fragment fn fs(in: VO) -> @location(0) vec4<f32> {',
    '  let px = textureSample(src, s, in.uv);',
    '  let r = floor(px.r*255.0+0.5); let g = floor(px.g*255.0+0.5); let b = floor(px.b*255.0+0.5);',
    '  let n = r*65536.0 + g*256.0 + b;',
    '  let value = u.offset + n*u.scale;',
    '  let t = clamp((value - u.rmin)/max(u.rspan, 1e-6), 0.0, 1.0);',
    '  let c = textureSample(ramp, s, vec2<f32>(t, 0.5));',              // sampled unconditionally -> uniform control flow (no early return)',
    '  return vec4<f32>(c.rgb, select(c.a, 0.0, px.a < 0.5));',          // NODATA (src alpha low) -> transparent',
    '}'
  ].join('\n');

  // WX-23: two-frame value interpolation. Decode BOTH frames' helm-wxv1 tiles, lerp the VALUE per
  // pixel (not an opacity crossfade), then ramp — so the colour is the colour of the interpolated
  // value. NODATA-honest: if one frame is nodata at a pixel we use the other; if both are nodata the
  // pixel stays transparent (never invents a value). textureSample stays unconditional (uniform flow).
  var WGSL_PAIR = [
    'struct P2 { scale: f32, offset: f32, rmin: f32, rspan: f32, frac: f32 };',
    '@group(0) @binding(0) var srcA: texture_2d<f32>;',
    '@group(0) @binding(1) var s: sampler;',
    '@group(0) @binding(2) var ramp: texture_2d<f32>;',
    '@group(0) @binding(3) var<uniform> u: P2;',
    '@group(0) @binding(4) var srcB: texture_2d<f32>;',
    'struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };',
    '@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {',
    '  var p = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));',
    '  var o: VO; o.pos = vec4<f32>(p[i], 0.0, 1.0);',
    '  o.uv = vec2<f32>((p[i].x+1.0)*0.5, (1.0-p[i].y)*0.5); return o;',
    '}',
    'fn val24(px: vec4<f32>, scale: f32, offset: f32) -> f32 {',
    '  let r = floor(px.r*255.0+0.5); let g = floor(px.g*255.0+0.5); let b = floor(px.b*255.0+0.5);',
    '  return offset + (r*65536.0 + g*256.0 + b)*scale;',
    '}',
    '@fragment fn fs(in: VO) -> @location(0) vec4<f32> {',
    '  let pa = textureSample(srcA, s, in.uv);',
    '  let pb = textureSample(srcB, s, in.uv);',
    '  let va = val24(pa, u.scale, u.offset);',
    '  let vb = val24(pb, u.scale, u.offset);',
    '  let badA = pa.a < 0.5; let badB = pb.a < 0.5;',          // NODATA flags per frame
    '  let both = (!badA) && (!badB); let onlyA = (!badA) && badB; let onlyB = badA && (!badB);',
    '  var value: f32 = 0.0;',
    '  value = select(value, vb, onlyB);',                      // A nodata, B has data -> B
    '  value = select(value, va, onlyA);',                      // B nodata, A has data -> A
    '  value = select(value, mix(va, vb, u.frac), both);',      // both -> lerp the value by time fraction
    '  let t = clamp((value - u.rmin)/max(u.rspan, 1e-6), 0.0, 1.0);',
    '  let c = textureSample(ramp, s, vec2<f32>(t, 0.5));',     // unconditional sample -> uniform control flow
    '  return vec4<f32>(c.rgb, select(c.a, 0.0, badA && badB));', // both-nodata -> transparent
    '}'
  ].join('\n');

  var gpu = null;         // { device, format, pipeline, pairPipeline, sampler, ramps:{} }
  function ensurePipeline() {
    if (gpu) return Promise.resolve(gpu);
    return device().then(function (d) {
      var dev = d.device, fmt = 'rgba8unorm';
      var mod = dev.createShaderModule({ code: WGSL });
      var pipeline = dev.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: fmt }] },   // no blend: one full-screen draw, straight alpha out
        primitive: { topology: 'triangle-list' }
      });
      var sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      gpu = { device: dev, format: fmt, pipeline: pipeline, sampler: sampler, ramps: {} };
      return gpu;
    });
  }

  // Bake a 256x1 RGBA ramp LUT texture from HelmWxRamp for `layer` over [rmin..rmax] (cached per layer+range).
  function rampTexture(g, layer, rmin, rmax) {
    var key = layer + '|' + rmin + '|' + rmax, cached = g.ramps[key];
    if (cached) return cached;
    var R = global.HelmWxRamp, lut = new Uint8Array(256 * 4), span = (rmax - rmin) || 1;
    for (var i = 0; i < 256; i++) {
      var v = rmin + (i / 255) * span, c = R ? R.rampColor(layer, v) : [255, 255, 255, 255];
      lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2]; lut[i * 4 + 3] = c[3];
    }
    var tex = g.device.createTexture({ size: [256, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    g.device.queue.writeTexture({ texture: tex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
    g.ramps[key] = tex; return tex;
  }

  // Colourise one helm-wxv1 tile on the GPU. `srcBitmap` = the raw value tile (ImageBitmap, 256x256).
  // Returns a colourised ImageBitmap MapLibre can composite. `rmin/rmax` = the ramp's value domain.
  function colorizeBitmap(srcBitmap, layer, scale, offset, rmin, rmax) {
    return ensurePipeline().then(function (g) {
      var dev = g.device, w = srcBitmap.width || 256, h = srcBitmap.height || 256;
      var bpr = Math.ceil((w * 4) / 256) * 256;                   // copyTextureToBuffer needs a 256-aligned bytesPerRow
      var srcTex = dev.createTexture({ size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });   // RENDER_ATTACHMENT required by copyExternalImageToTexture
      dev.queue.copyExternalImageToTexture({ source: srcBitmap }, { texture: srcTex }, [w, h]);
      var dst = dev.createTexture({ size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      var rbuf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      var rampTex = rampTexture(g, layer, rmin, rmax);
      var ubuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ubuf, 0, new Float32Array([scale, offset, rmin, (rmax - rmin) || 1]));
      var bind = dev.createBindGroup({ layout: g.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: srcTex.createView() }, { binding: 1, resource: g.sampler },
        { binding: 2, resource: rampTex.createView() }, { binding: 3, resource: { buffer: ubuf } } ] });
      var enc = dev.createCommandEncoder();
      var pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(g.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
      enc.copyTextureToBuffer({ texture: dst }, { buffer: rbuf, bytesPerRow: bpr }, [w, h]);
      dev.queue.submit([enc.finish()]);
      return rbuf.mapAsync(GPUMapMode.READ).then(function () {
        var padded = new Uint8Array(rbuf.getMappedRange()), out = new Uint8ClampedArray(w * 4 * h);
        for (var row = 0; row < h; row++) out.set(padded.subarray(row * bpr, row * bpr + w * 4), row * w * 4);
        rbuf.unmap();
        try { srcTex.destroy(); dst.destroy(); rbuf.destroy(); } catch (e) {}
        return createImageBitmap(new ImageData(out, w, h));
      });
    });
  }

  function ensurePairPipeline() {
    return ensurePipeline().then(function (g) {
      if (g.pairPipeline) return g;
      var mod = g.device.createShaderModule({ code: WGSL_PAIR });
      g.pairPipeline = g.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: g.format }] },
        primitive: { topology: 'triangle-list' }
      });
      return g;
    });
  }

  // WX-23: colourise the time-interpolated field between two frames. srcA/srcB = the same z/x/y
  // value tile from the two bracketing valid times; frac in [0,1] is the position between them.
  // Returns a colourised ImageBitmap (same contract as colorizeBitmap, so the tile handler is identical).
  function colorizeBitmapPair(srcA, srcB, frac, layer, scale, offset, rmin, rmax) {
    return ensurePairPipeline().then(function (g) {
      var dev = g.device, w = srcA.width || 256, h = srcA.height || 256;
      var bpr = Math.ceil((w * 4) / 256) * 256;
      function up(bm) {
        var t = dev.createTexture({ size: [w, h], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        dev.queue.copyExternalImageToTexture({ source: bm }, { texture: t }, [w, h]); return t;
      }
      var texA = up(srcA), texB = up(srcB);
      var dst = dev.createTexture({ size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      var rbuf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      var rampTex = rampTexture(g, layer, rmin, rmax);
      var ubuf = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      var f = Math.max(0, Math.min(1, frac));
      dev.queue.writeBuffer(ubuf, 0, new Float32Array([scale, offset, rmin, (rmax - rmin) || 1, f, 0, 0, 0]));
      var bind = dev.createBindGroup({ layout: g.pairPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texA.createView() }, { binding: 1, resource: g.sampler },
        { binding: 2, resource: rampTex.createView() }, { binding: 3, resource: { buffer: ubuf } },
        { binding: 4, resource: texB.createView() } ] });
      var enc = dev.createCommandEncoder();
      var pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(g.pairPipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
      enc.copyTextureToBuffer({ texture: dst }, { buffer: rbuf, bytesPerRow: bpr }, [w, h]);
      dev.queue.submit([enc.finish()]);
      return rbuf.mapAsync(GPUMapMode.READ).then(function () {
        var padded = new Uint8Array(rbuf.getMappedRange()), out = new Uint8ClampedArray(w * 4 * h);
        for (var row = 0; row < h; row++) out.set(padded.subarray(row * bpr, row * bpr + w * 4), row * w * 4);
        rbuf.unmap();
        try { texA.destroy(); texB.destroy(); dst.destroy(); rbuf.destroy(); } catch (e) {}
        return createImageBitmap(new ImageData(out, w, h));
      });
    });
  }

  global.HelmWxSceneGPU = { supported: supported, ready: ensurePipeline, colorizeBitmap: colorizeBitmap,
    colorizeBitmapPair: colorizeBitmapPair, rampTexture: rampTexture };
})(typeof window !== 'undefined' ? window : this);
