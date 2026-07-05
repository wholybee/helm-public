// WX-33 unit test: helm.env.grid.v1 decode — band decode (int16/uint16, scale/offset,
// NODATA->NaN), fail-loud codes, tier assembly with lon wrap + visible holes, velocity
// conversion, and valid-time bracketing. Run: node web/tests/wx-grid-decode.test.js
const assert = require('assert');
const D = require(require('path').join(__dirname, '..', 'wx-grid-decode.js'));

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}
function throwsCode(fn, code) {
  try { fn(); } catch (e) { assert.strictEqual(e.code, code, 'expected ' + code + ' got ' + e.code); return; }
  throw new Error('expected loud ' + code + ', nothing thrown');
}

// Build a chunk envelope with KNOWN values. rows[b][r][c]: row 0 = NORTH edge.
function envelope(opts) {
  const bands = opts.bands, names = Object.keys(bands);
  const w = opts.width, h = opts.height, cells = w * h;
  const payload = Buffer.alloc(cells * 2 * names.length);
  let off = 0;
  for (const name of names) {
    const b = bands[name];
    for (let i = 0; i < cells; i++) {
      const v = b.stored[i];
      if (b.type === 'uint16') payload.writeUInt16LE(v, off);
      else payload.writeInt16LE(v, off);
      off += 2;
    }
  }
  const header = {
    schema: 'helm.env.grid.chunk.v1', encoding: 'helm.env.grid.v1',
    endianness: 'little', compression: opts.compression || 'none',
    tier: 'global-low', layer: opts.layer || 'wind', validTime: '2026-07-01T00:00:00Z',
    bbox: opts.bbox, grid: { width: w, height: h, dx: opts.dx, dy: opts.dy },
    bands: Object.fromEntries(names.map(n => [n, {
      type: bands[n].type, scale: bands[n].scale, offset: bands[n].offset || 0,
      nodata: bands[n].nodata, unit: 'm/s'
    }]))
  };
  return { header, payload: new Uint8Array(payload) };
}

ok('int16 + uint16 decode with scale/offset; nodata -> NaN', () => {
  const env = envelope({
    width: 2, height: 1, dx: 0.5, dy: 0.5, bbox: [0, 0, 0.5, 0],
    bands: {
      u: { type: 'int16', scale: 0.01, nodata: -32768, stored: [1234, -32768] },
      r: { type: 'uint16', scale: 0.1, offset: -5, nodata: 65535, stored: [123, 65535] }
    }
  });
  const d = D.decodeChunk(env, {});
  assert.ok(Math.abs(d.bands.u[0] - 12.34) < 1e-6);
  assert.ok(Number.isNaN(d.bands.u[1]), 'int16 nodata -> NaN');
  assert.ok(Math.abs(d.bands.r[0] - (12.3 - 5)) < 1e-6, 'uint16 scale+offset');
  assert.ok(Number.isNaN(d.bands.r[1]), 'uint16 nodata -> NaN');
});

ok('fail-loud codes: compression, band type, endianness, payload length', () => {
  const base = { width: 1, height: 1, dx: 1, dy: 1, bbox: [0, 0, 0, 0],
    bands: { u: { type: 'int16', scale: 1, nodata: -32768, stored: [5] } } };
  const zst = envelope(base); zst.header.compression = 'zstd';
  throwsCode(() => D.decodeChunk(zst, {}), 'unsupported_compression');
  const f16 = envelope(base); f16.header.bands.u.type = 'float16';
  throwsCode(() => D.decodeChunk(f16, {}), 'unsupported_band_type');
  const be = envelope(base); be.header.endianness = 'big';
  throwsCode(() => D.decodeChunk(be, {}), 'unsupported_endianness');
  const short = envelope(base); short.payload = short.payload.slice(0, 1);
  throwsCode(() => D.decodeChunk(short, {}), 'bad_payload_length');
});

ok('assembleTier places chunks at bbox offsets (row 0 = north) and wraps lon', () => {
  // tiny "global" tier: 4 cols x 3 rows @ 90 deg; west -180, north 90
  const manifest = {
    packId: 'p', coverage: { global: true, bbox: [-180, -90, 180, 90] },
    tiers: { 'global-low': { grid: { dx: 90, dy: 90, width: 4, height: 3 } } },
    layers: { wind: { kind: 'vector', tier: 'global-low', bands: { u: {}, v: {} } } }
  };
  // one 2x2 chunk anchored at lon 90..180 (cols 3, 0-wrapped), lat 90..0 (rows 0,1)
  const chunk = {
    bbox: [90, 0, 180, 90], grid: { width: 2, height: 2, dx: 90, dy: 90 },
    bands: { u: Float32Array.from([1, 2, 3, 4]), v: Float32Array.from([5, 6, 7, 8]) }
  };
  const a = D.assembleTier(manifest, 'wind', '2026-07-01T00:00:00Z', [chunk]);
  assert.strictEqual(a.meta.width, 4); assert.strictEqual(a.meta.height, 3);
  const u = a.bands.u;
  assert.strictEqual(u[0 * 4 + 3], 1, 'chunk row0col0 -> tier row0 col3 (lon 90)');
  assert.strictEqual(u[0 * 4 + 0], 2, 'lon 180 wraps to col 0');
  assert.strictEqual(u[1 * 4 + 3], 3, 'row 1 south of row 0');
  assert.strictEqual(u[1 * 4 + 0], 4);
  assert.ok(Number.isNaN(u[2 * 4 + 1]), 'uncovered cells stay NaN — visible hole');
  assert.strictEqual(a.chunksPlaced, 1);
});

ok('chunkKeysFor filters the manifest index by layer + compact valid time', () => {
  const manifest = { chunks: {
    'global-low/wind/20260701T000000Z/-180_-90': {},
    'global-low/wind/20260701T030000Z/-180_-90': {},
    'global-low/rain/20260701T000000Z/-180_-90': {}
  } };
  const keys = D.chunkKeysFor(manifest, 'wind', '2026-07-01T00:00:00Z');
  assert.deepStrictEqual(keys, ['global-low/wind/20260701T000000Z/-180_-90']);
});

ok('toVelocityGrid converts units explicitly and keeps NaN honest', () => {
  const assembled = {
    meta: { width: 2, height: 1, dx: 1, dy: 1, west: 0, south: 0, east: 1, north: 0, global: false },
    bands: { u: Float32Array.from([10, NaN]), v: Float32Array.from([0, 3]) }
  };
  const vel = D.toVelocityGrid(assembled, 1.9438445);   // m/s -> kn
  assert.ok(Math.abs(vel[0].data[0] - 19.438445) < 1e-6);
  assert.ok(Number.isNaN(vel[0].data[1]));
  assert.strictEqual(vel[0].header.nx, 2);
  assert.strictEqual(vel[1].header.parameterNumber, 3);
});

ok('bracketValidTimes lerps between frames, clamps outside, snaps at edges', () => {
  const ts = ['2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z'];
  const mid = D.bracketValidTimes(ts, '2026-07-01T01:30:00Z');
  assert.strictEqual(mid.a, ts[0]); assert.strictEqual(mid.b, ts[1]);
  assert.ok(Math.abs(mid.frac - 0.5) < 1e-9);
  assert.strictEqual(D.bracketValidTimes(ts, '2026-06-30T00:00:00Z').frac, 0);
  assert.strictEqual(D.bracketValidTimes(ts, '2026-07-02T00:00:00Z').a, ts[1]);
  throwsCode(() => D.bracketValidTimes([], null), 'stale_run');
});

console.log((process.exitCode ? 'FAIL' : 'ok') + ' - wx-grid-decode: ' + pass + ' groups passed');

ok('grid.origin: absent defaults northwest; anything else fails loud (contract §6 pin)', () => {
  const base = { width: 1, height: 1, dx: 1, dy: 1, bbox: [0, 0, 0, 0],
    bands: { u: { type: 'int16', scale: 1, nodata: -32768, stored: [5] } } };
  const nw = envelope(base); nw.header.grid.origin = 'northwest';
  assert.strictEqual(D.decodeChunk(nw, {}).bands.u[0], 5, 'explicit northwest decodes');
  const legacy = envelope(base);                       // no origin — pre-pin v1 pack
  assert.strictEqual(D.decodeChunk(legacy, {}).bands.u[0], 5, 'absent origin = northwest');
  const flipped = envelope(base); flipped.header.grid.origin = 'southwest';
  throwsCode(() => D.decodeChunk(flipped, {}), 'unsupported_grid_origin');
});
