// WX-26 unit test: the helm-envd chunk-endpoint transport — the ONLY transport the live
// boat screen uses. Stubbed fetch pins the exact URL shape (encodeURIComponent round-trip
// of slash/colon packIds), client-side length+sha256 verification of endpoint bytes, and
// the loud envd-down/refusal codes. Run: node web/tests/wx-grid-endpoint.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');

let pass = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok - ' + name); },
    (e) => { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; });
}

function makeContext(fetchImpl) {
  const win = {
    console,
    TextDecoder, URL,                                        // vm context lacks web globals
    location: { href: 'http://localhost:8080/' },
    fetch: fetchImpl,
    crypto: {
      subtle: { digest: async (_alg, bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest().buffer },
    },
  };
  win.window = win;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'wx-grid-pack-client.js'), 'utf8'), vm.createContext(win));
  return win;
}

// a real HELMGRID envelope so parseEnvelope succeeds end-to-end
function envelopeBytes() {
  const header = Buffer.from(JSON.stringify({
    schema: 'helm.env.grid.chunk.v1', encoding: 'helm.env.grid.v1', endianness: 'little',
    compression: 'none', tier: 't', layer: 'wind', validTime: '2026-07-01T00:00:00Z',
    bbox: [0, 0, 1, 1], grid: { width: 1, height: 1, dx: 1, dy: 1, origin: 'northwest' },
    bands: { u: { type: 'int16', scale: 1, offset: 0, nodata: -32768 } },
  }));
  const head = Buffer.alloc(16);
  head.write('HELMGRID', 0, 'ascii');
  head.writeUInt16LE(1, 8); head.writeUInt16LE(0, 10); head.writeUInt32LE(header.length, 12);
  return Buffer.concat([head, header, Buffer.from([0x05, 0x00])]);
}

const BYTES = envelopeBytes();
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
const PACK_ID = 'open-meteo/gfs-seamless/2026-07-02T12:00:00Z/route-high/177.4_-17.6';
const CHUNK_KEY = 'route-high/wind/20260702T120000Z/157.4_-32.6';
const MANIFEST = {
  packId: PACK_ID,
  transport: { packUrl: 'x.pmtiles' },
  chunks: { [CHUNK_KEY]: { byteRange: [0, BYTES.length], checksum: 'sha256:' + SHA } },
};
const OPTS = { chunkEndpoint: 'http://localhost:8094' };

(async () => {
  await ok('endpoint URL shape: /chunk?pack=&chunk= with slash/colon packIds fully encoded', async () => {
    let seen = null;
    const win = makeContext(async (url) => {
      seen = url;
      return { ok: true, status: 200, arrayBuffer: async () => BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.length) };
    });
    const env = await win.HelmWxGridPacks.fetchChunk(MANIFEST, 'http://localhost:8080/m.json', CHUNK_KEY, OPTS);
    assert.strictEqual(seen,
      'http://localhost:8094/chunk?pack=' + encodeURIComponent(PACK_ID) + '&chunk=' + encodeURIComponent(CHUNK_KEY));
    assert.ok(!seen.includes('open-meteo/'), 'slashes must be percent-encoded');
    assert.strictEqual(env.header.schema, 'helm.env.grid.chunk.v1', 'envelope decodes');
  });

  await ok('endpoint bytes are still client-checksummed (defense in depth)', async () => {
    const bad = Buffer.from(BYTES); bad[bad.length - 1] ^= 0xff;   // envd "verified" but bytes differ
    const win = makeContext(async () => ({ ok: true, status: 200, arrayBuffer: async () => bad.buffer.slice(0, bad.length) }));
    await assert.rejects(
      win.HelmWxGridPacks.fetchChunk(MANIFEST, 'http://localhost:8080/m.json', CHUNK_KEY, OPTS),
      (e) => e.code === 'checksum_mismatch');
  });

  await ok('short endpoint body fails loud as missing_range', async () => {
    const win = makeContext(async () => ({ ok: true, status: 200, arrayBuffer: async () => BYTES.buffer.slice(0, 10) }));
    await assert.rejects(
      win.HelmWxGridPacks.fetchChunk(MANIFEST, 'http://localhost:8080/m.json', CHUNK_KEY, OPTS),
      (e) => e.code === 'missing_range');
  });

  await ok('envd refusal surfaces the envd error code verbatim', async () => {
    const win = makeContext(async () => ({ ok: false, status: 409, json: async () => ({ error: 'invalid_chunk' }) }));
    await assert.rejects(
      win.HelmWxGridPacks.fetchChunk(MANIFEST, 'http://localhost:8080/m.json', CHUNK_KEY, OPTS),
      (e) => e.code === 'invalid_chunk');
  });

  await ok('envd DOWN (network rejection) -> envd_unreachable with a start action', async () => {
    const win = makeContext(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(
      win.HelmWxGridPacks.fetchChunk(MANIFEST, 'http://localhost:8080/m.json', CHUNK_KEY, OPTS),
      (e) => e.code === 'envd_unreachable' && /start-helm|refresh/.test(e.details.action));
  });

  await ok('no endpoint configured -> Range transport unchanged (regression pin)', async () => {
    let headers = null;
    const win = makeContext(async (_url, init) => {
      headers = init && init.headers;
      return { ok: true, status: 206, arrayBuffer: async () => BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.length) };
    });
    await win.HelmWxGridPacks.fetchChunk(MANIFEST, 'http://localhost:8080/m.json', CHUNK_KEY, null);
    assert.strictEqual(headers.Range, 'bytes=0-' + (BYTES.length - 1));
  });

  console.log((process.exitCode ? 'FAIL' : 'ok') + ' - wx-grid-endpoint: ' + pass + ' groups passed');
})();
