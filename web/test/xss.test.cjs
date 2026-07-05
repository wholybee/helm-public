'use strict';
// xss.test.cjs — CLIENT-18 innerHTML/XSS hardening. Extracts the canonical escHtml() from index.html
// and proves it neutralises payloads + is null-safe, then asserts each untrusted popup sink actually
// routes through escHtml()/safeUrl() (a regression guard — removing the escaping turns these RED).
// Run: node web/test/xss.test.cjs
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// CLIENT-25: the AIS tap-inspector card moved to ais-inspector.js — its sinks are checked there.
const ais = fs.readFileSync(path.join(__dirname, '..', 'ais-inspector.js'), 'utf8');
// CLIENT-26: the saved-place / recommender popups moved to community-shell.js.
const comm = fs.readFileSync(path.join(__dirname, '..', 'community-shell.js'), 'utf8');

const line = src.split('\n').find((l) => l.includes('const escHtml ='));
if (!line) { console.error('escHtml not found in index.html'); process.exit(1); }
const expr = line.slice(line.indexOf('=') + 1).trim().replace(/;\s*$/, '');
const escHtml = new Function('return (' + expr + ')')();   // the real escaper, lifted from the page

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + m); c ? pass++ : fail++; };
const has = (s) => src.includes(s);
const hasAis = (s) => ais.includes(s);   // AIS-card sinks live in ais-inspector.js now
const hasComm = (s) => comm.includes(s); // community popups live in community-shell.js now
// extracted modules carry their OWN copy of the canonical escaper — each must be byte-identical, or
// a card could quietly diverge into an under-escaping fork.
const aisEscLine = ais.split('\n').find((l) => l.includes('const escHtml ='));
const commEscLine = comm.split('\n').find((l) => l.includes('const escHtml ='));

// escaper correctness
ok(escHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', '1. escapes < and >');
ok(escHtml('a & "b"') === 'a &amp; &quot;b&quot;', '2. escapes & and "');
ok(escHtml(null) === '' && escHtml(undefined) === '', '3. null/undefined -> "" (null-safe)');
ok(!/<script>/.test(escHtml('<script>x</script>')), '4. neutralises a <script> payload');

// application at each untrusted sink (regression guards)
ok(has('escHtml(p.name || p.kind)'), '5. places popup escapes the OSM place name');
ok(hasComm('escHtml(p.note || p.kind)'), '6. saved-place popup escapes the user note');
ok(hasComm("escHtml(p.name || '')"), '7. recommender popup escapes the name');
ok(hasComm('safeUrl(p.sourceUrl)') && hasComm('rel="noopener noreferrer"'), '8. saved sourceUrl -> safeUrl (no javascript:) + rel=noopener');
ok(hasAis('aisEsc(name)'), '9. AIS card still escapes the (open-radio) vessel name');
ok(!!aisEscLine && aisEscLine.replace(/\s+/g, '') === line.replace(/\s+/g, ''), '9b. ais-inspector escHtml is byte-identical to the canonical escaper');
ok(!!commEscLine && commEscLine.replace(/\s+/g, '') === line.replace(/\s+/g, ''), '9c. community-shell escHtml is byte-identical to the canonical escaper');

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + 'xss: ' + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
