#!/usr/bin/env node
// Generate a tiny helm.env.grid.v1 pack for the HELMC++ no-Python runtime harness.
// This is a test fixture writer, not a runtime service.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function fail(message) {
  console.error(`helmcxx-make-envd-fixture: ${message}`);
  process.exit(2);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return Buffer.from(JSON.stringify(stable(value)), 'utf8');
}

function chunkGrid(manifest, chunk) {
  const tier = manifest.tiers && manifest.tiers[chunk.tier];
  const grid = tier && tier.grid;
  if (!grid) fail(`missing grid for tier ${chunk.tier}`);
  const bbox = chunk.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) fail('chunk bbox must be [w,s,e,n]');
  const dx = Number(grid.dx || 1);
  const dy = Number(grid.dy || 1);
  return {
    width: Math.round((Number(bbox[2]) - Number(bbox[0])) / dx) + 1,
    height: Math.round((Number(bbox[3]) - Number(bbox[1])) / dy) + 1,
    dx,
    dy,
    origin: 'northwest'
  };
}

function bandBytes(bands, cells) {
  const buffers = [];
  for (const band of Object.values(bands || {})) {
    const type = String(band.type || '');
    const buf = Buffer.alloc(cells * 2);
    if (type !== 'int16' && type !== 'uint16') {
      fail(`unsupported fixture band type ${type}; expected int16/uint16`);
    }
    buffers.push(buf);
  }
  return Buffer.concat(buffers);
}

function makeChunk(manifest, chunkKey, chunk) {
  const layer = manifest.layers && manifest.layers[chunk.layer];
  if (!layer || !layer.bands) fail(`missing bands for layer ${chunk.layer}`);
  const grid = chunkGrid(manifest, chunk);
  const header = {
    schema: 'helm.env.grid.chunk.v1',
    encoding: 'helm.env.grid.v1',
    endianness: 'little',
    compression: 'none',
    tier: chunk.tier,
    layer: chunk.layer,
    validTime: chunk.validTime,
    bbox: chunk.bbox,
    grid,
    bands: layer.bands,
    chunkKey
  };
  const headerBytes = stableJson(header);
  const payload = bandBytes(layer.bands, grid.width * grid.height);
  const prefix = Buffer.alloc(16);
  prefix.write('HELMGRID', 0, 'ascii');
  prefix.writeUInt16LE(1, 8);
  prefix.writeUInt16LE(0, 10);
  prefix.writeUInt32LE(headerBytes.length, 12);
  return Buffer.concat([prefix, headerBytes, payload]);
}

const outDir = process.argv[2];
const sourcePath = process.argv[3] || path.join('services', 'wx', 'fixtures', 'helm-env-grid-v1.json');
if (!outDir) fail('usage: scripts/helmcxx-make-envd-fixture.mjs <out-dir> [source-manifest]');

fs.mkdirSync(outDir, { recursive: true });
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const chunkKey = Object.keys(source.chunks || {})[0];
if (!chunkKey) fail('source manifest has no chunks');

const sourceChunk = source.chunks[chunkKey];
const chunkBytes = makeChunk(source, chunkKey, sourceChunk);
const packName = 'helmcxx-envd-fixture.pmtiles';
const manifestName = `${packName}.manifest.json`;
const badManifestName = `${packName}.bad-container.manifest.json`;
const packPath = path.join(outDir, packName);
const manifestPath = path.join(outDir, manifestName);
const badManifestPath = path.join(outDir, badManifestName);

fs.writeFileSync(packPath, chunkBytes);

const checksum = crypto.createHash('sha256').update(chunkBytes).digest('hex');
const manifest = JSON.parse(JSON.stringify(source));
manifest.packId = 'helmcxx/envd/no-python-fixture';
manifest.generatedAt = '2026-07-05T00:00:00Z';
manifest.transport = {
  container: 'pmtiles',
  payload: 'helm.env.grid.chunk.v1',
  rangeReadable: true,
  servedBy: 'helm-envd',
  requiredRuntime: 'C++',
  packUrl: packName,
  byteRangeSemantics: 'offset-length',
  checksumAlgorithm: 'sha256'
};
manifest.chunks = {
  [chunkKey]: {
    ...sourceChunk,
    byteRange: [0, chunkBytes.length],
    checksum: `sha256:${checksum}`
  }
};

const badManifest = JSON.parse(JSON.stringify(manifest));
badManifest.transport.container = 'directory';

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(badManifestPath, `${JSON.stringify(badManifest, null, 2)}\n`);

process.stdout.write(JSON.stringify({
  pack: packPath,
  manifest: manifestPath,
  badManifest: badManifestPath,
  packId: manifest.packId,
  chunkKey
}) + '\n');
