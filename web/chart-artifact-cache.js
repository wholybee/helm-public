/*
 * Helm — chart-artifact-cache.js (SCHED-2)
 * Browser artifact cache keyed by scheduler cache_key with stale-safe admission.
 */
(function (global) {
  'use strict';

  function ChartArtifactCache(opts) {
    opts = opts || {};
    this._entries = Object.create(null);
    this._inflight = Object.create(null);
    this._trace = [];
    this._maxEntries = opts.maxEntries || 128;
    this._traceLimit = opts.traceLimit || 200;
  }

  ChartArtifactCache.prototype._pushTrace = function (event) {
    this._trace.push(Object.assign({ at: Date.now() }, event));
    if (this._trace.length > this._traceLimit) this._trace.shift();
  };

  ChartArtifactCache.prototype.get = function (cacheKey) {
    return this._entries[cacheKey] || null;
  };

  ChartArtifactCache.prototype.snapshot = function () {
    var keys = Object.keys(this._entries);
    return {
      size: keys.length,
      keys: keys.slice(0, 32),
      trace: this._trace.slice(-64)
    };
  };

  ChartArtifactCache.prototype.admit = function (scheduleEntry, artifact, state) {
    var key = scheduleEntry.cache_key;
    var prev = this._entries[key];
    this._entries[key] = {
      cache_key: key,
      entry_id: scheduleEntry.entry_id,
      role: scheduleEntry.role,
      stale_policy: scheduleEntry.stale_policy,
      blend_weight: scheduleEntry.blend_weight,
      tile: scheduleEntry.tile,
      artifact: artifact,
      state: state || 'fresh',
      updated_at: Date.now()
    };
    this._pushTrace({
      kind: 'admit',
      cache_key: key,
      role: scheduleEntry.role,
      state: state || 'fresh',
      replaced: !!prev
    });
    this._evictIfNeeded();
    return this._entries[key];
  };

  ChartArtifactCache.prototype.markRevalidating = function (cacheKey) {
    var row = this._entries[cacheKey];
    if (!row) return null;
    row.state = 'revalidating';
    row.updated_at = Date.now();
    this._pushTrace({ kind: 'revalidate', cache_key: cacheKey });
    return row;
  };

  ChartArtifactCache.prototype.coveringDrawEntries = function (scheduleResponse) {
    var self = this;
    var out = [];
    var strictMissing = false;
    (scheduleResponse.entries || []).forEach(function (entry) {
      var row = self._entries[entry.cache_key];
      if (row && row.artifact) {
        out.push({
          entry: entry,
          artifact: row.artifact,
          blend_weight: entry.blend_weight,
          stale_policy: entry.stale_policy,
          cache_state: row.state
        });
        return;
      }
      if (entry.stale_policy === 'strict') strictMissing = true;
    });
    return { entries: out, strictMissing: strictMissing };
  };

  ChartArtifactCache.prototype.prefetch = function (scheduleResponse, fetchFn) {
    var self = this;
    var promises = [];
    (scheduleResponse.entries || []).forEach(function (entry) {
      if (self._entries[entry.cache_key] || self._inflight[entry.cache_key]) return;
      self._inflight[entry.cache_key] = true;
      self._pushTrace({ kind: 'prefetch_start', cache_key: entry.cache_key, role: entry.role });
      promises.push(
        Promise.resolve(fetchFn(entry))
          .then(function (artifact) {
            delete self._inflight[entry.cache_key];
            if (artifact) self.admit(entry, artifact, 'fresh');
            self._pushTrace({ kind: 'prefetch_ok', cache_key: entry.cache_key, role: entry.role });
            return artifact;
          })
          .catch(function (err) {
            delete self._inflight[entry.cache_key];
            self._pushTrace({
              kind: 'prefetch_fail',
              cache_key: entry.cache_key,
              role: entry.role,
              error: err && err.message ? err.message : String(err)
            });
            return null;
          })
      );
    });
    return Promise.all(promises);
  };

  ChartArtifactCache.prototype._evictIfNeeded = function () {
    var keys = Object.keys(this._entries);
    if (keys.length <= this._maxEntries) return;
    var entries = this._entries;
    keys.sort(function (a, b) {
      return (entries[a].updated_at || 0) - (entries[b].updated_at || 0);
    });
    var drop = keys.length - this._maxEntries;
    for (var i = 0; i < drop; i++) {
      var k = keys[i];
      delete this._entries[k];
      this._pushTrace({ kind: 'evict', cache_key: k });
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ChartArtifactCache;
  else global.HelmChartArtifactCache = ChartArtifactCache;
})(typeof window !== 'undefined' ? window : this);
