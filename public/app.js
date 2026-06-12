'use strict';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtCost(n) { return '$' + (n || 0).toFixed(n >= 100 ? 0 : 2); }
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 10) return 'à l\'instant';
  if (s < 60) return `il y a ${Math.floor(s)}s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}
const STATE_LABEL = {
  working: 'Claude travaille', waiting: 'En attente de toi', attention: 'Action requise',
  idle: 'En pause', ended: 'Terminée', past: 'Passée',
};

let allSessions = [];
let currentSessionId = null;
let statusFilter = 'all';
const collapsedProjects = new Set();

// filtres par statut (single-select). `states` = états couverts par le filtre.
const STATUS_FILTERS = [
  { key: 'all', label: 'Tous', states: null },
  { key: 'attention', label: '🔴 Action', states: ['attention'] },
  { key: 'waiting', label: '🟡 Attente', states: ['waiting'] },
  { key: 'working', label: '🔵 Travaille', states: ['working'] },
  { key: 'idle', label: '🕘 En pause', states: ['idle'] },
  { key: 'done', label: '✓ Terminées', states: ['ended', 'past'] },
];
function filterMatches(f, state) { return !f.states || f.states.includes(state); }

// ---------- onglets ----------
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + t.dataset.view).classList.add('active');
  if (t.dataset.view === 'stats') loadStats();
}));

// ---------- SSE live ----------
let es;
function connectSSE() {
  es = new EventSource('/api/stream');
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  es.onmessage = () => { if ($('.tab.active').dataset.view === 'sessions') tick(); };
}
function setLive(on) {
  $('#live-dot').classList.toggle('on', on);
  $('#live-label').textContent = on ? 'live' : 'reconnexion…';
}

// ---------- data + sidebar ----------
async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    allSessions = (await r.json()).sessions;
    renderSidebar();
  } catch (_) {}
}
async function tick() {
  await loadSessions();
  if ($('#global-bar')) renderGlobal();
  // suit une session en cours de travail
  if (currentSessionId) {
    const s = allSessions.find((x) => x.id === currentSessionId);
    const cardShown = !!$('#question');
    // re-render si : Claude bosse ; OU une question vient d'apparaître (carte absente) ;
    // OU la question vient d'être répondue (carte présente à retirer). On évite de
    // re-render quand la carte est déjà là ET toujours en attente → préserve la sélection.
    if (s && (s.state === 'working' || (s.hasQuestion && !cardShown) || (!s.hasQuestion && cardShown))) {
      openSession(currentSessionId, true);
    }
  }
}

function renderStatusFilter() {
  const el = $('#status-filter');
  if (!el) return;
  const count = (f) => f.states === null ? allSessions.length : allSessions.filter((s) => filterMatches(f, s.state)).length;
  el.innerHTML = STATUS_FILTERS.map((f) => {
    const n = count(f);
    const active = statusFilter === f.key ? ' active' : '';
    return `<button class="sf-chip${active}" data-key="${f.key}">${f.label}<span class="sf-n">${n}</span></button>`;
  }).join('');
  $$('#status-filter .sf-chip').forEach((b) => b.addEventListener('click', () => {
    statusFilter = b.dataset.key;
    renderSidebar();
  }));
}

function renderSidebar() {
  renderStatusFilter();
  const q = $('#search').value.toLowerCase().trim();
  const hideOld = $('#hide-old').checked;
  const sf = STATUS_FILTERS.find((f) => f.key === statusFilter) || STATUS_FILTERS[0];
  let list = allSessions.filter((s) => {
    if (!filterMatches(sf, s.state)) return false;
    if (hideOld && s.lastActivity && (Date.now() - Date.parse(s.lastActivity)) > 86400000) return false;
    if (q) {
      const hay = `${s.projectName} ${s.title} ${s.lastPrompt} ${s.gitBranch}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const groups = {};
  list.forEach((s) => { (groups[s.projectName || '?'] = groups[s.projectName || '?'] || []).push(s); });
  const lastOf = (arr) => Math.max(...arr.map((s) => Date.parse(s.lastActivity || 0) || 0));
  const order = Object.keys(groups).sort((a, b) => lastOf(groups[b]) - lastOf(groups[a]));
  let html = '';
  for (const proj of order) {
    const items = groups[proj].sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
    const collapsed = collapsedProjects.has(proj);
    const flag = items.some((s) => s.state === 'attention') ? '<span class="pflag a"></span>'
      : items.some((s) => s.state === 'waiting' || s.state === 'working') ? '<span class="pflag w"></span>' : '';
    html += `<div class="pgroup ${collapsed ? 'collapsed' : ''}">
        <div class="phead" data-proj="${esc(proj)}"><span class="parrow">▾</span><span class="pname">${esc(proj)}</span>${flag}<span class="pcount">${items.length}</span></div>
        <div class="plist">${items.map(srow).join('')}</div>
      </div>`;
  }
  $('#side-list').innerHTML = html || '<div class="empty">Aucune session.</div>';
  $$('#side-list .phead').forEach((h) => h.addEventListener('click', () => {
    const p = h.dataset.proj;
    collapsedProjects.has(p) ? collapsedProjects.delete(p) : collapsedProjects.add(p);
    renderSidebar();
  }));
  $$('#side-list .srow').forEach((r) => r.addEventListener('click', () => openSession(r.dataset.id)));
  if (currentSessionId) {
    const el = $$('#side-list .srow').find((r) => r.dataset.id === currentSessionId);
    if (el) el.classList.add('active');
  }
}
const LIVE_STATES = ['working', 'waiting', 'attention', 'idle'];
function shortModel(m) { return (m || '').replace(/^claude-/, ''); }
// badges modèle + effort, affichés sur les sessions en cours
function metaTags(s) {
  if (!LIVE_STATES.includes(s.state)) return '';
  const tags = [];
  if (s.model) tags.push(`<span class="mtag">${esc(shortModel(s.model))}</span>`);
  if (s.effort) tags.push(`<span class="mtag eff">${esc(s.effort)}</span>`);
  return tags.length ? `<div class="srow-meta">${tags.join('')}</div>` : '';
}
function srow(s) {
  return `<div class="srow s-${s.state}${s.hasQuestion ? ' has-q' : ''}" data-id="${esc(s.id)}">
      <span class="sdot"></span>
      <div class="srow-main">
        <div class="srow-title">${s.hasQuestion ? '<span class="q-flag" title="Claude attend ta réponse">⌨</span>' : ''}${esc(s.title)}</div>
        <div class="srow-sub">${s.gitBranch ? esc(s.gitBranch) + ' · ' : ''}${ago(s.lastActivity)}</div>
        ${metaTags(s)}
      </div>
    </div>`;
}

$('#search').addEventListener('input', renderSidebar);
$('#hide-old').addEventListener('change', renderSidebar);
$('#ov-btn').addEventListener('click', showOverview);

// ---------- vue d'ensemble ----------
function showOverview() {
  currentSessionId = null;
  $$('#side-list .srow').forEach((r) => r.classList.remove('active'));
  $('#main-pane').innerHTML = `
    <div class="overview">
      <div id="global-bar" class="global-bar"></div>
      <p class="ov-hint">← Sélectionne une session à gauche pour relire la conversation (lecture seule).</p>
    </div>`;
  renderGlobal();
}
function renderGlobal() {
  if (!$('#global-bar')) return;
  const S = allSessions;
  const sum = (f) => S.reduce((a, s) => a + f(s), 0);
  const nb = (states) => S.filter((s) => states.includes(s.state)).length;
  const pill = (icon, v, l, cls, attr) => `<div class="gp ${cls || ''}" ${attr || ''}><span class="gp-i">${icon}</span><div><div class="gp-v">${v}</div><div class="gp-l">${l}</div></div></div>`;
  $('#global-bar').innerHTML =
    pill('📊', S.length, 'sessions') +
    pill('🔵', nb(['working']), 'en cours', 'g-working') +
    pill('🟡', nb(['waiting', 'attention']), 'en attente', 'g-waiting') +
    pill('💬', sum((s) => s.userPrompts), 'prompts') +
    pill('🎟', fmtTokens(sum((s) => s.usage.output + s.usage.input)), 'tokens') +
    pill('💲', fmtCost(sum((s) => s.cost)), 'coût API estimé ›', 'g-cost clickable', 'id="gp-cost"');
  const cb = $('#gp-cost');
  if (cb) cb.addEventListener('click', openCostModal);
}

// ---------- session (chat) ----------
async function openSession(id, keepScroll) {
  currentSessionId = id;
  $$('#side-list .srow').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
  let prevScroll = null;
  // préserve la saisie en cours du composer (re-render auto toutes les 5s si Claude bosse)
  const rt = $('#reply-text');
  const draft = rt ? rt.value : '';
  const draftFocused = rt && document.activeElement === rt;
  if (keepScroll) { const pb = $('#main-pane .pane-body'); prevScroll = pb ? pb.scrollTop : null; }
  const r = await fetch('/api/session?id=' + encodeURIComponent(id));
  if (!r.ok || currentSessionId !== id) return;
  const s = await r.json();
  const u = s.usage;
  const events = (s.events || []).slice().reverse();
  const chat = (s.messages || []).map(chatBubble).join('') || '<div class="pane-empty">Conversation vide.</div>';
  const timeline = events.length ? events.map(evRow).join('') : '<div class="empty">Pas d\'évènement de hook.</div>';
  const changes = s.changes || [];
  const changesHtml = changes.length ? changes.map(changeCard).join('') : '<div class="pane-empty">Aucune modification de fichier dans cette session.</div>';
  $('#main-pane').innerHTML = `
    <div class="pane-head s-${s.state}">
      <div class="card-top" style="cursor:default;margin-bottom:6px">
        <span class="proj">${esc(s.projectName || '?')}</span>
        ${s.gitBranch ? `<span class="branch">${esc(s.gitBranch)}</span>` : ''}
        ${s.tmuxPane ? `<span class="ro-tag live">↩ réponse possible</span><button id="stop-btn" class="stop-btn" data-id="${esc(s.id)}">⏹ Stopper</button>${s.tmuxAttach ? `<button id="attach-btn" class="attach-btn" title="${esc(s.tmuxAttach)}" data-cmd="${esc(s.tmuxAttach)}">⧉ Copier attach</button>` : ''}`
          : `<span class="ro-tag">lecture seule</span><button id="resume-btn" class="resume-btn" data-id="${esc(s.id)}">▶ Reprendre dans tmux</button>`}
        <span class="badge s-badge" style="margin-left:auto">${STATE_LABEL[s.state] || s.state}</span>
      </div>
      <h2 style="margin:0">${esc(s.title)}</h2>
      ${prLinksHtml(s.prLinks)}
      <div class="detail-grid" style="margin:14px 0 0">
        <div><div class="v">${fmtCost(s.cost)}</div><div class="l">coût estimé</div></div>
        <div><div class="v">${s.assistantTurns}</div><div class="l">tours</div></div>
        <div><div class="v">${s.userPrompts}</div><div class="l">prompts</div></div>
        <div><div class="v">${fmtTokens(u.output)}</div><div class="l">tokens out</div></div>
        <div><div class="v">${fmtTokens(u.cacheRead)}</div><div class="l">cache lu</div></div>
        <div><div class="v">${esc((s.model || '').replace('claude-', ''))}</div><div class="l">modèle</div></div>
        ${s.effort ? `<div><div class="v">${esc(s.effort)}</div><div class="l">effort</div></div>` : ''}
      </div>
      <div class="subtabs">
        <button class="subtab active" data-pane="chat">💬 Conversation <span class="count">${(s.messages || []).length}</span></button>
        <button class="subtab" data-pane="changes">📝 Fichiers <span class="count">${changes.length}</span></button>
        <button class="subtab" data-pane="activity">🪝 Activité <span class="count">${events.length}</span></button>
      </div>
    </div>
    <div class="pane-body">
      <div id="pane-chat" class="pane active"><div class="chat">${chat}</div>${s.pendingQuestion ? questionHtml(s.pendingQuestion) : ''}${s.tmuxPane ? composerHtml() : ''}</div>
      <div id="pane-changes" class="pane"><div class="changes">${changesHtml}</div></div>
      <div id="pane-activity" class="pane"><div class="timeline">${timeline}</div></div>
    </div>`;
  $$('#main-pane .subtab').forEach((b) => b.addEventListener('click', () => {
    $$('#main-pane .subtab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $$('#main-pane .pane').forEach((p) => p.classList.remove('active'));
    $('#pane-' + b.dataset.pane).classList.add('active');
  }));
  $$('#pane-changes .change-head').forEach((h) => h.addEventListener('click', () => {
    h.parentElement.classList.toggle('open');
  }));
  const rb = $('#resume-btn');
  if (rb) rb.addEventListener('click', () => openLaunchModal({ id: s.id, project: s.project, projectName: s.projectName, title: s.title }));
  const sb = $('#stop-btn');
  if (sb) sb.addEventListener('click', () => stopSession(sb));
  const ab = $('#attach-btn');
  if (ab) ab.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ab.dataset.cmd); const t = ab.textContent; ab.textContent = '✓ copié'; setTimeout(() => { ab.textContent = t; }, 1500); }
    catch (_) { ab.textContent = '✗ échec'; }
  });
  wireComposer(id, draft, draftFocused);
  if (s.pendingQuestion) wireQuestion(id, s.pendingQuestion);
  const pb = $('#main-pane .pane-body');
  if (pb) pb.scrollTop = prevScroll != null ? prevScroll : pb.scrollHeight; // bas = message le plus récent
}

// ---------- question interactive (AskUserQuestion) ----------
// Affiche proprement la question posée par Claude + ses réponses proposées, à partir
// des données structurées du transcript (zéro scraping terminal). Mono- ou multi-sélection
// selon `multiSelect`. La sélection est envoyée à Claude via /api/reply (tmux send-keys) :
// le ou les labels choisis sont « tapés » dans le TUI AskUserQuestion comme réponse.
function questionHtml(pq) {
  const blocks = (pq.questions || []).map((q, qi) => {
    const opts = (q.options || []).map((o, oi) => `
      <label class="q-opt" data-q="${qi}" data-o="${oi}">
        <input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${qi}" value="${oi}">
        <span class="q-opt-body">
          <span class="q-opt-label">${esc(o.label)}</span>
          ${o.description ? `<span class="q-opt-desc">${esc(o.description)}</span>` : ''}
        </span>
      </label>`).join('');
    return `<div class="q-block" data-q="${qi}">
        ${q.header ? `<span class="q-chip">${esc(q.header)}</span>` : ''}
        <div class="q-text">${esc(q.question)}</div>
        ${q.multiSelect ? '<div class="q-hint">Plusieurs choix possibles</div>' : ''}
        <div class="q-opts">${opts}</div>
      </div>`;
  }).join('');
  return `<div class="question" id="question">
      <div class="q-head"><span class="q-ico">⌨</span><span class="q-title">Claude te pose une question</span></div>
      ${blocks}
      <div class="q-foot">
        <div id="q-recap" class="q-recap">Sélectionne ${(pq.questions || []).length > 1 ? 'tes réponses' : 'ta réponse'}…</div>
        <button id="q-send" class="reply-send" disabled>Envoyer ↩</button>
      </div>
    </div>`;
}
function wireQuestion(id, pq) {
  const root = $('#question');
  if (!root) return;
  const questions = pq.questions || [];
  // sélection courante par question : index unique (mono) ou tableau d'index (multi)
  const pick = questions.map((q) => (q.multiSelect ? [] : null));
  const recap = $('#q-recap');
  const sendBtn = $('#q-send');
  // labels sélectionnés par question (tableau de tableaux de strings)
  const selectedLabels = () => questions.map((q, qi) => {
    const sel = pick[qi];
    return q.multiSelect
      ? sel.map((oi) => q.options[oi] && q.options[oi].label).filter(Boolean)
      : (sel != null && q.options[sel] ? [q.options[sel].label] : []);
  });
  // toutes les questions ont au moins une réponse → on peut envoyer
  const allAnswered = () => selectedLabels().every((l) => l.length);
  const update = () => {
    const labels = selectedLabels();
    const parts = labels.map((l, qi) => l.length ? `${questions[qi].header ? questions[qi].header + ' : ' : ''}${l.join(', ')}` : '').filter(Boolean);
    if (recap) recap.textContent = parts.length ? '→ ' + parts.join('  ·  ') : `Sélectionne ${questions.length > 1 ? 'tes réponses' : 'ta réponse'}…`;
    if (sendBtn) sendBtn.disabled = !allAnswered();
  };
  $$('#question .q-opt input').forEach((inp) => inp.addEventListener('change', () => {
    const lab = inp.closest('.q-opt');
    const qi = +lab.dataset.q, oi = +lab.dataset.o;
    if (questions[qi].multiSelect) {
      const arr = pick[qi];
      const at = arr.indexOf(oi);
      if (inp.checked && at < 0) arr.push(oi); else if (!inp.checked && at >= 0) arr.splice(at, 1);
    } else {
      pick[qi] = oi;
    }
    $$('#question .q-opt').forEach((l) => {
      const i = l.querySelector('input');
      l.classList.toggle('sel', i && i.checked);
    });
    update();
  }));

  // envoi de la sélection : on « tape » les labels choisis dans le TUI via /api/reply.
  // Texte sans saut de ligne (un \n validerait prématurément dans le terminal) :
  // multi-sélection d'une question jointe par « , », réponses de questions distinctes par « · ».
  const send = async () => {
    if (!allAnswered() || !sendBtn) return;
    const text = selectedLabels().map((l) => l.join(', ')).filter(Boolean).join(' · ');
    if (!text) return;
    sendBtn.disabled = true;
    const prev = sendBtn.textContent;
    sendBtn.textContent = 'envoi…';
    if (recap) recap.className = 'q-recap';
    try {
      const r = await fetch('/api/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        root.classList.add('sent');
        if (recap) { recap.textContent = '✓ envoyé : ' + text; recap.className = 'q-recap ok'; }
        $$('#question .q-opt input').forEach((i) => { i.disabled = true; });
        setTimeout(tick, 600); // rafraîchit (la question disparaîtra une fois répondue)
      } else {
        if (recap) { recap.textContent = '✗ ' + (d.error || 'échec'); recap.className = 'q-recap err'; }
        sendBtn.disabled = false; sendBtn.textContent = prev;
      }
    } catch (e) {
      if (recap) { recap.textContent = '✗ ' + (e.message || 'erreur réseau'); recap.className = 'q-recap err'; }
      sendBtn.disabled = false; sendBtn.textContent = prev;
    }
  };
  if (sendBtn) sendBtn.addEventListener('click', send);
}

function composerHtml() {
  return `<div class="composer">
      <textarea id="reply-text" rows="1" placeholder="Répondre à Claude…  (Entrée pour envoyer · Maj+Entrée = nouvelle ligne · @ pour un fichier)"></textarea>
      <button id="reply-send" class="reply-send">Envoyer ↩</button>
      <div id="at-pop" class="at-pop hidden"></div>
      <div id="reply-status" class="reply-status"></div>
    </div>`;
}
function wireComposer(id, draft, draftFocused) {
  const ta = $('#reply-text');
  const btn = $('#reply-send');
  if (!ta || !btn) return;
  if (draft) ta.value = draft;
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  autosize();
  if (draftFocused) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }

  // ----- auto-complétion @fichier : déclenchée quand on tape « @… » -----
  const pop = $('#at-pop');
  let acItems = [], acSel = -1, acStart = -1, acReq = 0;
  const acOpen = () => pop && !pop.classList.contains('hidden');
  const closeAc = () => { if (pop) { pop.classList.add('hidden'); pop.innerHTML = ''; } acItems = []; acSel = -1; acStart = -1; };
  const baseName = (f) => f.slice(f.lastIndexOf('/') + 1);
  const renderAc = () => {
    if (!pop || !acItems.length) { closeAc(); return; }
    pop.innerHTML = acItems.map((f, i) => `<div class="at-item${i === acSel ? ' sel' : ''}" data-i="${i}"><span class="at-name">${esc(baseName(f))}</span><span class="at-path">${esc(f)}</span></div>`).join('');
    pop.classList.remove('hidden');
    const sel = pop.querySelector('.at-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    $$('#at-pop .at-item').forEach((el) => el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      acSel = +el.dataset.i;
      acceptAc();
    }));
  };
  const moveAc = (d) => { if (!acItems.length) return; acSel = (acSel + d + acItems.length) % acItems.length; renderAc(); };
  const acceptAc = () => {
    if (acSel < 0) acSel = 0;
    const f = acItems[acSel];
    if (f == null || acStart < 0) return;
    const before = ta.value.slice(0, acStart);
    const after = ta.value.slice(ta.selectionStart);
    const ins = '@' + f + ' ';
    ta.value = before + ins + after;
    const pos = (before + ins).length;
    ta.selectionStart = ta.selectionEnd = pos;
    closeAc(); autosize(); ta.focus();
  };
  const queryAc = async () => {
    const pos = ta.selectionStart;
    const m = ta.value.slice(0, pos).match(/(^|\s)@([^\s@]*)$/);
    if (!m) { closeAc(); return; }
    acStart = pos - m[2].length - 1; // index du « @ »
    const myReq = ++acReq;
    try {
      const r = await fetch(`/api/files?id=${encodeURIComponent(id)}&q=${encodeURIComponent(m[2])}`);
      const d = await r.json();
      if (myReq !== acReq || ta.selectionStart !== pos) return; // réponse périmée
      acItems = (d.files || []).slice(0, 30);
      acSel = acItems.length ? 0 : -1;
      renderAc();
    } catch (_) { closeAc(); }
  };
  ta.addEventListener('input', () => { autosize(); queryAc(); });
  ta.addEventListener('blur', () => setTimeout(closeAc, 150));

  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true; ta.disabled = true;
    const status = $('#reply-status');
    status.textContent = 'envoi…'; status.className = 'reply-status';
    try {
      const r = await fetch('/api/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        ta.value = ''; autosize();
        status.textContent = '✓ remis dans ' + d.pane; status.className = 'reply-status ok';
        setTimeout(() => { const s = $('#reply-status'); if (s) s.textContent = ''; }, 2500);
        setTimeout(tick, 600); // rafraîchit la conversation
      } else {
        status.textContent = '✗ ' + (d.error || 'échec'); status.className = 'reply-status err';
      }
    } catch (e) {
      status.textContent = '✗ ' + (e.message || 'erreur réseau'); status.className = 'reply-status err';
    } finally {
      btn.disabled = false; ta.disabled = false; ta.focus();
    }
  };
  btn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (acOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
}
// ---------- liens de PR GitHub (header de conversation) ----------
function prLinksHtml(links) {
  if (!links || !links.length) return '';
  const chips = links.map((l) => {
    const m = l.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    const label = m ? `${m[2]} #${m[3]}` : l;
    return `<a class="pr-link" href="${esc(l)}" target="_blank" rel="noopener" title="${esc(l)}"><span class="pr-ico">🔗</span>${esc(label)}</a>`;
  }).join('');
  return `<div class="pr-links">${chips}</div>`;
}

// ---------- modifications de fichiers (onglet Fichiers) ----------
function changeCard(c) {
  const ops = (c.ops || []).map(diffHtml).join('');
  return `<div class="change">
      <div class="change-head" title="${esc(c.file)}">
        <span class="ch-arrow">▸</span>
        <span class="ch-name">${esc(c.name)}</span>
        <span class="ch-path">${esc(c.file)}</span>
        <span class="ch-count">${c.count} ${c.count > 1 ? 'modifs' : 'modif'}</span>
      </div>
      <div class="change-ops">${ops}</div>
    </div>`;
}
function diffHtml(o) {
  // Write / NotebookEdit : pas d'« avant » → contenu complet en pleine largeur.
  if (o.kind === 'write' || o.kind === 'notebook') {
    const src = o.kind === 'write' ? o.content : o.new;
    const lines = src.split('\n').map((l) => `<div class="dl add">${esc(l)}</div>`).join('');
    const tag = o.kind === 'write' ? '＋ nouveau contenu' : 'notebook';
    return `<div class="diff"><div class="diff-tag write">${tag}</div><div class="diff-body">${lines}</div></div>`;
  }
  // Edit : vue côte à côte (avant | après), lignes alignées par index.
  const oldL = o.old ? o.old.split('\n') : [];
  const newL = o.new ? o.new.split('\n') : [];
  const n = Math.max(oldL.length, newL.length, 1);
  let rows = '';
  for (let i = 0; i < n; i++) {
    rows += i < oldL.length ? `<div class="dl del">${esc(oldL[i])}</div>` : '<div class="dl nil"></div>';
    rows += i < newL.length ? `<div class="dl add">${esc(newL[i])}</div>` : '<div class="dl nil"></div>';
  }
  return `<div class="diff">${o.all ? '<div class="diff-tag">remplace toutes les occurrences</div>' : ''}
      <div class="diff-split">
        <div class="ds-head">avant</div><div class="ds-head">après</div>
        ${rows}
      </div>
    </div>`;
}

function chatBubble(m) {
  const tools = (m.tools || []).map((t) => `<span class="chip">🔧 ${esc(t.name)}${t.detail ? `<span class="chip-d">${esc(t.detail)}</span>` : ''}</span>`).join('');
  const body = m.text ? `<div class="md">${mdLite(m.text)}</div>` : '';
  return `<div class="bubble ${m.role}">
      <div class="who">${m.role === 'user' ? '🧑 Toi' : '🤖 Claude'}<span class="t">${ago(m.ts)}</span></div>
      ${body}
      ${tools ? `<div class="chips">${tools}</div>` : ''}
    </div>`;
}
function mdLite(t) {
  const parts = String(t).split(/```/);
  let out = '';
  parts.forEach((seg, i) => {
    if (i % 2 === 1) {
      out += `<pre><code>${esc(seg.replace(/^[a-zA-Z0-9]*\n/, ''))}</code></pre>`;
    } else {
      out += esc(seg)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,4} (.+)$/gm, '<b>$1</b>')
        .replace(/\n/g, '<br>');
    }
  });
  return out;
}
function evRow(e) {
  const tool = e.tool ? ` <span class="tool">${esc(e.tool)}</span>` : '';
  const msg = e.message ? ` — ${esc(e.message.slice(0, 90))}` : '';
  return `<div class="ev"><b>${esc(e.event)}</b>${tool}${msg}<span class="t">${ago(e.ts)}</span></div>`;
}

// ---------- modale coût ----------
function openCostModal() {
  const S = allSessions;
  const sum = (f) => S.reduce((a, s) => a + f(s), 0);
  const cb = {
    input: sum((s) => (s.costBreak ? s.costBreak.input : 0)),
    output: sum((s) => (s.costBreak ? s.costBreak.output : 0)),
    cacheCreate: sum((s) => (s.costBreak ? s.costBreak.cacheCreate : 0)),
    cacheRead: sum((s) => (s.costBreak ? s.costBreak.cacheRead : 0)),
  };
  const tk = {
    input: sum((s) => s.usage.input), output: sum((s) => s.usage.output),
    cacheCreate: sum((s) => s.usage.cacheCreate), cacheRead: sum((s) => s.usage.cacheRead),
  };
  const tot = cb.input + cb.output + cb.cacheCreate + cb.cacheRead || 1e-9;
  const COMP = [['Input', 'input', '#6cb0ff'], ['Output', 'output', '#3fb950'], ['Cache write', 'cacheCreate', '#e3b341'], ['Cache read', 'cacheRead', '#f0883e']];
  const compRows = COMP.map(([label, key, col]) => `
    <div class="bar-row">
      <span class="label">${label}</span>
      <span class="track"><span class="fill" style="width:${Math.max(1, (cb[key] / tot) * 100)}%;background:${col}"></span></span>
      <span class="val">${fmtCost(cb[key])}</span>
      <span class="val" style="width:48px;color:var(--muted)">${(cb[key] / tot * 100).toFixed(0)}%</span>
      <span class="val" style="width:58px;color:var(--muted)">${fmtTokens(tk[key])}</span>
    </div>`).join('');
  const byModel = {}; S.forEach((s) => { if (s.cost) byModel[s.model || '?'] = (byModel[s.model || '?'] || 0) + s.cost; });
  const byProj = {}; S.forEach((s) => { byProj[s.projectName || '?'] = (byProj[s.projectName || '?'] || 0) + s.cost; });
  const list = (obj, fk) => {
    const e = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const mx = Math.max(1e-9, ...e.map((x) => x[1]));
    return e.map(([k, v]) => `<div class="bar-row"><span class="label" title="${esc(k)}">${esc(fk ? fk(k) : k)}</span><span class="track"><span class="fill" style="width:${Math.max(1, v / mx * 100)}%"></span></span><span class="val">${fmtCost(v)}</span></div>`).join('');
  };
  $('#modal-body').innerHTML = `
    <h2 style="margin:0 0 4px">💲 Coût API estimé — ${fmtCost(tot)}</h2>
    <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 18px">
      Estimation API pay-as-you-go. En abonnement (Max/Pro), ce n'est <b>pas</b> ta facture réelle.
      Tarifs : Fable 10/50, Opus 5/25, Sonnet 3/15, Haiku 1/5 $/Mtok ; cache write ×1.25, read ×0.1.</p>
    <h3 style="margin:0 0 12px">Par composant <span style="color:var(--muted);font-weight:400;font-size:12px">(coût · % · tokens)</span></h3>
    ${compRows}
    <div class="cost-cols">
      <div><h3 style="margin:18px 0 12px">Par modèle</h3>${list(byModel, (k) => k.replace('claude-', '')) || '<div class="empty">—</div>'}</div>
      <div><h3 style="margin:18px 0 12px">Par projet</h3>${list(byProj) || '<div class="empty">—</div>'}</div>
    </div>`;
  $('#modal').classList.remove('hidden');
}
$('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('.modal-bg').addEventListener('click', () => $('#modal').classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });

// ---------- STATS ----------
let curRange = '7';
$$('#range button').forEach((b) => b.addEventListener('click', () => {
  $$('#range button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  curRange = b.dataset.range;
  loadStats();
}));
async function loadStats() {
  const r = await fetch('/api/stats?range=' + curRange);
  const d = await r.json();
  const t = d.totals;
  $('#kpis').innerHTML = [
    kpi(fmtCost(t.cost), 'Coût estimé'), kpi(t.sessions, 'Sessions'), kpi(t.turns, 'Tours Claude'),
    kpi(t.prompts, 'Prompts'), kpi(fmtTokens(t.output), 'Tokens générés'), kpi(fmtTokens(t.cacheRead), 'Tokens cache lus'),
  ].join('');
  const days = Object.keys(d.byDay).sort();
  const maxCost = Math.max(1e-6, ...days.map((k) => d.byDay[k].cost));
  $('#chart-day').innerHTML = days.length
    ? `<div class="daybars">${days.slice(-30).map((k) => {
        const c = d.byDay[k].cost; const h = Math.round((c / maxCost) * 100);
        return `<div class="col" title="${k} · ${fmtCost(c)}"><div class="b" style="height:${h}%"></div><div class="cap">${k.slice(5)}</div></div>`;
      }).join('')}</div>`
    : '<div class="empty">Aucune donnée</div>';
  barChart('#chart-model', Object.entries(d.byModel).map(([k, v]) => [k.replace('claude-', ''), v.cost]), fmtCost);
  barChart('#chart-project', Object.entries(d.byProject).map(([k, v]) => [k, v.cost]), fmtCost);
  barChart('#chart-tool', Object.entries(d.byTool).map(([k, v]) => [k, v]), (n) => n);
}
function kpi(v, l) { return `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`; }
function barChart(sel, entries, fmt) {
  entries.sort((a, b) => b[1] - a[1]);
  entries = entries.slice(0, 8);
  const max = Math.max(1e-6, ...entries.map((e) => e[1]));
  const el = $(sel);
  if (!entries.length) { el.innerHTML = '<div class="empty">Aucune donnée</div>'; return; }
  el.innerHTML = entries.map(([k, v]) => `
    <div class="bar-row">
      <span class="label" title="${esc(k)}">${esc(k)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(2, (v / max) * 100)}%"></span></span>
      <span class="val">${fmt(v)}</span>
    </div>`).join('');
}

// ---------- lancer / reprendre une session (tmux) ----------
$('#new-btn').addEventListener('click', () => openLaunchModal());

// Projets uniques triés par utilisation : activité la plus récente d'abord
// (à égalité, le plus de sessions). Renvoie [[cwd, name], …].
function uniqProjects() {
  const m = new Map();
  for (const s of allSessions) {
    if (!s.project) continue;
    const e = m.get(s.project) || { name: s.projectName || s.project, count: 0, last: '' };
    e.count++;
    const t = s.lastActivity || '';
    if (t > e.last) e.last = t;
    m.set(s.project, e);
  }
  return [...m.entries()]
    .sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)) || b[1].count - a[1].count)
    .map(([cwd, e]) => [cwd, e.name]);
}

function modelEffortHtml() {
  return `<div class="lf-row">
      <div>
        <label class="lf-label">Modèle</label>
        <select id="lf-model" class="lf-input">
          <option value="">⚙️ défaut</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
          <option value="fable">Fable</option>
        </select>
      </div>
      <div>
        <label class="lf-label">Effort</label>
        <select id="lf-effort" class="lf-input">
          <option value="">⚙️ défaut</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
      </div>
    </div>`;
}

// Sans argument : nouvelle session. Avec `resume` ({id, project, projectName, title}) :
// reprise de cette session (mêmes sélecteurs modèle/effort, dossier verrouillé à l'original).
function openLaunchModal(resume) {
  if (resume) return openResumeModal(resume);
  const projs = uniqProjects();
  $('#modal-body').innerHTML = `
    <h2 style="margin:0 0 4px">＋ Nouvelle session Claude</h2>
    <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 18px">
      Lance <code>claude</code> interactif dans une session <b>tmux</b> détachée — ton abonnement,
      <b>aucune conso token</b>, pas de <code>claude -p</code>. Attache-toi ensuite avec la commande affichée.</p>
    <label class="lf-label">Projet</label>
    <input id="lf-proj-search" type="search" class="lf-input" placeholder="🔍 Rechercher un projet…" />
    <div id="lf-proj-list" class="lf-picklist"></div>
    <input id="lf-cwd" class="lf-input" placeholder="/chemin/vers/le/projet" style="display:none;margin-top:8px" />
    ${modelEffortHtml()}
    <label class="lf-label">Premier message <span style="color:var(--muted);font-weight:400">(optionnel)</span></label>
    <textarea id="lf-prompt" class="lf-input" rows="3" placeholder="Laisse vide pour démarrer sans prompt…"></textarea>
    <div class="lf-actions">
      <button id="lf-go" class="reply-send">Lancer ↗</button>
      <div id="lf-status" class="reply-status"></div>
    </div>`;
  $('#modal').classList.remove('hidden');

  const search = $('#lf-proj-search'), listEl = $('#lf-proj-list'), cwd = $('#lf-cwd');
  let selected = projs.length ? projs[0][0] : '__custom'; // cwd choisi (ou __custom)
  const rowHtml = ([c, name]) => `<div class="lf-pick" data-cwd="${esc(c)}"><span class="pn">${esc(name)}</span><span class="pp">${esc(c)}</span></div>`;
  const customRow = '<div class="lf-pick custom" data-cwd="__custom">📁 Autre dossier…</div>';
  const renderList = () => {
    const q = search.value.toLowerCase().trim();
    const hit = projs.filter(([c, name]) => !q || (name + ' ' + c).toLowerCase().includes(q));
    listEl.innerHTML = (hit.length ? hit.map(rowHtml).join('') : '<div class="lf-empty">Aucun projet — utilise « Autre dossier… »</div>') + customRow;
    if (!hit.some(([c]) => c === selected) && selected !== '__custom') selected = hit.length ? hit[0][0] : '__custom';
    $$('#lf-proj-list .lf-pick').forEach((el) => {
      el.classList.toggle('sel', el.dataset.cwd === selected);
      el.addEventListener('click', () => { selected = el.dataset.cwd; toggleCustom(); renderList(); });
    });
    cwd.style.display = selected === '__custom' ? 'block' : 'none';
  };
  const toggleCustom = () => { if (selected === '__custom') setTimeout(() => cwd.focus(), 0); };
  search.addEventListener('input', renderList);
  renderList();

  $('#lf-go').addEventListener('click', () => {
    const dir = selected === '__custom' ? cwd.value.trim() : selected;
    const status = $('#lf-status');
    if (!dir) { status.textContent = '✗ choisis un projet ou un dossier'; status.className = 'reply-status err'; return; }
    launch({ cwd: dir, prompt: $('#lf-prompt').value.trim(), model: $('#lf-model').value, effort: $('#lf-effort').value }, '#lf-status', '#lf-go');
  });
}

function openResumeModal(r) {
  $('#modal-body').innerHTML = `
    <h2 style="margin:0 0 4px">▶ Reprendre la session</h2>
    <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 16px">
      Relance <code>claude --resume …</code> dans <code>${esc(r.project || r.projectName || '?')}</code>
      (session <b>tmux</b> détachée, abonnement, <b>zéro conso token</b>). Modèle/effort optionnels —
      laisse « défaut » pour garder la config d'origine.</p>
    <div class="lf-resume-title">📄 ${esc(r.title || r.id)}</div>
    ${modelEffortHtml()}
    <label class="lf-label">Message à envoyer <span style="color:var(--muted);font-weight:400">(optionnel)</span></label>
    <textarea id="lf-prompt" class="lf-input" rows="3" placeholder="Laisse vide pour juste rouvrir la session…"></textarea>
    <div class="lf-actions">
      <button id="lf-go" class="reply-send">Reprendre ↗</button>
      <div id="lf-status" class="reply-status"></div>
    </div>`;
  $('#modal').classList.remove('hidden');
  $('#lf-go').addEventListener('click', () => {
    launch({ resumeId: r.id, prompt: $('#lf-prompt').value.trim(), model: $('#lf-model').value, effort: $('#lf-effort').value }, '#lf-status', '#lf-go');
  });
}

async function launch(payload, statusSel, btnSel) {
  const btn = btnSel ? $(btnSel) : null;
  if (btn) btn.disabled = true;
  const status = statusSel ? $(statusSel) : null;
  if (status) { status.textContent = 'lancement…'; status.className = 'reply-status'; }
  try {
    const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      showLaunchResult(d);
      setTimeout(tick, 1200);
    } else {
      const msg = '✗ ' + (d.error || 'échec');
      if (status) { status.textContent = msg; status.className = 'reply-status err'; }
      else alert(msg);
    }
  } catch (e) {
    const msg = '✗ ' + (e.message || 'erreur réseau');
    if (status) { status.textContent = msg; status.className = 'reply-status err'; }
    else alert(msg);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function stopSession(btn) {
  const id = btn.dataset.id;
  if (!confirm('Stopper cette session ? Le pane tmux où tourne Claude sera fermé.')) return;
  btn.disabled = true; btn.textContent = '⏳ arrêt…';
  try {
    const r = await fetch('/api/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) { btn.textContent = '✓ stoppée'; setTimeout(tick, 800); }
    else { btn.disabled = false; btn.textContent = '⏹ Stopper'; alert('✗ ' + (d.error || 'échec')); }
  } catch (e) {
    btn.disabled = false; btn.textContent = '⏹ Stopper'; alert('✗ ' + (e.message || 'erreur réseau'));
  }
}

function showLaunchResult(d) {
  $('#modal-body').innerHTML = `
    <h2 style="margin:0 0 10px">✓ Session ${d.resume ? 'reprise' : 'lancée'}</h2>
    <p style="color:var(--muted);font-size:12.5px;line-height:1.6;margin:0 0 14px">
      <code>claude${d.resume ? ' --resume ' + esc(d.resume.slice(0, 8)) + '…' : ''}</code> tourne dans la session tmux
      <b>${esc(d.tmux)}</b><br>dossier <code>${esc(d.cwd)}</code>. Attache-toi :</p>
    <div class="attach-row">
      <code id="attach-cmd">${esc(d.attach)}</code>
      <button id="attach-copy" class="reply-send">Copier</button>
    </div>
    <p style="color:var(--muted);font-size:12px;margin:14px 0 0">
      Elle apparaîtra dans la liste dès le premier évènement de hook — tu pourras alors répondre directement depuis l'UI.</p>`;
  $('#modal').classList.remove('hidden');
  const cp = $('#attach-copy');
  cp.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(d.attach); cp.textContent = '✓ copié'; }
    catch (_) { cp.textContent = 'copie manuelle'; }
  });
}

// ---------- boot ----------
connectSSE();
(async () => { await loadSessions(); showOverview(); })();
setInterval(() => { if ($('.tab.active').dataset.view === 'sessions') tick(); }, 5000);
