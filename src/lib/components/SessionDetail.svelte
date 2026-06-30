<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, loadSessions, openModal, sessionTitle, renameSession, toggleFocus } from '$lib/state.svelte.js';
  import { getSession, kill, setMode, setModelEffort, openInVscode, openInGhostty, fork, showInPane, killPane } from '$lib/api.js';
  import { STATE_LABEL, fmtCost, fmtTokens, fmtDuration, ago, shortModel, prLabel, PERMISSION_MODES, modeLabel, modeMeta, modelAlias } from '$lib/format.js';
  import ModelEffort from './ModelEffort.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Composer from './Composer.svelte';
  import Changes from './Changes.svelte';
  import Subagents from './Subagents.svelte';
  import Todos from './Todos.svelte';
  import Terminal from './Terminal.svelte';
  import { TERM_THEMES, DEFAULT_TERM_THEME, TERM_FONTS, DEFAULT_TERM_FONT } from '$lib/terminalThemes.js';

  let { id } = $props();
  let s = $state(null);          // détail de session
  let tab = $state('chat');
  let termPane = $state(null);   // pane « show » courant affiché dans l'onglet Terminal
  let termInteractive = $state(true);  // onglet Terminal : interactif (frappes → tmux) par défaut
  let termFit = $state(true);          // adapter le pane tmux à la place dispo dans la vue web
  let termTheme = $state(DEFAULT_TERM_THEME); // thème xterm choisi (persisté en localStorage)
  let termFont = $state(DEFAULT_TERM_FONT);   // police choisie (persistée)
  // restaure les préférences mémorisées ; chacune persiste à son changement.
  onMount(() => {
    try {
      const v = localStorage.getItem('hooked.termTheme'); if (v && TERM_THEMES[v]) termTheme = v;
      const f = localStorage.getItem('hooked.termFont'); if (f && TERM_FONTS[f]) termFont = f;
      const it = localStorage.getItem('hooked.termInteractive'); if (it != null) termInteractive = it === '1';
      const ft = localStorage.getItem('hooked.termFit'); if (ft != null) termFit = ft === '1';
    } catch (_) {}
  });
  $effect(() => { try { localStorage.setItem('hooked.termTheme', termTheme); } catch (_) {} });
  $effect(() => { try { localStorage.setItem('hooked.termFont', termFont); } catch (_) {} });
  $effect(() => { try { localStorage.setItem('hooked.termInteractive', termInteractive ? '1' : '0'); } catch (_) {} });
  $effect(() => { try { localStorage.setItem('hooked.termFit', termFit ? '1' : '0'); } catch (_) {} });
  const termThemeObj = $derived((TERM_THEMES[termTheme] || TERM_THEMES[DEFAULT_TERM_THEME]).theme);
  const termFontFamily = $derived((TERM_FONTS[termFont] || TERM_FONTS[DEFAULT_TERM_FONT]).family);
  let body;                      // ref .pane-body (conteneur scrollable)
  let composer;                  // ref Composer (pour déclencher interruption + édition via Échap)
  let lastActivity = null;
  let stopping = $state(false);
  let attachCopied = $state(false);
  // changement de mode de permission (Normal / Auto-edits / Plan) via Maj+Tab dans le pane.
  let modeBusy = $state(false);
  let modeStatus = $state('');
  let modeOverride = $state(null);  // mode visé en optimiste, tant que les hooks ne le reflètent pas

  // mode affiché : choix optimiste sinon mode réel remonté par les hooks (défaut : Normal).
  const modeView = $derived(modeOverride || (s && s.permissionMode) || 'default');
  // messages envoyés en attente d'apparaître dans le transcript (file d'attente, comme le CLI).
  let queued = $state([]);
  let forceBottom = false;          // force le scroll en bas au prochain rendu (envoi d'un message)

  const events = $derived(s ? (s.events || []).slice().reverse() : []);
  const shownPanes = $derived(s ? (s.shownPanes || []) : []);

  // Liste des terminaux de l'onglet : le pane Claude Code lui-même (si son tmux est vivant) +
  // les panes « show » ouverts par un agent. Le pane Claude est toujours en tête.
  const terminals = $derived.by(() => {
    const list = [];
    if (s && s.tmuxAlive && s.tmuxPane) list.push({ pane: s.tmuxPane, label: 'Claude Code', kind: 'claude' });
    for (const p of shownPanes) list.push({ pane: p.pane, label: p.command || 'shell', kind: 'show', target: p.target });
    return list;
  });

  let wantPane = $state(null); // pane à sélectionner dès qu'il apparaît (après « + Pane »)
  // pane Terminal sélectionné : le pane qu'on vient d'ouvrir dès qu'il arrive, sinon le pane « show »
  // le plus récent (un agent a voulu montrer qqch), sinon le pane Claude. Rebascule si le courant part.
  $effect(() => {
    const list = terminals;
    if (!list.length) { if (termPane !== null) untrack(() => (termPane = null)); return; }
    if (wantPane && list.some((t) => t.pane === wantPane)) { untrack(() => { termPane = wantPane; wantPane = null; }); return; }
    if (!list.some((t) => t.pane === termPane)) {
      const def = shownPanes.length ? shownPanes[shownPanes.length - 1].pane : list[0].pane;
      untrack(() => (termPane = def));
    }
  });

  // ouvre un nouveau pane shell dans le tmux de la session, puis bascule dessus.
  let paneBusy = $state(false);
  async function newPane() {
    if (!s || paneBusy) return;
    paneBusy = true;
    const res = await showInPane(s.id, '', 'window').catch((e) => ({ ok: false, data: { error: e.message } }));
    paneBusy = false;
    if (res.ok && res.data.pane) { wantPane = res.data.pane; tab = 'terminal'; setTimeout(() => { loadSessions(); ui.tick++; }, 250); }
    else if (!res.ok) alert('✗ ' + (res.data.error || 'échec'));
  }
  // ferme un pane « show » (✕).
  async function closePane(pane) {
    if (paneBusy) return;
    paneBusy = true;
    const res = await killPane(pane).catch((e) => ({ ok: false, data: { error: e.message } }));
    paneBusy = false;
    if (res.ok) setTimeout(() => { loadSessions(); ui.tick++; }, 250);
    else alert('✗ ' + (res.data.error || 'échec'));
  }

  // indicateur 5 h compact pour la ligne de stats : valeur réelle (statusline) sinon estimation.
  const stat5h = $derived.by(() => {
    if (!s) return null;
    const rl = s.rateLimit && s.rateLimit.fiveHour;
    if (rl && rl.pct != null) {
      return { pct: rl.pct, est: false, title: 'Rate limit de session 5 h (réel)' + (rl.resetInMin != null ? ` — réinitialise dans ${fmtDuration(rl.resetInMin)}` : '') };
    }
    if (s.usage5h) {
      const u = s.usage5h;
      return { pct: u.pct, est: true, title: `Estimation 5 h : ${fmtCost(u.cost)} / ${fmtCost(u.budget)}` + (u.resetInMin != null ? ` — réinitialise dans ${fmtDuration(u.resetInMin)}` : '') };
    }
    return null;
  });

  async function load(isRefresh) {
    let prevScroll = null, wasAtBottom = false;
    if (isRefresh && body) {
      prevScroll = body.scrollTop;
      wasAtBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 60;
    }
    let d;
    try { d = await getSession(id); } catch (_) { return; }
    s = d;
    lastActivity = d.lastActivity || null;
    // les hooks reflètent enfin le mode visé → on lâche le choix optimiste.
    if (modeOverride && d.permissionMode === modeOverride) modeOverride = null;
    // un message en file disparaît dès qu'il apparaît comme bulle user dans le transcript.
    if (queued.length) {
      const userTexts = new Set((d.messages || []).filter((m) => m.role === 'user').map((m) => (m.text || '').trim()));
      queued = queued.filter((q) => !userTexts.has(q.text.trim()));
    }
    await tick();
    // ancre #msg-<ts> (depuis la page Recherche) : scroll vers la bulle ciblée
    // au premier load, court-circuite le scroll auto en bas.
    if (!isRefresh && scrollToHashMsg()) return;
    const keepPos = isRefresh && !wasAtBottom && !forceBottom && prevScroll != null;
    forceBottom = false;
    if (body) body.scrollTop = keepPos ? prevScroll : body.scrollHeight;
  }

  // localise la bulle dont data-msg-ts correspond à l'ancre URL #msg-<ts encodé> et
  // scroll dessus + flash. Renvoie true si une cible a été trouvée et déclenchée.
  function scrollToHashMsg() {
    if (typeof window === 'undefined') return false;
    const h = window.location.hash || '';
    const m = h.match(/^#msg-(.+)$/);
    if (!m) return false;
    let ts;
    try { ts = decodeURIComponent(m[1]); } catch (_) { return false; }
    const root = body || document;
    const el = root.querySelector(`.bubble[data-msg-ts="${ts.replace(/"/g, '\\"')}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.classList.remove('flash');
    void el.offsetWidth; // force reflow → ré-arme l'animation
    el.classList.add('flash');
    return true;
  }

  // appelé par le Composer juste après un envoi réussi : affiche le message en file et scroll en bas.
  async function onSent(t) {
    queued = [...queued, { text: t, ts: new Date().toISOString() }];
    forceBottom = true;
    await tick();
    if (body) body.scrollTop = body.scrollHeight;
  }

  onMount(() => load(false));

  // Retour sur l'onglet Conversation : re-scroll en bas. Les sous-onglets partagent le même
  // conteneur scrollable (.pane-body) → en revenant du Terminal/Fichiers, il gardait la position
  // de l'onglet précédent et on ne voyait pas le dernier message. On ne scrolle qu'à la TRANSITION
  // vers « chat » (pas au montage initial, déjà géré par load()).
  let prevTab = 'chat';
  $effect(() => {
    const t = tab;
    if (t === 'chat' && prevTab !== 'chat') {
      tick().then(() => { if (body) body.scrollTop = body.scrollHeight; });
    }
    prevTab = t;
  });

  // Échap dans la vue chat (hors textarea — le composer gère lui-même quand il a le focus) :
  // interrompt Claude et recharge le dernier prompt pour l'éditer, comme dans le CLI claude-code.
  function onWindowKey(e) {
    if (e.key !== 'Escape' || tab !== 'chat' || ui.modal) return;
    if (e.target && e.target.id === 'reply-text') return; // déjà géré par le composer focalisé
    if (!composer) return;
    e.preventDefault();
    composer.interruptEdit();
  }
  onMount(() => { window.addEventListener('keydown', onWindowKey); });
  onDestroy(() => { window.removeEventListener('keydown', onWindowKey); });

  // live : sur chaque tick, refetch ciblé (question (dis)paraît, ou chat actif qui bouge)
  $effect(() => {
    ui.tick; // dépendance
    untrack(() => {
      const sess = data.sessions.find((x) => x.id === id);
      if (!sess || !s) return;
      const cardShown = !!s.pendingQuestion;
      const qChanged = (sess.hasQuestion && !cardShown) || (!sess.hasQuestion && cardShown);
      const activityChanged = sess.lastActivity && sess.lastActivity !== lastActivity;
      // session live : on recharge aussi pour capter l'arrivée/fermeture des panes « show »
      // (panes.jsonl déclenche un tick) → l'onglet Terminal apparaît/disparaît tout seul.
      if (qChanged || (tab === 'chat' && (sess.state === 'working' || activityChanged)) || s.tmuxAlive) load(true);
    });
  });

  function resume() {
    ui.modal = { type: 'resume', data: { id: s.id, project: s.project, projectName: s.projectName, title: s.title, model: s.launchModel || modelAlias(s.model), effort: s.effort } };
  }

  // Renommage local de la session (titre custom, persisté côté navigateur comme les pins).
  // Champ vidé → on retire la surcharge et on retombe sur le titre auto.
  let renaming = $state(false);
  let renameVal = $state('');
  function startRename() { renameVal = sessionTitle(s); renaming = true; }
  function commitRename() { if (!renaming) return; renaming = false; renameSession(s.id, renameVal); }

  // Fork avancé : ouvre la modale (choix modèle/effort + message immédiat optionnel) qui
  // crée une branche indépendante (copie du transcript jusqu'à ce message) et la reprend.
  function openFork(m) {
    const snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (m.role === 'user' ? '(message)' : '(activité outils)');
    ui.modal = { type: 'fork', data: {
      id: s.id, forkUuid: m.forkUuid, role: m.role, snippet,
      project: s.project, projectName: s.projectName, title: s.title,
      model: s.launchModel || modelAlias(s.model), effort: s.effort,
    } };
  }

  // Fork express en 1 clic : forke SANS aucune saisie ni modale (modèle/effort de la session
  // courante, message vide) et reprend la branche en tmux détaché — elle attend. Retour inline
  // sur la bulle ; la nouvelle session apparaît ensuite toute seule dans la sidebar.
  let forkState = $state(null); // { uuid, phase: 'busy'|'done'|'err', text }
  async function quickFork(m) {
    if (!m.forkUuid || forkState?.phase === 'busy') return;
    forkState = { uuid: m.forkUuid, phase: 'busy', text: '⑂ fork…' };
    const payload = { id: s.id, forkUuid: m.forkUuid, prompt: '', model: s.launchModel || modelAlias(s.model), effort: s.effort };
    const res = await fork(payload).catch((e) => ({ ok: false, data: { error: e?.message || 'échec' } }));
    if (res.ok) {
      forkState = { uuid: m.forkUuid, phase: 'done', text: '✓ branche créée → ' + (res.data?.tmux || 'tmux') };
      setTimeout(() => { loadSessions(); ui.tick++; }, 1000);
      setTimeout(() => { if (forkState?.uuid === m.forkUuid && forkState.phase === 'done') forkState = null; }, 5000);
    } else {
      forkState = { uuid: m.forkUuid, phase: 'err', text: '✗ ' + (res.data?.error || 'échec') };
      setTimeout(() => { if (forkState?.uuid === m.forkUuid && forkState.phase === 'err') forkState = null; }, 6000);
    }
  }

  // changement à chaud du modèle / de l'effort d'une session live (envoie /model et /effort
  // dans le TUI). État local synchronisé sur les vraies valeurs tant qu'on n'édite pas.
  let editModel = $state('');
  let editEffort = $state('');
  let meBusy = $state(false);
  let meStatus = $state('');
  $effect(() => {
    if (!s || meBusy) return;
    // launchModel (persisté, reflète notre dernier /model) prioritaire ; sinon modèle du transcript.
    const m = s.launchModel || modelAlias(s.model) || 'opus';
    const e = s.effort || 'high';
    untrack(() => { editModel = m; editEffort = e; });
  });
  async function applyModelEffort() {
    if (meBusy) return;
    meBusy = true;
    meStatus = '…';
    const res = await setModelEffort(s.id, editModel, editEffort).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      meStatus = '✓ ' + editModel + ' · ' + editEffort;
      setTimeout(() => { meStatus = ''; }, 2500);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      meStatus = '✗ ' + (res.data.error || 'échec');
      setTimeout(() => { meStatus = ''; }, 3500);
    }
    meBusy = false;
  }
  async function stop() {
    if (!confirm('Stopper cette session ? Le pane tmux où tourne Claude sera fermé.')) return;
    stopping = true;
    const res = await kill(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) { setTimeout(() => { loadSessions(); ui.tick++; }, 800); }
    else { stopping = false; alert('✗ ' + (res.data.error || 'échec')); }
  }
  async function switchMode(target) {
    if (modeBusy || modeView === target) return;
    modeBusy = true;
    modeStatus = '…';
    const res = await setMode(s.id, target).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      modeOverride = res.data.mode || target;  // mode réellement atteint, vérifié côté serveur
      modeStatus = '✓ ' + modeLabel(modeOverride);
      setTimeout(() => { modeStatus = ''; }, 2000);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      modeStatus = '✗ ' + (res.data.error || 'échec');
      setTimeout(() => { modeStatus = ''; }, 3000);
    }
    modeBusy = false;
  }
  async function copyAttach() {
    try { await navigator.clipboard.writeText(s.tmuxAttach); attachCopied = true; setTimeout(() => (attachCopied = false), 1500); } catch (_) {}
  }
  let vscodeBusy = $state(false);
  async function openVscode() {
    if (vscodeBusy) return;
    vscodeBusy = true;
    const res = await openInVscode(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!res.ok) alert('✗ ' + (res.data.error || 'échec'));
    vscodeBusy = false;
  }
  let ghosttyBusy = $state(false);
  async function openGhostty() {
    if (ghosttyBusy) return;
    ghosttyBusy = true;
    const res = await openInGhostty(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!res.ok) alert('✗ ' + (res.data.error || 'échec'));
    ghosttyBusy = false;
  }
</script>

{#if s}
  <div class="pane-head s-{s.state}">
    <div class="card-top" style="cursor:default;margin-bottom:6px">
      <button class="pane-back" onclick={() => goto('/')} title="Retour à la liste">←</button>
      <span class="proj">{s.projectName || '?'}</span>
      {#if s.gitBranch}<span class="branch">{s.gitBranch}</span>{/if}
      {#if s.tmuxAlive}
        <span class="ro-tag live">↩ réponse possible</span>
        <button class="stop-btn" disabled={stopping} onclick={stop}>{stopping ? '⏳ arrêt…' : '⏹ Stopper'}</button>
        {#if s.tmuxAttach}
          <button class="attach-btn" title={s.tmuxAttach} onclick={copyAttach}>{attachCopied ? '✓ copié' : '⧉ Copier attach'}</button>
        {/if}
      {:else if s.tmuxPane}
        <span class="ro-tag">⛔ tmux fermé · un message relance</span>
        <button class="resume-btn" onclick={resume}>▶ Reprendre dans tmux</button>
      {:else}
        <span class="ro-tag">lecture seule</span>
        <button class="resume-btn" onclick={resume}>▶ Reprendre dans tmux</button>
      {/if}
      <button class="vscode-btn" style="margin-left:auto" disabled={vscodeBusy} onclick={openVscode} title="Ouvrir le projet entier dans VS Code">{vscodeBusy ? '⏳' : '⧉'} Open in VS Code</button>
      <button class="vscode-btn" disabled={ghosttyBusy} onclick={openGhostty} title="Ouvrir la session dans Ghostty (attache le tmux si vivant)">{ghosttyBusy ? '⏳' : '⧉'} Open in Ghostty</button>
      <button class="vscode-btn" class:on={ui.focus} onclick={toggleFocus} title="Mode focus : discussion plein écran (sidebar + header repliés)">⛶ {ui.focus ? 'Quitter' : 'Focus'}</button>
      <span class="badge s-badge"><span class="bdot"></span>{STATE_LABEL[s.state] || s.state}</span>
    </div>
    {#if renaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="sess-rename" autofocus bind:value={renameVal}
             placeholder={s.title || 'Titre de la session'}
             onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = false; }}
             onblur={commitRename} />
    {:else}
      <h2 class="sess-title" style="margin:6px 0 0">{sessionTitle(s)}
        <button class="sess-rename-btn" title="Renommer cette session (local)" aria-label="Renommer" onclick={startRename}>✎</button>
        {#if ui.names[s.id]}<button class="sess-rename-btn" title="Rétablir le titre auto" aria-label="Titre auto" onclick={() => renameSession(s.id, '')}>↺</button>{/if}
      </h2>
    {/if}
    {#if s.tmuxAlive}
      {@const cur = modeMeta(modeView)}
      <div class="head-toolbar">
        <div class="tb-group" title="Mode de permission de Claude (Maj+Tab dans la session)">
          {#if !PERMISSION_MODES.some((m) => m.key === modeView)}
            <span class="mode-now mode-{modeView}" title={cur.title}><span class="mode-ico">{cur.icon}</span>{cur.label}</span>
          {/if}
          {#each PERMISSION_MODES as m}
            <button class="mode-chip" class:active={modeView === m.key} disabled={modeBusy}
                    onclick={() => switchMode(m.key)} title={m.title}>
              <span class="mode-ico">{m.icon}</span>{m.label}
            </button>
          {/each}
          {#if modeStatus}<span class="mode-status">{modeStatus}</span>{/if}
        </div>
        <span class="tb-sep"></span>
        <div class="tb-group" title="Modèle et effort de la session — applique /model et /effort dans le TUI">
          <ModelEffort compact bind:model={editModel} bind:effort={editEffort} onchange={applyModelEffort} disabled={meBusy} />
          {#if meStatus}<span class="mode-status">{meStatus}</span>{/if}
        </div>
      </div>
    {/if}
    <div class="head-stats" onclick={() => openModal('cost')} title="Voir le détail du coût estimé">
      <span><b>{fmtCost(s.cost)}</b>{#if s.subagentCost > 0} <span class="hs-sub">(dont {fmtCost(s.subagentCost)} agents)</span>{/if}</span>
      <span class="hs-dot">·</span><span>{s.userPrompts} prompts</span>
      <span class="hs-dot">·</span><span>{fmtTokens(s.usage.output)} out</span>
      <span class="hs-dot">·</span><span>{fmtTokens(s.usage.cacheRead)} cache</span>
      {#if !s.tmuxAlive && s.model}<span class="hs-dot">·</span><span>{shortModel(s.model)}</span>{/if}
      {#if stat5h && stat5h.pct != null}
        <span class="hs-dot">·</span>
        <span class="hs-5h" class:warn={stat5h.pct >= 75} class:full={stat5h.pct >= 95} title={stat5h.title}>⏳ {stat5h.pct}%{#if stat5h.est} est.{/if}</span>
      {/if}
      {#if s.prLinks && s.prLinks.length}
        {#each s.prLinks as l}
          <span class="hs-dot">·</span>
          <a class="hs-pr" href={l} target="_blank" rel="noopener" title={l} onclick={(e) => e.stopPropagation()}>🔗 {prLabel(l)}</a>
        {/each}
      {/if}
      <span class="hs-more">›</span>
    </div>
    <div class="subtabs">
      <button class="subtab" class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>💬 Conversation <span class="count">{(s.messages || []).length}</span></button>
      <button class="subtab" class:active={tab === 'changes'} onclick={() => (tab = 'changes')}>📝 Fichiers <span class="count">{(s.changes || []).length}</span></button>
      {#if (s.todos || []).length}
        <button class="subtab" class:active={tab === 'todos'} onclick={() => (tab = 'todos')}>✅ Tâches <span class="count">{(s.todos || []).length}</span></button>
      {/if}
      <button class="subtab" class:active={tab === 'subagents'} onclick={() => (tab = 'subagents')}>🤖 Sous-agents <span class="count">{(s.subagents || []).length}</span></button>
      <button class="subtab" class:active={tab === 'activity'} onclick={() => (tab = 'activity')}>🪝 Activité <span class="count">{events.length}</span></button>
      {#if terminals.length}
        <button class="subtab" class:active={tab === 'terminal'} onclick={() => (tab = 'terminal')}>🖥 Terminal <span class="count">{terminals.length}</span></button>
      {/if}
    </div>
  </div>

  <div class="pane-body" bind:this={body}>
    <div class="pane" class:active={tab === 'chat'}>
      <div class="chat">
        {#if (s.messages || []).length}
          {#each s.messages as m, i (m.ts + ':' + i)}<ChatBubble {m} onfork={quickFork} onforkadvanced={openFork} {forkState} />{/each}
        {:else if !queued.length}
          <div class="pane-empty">Conversation vide.</div>
        {/if}
        {#each queued as q (q.ts)}
          <div class="bubble user queued">
            <div class="who">🧑 Toi <span class="t">⏳ en file d'attente</span></div>
            <div class="md">{q.text}</div>
          </div>
        {/each}
      </div>
      {#if s.pendingQuestion}<Question {id} pq={s.pendingQuestion} />{/if}
      {#if s.tmuxPane}
        <Composer bind:this={composer} {id} alive={s.tmuxAlive} project={s.project}
                  resumeModel={s.launchModel} resumeEffort={s.effort} lastPrompt={s.lastPrompt || ''} {onSent} />
      {/if}
    </div>

    <div class="pane" class:active={tab === 'changes'}>
      <div class="changes"><Changes changes={s.changes || []} /></div>
    </div>

    <div class="pane" class:active={tab === 'subagents'}>
      <div class="changes"><Subagents subagents={s.subagents || []} session={id} /></div>
    </div>

    <div class="pane" class:active={tab === 'todos'}>
      <Todos todos={s.todos || []} />
    </div>

    <div class="pane" class:active={tab === 'terminal'}>
      {#if terminals.length}
        <div class="term-bar">
          <div class="term-tabs">
            {#each terminals as t (t.pane)}
              <div class="term-chip" class:active={termPane === t.pane} class:claude={t.kind === 'claude'}>
                <button class="term-tab" onclick={() => (termPane = t.pane)} title={t.label}>
                  {t.kind === 'claude' ? '🤖' : t.target === 'window' ? '🗔' : '▦'} {t.label.slice(0, 32)}
                </button>
                {#if t.kind === 'show'}
                  <button class="term-x" title="Fermer ce pane" disabled={paneBusy} onclick={() => closePane(t.pane)}>✕</button>
                {/if}
              </div>
            {/each}
            <button class="term-new" title="Nouveau pane shell" disabled={paneBusy || !(s && s.tmuxAlive)} onclick={newPane}>＋</button>
          </div>
          <select class="term-theme" bind:value={termFont} title="Police du terminal" aria-label="Police du terminal">
            {#each Object.entries(TERM_FONTS) as [key, f] (key)}
              <option value={key}>🔤 {f.name}</option>
            {/each}
          </select>
          <select class="term-theme" bind:value={termTheme} title="Thème de couleurs du terminal" aria-label="Thème du terminal">
            {#each Object.entries(TERM_THEMES) as [key, t] (key)}
              <option value={key}>🎨 {t.name}</option>
            {/each}
          </select>
          <button class="term-mode" class:on={termFit} onclick={() => (termFit = !termFit)}
                  title={termFit ? 'Adapter : le pane tmux remplit la vue web' : 'Taille fixe du pane tmux'}>
            {termFit ? '⤢ Adapter' : '▭ Fixe'}
          </button>
          <button class="term-mode" class:on={termInteractive} onclick={() => (termInteractive = !termInteractive)}
                  title={termInteractive ? 'Interactif : tes frappes vont au pane tmux' : 'Lecture seule : observation'}>
            {termInteractive ? '⌨ Interactif' : '👁 Lecture seule'}
          </button>
        </div>
        {#if tab === 'terminal' && termPane}
          {#key termPane + ':' + termInteractive + ':' + termFit}<Terminal pane={termPane} interactive={termInteractive} theme={termThemeObj} fontFamily={termFontFamily} fit={termFit} />{/key}
        {/if}
      {:else}
        <div class="pane-empty">Aucun terminal disponible (session tmux fermée).</div>
      {/if}
    </div>

    <div class="pane" class:active={tab === 'activity'}>
      <div class="timeline">
        {#if events.length}
          {#each events as e, i (e.ts + ':' + i)}
            <div class="ev">
              <b>{e.event}</b>{#if e.tool} <span class="tool">{e.tool}</span>{/if}{#if e.message} — {e.message.slice(0, 90)}{/if}<span class="t">{ago(e.ts)}</span>
            </div>
          {/each}
        {:else}
          <div class="empty">Pas d'évènement de hook.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
