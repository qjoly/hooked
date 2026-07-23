<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, settings, loadSessions, openModal, sessionTitle, renameSession, toggleFocus } from '$lib/state.svelte.js';
  import { getSession, kill, setMode, setModelEffort, openInVscode, openInGhostty, fork, showInPane, killPane, deleteSession } from '$lib/api.js';
  import { STATE_LABEL, fmtCost, fmtTokens, fmtDuration, shortModel, prLabel, issueLabel, PERMISSION_MODES, modeLabel, modeMeta, modelAlias } from '$lib/format.js';
  import ModelEffort from './ModelEffort.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Plan from './Plan.svelte';
  import Composer from './Composer.svelte';
  import Changes from './Changes.svelte';
  import Subagents from './Subagents.svelte';
  import SubSessions from './SubSessions.svelte';
  import PrLinks from './PrLinks.svelte';
  import IssueLinks from './IssueLinks.svelte';
  import Todos from './Todos.svelte';
  import Background from './Background.svelte';
  import Terminal from './Terminal.svelte';
  import { TERM_THEMES, DEFAULT_TERM_THEME, TERM_FONTS, DEFAULT_TERM_FONT } from '$lib/terminalThemes.js';
  import { conversationToMarkdown } from '$lib/exportConversation.js';

  let { id } = $props();
  // $state.raw (pas $state) : le détail contient un tableau `messages` de 1000+ objets profonds.
  // $state proxifie récursivement à l'affectation `s = d` → tâche synchrone de plusieurs centaines
  // de ms qui GÈLE l'UI au changement de session. On ne mute jamais un message en place (on
  // remplace `s` en entier au refetch), donc raw est correct : réactif à la réaffectation, sans
  // proxy profond. Coût de `s = d` : O(1) au lieu de O(nombre de nœuds du transcript).
  let s = $state.raw(null);      // détail de session
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
  // Fenêtrage du transcript : sur une grosse conv (1M+ tokens) monter toutes les bulles (chacune =
  // plusieurs Markdown parsés) fige l'UI, d'autant qu'un tick SSE refetch et re-diffe tout. On ne
  // rend que la QUEUE (les MSG_WINDOW derniers messages) ; « plus haut » en révèle MSG_STEP de plus.
  const MSG_WINDOW = 40;
  const MSG_STEP = 120;
  let visibleCount = $state(MSG_WINDOW);
  const msgCount = $derived((s?.messages || []).length);
  const startIdx = $derived(Math.max(0, msgCount - visibleCount));
  // changement de session (prop id, sans remount) → on repart de la queue.
  $effect(() => { id; untrack(() => { visibleCount = MSG_WINDOW; }); });
  // révèle un cran de messages plus anciens en gardant la vue ancrée (le contenu ajouté au-dessus
  // pousserait tout vers le bas sinon).
  async function showEarlier() {
    const prev = body ? body.scrollHeight : 0;
    visibleCount = Math.min(msgCount, visibleCount + MSG_STEP);
    await tick();
    if (body) body.scrollTop += body.scrollHeight - prev;
  }
  // « collé en bas » : vrai tant que l'utilisateur suit la conversation (proche du bas). Dès qu'il
  // scrolle vers le haut (lire l'historique / composer), on NE le ramène plus en bas aux ticks SSE.
  let stickToBottom = true;

  const shownPanes = $derived(s ? (s.shownPanes || []) : []);

  // Liste des terminaux de l'onglet : le pane Claude Code lui-même (si son tmux est vivant) +
  // les panes « show » ouverts par un agent. Le pane Claude est toujours en tête.
  const terminals = $derived.by(() => {
    const list = [];
    if (s && s.tmuxAlive && s.tmuxPane) list.push({ pane: s.tmuxPane, label: 'Claude Code', kind: 'claude' });
    for (const p of shownPanes) list.push({ pane: p.pane, label: p.command || 'shell', kind: 'show', target: p.target });
    return list;
  });

  // Sous-onglets du détail, ordonnés selon le réglage persistant (settings.subtabOrder) et
  // filtrés sur ceux disponibles. Le 1er de la liste devient l'onglet ouvert à l'arrivée.
  const SUBTAB_META = {
    chat:       { icon: '💬', label: 'Conversation' },
    changes:    { icon: '📝', label: 'Files' },
    todos:      { icon: '✅', label: 'Tasks' },
    subagents:  { icon: '🤖', label: 'Subagents' },
    subsessions:{ icon: '🔗', label: 'Sub-sessions' },
    background: { icon: '🌀', label: 'Background' },
    terminal:   { icon: '🖥', label: 'Terminal' },
    pr:         { icon: '🔀', label: 'PRs' },
    issues:     { icon: '🐛', label: 'Issues' },
  };
  const subtabCount = $derived({
    chat: (s?.messages || []).length,
    changes: (s?.changes || []).length,
    todos: (s?.todos || []).length,
    subagents: (s?.subagents || []).length,
    subsessions: (s?.subSessions || []).length,
    background: (s?.bgJobs || []).filter((j) => (j.status || 'running') === 'running').length,
    terminal: terminals.length,
    pr: (s?.prLinks || []).length,
    issues: (s?.issueLinks || []).length,
  });
  const subtabShown = $derived({
    chat: true, changes: true,
    todos: subtabCount.todos > 0,
    subagents: subtabCount.subagents > 0,
    subsessions: subtabCount.subsessions > 0,
    // le badge compte les jobs RUNNING (honnête), mais l'onglet reste visible tant qu'il existe des
    // jobs (running OU terminés) pour laisser accéder à l'historique « Finished ».
    background: (s?.bgJobs || []).length > 0,
    terminal: subtabCount.terminal > 0,
    pr: subtabCount.pr > 0,
    issues: subtabCount.issues > 0,
  });
  // Ordre persistant (settings.subtabOrder), PUIS toute clé connue absente de l'ordre sauvegardé
  // (migration : un réglage antérieur à un nouveau sous-onglet — ex. `background` — le verrait
  // sinon jamais, car on itère l'ordre persistant). On complète à la fin, seulement si disponible.
  const orderedSubtabs = $derived.by(() => {
    const order = settings.subtabOrder || [];
    const hidden = new Set(settings.subtabHidden || []);
    const keys = [...order.filter((k) => SUBTAB_META[k]), ...Object.keys(SUBTAB_META).filter((k) => !order.includes(k))];
    // masqué manuellement (réglages) sauf 'chat', EN PLUS de l'auto-masquage quand vide (subtabShown).
    return keys.filter((k) => subtabShown[k] && (k === 'chat' || !hidden.has(k))).map((k) => ({ key: k, ...SUBTAB_META[k], count: subtabCount[k] }));
  });
  // Ouvre le 1er onglet disponible selon l'ordre configuré (une seule fois, dès que s est chargé).
  let tabInit = false;
  $effect(() => {
    const first = orderedSubtabs[0];
    if (tabInit || !s || !first) return;
    untrack(() => { tab = first.key; tabInit = true; });
  });

  // Lazy-mount des sous-onglets. Svelte monte TOUS les panes (les inactifs sont seulement masqués
  // en CSS) → l'onglet Fichiers (jusqu'à des dizaines de diffs Pierre = coloration TextMate lourde)
  // se rendait à CHAQUE ouverture de session, même invisible → gel ~600 ms au changement de session.
  // On ne monte le contenu d'un pane qu'une fois son onglet visité, puis on le garde (retour instantané).
  let seen = $state({});
  $effect(() => { const t = tab; if (t && !seen[t]) untrack(() => { seen = { ...seen, [t]: true }; }); });

  // Footer « working » live : tant que la session travaille, le transcript ne reçoit pas de
  // nouvelle bulle avant le flush du message → la conversation paraît figée. On affiche donc,
  // sous la dernière bulle, le verbe d'activité (s.activity) + un temps écoulé. L'écoulé est
  // ancré côté client au moment où l'on OBSERVE l'état working (workingSince) et rafraîchi par
  // une horloge locale à la seconde ; il disparaît dès que l'état quitte « working ».
  let workingSince = $state(null);
  let nowMs = $state(Date.now());
  $effect(() => {
    const working = s?.state === 'working';  // dep suivie lue AVANT toute garde (piège Svelte 5)
    if (!working) { if (workingSince !== null) untrack(() => { workingSince = null; }); return; }
    untrack(() => { if (workingSince === null) workingSince = Date.now(); });
  });
  onMount(() => {
    const iv = setInterval(() => { nowMs = Date.now(); }, 1000);
    return () => clearInterval(iv);
  });
  // écoulé compact : « 12s » puis « 2m7s ». Vide tant qu'on n'a pas d'ancre.
  const workElapsed = $derived.by(() => {
    if (!workingSince) return '';
    const sec = Math.max(0, Math.floor((nowMs - workingSince) / 1000));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  });

  // Proposition de suivi : un tour qui se termine sans question/plan en attente se clôt souvent sur
  // une offre (« Dis-moi si je le fais », une commande, un next step). On la surface au-dessus du
  // composer pour la reprendre en 1 clic. Heuristique : dernier paragraphe du dernier message
  // assistant. ponytail: heuristique volontaire, pas un parseur de « proposition ».
  let dismissedFollowup = $state(null); // proposition masquée localement (revient si le texte change)
  const followup = $derived.by(() => {
    if (!s || s.state === 'working' || s.pendingQuestion || s.pendingPlan || !s.tmuxPane) return null;
    const msgs = s.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant' || !last.text) return null;
    const paras = last.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let snippet = paras[paras.length - 1] || last.text.trim();
    if (snippet.length > 400) snippet = '…' + snippet.slice(-400).replace(/^\S+\s/, '');
    return snippet;
  });
  const showFollowup = $derived(followup && followup !== dismissedFollowup && !queued.length);
  async function takeFollowup() {
    if (!composer || !followup) return;
    tab = 'chat';
    await tick();
    composer.prefill(followup);
  }

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
    else if (!res.ok) alert('✗ ' + (res.data.error || 'failed'));
  }
  // ferme un pane « show » (✕).
  async function closePane(pane) {
    if (paneBusy) return;
    paneBusy = true;
    const res = await killPane(pane).catch((e) => ({ ok: false, data: { error: e.message } }));
    paneBusy = false;
    if (res.ok) setTimeout(() => { loadSessions(); ui.tick++; }, 250);
    else alert('✗ ' + (res.data.error || 'failed'));
  }

  // indicateur 5 h compact pour la ligne de stats : valeur réelle (statusline) sinon estimation.
  const stat5h = $derived.by(() => {
    if (!s) return null;
    const rl = s.rateLimit && s.rateLimit.fiveHour;
    if (rl && rl.pct != null) {
      return { pct: rl.pct, est: false, title: '5 h session rate limit (actual)' + (rl.resetInMin != null ? ` — resets in ${fmtDuration(rl.resetInMin)}` : '') };
    }
    if (s.usage5h) {
      const u = s.usage5h;
      return { pct: u.pct, est: true, title: `5 h estimate: ${fmtCost(u.cost)} / ${fmtCost(u.budget)}` + (u.resetInMin != null ? ` — resets in ${fmtDuration(u.resetInMin)}` : '') };
    }
    return null;
  });

  // Visibilité des éléments de la barre de statut. Lire settings.statusBar AVANT tout guard
  // (règle réactivité Svelte 5 : une dépendance derrière un court-circuit n'est pas suivie).
  const sb = $derived(settings.statusBar || {});
  // Ordre d'affichage des éléments de la barre de statut (réorganisable dans les réglages, comme
  // les sous-onglets). Le conteneur .head-stats est flex → on pose `order:` sur chaque élément.
  // Lu AVANT toute garde (règle réactivité Svelte 5). Clé inconnue → ordre élevé (rejetée en fin).
  const sbOrder = $derived(settings.statusBarOrder || []);
  const sbOrd = (k) => { const i = sbOrder.indexOf(k); return i === -1 ? 90 : i; };

  async function load(isRefresh) {
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
    // deep-link #msg-<ts> (page Recherche) : la cible peut être hors fenêtre → tout rendre une fois
    // pour que scrollToHashMsg la trouve.
    if (!isRefresh && typeof window !== 'undefined' && (window.location.hash || '').startsWith('#msg-'))
      visibleCount = (d.messages || []).length;
    await tick();
    // ancre #msg-<ts> (depuis la page Recherche) : scroll vers la bulle ciblée au 1er load.
    if (!isRefresh && scrollToHashMsg()) return;
    // On force le bas UNIQUEMENT si : envoi (forceBottom), 1er chargement, ou l'utilisateur suivait
    // déjà (collé en bas). Sinon on NE touche PAS à scrollTop → un lecteur scrollé vers le haut (ou en
    // train de composer) n'est JAMAIS ramené en bas par un refetch de tick SSE. (L'ancien code
    // restaurait un scrollTop capturé AVANT le fetch async → il combattait le scroll/typing en cours.)
    if (body && (forceBottom || !isRefresh || stickToBottom)) body.scrollTop = body.scrollHeight;
    forceBottom = false;
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
    // Sending free text while a question is pending dismisses it (the backend sends Escape then
    // types) → hide the card immediately; the event-driven refetch (UserPromptSubmit clears
    // liveQuestionForSession) confirms it. No-op when nothing is pending.
    // réaffectation (pas mutation en place) : `s` est en $state.raw → seule la réaffectation est réactive.
    if (s && s.pendingQuestion) s = { ...s, pendingQuestion: null };
    queued = [...queued, { text: t, ts: new Date().toISOString() }];
    forceBottom = true;
    stickToBottom = true;            // après un envoi, on re-suit la conversation
    await tick();
    if (body) body.scrollTop = body.scrollHeight;
  }

  // Revue de fichiers → on bascule sur la Conversation (pour voir la file d'attente + le statut)
  // et on délègue au Composer, qui gère l'envoi comme un message normal (alive / relance).
  async function reviewChanges(prompt) {
    tab = 'chat';
    await tick();
    if (composer) composer.sendText(prompt);
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
      stickToBottom = true;          // revenir sur Conversation = re-suivre le bas
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
      const cardShown = !!s.pendingQuestion || !!s.pendingPlan;
      const cardWanted = sess.hasQuestion || sess.hasPlan;
      const qChanged = (cardWanted && !cardShown) || (!cardWanted && cardShown);
      const activityChanged = sess.lastActivity && sess.lastActivity !== lastActivity;
      // Refetch UNIQUEMENT quand quelque chose a vraiment changé — plus de refetch aveugle à chaque
      // tick pour toute session live (c'était 1,8 MB de transcript rechargés/sec pour une session
      // juste ouverte). On recharge sur : question (dis)parue, nouvelle activité (lastActivity a
      // avancé), chat d'une session qui travaille, ou onglet Terminal actif (capter les panes « show »).
      if (qChanged || activityChanged || (tab === 'chat' && sess.state === 'working') || (tab === 'terminal' && s.tmuxAlive)) load(true);
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
    const snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (m.role === 'user' ? '(message)' : '(tool activity)');
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
    const res = await fork(payload).catch((e) => ({ ok: false, data: { error: e?.message || 'failed' } }));
    if (res.ok) {
      forkState = { uuid: m.forkUuid, phase: 'done', text: '✓ branch created → ' + (res.data?.tmux || 'tmux') };
      setTimeout(() => { loadSessions(); ui.tick++; }, 1000);
      setTimeout(() => { if (forkState?.uuid === m.forkUuid && forkState.phase === 'done') forkState = null; }, 5000);
    } else {
      forkState = { uuid: m.forkUuid, phase: 'err', text: '✗ ' + (res.data?.error || 'failed') };
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
      meStatus = '✗ ' + (res.data.error || 'failed');
      setTimeout(() => { meStatus = ''; }, 3500);
    }
    meBusy = false;
  }
  function stop() {
    openModal('confirm', {
      title: 'Stop this session?',
      message: 'The tmux pane running Claude will be closed.',
      confirmLabel: '⏹ Stop session', danger: true, onConfirm: doStop,
    });
  }
  async function doStop() {
    stopping = true;
    const res = await kill(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) { setTimeout(() => { loadSessions(); ui.tick++; }, 800); }
    else { stopping = false; alert('✗ ' + (res.data.error || 'failed')); }
  }
  let deleting = $state(false);
  function del() {
    openModal('confirm', {
      title: 'Move to trash?',
      message: 'The transcript is kept in bin/ (recoverable) and the session leaves the dashboard.',
      confirmLabel: '🗑 Move to trash', danger: true, onConfirm: doDel,
    });
  }
  async function doDel() {
    deleting = true;
    const res = await deleteSession(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) { loadSessions(); ui.tick++; goto('/'); }
    else { deleting = false; alert('✗ ' + (res.data.error || 'failed')); }
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
      modeStatus = '✗ ' + (res.data.error || 'failed');
      setTimeout(() => { modeStatus = ''; }, 3000);
    }
    modeBusy = false;
  }
  async function copyAttach() {
    try { await navigator.clipboard.writeText(s.tmuxAttach); attachCopied = true; setTimeout(() => (attachCopied = false), 1500); } catch (_) {}
  }
  // Copie le deep-link ABSOLU vers cette session (partageable / ouverture à froid). L'origine réelle
  // du navigateur est utilisée → correct quel que soit l'accès (localhost / IP LAN / MagicDNS).
  let linkCopied = $state(false);
  async function copyLink() {
    try { await navigator.clipboard.writeText(location.origin + '/session/' + s.id); linkCopied = true; setTimeout(() => (linkCopied = false), 1500); } catch (_) {}
  }
  let exportCopied = $state(false);
  async function copyExport() {
    try { await navigator.clipboard.writeText(conversationToMarkdown(s)); exportCopied = true; setTimeout(() => (exportCopied = false), 1500); } catch (_) {}
  }
  let vscodeBusy = $state(false);
  async function openVscode() {
    if (vscodeBusy) return;
    vscodeBusy = true;
    const res = await openInVscode(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!res.ok) alert('✗ ' + (res.data.error || 'failed'));
    vscodeBusy = false;
  }
  let ghosttyBusy = $state(false);
  async function openGhostty() {
    if (ghosttyBusy) return;
    ghosttyBusy = true;
    const res = await openInGhostty(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!res.ok) alert('✗ ' + (res.data.error || 'failed'));
    ghosttyBusy = false;
  }
</script>

{#if s}
  <div class="pane-head s-{s.state}">
    <div class="card-top" style="cursor:default;margin-bottom:6px">
      <button class="pane-back" onclick={() => goto('/')} title="Back to list">←</button>
      <span class="proj">{s.projectName || '?'}</span>
      {#if s.gitBranch && sb.branch !== false}<span class="branch">{s.gitBranch}</span>{/if}
      {#if sb.stateBadge !== false}<span class="badge s-badge" style="margin-left:0"><span class="bdot"></span>{s.state === 'working' && s.activity ? s.activity + '…' : (STATE_LABEL[s.state] || s.state)}</span>{/if}
      {#if s.tmuxAlive}
        <span class="ro-tag live">↩ reply available</span>
        <button class="stop-btn" disabled={stopping} onclick={stop}>{stopping ? '⏳ stopping…' : '⏹ Stop'}</button>
      {:else if s.tmuxPane}
        <span class="ro-tag">⛔ tmux closed · a message restarts it</span>
        <button class="resume-btn" onclick={resume}>▶ Resume in tmux</button>
      {:else}
        <span class="ro-tag">read-only</span>
        <button class="resume-btn" onclick={resume}>▶ Resume in tmux</button>
      {/if}
      <details class="hdr-more">
        <summary title="More actions" aria-label="More actions">⋯</summary>
        <div class="hdr-menu">
          {#if s.tmuxAlive && (sb.permissionMode !== false || sb.modelEffort !== false)}
            {@const cur = modeMeta(modeView)}
            <div class="hdr-controls">
              {#if sb.permissionMode !== false}
                <div class="hc-label">Permission mode</div>
                <div class="hc-modes">
                  {#if !PERMISSION_MODES.some((m) => m.key === modeView)}
                    <span class="mode-now mode-{modeView}" title={cur.title}><span class="mode-ico">{cur.icon}</span>{cur.label}</span>
                  {/if}
                  {#each PERMISSION_MODES as m}
                    <button class="mode-chip" class:active={modeView === m.key} disabled={modeBusy}
                            onclick={() => switchMode(m.key)} title={m.title}><span class="mode-ico">{m.icon}</span>{m.label}</button>
                  {/each}
                </div>
              {/if}
              {#if sb.modelEffort !== false}
                <div class="hc-label">Model · effort</div>
                <ModelEffort compact bind:model={editModel} bind:effort={editEffort} onchange={applyModelEffort} disabled={meBusy} />
              {/if}
              {#if modeStatus || meStatus}<div class="mode-status">{modeStatus || meStatus}</div>{/if}
            </div>
            <div class="hdr-div"></div>
          {/if}
          <button class="vscode-btn" title="Copy a shareable link that opens this session in hooked" onclick={copyLink}>{linkCopied ? '✓ copied' : '🔗 Copy link'}</button>
          {#if s.tmuxAlive && s.tmuxAttach}
            <button class="vscode-btn" title={s.tmuxAttach} onclick={copyAttach}>{attachCopied ? '✓ copied' : '⧉ Copy attach'}</button>
          {/if}
          <button class="vscode-btn" disabled={vscodeBusy} onclick={openVscode} title="Open the entire project in VS Code">{vscodeBusy ? '⏳' : '⧉'} Open in VS Code</button>
          <button class="vscode-btn" disabled={ghosttyBusy} onclick={openGhostty} title="Open the session in Ghostty (attaches tmux if alive)">{ghosttyBusy ? '⏳' : '⧉'} Open in Ghostty</button>
          <button class="vscode-btn" onclick={copyExport} title="Copy the conversation as Markdown to the clipboard">{exportCopied ? '✓ copied' : '⧉ Copy as Markdown'}</button>
          {#if sb.focusBtn !== false}<button class="vscode-btn" class:on={ui.focus} onclick={toggleFocus} title="Focus mode: full-screen conversation (sidebar + header collapsed)">⛶ {ui.focus ? 'Exit focus' : 'Focus'}</button>{/if}
          <button class="vscode-btn del-btn" disabled={deleting} onclick={del} title="Move to trash: removes from dashboard; transcript kept in bin/ (recoverable)">{deleting ? '⏳' : '🗑'} Delete</button>
        </div>
      </details>
    </div>
    {#if renaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="sess-rename" autofocus bind:value={renameVal}
             placeholder={s.title || 'Session title'}
             onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = false; }}
             onblur={commitRename} />
    {:else}
      <h2 class="sess-title" style="margin:6px 0 0">{sessionTitle(s)}
        <button class="sess-rename-btn" title="Rename this session (local)" aria-label="Rename" onclick={startRename}>✎</button>
        {#if ui.names[s.id]}<button class="sess-rename-btn" title="Restore auto title" aria-label="Auto title" onclick={() => renameSession(s.id, '')}>↺</button>{/if}
      </h2>
    {/if}
    <div class="head-stats" onclick={() => openModal('cost')} title="View estimated cost breakdown">
      {#if sb.cost !== false}<span style="order:{sbOrd('cost')}"><b>{fmtCost(s.cost)}</b>{#if s.subagentCost > 0} <span class="hs-sub">({fmtCost(s.subagentCost)} agents)</span>{/if}</span>{/if}
      {#if sb.prompts !== false}<span class="hs-dot" style="order:{sbOrd('prompts')}">·</span><span style="order:{sbOrd('prompts')}">{s.userPrompts} prompts</span>{/if}
      {#if sb.tokens !== false}<span class="hs-dot" style="order:{sbOrd('tokens')}">·</span><span style="order:{sbOrd('tokens')}">{fmtTokens(s.usage.output)} out</span><span class="hs-dot" style="order:{sbOrd('tokens')}">·</span><span style="order:{sbOrd('tokens')}">{fmtTokens(s.usage.cacheRead)} cache</span>{/if}
      {#if !s.tmuxAlive && s.model && sb.model !== false}<span class="hs-dot" style="order:{sbOrd('model')}">·</span><span style="order:{sbOrd('model')}">{shortModel(s.model)}</span>{/if}
      {#if stat5h && stat5h.pct != null && sb.usage5h !== false}
        <span class="hs-dot" style="order:{sbOrd('usage5h')}">·</span>
        <span class="hs-5h" style="order:{sbOrd('usage5h')}" class:warn={stat5h.pct >= 75} class:full={stat5h.pct >= 95} title={stat5h.title}>⏳ {stat5h.pct}%{#if stat5h.est} est.{/if}</span>
      {/if}
      {#if s.prLinks && s.prLinks.length && sb.prLinks !== false}
        {#each s.prLinks as l}
          <span class="hs-dot" style="order:{sbOrd('prLinks')}">·</span>
          <a class="hs-pr" style="order:{sbOrd('prLinks')}" href={l} target="_blank" rel="noopener" title={l} onclick={(e) => e.stopPropagation()}>🔗 {prLabel(l)}</a>
        {/each}
      {/if}
      {#if s.issueLinks && s.issueLinks.length && sb.issueLinks !== false}
        {#each s.issueLinks as l}
          <span class="hs-dot" style="order:{sbOrd('issueLinks')}">·</span>
          <a class="hs-pr" style="order:{sbOrd('issueLinks')}" href={l} target="_blank" rel="noopener" title={l} onclick={(e) => e.stopPropagation()}>🐛 {issueLabel(l)}</a>
        {/each}
      {/if}
      <span class="hs-more" style="order:99">›</span>
    </div>
    <div class="subtabs">
      {#each orderedSubtabs as st (st.key)}
        <button class="subtab" class:active={tab === st.key} onclick={() => (tab = st.key)}>{st.icon} {st.label} <span class="count">{st.count}</span></button>
      {/each}
    </div>
  </div>

  <div class="pane-body" bind:this={body}
       onscroll={() => { if (body) stickToBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 60; }}>
    <div class="pane" class:active={tab === 'chat'}>
      <div class="chat">
        {#if startIdx > 0}
          <button class="show-earlier" onclick={showEarlier}>⬆ Show earlier messages · {startIdx} hidden</button>
        {/if}
        {#if (s.messages || []).length}
          <!-- key by stable ABSOLUTE index (startIdx + j), NOT m.ts: the streaming turn's ts advances on every
               block (conversation.js rewrites prev.ts), so a ts-based key destroys+recreates the whole live bubble
               each tick → the "jumps". Transcript is append/merge-only, so a message's absolute index never moves,
               even as the render window slides → the key stays stable across MSG_STEP expansions and new ticks. -->
          {#each (s.messages || []).slice(startIdx) as m, j (startIdx + j)}<ChatBubble {m} onfork={quickFork} onforkadvanced={openFork} {forkState} />{/each}
        {:else if !queued.length}
          <div class="pane-empty">Empty conversation.</div>
        {/if}
        {#each queued as q (q.ts)}
          <div class="bubble user queued">
            <div class="who">🧑 You <span class="t">⏳ queued</span></div>
            <div class="md">{q.text}</div>
          </div>
        {/each}
        {#if s.state === 'working' && tab === 'chat'}
          <div class="working-live" title="Claude is working — new messages appear once flushed">
            <span class="wl-dots" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="wl-verb">{s.activity || 'Working'}…</span>
            {#if workElapsed}<span class="wl-sep">·</span><span class="wl-time">{workElapsed}</span>{/if}
          </div>
        {/if}
      </div>
      {#if s.pendingQuestion}<Question {id} pq={s.pendingQuestion} />{/if}
      {#if s.pendingPlan}<Plan {id} pp={s.pendingPlan} />{/if}
      {#if showFollowup}
        <div class="followup">
          <div class="fu-head">
            <span class="fu-ico">💡</span> Claude a terminé — proposition de suivi
            <button class="fu-x" title="Dismiss" aria-label="Dismiss" onclick={() => (dismissedFollowup = followup)}>✕</button>
          </div>
          <div class="fu-text">{followup}</div>
          <button class="fu-take" onclick={takeFollowup}>↵ Reprendre dans le composer</button>
        </div>
      {/if}
      {#if s.tmuxPane}
        <Composer bind:this={composer} {id} alive={s.tmuxAlive} project={s.project}
                  resumeModel={s.launchModel} resumeEffort={s.effort} lastPrompt={s.lastPrompt || ''} {onSent} />
      {/if}
    </div>

    <div class="pane" class:active={tab === 'changes'}>
      {#if seen.changes}<div class="changes"><Changes changes={s.changes || []} {id} onReview={reviewChanges} canReview={!!(s.tmuxPane)} /></div>{/if}
    </div>

    <div class="pane" class:active={tab === 'subagents'}>
      {#if seen.subagents}<div class="changes"><Subagents subagents={s.subagents || []} session={id} /></div>{/if}
    </div>

    <div class="pane" class:active={tab === 'subsessions'}>
      {#if seen.subsessions}<div class="changes"><SubSessions subSessions={s.subSessions || []} /></div>{/if}
    </div>

    <div class="pane" class:active={tab === 'pr'}>
      {#if seen.pr}<PrLinks prLinks={s.prLinks || []} />{/if}
    </div>

    <div class="pane" class:active={tab === 'issues'}>
      {#if seen.issues}<IssueLinks issueLinks={s.issueLinks || []} />{/if}
    </div>

    <div class="pane" class:active={tab === 'todos'}>
      {#if seen.todos}<Todos todos={s.todos || []} />{/if}
    </div>

    <div class="pane" class:active={tab === 'background'}>
      {#if seen.background}<Background jobs={s.bgJobs || []} session={id} />{/if}
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
                  <button class="term-x" title="Close this pane" disabled={paneBusy} onclick={() => closePane(t.pane)}>✕</button>
                {/if}
              </div>
            {/each}
            <button class="term-new" title="New shell pane" disabled={paneBusy || !(s && s.tmuxAlive)} onclick={newPane}>＋</button>
          </div>
          <select class="term-theme" bind:value={termFont} title="Terminal font" aria-label="Terminal font">
            {#each Object.entries(TERM_FONTS) as [key, f] (key)}
              <option value={key}>🔤 {f.name}</option>
            {/each}
          </select>
          <select class="term-theme" bind:value={termTheme} title="Terminal color theme" aria-label="Terminal theme">
            {#each Object.entries(TERM_THEMES) as [key, t] (key)}
              <option value={key}>🎨 {t.name}</option>
            {/each}
          </select>
          <button class="term-mode" class:on={termFit} onclick={() => (termFit = !termFit)}
                  title={termFit ? 'Fit: the tmux pane fills the web view' : 'Fixed tmux pane size'}>
            {termFit ? '⤢ Fit' : '▭ Fixed'}
          </button>
          <button class="term-mode" class:on={termInteractive} onclick={() => (termInteractive = !termInteractive)}
                  title={termInteractive ? 'Interactive: your keystrokes go to the tmux pane' : 'Read-only: observation'}>
            {termInteractive ? '⌨ Interactive' : '👁 Read-only'}
          </button>
        </div>
        {#if tab === 'terminal' && termPane}
          {#key termPane + ':' + termInteractive + ':' + termFit}<Terminal pane={termPane} interactive={termInteractive} theme={termThemeObj} fontFamily={termFontFamily} fit={termFit} />{/key}
        {/if}
      {:else}
        <div class="pane-empty">No terminal available (tmux session closed).</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* menu « ⋯ » des actions secondaires de l'en-tête (natif <details>, sans JS) */
  .hdr-more { position: relative; margin-left: auto; }
  .hdr-more > summary {
    list-style: none; cursor: pointer; user-select: none;
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 28px; border: 1px solid var(--border2); border-radius: 8px;
    color: var(--muted); background: transparent; font-size: 18px; line-height: 1;
  }
  .hdr-more > summary::-webkit-details-marker { display: none; }
  .hdr-more > summary:hover { background: var(--bg3); color: var(--text); }
  .hdr-more[open] > summary { background: var(--bg3); color: var(--text); border-color: var(--accent); }
  .hdr-menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 30;
    display: flex; flex-direction: column; gap: 4px; min-width: 240px; padding: 6px;
    background: var(--surface); border: 1px solid var(--border2); border-radius: 12px;
    box-shadow: var(--shadow);
  }
  /* Live-session controls (permission mode + model/effort) moved into the ⋯ menu so the cockpit
     bar stays clean (repo/branch/status · title · meta · tabs), matching the design. */
  .hdr-controls { display: flex; flex-direction: column; gap: 7px; padding: 4px 6px 2px; }
  .hc-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .hc-modes { display: flex; flex-wrap: wrap; gap: 5px; }
  .hdr-div { height: 1px; background: var(--border); margin: 6px 2px; }
  /* dans le menu : boutons pleine largeur, alignés à gauche, sans bordure individuelle */
  .hdr-menu :global(.vscode-btn) {
    display: flex; align-items: center; width: 100%; justify-content: flex-start; text-align: left;
    border: none; border-radius: 8px; padding: 7px 10px;
  }
  /* bouton « révéler les messages plus anciens » en tête du transcript fenêtré */
  .show-earlier {
    display: block; margin: 4px auto 10px; padding: 5px 14px;
    font-size: 12.5px; color: var(--muted); font-weight: 600;
    background: var(--bg2); border: 1px dashed var(--border); border-radius: 999px;
    cursor: pointer;
  }
  .show-earlier:hover { color: var(--text); background: var(--bg3); border-color: var(--accent); }
  /* carte « proposition de suivi » : entre la conversation et le composer, filet accent à gauche. */
  .followup {
    margin: 4px 2px 8px; padding: 10px 12px;
    background: var(--bg2); border: 1px solid var(--border2);
    border-left: 3px solid var(--accent); border-radius: 10px;
  }
  .fu-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .fu-ico { font-size: 14px; }
  .fu-x { margin-left: auto; border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 13px; padding: 0 4px; line-height: 1; }
  .fu-x:hover { color: var(--text); }
  .fu-text {
    margin: 6px 0 8px; font-size: 13px; color: var(--text); line-height: 1.4; white-space: pre-wrap;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .fu-take {
    font-size: 12.5px; font-weight: 600; color: var(--accent);
    background: transparent; border: 1px solid var(--accent-soft, var(--border)); border-radius: 8px;
    padding: 5px 12px; cursor: pointer;
  }
  .fu-take:hover { background: var(--bg3); }
  /* indicateur « working » sous la dernière bulle : slim, discret, respire (couleur de statut) */
  .working-live {
    display: flex; align-items: center; gap: 6px;
    margin: 4px 2px 2px; padding: 2px 2px;
    font-size: 12.5px; color: var(--working); font-weight: 600;
  }
  .wl-verb { animation: act-pulse 1.6s ease-in-out infinite; }
  .wl-sep { opacity: .5; }
  .wl-time { color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
  /* trois points qui rebondissent en cascade */
  .wl-dots { display: inline-flex; gap: 3px; }
  .wl-dots span {
    width: 5px; height: 5px; border-radius: 50%; background: var(--working);
    animation: wl-bounce 1.2s ease-in-out infinite;
  }
  .wl-dots span:nth-child(2) { animation-delay: .18s; }
  .wl-dots span:nth-child(3) { animation-delay: .36s; }
  @keyframes wl-bounce {
    0%, 80%, 100% { transform: translateY(0); opacity: .45; }
    40% { transform: translateY(-3px); opacity: 1; }
  }
</style>
