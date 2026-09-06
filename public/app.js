/* Recipes -- PLAN.md Phase 1.
 *
 * No framework, no build step, no dependencies. Three screens, one bundle.
 *
 * Routing is hash-based so the phone's hardware/gesture back button works
 * without any extra handling: #/  #/r/<id>  #/edit/<id>  #/new
 *
 * Every read and write goes through DB (db.js), which is IndexedDB. Nothing
 * here touches the network -- Drive sync arrives in Phase 4 and reconciles in
 * the background, so no code path in this file needs to change for it.
 */
/* Scoped so nothing reaches the global object at all -- see the note in
   db.js for the collision that made this necessary. */
(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- state
  let recipes = [];              // live records, freshest first
  let activeCategories = [];     // AND-ed: a recipe must have all of them
  let query = '';
  let editingId = null;          // null while creating

  // ---------------------------------------------------------------- utils
  /* Everything rendered as HTML goes through this. Recipe text is user input,
     and a title containing an <img onerror=...> must render as characters. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Only http(s) reaches an href. A saved "javascript:..." link would otherwise
     run on tap, and links are pasted from the web by definition. */
  function safeUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  function lines(text) {
    return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }

  function parseCategories(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(',')) {
      const c = raw.trim();
      if (!c) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;      // "Pasta, pasta" is one category
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /* One link per line, "label | url" or a bare url. The separator is a pipe
     because URLs contain commas and colons but effectively never pipes. */
  function parseLinks(text) {
    return lines(text).map((line) => {
      const i = line.indexOf('|');
      if (i === -1) return { url: line, label: '' };
      return { label: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
    }).filter((l) => l.url);
  }

  function formatLinks(links) {
    return (links || []).map((l) => (l.label ? l.label + ' | ' + l.url : l.url)).join('\n');
  }

  function metaLine(r) {
    const bits = [];
    if (r.timeMinutes) bits.push(r.timeMinutes + ' min');
    if (r.servings) bits.push('serves ' + r.servings);
    if (r.ingredients.length) bits.push(r.ingredients.length + ' ingredients');
    return bits.join(' · ');
  }

  let toastTimer = null;
  function toast(message) {
    const node = el('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- filtering
  /* Search matches title, categories and ingredients -- the three things you
     actually remember about a recipe. Steps are excluded on purpose: they are
     long and full of common words, so including them makes every query match. */
  function matches(r) {
    if (activeCategories.length) {
      const have = r.categories.map((c) => c.toLowerCase());
      if (!activeCategories.every((c) => have.includes(c))) return false;
    }
    if (!query) return true;
    const hay = [r.title, r.categories.join(' '), r.ingredients.join(' ')]
      .join(' ').toLowerCase();
    return query.split(/\s+/).every((term) => hay.includes(term));
  }

  function allCategories() {
    const counts = new Map();
    for (const r of recipes) {
      for (const c of r.categories) {
        const key = c.toLowerCase();
        const entry = counts.get(key) || { label: c, n: 0 };
        entry.n++;
        counts.set(key, entry);
      }
    }
    // Most-used first, then alphabetical -- the chips you reach for stay put.
    return [...counts.entries()]
      .map(([key, v]) => ({ key: key, label: v.label, n: v.n }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  }

  // ---------------------------------------------------------------- render
  function renderChips() {
    const cats = allCategories();
    el('chips').innerHTML = cats.map((c) =>
      '<button type="button" class="chip" data-cat="' + esc(c.key) + '" aria-pressed="' +
      (activeCategories.includes(c.key) ? 'true' : 'false') + '">' +
      esc(c.label) + ' ' + c.n + '</button>'
    ).join('');
  }

  function renderList() {
    const shown = recipes.filter(matches);

    el('list').innerHTML = shown.map((r) =>
      '<li><button type="button" class="card" data-id="' + esc(r.id) + '">' +
        '<h3>' + esc(r.title || 'Untitled') + '</h3>' +
        (metaLine(r) ? '<div class="meta">' + esc(metaLine(r)) + '</div>' : '') +
        (r.categories.length
          ? '<div class="cats">' +
            r.categories.map((c) => '<span class="tag">' + esc(c) + '</span>').join('') +
            '</div>'
          : '') +
      '</button></li>'
    ).join('');

    const total = recipes.length;
    el('list-count').textContent =
      total === 0 ? ''
      : shown.length === total ? total + (total === 1 ? ' recipe' : ' recipes')
      : shown.length + ' of ' + total;

    const empty = el('list-empty');
    if (total === 0) {
      empty.textContent = 'No recipes yet. Tap + to add your first one.';
      empty.hidden = false;
    } else if (shown.length === 0) {
      empty.textContent = 'Nothing matches that filter.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function renderDetail(r) {
    const parts = ['<h2>' + esc(r.title || 'Untitled') + '</h2>'];

    if (metaLine(r)) parts.push('<div class="meta">' + esc(metaLine(r)) + '</div>');

    if (r.categories.length) {
      parts.push('<div class="cats" style="margin-top:10px">' +
        r.categories.map((c) => '<span class="tag">' + esc(c) + '</span>').join('') +
        '</div>');
    }
    if (r.ingredients.length) {
      parts.push('<h3>Ingredients</h3><ul>' +
        r.ingredients.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul>');
    }
    if (r.steps.length) {
      parts.push('<h3>Steps</h3><ol>' +
        r.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>');
    }

    const links = r.links
      .map((l) => ({ href: safeUrl(l.url), label: l.label || l.url }))
      .filter((l) => l.href);
    if (links.length) {
      parts.push('<h3>Links</h3><ul>' + links.map((l) =>
        '<li><a href="' + esc(l.href) + '" target="_blank" rel="noopener noreferrer">' +
        esc(l.label) + '</a></li>').join('') + '</ul>');
    }

    if (r.notes.trim()) {
      parts.push('<h3>Notes</h3><p class="notes">' + esc(r.notes) + '</p>');
    }

    el('detail').innerHTML = parts.join('');
  }

  /* Fields are reached through f.elements rather than f.<name>: a control named
     "title" would otherwise be shadowing Element.prototype.title, which is legal
     but relies on a legacy override rule that is easy to trip over later. */
  function fillEditor(r) {
    const f = el('editor').elements;
    f.title.value = r ? r.title : '';
    f.categories.value = r ? r.categories.join(', ') : '';
    f.servings.value = r && r.servings ? r.servings : '';
    f.timeMinutes.value = r && r.timeMinutes ? r.timeMinutes : '';
    f.ingredients.value = r ? r.ingredients.join('\n') : '';
    f.steps.value = r ? r.steps.join('\n') : '';
    f.links.value = r ? formatLinks(r.links) : '';
    f.notes.value = r ? r.notes : '';
    el('editor-error').hidden = true;
    el('editor-title').textContent = r ? 'Edit recipe' : 'New recipe';
  }

  // ---------------------------------------------------------------- routing
  function show(screen) {
    for (const name of ['list', 'detail', 'editor']) {
      el('screen-' + name).hidden = (name !== screen);
    }
    window.scrollTo(0, 0);
  }

  async function route() {
    const hash = location.hash || '#/';
    const detail = hash.match(/^#\/r\/(.+)$/);
    const edit = hash.match(/^#\/edit\/(.+)$/);

    if (hash === '#/new') {
      editingId = null;
      fillEditor(null);
      show('editor');
      return;
    }

    if (edit) {
      const r = await DB.get(decodeURIComponent(edit[1]));
      if (!r) { location.replace('#/'); return; }
      editingId = r.id;
      fillEditor(r);
      show('editor');
      return;
    }

    if (detail) {
      const r = await DB.get(decodeURIComponent(detail[1]));
      if (!r) { location.replace('#/'); return; }
      el('screen-detail').dataset.id = r.id;
      renderDetail(r);
      show('detail');
      return;
    }

    await refresh();
    show('list');
  }

  async function refresh() {
    recipes = await DB.all();
    // Freshest first: the thing you just cooked or edited is the thing you want.
    recipes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    renderChips();
    renderList();
  }

  // ---------------------------------------------------------------- actions
  async function save() {
    const f = el('editor').elements;
    const title = f.title.value.trim();
    if (!title) {
      const err = el('editor-error');
      err.textContent = 'A title is required.';
      err.hidden = false;
      f.title.focus();
      return;
    }

    // Spread the existing record first so fields this form does not touch --
    // id, createdAt, imageIds -- survive an edit.
    const base = editingId ? await DB.get(editingId) : null;
    const record = DB.normalize(Object.assign({}, base || {}, {
      title: title,
      categories: parseCategories(f.categories.value),
      servings: parseInt(f.servings.value, 10) || null,
      timeMinutes: parseInt(f.timeMinutes.value, 10) || null,
      ingredients: lines(f.ingredients.value),
      steps: lines(f.steps.value),
      links: parseLinks(f.links.value),
      notes: f.notes.value.trim()
    }));

    const saved = await DB.save(record);
    await refresh();
    syncSoon();
    toast(editingId ? 'Saved' : 'Recipe added');
    // replace, not assign: going back from the detail view should land on the
    // list, not re-open the editor that was just submitted.
    location.replace('#/r/' + encodeURIComponent(saved.id));
  }

  async function del() {
    const id = el('screen-detail').dataset.id;
    const r = await DB.get(id);
    if (!r) return;
    if (!confirm('Delete "' + (r.title || 'Untitled') + '"?')) return;
    await DB.remove(id);
    await refresh();
    syncSoon();
    toast('Deleted');
    location.replace('#/');
  }

  /* Between Phase 1 and Phase 4 (Drive sync) the only copy of the data is
     IndexedDB in one browser profile, and clearing site data destroys it. This
     is the stopgap backup until sync lands. */
  async function exportJson() {
    const payload = {
      schemaVersion: 1,
      exportedAt: DB.nowIso(),
      recipes: await DB.allRaw()      // tombstones included, so re-importing a
    };                                // backup cannot resurrect a deleted recipe
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recipes-' + DB.nowIso().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported ' + payload.recipes.length + ' records');
  }

  async function importJson(file) {
    try {
      const payload = JSON.parse(await file.text());
      const list = Array.isArray(payload) ? payload : payload.recipes;
      if (!Array.isArray(list)) throw new Error('no recipes array');
      // Merges by last-write-wins rather than replacing, so importing an old
      // backup cannot clobber newer local edits.
      const r = await DB.importAll(list);
      await refresh();
      if (r.added || r.updated) syncSoon();
      toast(r.added + ' added, ' + r.updated + ' updated, ' + r.skipped + ' unchanged');
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
  }

  // -------------------------------------------------------------------- sync
  /* Sync is never in the path of a user action: a save writes to IndexedDB and
     returns, and this runs afterwards. So every failure here is a status line,
     never a blocked edit and never a dialog. */
  let syncTimer = null;

  function renderSyncStatus() {
    const node = el('sync-status');
    const s = Drive.status();

    if (s.phase === 'unconfigured') {
      // Nothing is set up and nothing is broken. Saying so would be noise.
      node.hidden = true;
      return;
    }

    const when = s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : null;
    let text;
    if (s.phase === 'syncing') text = 'Syncing\u2026';
    else if (s.phase === 'offline') text = when ? 'Offline \u00b7 last synced ' + when : 'Offline';
    else if (s.phase === 'error') text = 'Not synced \u2014 ' + s.error;
    else if (s.phase === 'retry') text = 'Will retry \u2014 ' + s.error;
    else if (when) text = 'Synced ' + when;
    else text = '';

    node.textContent = text;
    node.className = 'sync-status' +
      (s.phase === 'error' ? ' is-error' : '') +
      (s.phase === 'syncing' ? ' is-busy' : '');
    node.hidden = !text;
  }

  function relativeTime(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
    return Math.round(seconds / 86400) + 'd ago';
  }

  /* interactive: true may open a Google popup, so it is only ever reached from a
     tap. Everything automatic passes false and stays silent. */
  async function syncNow(interactive) {
    if (!Drive.isConfigured()) {
      if (interactive) toast('Google Drive is not configured yet \u2014 see README');
      return;
    }
    renderSyncStatus();
    await Drive.sync(interactive);
    // The merge may have pulled records in, so the list is redrawn either way.
    await refresh();
    renderSyncStatus();
  }

  /* Coalesced: editing three recipes in a row is one upload, not three. */
  function syncSoon() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(false), 2500);
  }

  // ------------------------------------------------------------ service worker
  /* Registration is entirely optional. Service workers need a secure context, so
     on a plain-HTTP LAN address -- which is how you reach a dev server from a
     phone -- navigator.serviceWorker is simply absent. The app then runs
     online-only, which is correct behaviour, not an error to report. */
  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;      // controllerchange can fire more than once
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker.register('sw.js').then((reg) => {
      // A worker may already be waiting from a previous visit.
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg);

      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          // No existing controller means this is the first install, not an
          // update -- there is nothing for the user to decide.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate(reg);
          }
        });
      });
    }).catch(() => {
      /* Registration can fail for reasons the user cannot act on (private mode,
         an unsupported context). The app works without it. */
    });
  }

  function offerUpdate(reg) {
    const bar = el('update-bar');
    bar.hidden = false;
    el('btn-update').onclick = () => {
      bar.hidden = true;
      // The worker calls skipWaiting, which fires controllerchange, which
      // reloads. Reloading here instead would just re-serve the old shell.
      if (reg.waiting) reg.waiting.postMessage('skip-waiting');
    };
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    el('btn-new').addEventListener('click', () => { location.hash = '#/new'; });
    el('btn-save').addEventListener('click', save);
    el('btn-delete').addEventListener('click', del);
    el('btn-edit').addEventListener('click', () => {
      location.hash = '#/edit/' + encodeURIComponent(el('screen-detail').dataset.id);
    });

    for (const b of document.querySelectorAll('[data-back]')) {
      b.addEventListener('click', () => history.back());
    }

    el('btn-menu').addEventListener('click', (e) => {
      const opening = el('menu').hidden;
      el('menu').hidden = !opening;
      e.currentTarget.setAttribute('aria-expanded', String(opening));
    });
    el('btn-sync').addEventListener('click', () => {
      el('menu').hidden = true;
      el('btn-menu').setAttribute('aria-expanded', 'false');
      syncNow(true);
    });
    el('btn-export').addEventListener('click', exportJson);
    el('btn-import').addEventListener('click', () => el('file-import').click());
    el('file-import').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importJson(file);
      e.target.value = '';             // re-importing the same file must re-fire
    });

    el('search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      renderList();
    });

    // Delegated: chips and cards are re-rendered on every keystroke, so binding
    // each one individually would leak listeners.
    el('chips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      const cat = chip.dataset.cat;
      const i = activeCategories.indexOf(cat);
      if (i === -1) activeCategories.push(cat); else activeCategories.splice(i, 1);
      renderChips();
      renderList();
    });

    el('list').addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]');
      if (card) location.hash = '#/r/' + encodeURIComponent(card.dataset.id);
    });

    // The editor is submitted by the Save button, but a phone keyboard's "go"
    // key fires submit -- route it to the same place rather than reloading.
    el('editor').addEventListener('submit', (e) => { e.preventDefault(); save(); });

    window.addEventListener('hashchange', route);
    route();
    registerWorker();

    // A silent attempt on open, and again when the network comes back. Both
    // no-op harmlessly when Drive is not configured.
    syncNow(false);
    window.addEventListener('online', () => syncNow(false));
    window.addEventListener('offline', renderSyncStatus);
  }

  init();
})();
