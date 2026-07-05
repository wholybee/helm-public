#!/usr/bin/env node
'use strict';
// AI-18: the Python backend is an optional, non-safety companion. The web client
// must not require it for chart/nav runtime and must return honest offline states
// when :8090 is absent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceData = Object.create(null);
const cached = {
  'community.places': { type: 'FeatureCollection', features: [{ id: 'p1' }] },
  'community.saved': { type: 'FeatureCollection', features: [{ id: 's1' }] },
  'community.whereto': { type: 'FeatureCollection', features: [{ id: 'w1' }] },
};
const fetchCalls = [];
const statuses = [];

const context = {
  console,
  Promise,
  AbortSignal: { timeout: () => ({ aborted: false }) },
  fetch: async (url) => {
    fetchCalls.push(String(url));
    throw new Error('backend offline');
  },
  window: {
    HelmLayerCache: {
      getBest(layerId) {
        const geojson = cached[layerId];
        return geojson ? { payload: { geojson } } : null;
      },
      put() {},
    },
  },
};
context.window.window = context.window;

const src = fs.readFileSync(path.join(__dirname, '..', 'community.js'), 'utf8');
vm.runInNewContext(src, context, { filename: 'community.js' });

const map = {
  getSource(name) {
    return {
      setData(fc) { sourceData[name] = fc; },
    };
  },
};

(async () => {
  const community = context.window.HelmCommunity(map, { api: 'http://127.0.0.1:8090' });
  community.onStatus((online) => statuses.push(online));

  assert.equal(community.isOnline(), false, 'backend starts offline until health proves otherwise');
  assert.equal(await community.health(), null, 'offline health returns null');
  assert.deepEqual(statuses, [false], 'offline status is emitted');
  assert.equal(community.isOnline(), false, 'backend remains offline after failed health');

  assert.equal(await community.loadPlaces(['osm']), cached['community.places'], 'places fall back to cached/local data');
  assert.equal(sourceData.places, cached['community.places'], 'places source is updated only from cache');
  assert.equal(await community.loadSaved(), cached['community.saved'], 'saved pins fall back to cached/local data');
  assert.equal(sourceData.saved, cached['community.saved'], 'saved source is updated only from cache');

  const whereTo = await community.whereTo({ query: 'quiet anchorage' });
  assert.equal(whereTo.offline, true, 'where-to returns an explicit offline state');
  assert.equal(Array.isArray(whereTo.recommendations), true, 'where-to offline recommendations are an array');
  assert.equal(whereTo.recommendations.length, 0, 'where-to does not invent recommendations offline');
  assert.equal(sourceData.whereto, cached['community.whereto'], 'where-to may show last cached highlight');

  assert.equal((await community.narrate({ lat: 1, lon: 2 })).offline, true, 'narrate is explicitly offline');
  assert.equal((await community.briefing({ points: [] })).offline, true, 'briefing is explicitly offline');
  assert.equal((await community.nflPush({ lat: 1, lon: 2 })).offline, true, 'NFL push is explicitly offline');
  assert.equal((await community.osmNote({ lat: 1, lon: 2, text: 'x' })).offline, true, 'OSM note is explicitly offline');
  assert.equal((await community.savePin({ title: 'x', lat: 1, lon: 2 })).offline, true, 'saved-pin writes are explicitly offline');

  assert.deepEqual(fetchCalls, ['http://127.0.0.1:8090/health'], 'offline companion endpoints are not fetched after health fails');
  console.log('ai18-optional-backend: offline boundary passed');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
