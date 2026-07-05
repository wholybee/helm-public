/* Helm Clean-room Symbol Catalog — PUBLIC static build (FORGE-59).
 * Reads one DB-derived record per symbol from proof/site-index.json (symbols[]),
 * with explicit art paths. No client-side dedup, no directory guessing, no backend,
 * no local sign-off (:9017) hooks — that lives only in the local review prototype.
 */
(() => {
  "use strict";

  const REPO = "StevenRidder/helm-public";
  const REVIEW_KEY = "helm-forge59-public-reviews";
  const PALETTES = ["day", "dusk", "night"];
  const state = { q: "", family: "", geometry: "", gate: "", page: 0, pageSize: 60 };
  let DATA = null;
  let SYMS = [];
  let filtered = [];
  const reviews = loadReviews();

  const el = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const symbolUrl = (s) => `${location.origin}${location.pathname}?symbol=${encodeURIComponent(s.id)}`;

  async function init() {
    bindControls();
    applyTheme(localStorage.getItem("helm-theme") || "light");
    try {
      const res = await fetch("proof/site-index.json", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      DATA = await res.json();
    } catch (err) {
      el("alert").innerHTML =
        `<div class="alert alert-danger"><h4 class="alert-title">Catalog data failed to load</h4>
         <div class="text-secondary">proof/site-index.json is required; there is no fallback. ${esc(err.message)}</div></div>`;
      return;
    }
    SYMS = DATA.symbols || [];
    el("schemaTag").textContent = DATA.schema || "";
    renderStats();
    buildFilters();
    apply();
    updateDock();
    const requested = new URLSearchParams(location.search).get("symbol");
    if (requested && SYMS.some((s) => s.id === requested)) openDetail(requested, false);
  }

  /* ---------- stats + filters ---------- */
  function statCard(label, value, sub, tone) {
    return `<div class="col-6 col-sm-4 col-xl"><div class="card card-sm"><div class="card-body">
      <div class="subheader">${esc(label)}</div>
      <div class="h1 mb-0 mt-1 ${tone ? "text-" + tone : ""}">${esc(value)}</div>
      <div class="text-secondary small">${sub || ""}</div></div></div></div>`;
  }
  function renderStats() {
    const c = DATA.coverage || {};
    const g = c.proof_gate_counts || {};
    const contexts = SYMS.reduce((n, s) => n + (s.uses || 1), 0);
    el("stats").innerHTML = [
      statCard("Symbols", SYMS.length.toLocaleString(), "unique final icons"),
      statCard("Chart contexts", contexts.toLocaleString(), "reuse instances"),
      statCard("Owner signoff", (c.human_review_approved_symbols ?? 0).toLocaleString(), c.human_review_status || "not recorded", "green"),
      statCard("Registry symbols", (c.registry_symbols ?? 0).toLocaleString(), `${(c.registry_blocked_candidates ?? 0).toLocaleString()} non-symbol candidates`),
      statCard("Proof gates", `${g.green ?? 0}/${g.yellow ?? 0}/${g.red ?? 0}`, "green / yellow / red (by context)"),
      statCard("Runtime export", (c.runtime_export_rows ?? 0).toLocaleString(), "fail-closed", "danger"),
    ].join("");
  }
  function buildFilters() {
    const f = DATA.facets || {};
    fillSelect("family", f.family_counts);
    fillSelect("geometry", f.geometry_counts);
  }
  function fillSelect(id, counts) {
    const sel = el(id);
    const keep = sel.querySelector("option").outerHTML;
    sel.innerHTML = keep + Object.keys(counts || {}).sort().map((k) => `<option value="${esc(k)}">${esc(k)} (${counts[k]})</option>`).join("");
  }

  /* ---------- filter + render ---------- */
  function matches(s) {
    if (state.family && !(s.families || [s.family]).includes(state.family)) return false;
    if (state.geometry && !(s.geometries || [s.geometry]).includes(state.geometry)) return false;
    if (state.gate && ((s.gate || {}).proof || "red") !== state.gate) return false;
    if (state.q) {
      const hay = JSON.stringify([s.id, s.name, s.object_class, s.family, s.s52_refs, s.s101]).toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    return true;
  }
  function apply() {
    filtered = SYMS.filter(matches);
    if (state.page * state.pageSize >= filtered.length) state.page = 0;
    render();
  }
  function gateBadge(kind, val) {
    const tone = val === "green" ? "green" : val === "yellow" ? "yellow" : val === "red" ? "red" : "secondary";
    return `<span class="badge bg-${tone}-lt">${esc(kind)} ${esc(val || "—")}</span>`;
  }
  function triptych(art) {
    return `<div class="trip mb-2">${PALETTES.map((p) =>
      `<div class="sw">${art && art[p] ? `<img loading="lazy" src="${esc(art[p])}" alt="${p}">` : `<div class="empty"></div>`}</div>`
    ).join("")}</div>`;
  }
  function card(s) {
    const parts = [];
    if (s.object_class && s.object_class !== s.id) parts.push(s.object_class);
    else if (s.family && s.family !== s.id) parts.push(s.family);
    if (s.geometry) parts.push(s.geometry);
    const reviewed = reviews[s.id] ? ` · ${reviews[s.id].decision}` : "";
    return `<div class="col-6 col-md-4 col-lg-3 col-xxl-2">
      <div class="card sym-card" data-id="${esc(s.id)}"><div class="card-body p-2">
        ${triptych(s.art)}
        <div class="sym-id text-truncate" title="${esc(s.id)}">${esc(s.name || s.id)}</div>
        <div class="text-secondary small text-truncate">${esc(parts.join(" · "))}</div>
        ${reviewed ? `<div class="text-secondary small text-truncate">review${esc(reviewed)}</div>` : ""}
      </div></div></div>`;
  }
  function render() {
    const total = filtered.length;
    const start = state.page * state.pageSize;
    const pageSyms = filtered.slice(start, start + state.pageSize);
    el("grid").innerHTML = pageSyms.map(card).join("") || `<div class="col-12"><div class="text-secondary p-4 text-center">No symbols match these filters.</div></div>`;
    el("count").textContent = total ? `${(start + 1).toLocaleString()}–${(start + pageSyms.length).toLocaleString()} of ${total.toLocaleString()} symbols` : "0 symbols";
    renderPager(total);
    for (const c of document.querySelectorAll(".sym-card")) c.addEventListener("click", () => openDetail(c.dataset.id));
  }
  function renderPager(total) {
    const pages = Math.ceil(total / state.pageSize) || 1;
    const cur = state.page;
    const item = (p, label, disabled, active) => `<li class="page-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}"><a class="page-link" href="#" data-p="${p}">${label}</a></li>`;
    const parts = [item(cur - 1, "‹", cur === 0)];
    for (let p = Math.max(0, cur - 2); p <= Math.min(pages - 1, cur + 2); p++) parts.push(item(p, p + 1, false, p === cur));
    parts.push(item(cur + 1, "›", cur >= pages - 1));
    const pager = el("pager");
    pager.innerHTML = parts.join("");
    for (const a of pager.querySelectorAll("a.page-link")) a.addEventListener("click", (e) => { e.preventDefault(); const p = +a.dataset.p; if (p >= 0 && p < pages) { state.page = p; render(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
  }

  /* ---------- detail ---------- */
  const offcanvas = () => bootstrap.Offcanvas.getOrCreateInstance(el("detail"));
  function paletteStrip(art) {
    if (!art) return "";
    const cells = PALETTES.map((p) => `<div class="cell"><div class="box">${art[p] ? `<img loading="lazy" src="${esc(art[p])}" alt="${p}">` : "—"}</div><div class="small text-secondary mt-1">${p}</div></div>`).join("");
    return `<div class="mb-3"><div class="fw-bold mb-1">Palette variants (day / dusk / night)</div><div class="strip">${cells}</div></div>`;
  }
  function contextsBlock(s) {
    const ctx = s.contexts || [];
    if (!ctx.length) return "";
    const rows = ctx.slice(0, 40).map((c) => `<tr><td class="sym-id">${esc(c.object_class || "—")}</td><td>${esc(c.geometry || "—")}</td><td>${esc(c.section || "—")}</td><td>${gateBadge("", c.gate)}</td><td class="text-secondary">${c.count > 1 ? "×" + c.count : ""}</td></tr>`).join("");
    return `<div class="hr-text">chart contexts (${s.uses || ctx.length})</div>
      <div class="table-responsive mb-3"><table class="table table-sm"><thead><tr><th>S-57 object</th><th>Geometry</th><th>Section</th><th>Proof</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${ctx.length > 40 ? `<div class="small text-secondary">+${ctx.length - 40} more distinct contexts</div>` : ""}</div>`;
  }
  function refChips(refs) {
    if (!refs || !Object.keys(refs).length) return "";
    return `<div class="d-flex flex-wrap mb-3">${Object.entries(refs).map(([k, vals]) =>
      `<div class="me-3 mb-1"><div class="text-secondary small text-uppercase">${esc(k.replace(/_/g, " "))}</div>${vals.map((v) => `<span class="badge bg-secondary-lt me-1 mb-1 sym-id">${esc(v)}</span>`).join("")}</div>`).join("")}</div>`;
  }
  function interpBlocks(hi) {
    if (!hi || typeof hi !== "object") return "";
    const label = (k) => k.replace(/_/g, " ").replace(/\bs(\d+)\b/gi, (_, n) => "S-" + n);
    return Object.entries(hi).filter(([k, v]) => k !== "helm_render_interpretation" && v).map(([k, v]) =>
      `<div class="mb-2"><div class="fw-bold text-capitalize">${esc(label(k))}</div><div class="authority text-secondary small">${esc(String(v))}</div></div>`).join("");
  }
  function comparisonPanel(label, body, image, tone) {
    const cls = image ? "" : " cmp-missing";
    const toneCls = tone ? ` cmp-${tone}` : "";
    return `<div class="cmp-panel${cls}${toneCls}">
      <div class="cmp-box">${image ? `<img loading="lazy" src="${esc(image)}" alt="${esc(label)}">` : ""}</div>
      <div class="cmp-na">${esc(body || "No public thumbnail bundled; evidence shown below.")}</div>
      <div class="cmp-label">${esc(label)}</div>
      ${image ? `<div class="text-secondary small text-center mt-1">${esc(body || "")}</div>` : ""}
    </div>`;
  }
  function comparisonNote(entry, fallback) {
    if (!entry) return fallback;
    return entry.note || entry.status || fallback;
  }
  function comparisonSection(s, hi) {
    const helm = s.art && (s.art.canonical || s.art.day);
    const s101 = hi.s101_summary || s101Fallback(s);
    const opencpn = hi.opencpn_s52_evidence || opencpnFallback(s);
    const cmp = s.comparison || {};
    const s101Entry = cmp.s101 || {};
    const opencpnEntry = cmp.opencpn || {};
    return `<div class="hr-text">public comparison</div>
      <div class="text-secondary small mb-2">The public page shows Helm-owned art plus DB-derived S-101 and OpenCPN/S-52 comparison evidence. Comparison thumbnails are visual witnesses only, not Helm canonical artwork. OpenCPN PNGs are GPL comparison evidence, not Apache Helm assets.</div>
      <div class="cmp-grid mb-3">
        ${comparisonPanel("Helm resolved", "Helm-owned canonical SVG", helm)}
        ${comparisonPanel("S-101 evidence", comparisonNote(s101Entry, s101 || "No S-101 evidence recorded in site-index.json."), s101Entry.image, "s101")}
        ${comparisonPanel("OpenCPN / S-52 evidence", comparisonNote(opencpnEntry, opencpn || "No OpenCPN/S-52 evidence recorded in site-index.json."), opencpnEntry.image)}
      </div>`;
  }
  function descriptionCard(title, body, empty) {
    const text = String(body || "").trim();
    return `<div class="card mb-3"><div class="card-body">
      <div class="fw-bold mb-1">${esc(title)}</div>
      <div class="text-secondary">${esc(text || empty || "No public evidence recorded for this field.")}</div>
    </div></div>`;
  }
  function compactMeta(s) {
    return [
      s.object_class ? `S-57 ${s.object_class}` : "",
      s.geometry || "",
      s.family || "",
      s.category || "",
    ].filter(Boolean).join(" · ");
  }
  function s101Fallback(s) {
    const t = s.s101 || {};
    const parts = [];
    if (t.classification) parts.push(`classification ${t.classification}`);
    if (t.mapping_type) parts.push(`mapping ${t.mapping_type}`);
    if (t.rule_file) parts.push(`rule ${t.rule_file}`);
    return parts.length ? `S-101 evidence: ${parts.join("; ")}.` : "";
  }
  function opencpnFallback(s) {
    const refs = s.s52_refs || {};
    const parts = [];
    for (const [k, vals] of Object.entries(refs)) {
      if (Array.isArray(vals) && vals.length) parts.push(`${k}: ${vals.join(", ")}`);
    }
    return parts.length ? `OpenCPN/S-52 references: ${parts.join("; ")}.` : "";
  }
  function openDetail(id, updateUrl = true) {
    const s = SYMS.find((x) => x.id === id);
    if (!s) return;
    if (updateUrl) history.replaceState(null, "", `?symbol=${encodeURIComponent(s.id)}`);
    el("detailTitle").textContent = s.name || s.id;
    el("detailKey").textContent = s.id;
    const hi = s.interpretation || {};
    const rev = reviews[s.id] || { decision: "", notes: "" };
    const sel = (v) => (rev.decision === v ? "checked" : "");
    el("detailBody").innerHTML = `
      <div class="mb-3 d-flex flex-wrap gap-1 align-items-center">
        <div class="text-secondary">${esc(compactMeta(s))}</div>
        <button class="btn btn-sm btn-outline-primary ms-auto" id="seeFamily">See all “${esc(s.family)}”</button>
      </div>
      ${s.art && s.art.canonical ? `<div class="d-flex align-items-center gap-3 mb-3"><div class="card-icon" style="width:120px;height:120px;flex:none"><img src="${esc(s.art.canonical)}" alt="canonical" onerror="this.style.visibility='hidden'"></div><div><div class="fw-bold">Helm resolved — final art</div><div class="text-secondary small">canonical + day/dusk/night below</div></div></div>` : ""}
      ${paletteStrip(s.art)}
      ${comparisonSection(s, hi)}
      ${descriptionCard("What It Is", hi.what_it_is || s.name)}
      ${descriptionCard("S-57 Description", hi.s57_description, `S-57 ${s.object_class || "object"} · ${s.geometry || "geometry"} · ${s.category || "category"}`)}
      ${descriptionCard("S-101 Comparison", hi.s101_summary || s101Fallback(s), "No public S-101 comparison evidence recorded for this symbol.")}
      ${descriptionCard("OpenCPN / S-52 Comparison", hi.opencpn_s52_evidence || opencpnFallback(s), "No public OpenCPN/S-52 comparison evidence recorded for this symbol.")}
      ${descriptionCard("Clean-room Boundary", hi.clean_room_boundary, "Helm-owned render outputs remain separate from third-party comparison evidence.")}
      <div class="card"><div class="card-body">
        <div class="fw-bold mb-2">Reviewer decision <span class="text-secondary fw-normal small">(stored in your browser, exported as JSON or GitHub issue)</span></div>
        <div class="btn-group w-100 mb-2" role="group">
          <input type="radio" class="btn-check" name="rev" id="rev-approve" value="approve" ${sel("approve")}><label class="btn btn-outline-green" for="rev-approve">Approve</label>
          <input type="radio" class="btn-check" name="rev" id="rev-needs" value="needs_work" ${sel("needs_work")}><label class="btn btn-outline-yellow" for="rev-needs">Needs work</label>
          <input type="radio" class="btn-check" name="rev" id="rev-reject" value="reject" ${sel("reject")}><label class="btn btn-outline-red" for="rev-reject">Reject</label>
        </div>
        <textarea class="form-control mb-2" id="revNotes" rows="2" placeholder="Notes (optional)">${esc(rev.notes || "")}</textarea>
        <div class="btn-list">
          <button class="btn btn-primary" id="revSave">Save decision</button>
          <a class="btn btn-outline-primary" id="revReport" target="_blank" rel="noopener">Report this symbol</a>
        </div>
      </div></div>`;
    const saveCurrent = () => {
      const decision = (document.querySelector('input[name="rev"]:checked') || {}).value;
      if (!decision) return false;
      reviews[s.id] = reviewRecord(s, decision, el("revNotes").value.trim());
      saveReviews(); updateDock(); render(); offcanvas().hide();
      return true;
    };
    el("revSave").addEventListener("click", saveCurrent);
    el("revReport").href = singleIssueUrl(s, rev);
    el("revReport").addEventListener("click", () => {
      const decision = (document.querySelector('input[name="rev"]:checked') || {}).value;
      if (decision) {
        reviews[s.id] = reviewRecord(s, decision, el("revNotes").value.trim());
        saveReviews(); updateDock(); render();
        el("revReport").href = singleIssueUrl(s, reviews[s.id]);
      }
    });
    el("seeFamily").addEventListener("click", () => { state.family = s.family; el("family").value = s.family; state.page = 0; apply(); offcanvas().hide(); });
    offcanvas().show();
  }

  /* ---------- reviews ---------- */
  function loadReviews() { try { return JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}"); } catch { return {}; } }
  function saveReviews() { localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews)); }
  function symbolSnapshot(s) {
    const t = (s && s.s101) || {};
    const art = (s && s.art) || {};
    return {
      symbol_id: s.id,
      name: s.name,
      family: s.family,
      object_class: s.object_class,
      geometry: s.geometry,
      category: s.category,
      proof_gate: (s.gate || {}).proof,
      visual_gate: (s.gate || {}).visual,
      semantic_gate: (s.gate || {}).semantic,
      current_helm_art: art.canonical,
      day_art: art.day,
      dusk_art: art.dusk,
      night_art: art.night,
      s101: { classification: t.classification, mapping_type: t.mapping_type, rule_file: t.rule_file },
      symbol_url: symbolUrl(s),
    };
  }
  function reviewRecord(s, decision, notes) {
    return { ...symbolSnapshot(s), decision, notes: notes || "", ts: new Date().toISOString() };
  }
  function reviewRecords() {
    return Object.entries(reviews).map(([id, v]) => {
      const s = SYMS.find((x) => x.id === id);
      return s ? { ...symbolSnapshot(s), ...v, symbol_id: id } : { symbol_id: id, ...v };
    });
  }
  function decisionsPayload(records) {
    const decisions = records || reviewRecords();
    return { schema: "helm.forge.public_review_decisions.v1", site_schema: DATA && DATA.schema, count: decisions.length,
      source_url: location.href, decisions };
  }
  function decisionsJson(records) {
    return JSON.stringify(decisionsPayload(records), null, 2);
  }
  function issueUrl(title, records) {
    const body = `Symbol feedback from the public Helm catalog.\n\nThis issue is machine-readable. Please keep the JSON block intact when editing.\n\n\`\`\`json\n${decisionsJson(records)}\n\`\`\`\n`;
    return `https://github.com/${REPO}/issues/new?template=symbol_feedback.md&labels=symbol-feedback&title=` + encodeURIComponent(title) +
      "&body=" + encodeURIComponent(body);
  }
  function singleIssueUrl(s, rev) {
    const decision = rev.decision || "needs_work";
    const notes = rev.notes || "";
    return issueUrl(`Symbol feedback: ${s.id}`, [reviewRecord(s, decision, notes)]);
  }
  function updateDock() {
    const n = Object.keys(reviews).length;
    el("reviewDock").hidden = n === 0;
    el("reviewCount").textContent = n;
    el("openIssue").href = issueUrl(`Symbol review: ${n} decision(s)`, reviewRecords());
    renderFeedbackDashboard();
  }
  function exportJson() {
    const blob = new Blob([decisionsJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "helm-symbol-review-decisions.json"; a.click();
    URL.revokeObjectURL(a.href);
  }
  function renderFeedbackDashboard() {
    if (!el("feedbackDashboardBody")) return;
    const rows = reviewRecords();
    const counts = rows.reduce((acc, r) => { acc[r.decision] = (acc[r.decision] || 0) + 1; return acc; }, {});
    if (!rows.length) {
      el("feedbackDashboardBody").innerHTML = `<div class="text-secondary">No review decisions saved in this browser yet.</div>`;
      return;
    }
    el("feedbackDashboardBody").innerHTML = `
      <div class="row row-cards mb-3">
        ${["approve", "needs_work", "reject"].map((k) => `<div class="col"><div class="card card-sm"><div class="card-body"><div class="subheader">${esc(k)}</div><div class="h2 m-0">${counts[k] || 0}</div></div></div></div>`).join("")}
      </div>
      <div class="btn-list mb-3">
        <button class="btn btn-primary" id="dashExport">Download JSON</button>
        <a class="btn btn-outline-primary" id="dashIssue" target="_blank" rel="noopener">Open GitHub issue</a>
      </div>
      <div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>Symbol</th><th>Decision</th><th>Family</th><th>Notes</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="sym-id">${esc(r.symbol_id)}</td><td>${esc(r.decision)}</td><td>${esc(r.family || "")}</td><td>${esc(r.notes || "")}</td></tr>`).join("")}</tbody>
      </table></div>`;
    el("dashExport").addEventListener("click", exportJson);
    el("dashIssue").href = issueUrl(`Symbol review: ${rows.length} decision(s)`, rows);
  }

  /* ---------- controls ---------- */
  function applyTheme(t) { document.documentElement.setAttribute("data-bs-theme", t); localStorage.setItem("helm-theme", t); }
  function bindControls() {
    el("q").addEventListener("input", (e) => { state.q = e.target.value; state.page = 0; apply(); });
    el("family").addEventListener("change", (e) => { state.family = e.target.value; state.page = 0; apply(); });
    el("geometry").addEventListener("change", (e) => { state.geometry = e.target.value; state.page = 0; apply(); });
    el("gate").addEventListener("change", (e) => { state.gate = e.target.value; state.page = 0; apply(); });
    el("themeToggle").addEventListener("click", () => applyTheme(document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark"));
    el("exportJson").addEventListener("click", exportJson);
    el("openFeedbackDashboard").addEventListener("click", () => { renderFeedbackDashboard(); bootstrap.Offcanvas.getOrCreateInstance(el("feedbackDashboard")).show(); });
    el("clearReviews").addEventListener("click", () => { if (confirm("Clear all review decisions stored in this browser?")) { for (const k of Object.keys(reviews)) delete reviews[k]; saveReviews(); updateDock(); render(); } });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
