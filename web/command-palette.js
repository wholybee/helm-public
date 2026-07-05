// web/command-palette.js — SHELL-3 ⌘K command palette, extracted from index.html (CLIENT-27).
// A stable fuzzy palette listing every HelmShell.registerCommand({...}) entry (epics append their own
// from their modules — no edit here). Self-contained: HelmShell + DOM only, own esc(). Exposes
// window.HelmCmdK = { open, close }. Self-executing + reactive (HelmShell.onCommandsChanged), so it
// picks up commands registered before or after it loads.
// ================= SHELL-3: ⌘K command palette =================
// A stable palette that lists EVERY HelmShell.registerCommand({...}) entry. Epics append one
// command from their own module — no edit here. TOOLS-3/AI-6 own richer fuzzy-go-to + NL; this
// is the baseline chrome + the hook they build on (HelmShell.commands / runCommand / onCommandsChanged).
if (window.HelmShell) (function () {
  const palette = document.createElement('div');
  palette.id = 'cmdk'; palette.hidden = true;
  palette.innerHTML =
    '<div class="cmdk-backdrop"></div>' +
    '<div class="cmdk-box glass" role="dialog" aria-label="Command palette">' +
      '<input id="cmdk-input" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false">' +
      '<div id="cmdk-list" class="cmdk-list"></div>' +
    '</div>';
  document.body.appendChild(palette);
  const input = palette.querySelector('#cmdk-input');
  const list = palette.querySelector('#cmdk-list');
  let all = [], shown = [], sel = 0;

  HelmShell.onCommandsChanged(cmds => { all = cmds; if (!palette.hidden) refilter(); });

  function score(c, q) {                          // simple subsequence fuzzy match
    const hay = (c.title + ' ' + c.subtitle + ' ' + c.group + ' ' + [].concat(c.keywords || []).join(' ')).toLowerCase();  // keywords may be a string OR array — normalise (was: .join threw on a string, breaking ⌘K)
    if (!q) return 0;
    let i = 0; for (const ch of q) { i = hay.indexOf(ch, i); if (i < 0) return -1; i++; }
    return 1;
  }
  function refilter() {
    const q = input.value.trim().toLowerCase();
    shown = all.filter(c => score(c, q) >= 0);
    sel = 0; renderList();
  }
  function renderList() {
    if (!shown.length) { list.innerHTML = '<div class="cmdk-empty">' + (all.length ? 'No matching command' : 'No commands registered yet') + '</div>'; return; }
    list.innerHTML = shown.map((c, i) =>
      '<div class="cmdk-item' + (i === sel ? ' on' : '') + '" data-i="' + i + '">' +
        '<span class="cmdk-t">' + esc(c.title) + '</span>' +
        (c.subtitle ? '<span class="cmdk-s">' + esc(c.subtitle) + '</span>' : '') +
        (c.group ? '<span class="cmdk-g">' + esc(c.group) + '</span>' : '') +
      '</div>').join('');
    list.querySelectorAll('.cmdk-item').forEach(el =>
      el.addEventListener('click', () => run(+el.dataset.i)));
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function open() { palette.hidden = false; input.value = ''; refilter(); setTimeout(() => input.focus(), 0); }
  function close() { palette.hidden = true; }
  function run(i) { const c = shown[i]; if (!c) return; close(); HelmShell.runCommand(c.id); }

  input.addEventListener('input', refilter);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderList(); e.preventDefault(); }
    else if (e.key === 'Enter') { run(sel); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); }
  });
  palette.querySelector('.cmdk-backdrop').addEventListener('click', close);
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palette.hidden ? open() : close(); }
  });
  // make the always-present toolbar search box open the palette too
  const tbSearch = document.querySelector('.tb .search'); if (tbSearch) { tbSearch.style.cursor = 'pointer'; tbSearch.addEventListener('click', open); }
  window.HelmCmdK = { open, close };   // so a command/toolbar entry can open it programmatically
})();
