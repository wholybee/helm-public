#!/usr/bin/env node
// HELMC++-7: static maintainability audit for required C++ runtime services.
// This is a gate for boring, reviewable service shape; it is not a substitute for code review.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(process.env.HELM_HELMCXX7_EVIDENCE_DIR || path.join(ROOT, 'test-results/helmcxx7-maintainability'));

const services = [
  {
    id: 'helm-server',
    source: 'engine/vendor/cli/helm_server.cpp',
    target: 'helm-server',
    tests: ['scripts/helmcxx-no-python-runtime.sh', 'scripts/helmcxx-cockpit-proof.sh', 'scripts/helmcxx-benchmark-soak.mjs'],
    docs: ['docs/HELMCXX-ACCEPTANCE.md', 'docs/RUNTIME-SERVICES.md'],
    maxLines: 5000,
    warnLines: 3000,
    legacyRawOwnershipAllowed: true,
    rationale: 'OpenCPN/ixwebsocket adapter and one-origin server; raw ownership remains legacy debt but is bounded by end-to-end harnesses.'
  },
  {
    id: 'helm-packd',
    source: 'engine/vendor/cli/helm_packd.cpp',
    target: 'helm-packd',
    tests: ['engine/test-packd.sh', 'scripts/helmcxx-no-python-runtime.sh', 'scripts/helmcxx-benchmark-soak.mjs'],
    docs: ['docs/HELMCXX-ACCEPTANCE.md', 'docs/RUNTIME-SERVICES.md'],
    maxLines: 2500,
    warnLines: 2200,
    legacyRawOwnershipAllowed: false,
    rationale: 'Local pack daemon should remain a bounded C++17 service with RAII ownership.'
  },
  {
    id: 'helm-basemap-cache',
    source: 'engine/vendor/cli/helm_basemap_cache.cpp',
    target: 'helm-basemap-cache',
    tests: ['engine/test-basemap-cache.sh', 'scripts/helmcxx-no-python-runtime.sh', 'scripts/helmcxx-benchmark-soak.mjs'],
    docs: ['docs/HELMCXX-ACCEPTANCE.md', 'docs/RUNTIME-SERVICES.md'],
    maxLines: 1400,
    warnLines: 1000,
    legacyRawOwnershipAllowed: false,
    rationale: 'Cache/proxy daemon should stay byte-cache only, not a chart semantics service.'
  },
  {
    id: 'helm-envd',
    source: 'engine/vendor/cli/helm_envd.cpp',
    target: 'helm-envd',
    tests: ['engine/test-envd.sh', 'scripts/helmcxx-no-python-runtime.sh', 'scripts/helmcxx-benchmark-soak.mjs'],
    docs: ['docs/HELMCXX-ACCEPTANCE.md', 'docs/RUNTIME-SERVICES.md', 'docs/WX-20-HELM-ENVD.md'],
    maxLines: 1400,
    warnLines: 1000,
    legacyRawOwnershipAllowed: false,
    rationale: 'Environmental replay daemon should stay local-pack validation/replay only.'
  }
];

const hardPatterns = [
  { id: 'raw_new', regex: /\bnew\b/g },
  { id: 'raw_delete', regex: /\bdelete\b/g },
  { id: 'malloc', regex: /\bmalloc\s*\(/g },
  { id: 'free', regex: /\bfree\s*\(/g },
  { id: 'goto', regex: /\bgoto\b/g },
  { id: 'boost', regex: /\bboost::/g },
  { id: 'novel_template', regex: /template\s*</g }
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function lineCount(text) {
  return text.split(/\r?\n/).length;
}

function count(regex, text) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function grepLine(regex, text) {
  const lines = text.split(/\r?\n/);
  return lines.reduce((hits, line, index) => {
    if (regex.test(line)) hits.push({ line: index + 1, text: line.trim() });
    regex.lastIndex = 0;
    return hits;
  }, []);
}

function allPatchText() {
  const patchDir = path.join(ROOT, 'engine/patches');
  return fs.readdirSync(patchDir)
    .filter((name) => /^\d+/.test(name))
    .sort()
    .map((name) => fs.readFileSync(path.join(patchDir, name), 'utf8'))
    .join('\n');
}

function auditService(service, patchText) {
  const failures = [];
  const warnings = [];
  if (!exists(service.source)) failures.push(`missing source ${service.source}`);
  const text = exists(service.source) ? read(service.source) : '';
  const codeText = stripComments(text);
  const lines = lineCount(text);

  if (!new RegExp(`add_executable\\(${service.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(patchText)) {
    failures.push(`missing CMake add_executable for ${service.target}`);
  }
  if (!new RegExp(`target_link_libraries\\(${service.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(patchText)) {
    failures.push(`missing CMake target_link_libraries for ${service.target}`);
  }
  if (!new RegExp(`target_compile_features\\(${service.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(patchText)) {
    warnings.push(`missing explicit target_compile_features(... cxx_std_17) for ${service.target}`);
  }

  if (lines > service.maxLines) failures.push(`${service.source} has ${lines} lines, over max ${service.maxLines}`);
  else if (lines > service.warnLines) warnings.push(`${service.source} has ${lines} lines; keep future work from growing this file`);

  const patternCounts = {};
  for (const pattern of hardPatterns) {
    patternCounts[pattern.id] = count(pattern.regex, codeText);
  }
  const rawDebt = patternCounts.raw_new + patternCounts.raw_delete + patternCounts.malloc + patternCounts.free;
  if (rawDebt > 0 && !service.legacyRawOwnershipAllowed) {
    failures.push(`${service.source} has raw ownership calls outside the helm-server legacy exception`);
  }
  if (patternCounts.goto > 0) failures.push(`${service.source} uses goto`);
  if (patternCounts.boost > 0) failures.push(`${service.source} uses boost:: despite minimal-dependency bar`);
  if (patternCounts.novel_template > 0) failures.push(`${service.source} uses template machinery; review whether it is necessary`);

  for (const test of service.tests) {
    if (!exists(test)) failures.push(`missing required test harness ${test}`);
  }
  for (const doc of service.docs) {
    if (!exists(doc)) failures.push(`missing required contract doc ${doc}`);
  }

  const includes = grepLine(/^#include\s+[<"]([^>"]+)[>"]/, text).map((hit) => hit.text);
  const comments = grepLine(/\b(TODO|FIXME|HACK)\b/, text);
  if (comments.length) warnings.push(`${service.source} has TODO/FIXME/HACK comments: ${comments.length}`);

  return {
    id: service.id,
    source: service.source,
    target: service.target,
    lines,
    maxLines: service.maxLines,
    warnLines: service.warnLines,
    includes: includes.length,
    patternCounts,
    rawOwnershipException: service.legacyRawOwnershipAllowed,
    tests: service.tests,
    docs: service.docs,
    rationale: service.rationale,
    warnings,
    failures
  };
}

function main() {
  const patchText = allPatchText();
  const audited = services.map((service) => auditService(service, patchText));
  const failures = audited.flatMap((service) => service.failures.map((failure) => `${service.id}: ${failure}`));
  const warnings = audited.flatMap((service) => service.warnings.map((warning) => `${service.id}: ${warning}`));
  const result = {
    schema: 'helm.helmcxx7.maintainability_audit.v1',
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    task: 'HELMC++-7',
    services: audited,
    summary: {
      serviceCount: audited.length,
      failures: failures.length,
      warnings: warnings.length,
      pass: failures.length === 0
    },
    failures,
    warnings
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'audit.json'), JSON.stringify(result, null, 2) + '\n');

  console.log('HELMC++-7 maintainability audit');
  for (const service of audited) {
    console.log(`  ${service.id}: ${service.lines} lines, warnings=${service.warnings.length}, failures=${service.failures.length}`);
  }
  if (warnings.length) {
    console.log('  warnings:');
    for (const warning of warnings) console.log(`    - ${warning}`);
  }
  if (failures.length) {
    console.error('  failures:');
    for (const failure of failures) console.error(`    - ${failure}`);
    console.error(`HELMC++-7 maintainability audit: FAIL (${path.join(OUT_DIR, 'audit.json')})`);
    process.exit(1);
  }
  console.log(`HELMC++-7 maintainability audit: PASS (${path.join(OUT_DIR, 'audit.json')})`);
}

main();
