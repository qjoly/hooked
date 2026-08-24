<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, settings, loadSessions, openModal, sessionTitle, sessionTags, renameSession, toggleFocus, splitWithMostRecent, canSplit, toggleArchive, isArchived } from '$lib/state.svelte.js';
  import { getSession, setMode, setModelEffort, openInVscode, openInGhostty, fork, showInPane, killPane, deleteSession } from '$lib/api.js';
  import { STATE_LABEL, fmtCost, fmtTokens, fmtDuration, shortModel, prLabel, issueLabel, PERMISSION_MODES, modeLabel, modeMeta, modelAlias, tagColor } from '$lib/format.js';
  import { page } from '$app/state';
  import ModelEffort from './ModelEffort.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Plan from './Plan.svelte';
  import Composer from './Composer.svelte';
  import Ship from './Ship.svelte';
  import Dock from './Dock.svelte';
  import Terminal from './Terminal.svelte';
  import { TERM_THEMES, DEFAULT_TERM_THEME, TERM_FONTS, DEFAULT_TERM_FONT } from '$lib/terminalThemes.js';
  import { conversationToMarkdown } from '$lib/exportConversation.js';

  // `inSplit`/`focused`/`onClose` : rendu en pane de la vue split (plusieurs sessions côte à côte
  // dans la vue normale). En split, seul le pane focalisé réagit au clavier (lentilles 1-4, Échap),
  // et `onClose` affiche une croix pour retirer le pane.
  let { id, inSplit = false, focused = true, onClose = null } = $props();
  // $state.raw (pas $state) : le détail contient un tableau `messages` de 1000+ objets profonds.
  // $state proxifie récursivement à l'affectation `s = d` → tâche synchrone de plusieurs centaines
  // de ms qui GÈLE l'UI au changement de session. On ne mute jamais un message en place (on
  // remplace `s` en entier au refetch), donc raw est correct : réactif à la réaffectation, sans
  // proxy profond. Coût de `s = d` : O(1) au lieu de O(nombre de nœuds du transcript).
  let s = $state.raw(null);      // détail de session
  // Lentille active : 'chat' (Converse + dock) / 'terminal' (Shell) / 'ship' (relecture des
  // diffs + liens). Touches 1-3.
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
  let archiving = $state(false);
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

  // Le dock droit n'apparaît que s'il a quelque chose à montrer (tasks / changes / agents /
  // sub-sessions / jobs / liens) — sinon ni panneau ni rail de réouverture.
  const dockHasContent = $derived(!!s && !!(
    (s.todos || []).length || (s.changes || []).length || (s.subagents || []).length ||
    (s.subSessions || []).length || (s.bgJobs || []).length ||
    (s.prLinks || []).length || (s.issueLinks || []).length
  ));

  // Liste des terminaux de l'onglet : le pane Claude Code lui-même (si son tmux est vivant) +
  // les panes « show » ouverts par un agent. Le pane Claude est toujours en tête.
  const terminals = $derived.by(() => {
    const list = [];
    if (s && s.tmuxAlive && s.tmuxPane) list.push({ pane: s.tmuxPane, label: 'Claude Code', kind: 'claude' });
    for (const p of shownPanes) list.push({ pane: p.pane, label: p.command || 'shell', kind: 'show', target: p.target });
    return list;
  });

  // Lentilles du workspace : Converse et Ship. Le Shell n'est PLUS une lentille — c'est un
  // panneau BAS redimensionnable façon VS Code (1/3 de fenêtre par défaut), togglé par le tiroir
  // ou la touche 2, visible quelle que soit la lentille active.
  const LENSES = [
    { key: 'chat', icon: '💬', label: 'Converse', kbd: '1' },
    { key: 'ship', icon: '🚢', label: 'Ship', kbd: '3' },
  ];
  const lensCount = $derived({
    chat: (s?.messages || []).length,
    ship: (s?.changes || []).length,
  });
  const shownLenses = $derived(LENSES);
  let shellOpen = $state(false); // panneau shell bas ouvert ? (par pane, non persisté)
  function startShellResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = ui.shellHeight || Math.round(window.innerHeight / 3);
    const move = (ev) => { ui.shellHeight = Math.max(140, Math.min(Math.round(window.innerHeight * 0.8), startH + (startY - ev.clientY))); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  // Deep-link ?lens=<key> (Deck « Open the shell », dock « open Ship », palette…). Réactif à
  // l'URL : naviguer vers la même session avec un autre ?lens= bascule la lentille sans remount.
  // `?lens=terminal` (liens historiques) ouvre désormais le panneau shell.
  $effect(() => {
    const lens = page.url.searchParams.get('lens');
    if (inSplit) return;
    if (lens === 'terminal') untrack(() => { shellOpen = true; });
    else if (LENSES.some((l) => l.key === lens)) untrack(() => { tab = lens; });
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

  // Prompt de follow-up : la suggestion pré-remplie par le TUI de Claude Code (ghost text de la
  // boîte de saisie), lue côté serveur dans la pane (cf. paneFollowupSync). C'est un vrai prompt
  // actionnable — pas la dernière phrase de Claude. On la surface au-dessus du composer pour la
  // reprendre en 1 clic. Masquée si une question/plan est déjà en attente.
  let dismissedFollowup = $state(null); // suggestion masquée localement (revient si le texte change)
  const followup = $derived(
    (s && s.followupSuggestion && !s.pendingQuestion && !s.pendingPlan) ? s.followupSuggestion : null,
  );
  const showFollowup = $derived(followup && followup !== dismissedFollowup && !queued.length);
  async function takeFollowup() {
    if (!composer || !followup) return;
    tab = 'chat';
    await tick();
    composer.sendText(followup); // envoi direct (remplit + envoie), comme la revue de fichiers
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
    if (res.ok && res.data.pane) { wantPane = res.data.pane; shellOpen = true; setTimeout(() => { loadSessions(); ui.tick++; }, 250); }
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

  // indicateur 5 h compact pour la ligne de stats : uniquement la valeur réelle (statusline).
  // Pas d'estimation de repli → masqué tant que le vrai % n'est pas connu.
  const stat5h = $derived.by(() => {
    if (!s) return null;
    const rl = s.rateLimit && s.rateLimit.fiveHour;
    if (rl && rl.pct != null) {
      return { pct: rl.pct, title: '5 h session rate limit (actual)' + (rl.resetInMin != null ? ` — resets in ${fmtDuration(rl.resetInMin)}` : '') };
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
  // Chips PR / issue de la barre de statut : bornés par le réglage (0 = tous), surplus résumé en « +N ».
  const linkLimit = $derived(settings.statusBarLinkLimit || 0);
  const shownLinks = (links) => (linkLimit ? links.slice(0, linkLimit) : links);

  async function load(isRefresh) {
    let d;
    try { d = await getSession(id); } catch (_) { return; }
    s = d;
    lastActivity = d.lastActivity || null;
    // les hooks reflètent enfin le mode visé → on lâche le choix optimiste.
    if (modeOverride && d.permissionMode === modeOverride) modeOverride = null;
    // un message en file disparaît dès qu'il apparaît comme bulle user dans le transcript.
    // On normalise des DEUX côtés comme chatText (server/util.js) : le transcript collapse déjà
    // `[ \t]+` et strip les balises, alors que le texte optimiste est brut → un collage multi-espaces
    // (table alignée) ou multi-lignes ne matchait jamais et restait en double « ⏳ queued ».
    if (queued.length) {
      const norm = (t) => (t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const userTexts = new Set((d.messages || []).filter((m) => m.role === 'user').map((m) => norm(m.text)));
      queued = queued.filter((q) => !userTexts.has(norm(q.text)));
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

  // Raccourcis fenêtre du workspace :
  //  • 1-4 (hors saisie) : bascule de lentille (Converse / Build / Shell / Ship) ;
  //  • Échap dans la vue chat (hors textarea — le composer gère lui-même quand il a le focus) :
  //    interrompt Claude et recharge le dernier prompt pour l'éditer, comme dans le CLI.
  const LENS_KEYS = { 1: 'chat', 2: 'shell', 3: 'ship' };
  function onWindowKey(e) {
    if (ui.modal) return;
    if (inSplit && !focused) return; // in split, only the focused pane reacts to keys
    const t = e.target;
    const isInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey && LENS_KEYS[e.key]) {
      const k = LENS_KEYS[e.key];
      if (k === 'shell') { if (terminals.length) { e.preventDefault(); shellOpen = !shellOpen; } }
      else { e.preventDefault(); tab = k; }
      return;
    }
    if (e.key !== 'Escape' || tab !== 'chat') return;
    if (t && t.id === 'reply-text') return; // déjà géré par le composer focalisé
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
      // La liste (polée, peu coûteuse) détecte l'apparition/disparition du ghost text de follow-up
      // AVANT le détail → on refetch pour peupler followupSuggestion. Corrige la carte de follow-up
      // qui « ne s'affichait plus » (course entre la fin du tour et le rendu du ghost text du TUI).
      const followupChanged = (sess.followup || null) !== (s.followupSuggestion || null);
      // Refetch UNIQUEMENT quand quelque chose a vraiment changé — plus de refetch aveugle à chaque
      // tick pour toute session live (c'était 1,8 MB de transcript rechargés/sec pour une session
      // juste ouverte). On recharge sur : question (dis)parue, nouvelle activité (lastActivity a
      // avancé), follow-up (dis)paru, chat d'une session qui travaille, ou onglet Terminal actif.
      if (qChanged || activityChanged || followupChanged || (tab === 'chat' && sess.state === 'working') || (shellOpen && s.tmuxAlive)) load(true);
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
  // Archive replaces the old Stop: it stops the tmux session AND moves the session to Archived
  // (the two are no longer distinct). `toggleArchive` performs the kill; we just leave the view.
  const archived = $derived(!!s && isArchived(s.id));
  function archive() {
    if (archived) { toggleArchive(s.id); setTimeout(() => { loadSessions(); ui.tick++; }, 400); return; }
    openModal('confirm', {
      title: 'Archive this session?',
      message: 'The tmux session running Claude will be stopped and the session moves to Archived (reversible).',
      confirmLabel: '📥 Archive', danger: true,
      onConfirm: () => {
        archiving = true;
        toggleArchive(s.id);
        setTimeout(() => { loadSessions(); ui.tick++; }, 800);
        if (inSplit) onClose?.(); else goto('/');
      },
    });
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
  <div class="detail-shell" class:in-split={inSplit} class:focused={inSplit && focused}>
  <div class="detail-main">
  <div class="pane-head s-{s.state}">
    <!-- En-tête compact : UNE ligne (nom éditable · repo/branche · état · actions), puis les
         onglets. La status bar (coût/tokens/liens) est retirée — ces infos vivent dans le dock,
         la lentille Ship et le menu ⋯. -->
    <div class="head-line">
      {#if !inSplit}
        <button class="pane-back" onclick={() => goto('/')} title="Back to list">←</button>
      {/if}
      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="sess-rename-inline" autofocus bind:value={renameVal}
               placeholder={s.title || 'Session title'}
               onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = false; }}
               onblur={commitRename} />
      {:else}
        <button class="sess-name" onclick={startRename} title="Rename this session (local)">{sessionTitle(s)}</button>
        {#if ui.names[s.id]}<button class="sess-restore" title="Restore auto title" aria-label="Auto title" onclick={() => renameSession(s.id, '')}>↺</button>{/if}
      {/if}
      <span class="head-meta" title={s.project || ''}>{s.repo || s.projectName || '?'}{#if s.gitBranch} · ⎇ {s.gitBranch}{/if}</span>
      {#if sessionTags(id).length}
        <!-- tags de session (manuels + auto-tag PR) : cliquer ouvre l'éditeur -->
        <button class="head-tags" onclick={() => openModal('editTags', { sessionId: id })} title="Edit tags">
          {#each sessionTags(id) as t (t)}<span class="head-tag" style="--c:{tagColor(t)}">#{t}</span>{/each}
        </button>
      {/if}
      <span class="badge s-badge"><span class="bdot"></span>{s.state === 'working' && s.activity ? s.activity + '…' : (STATE_LABEL[s.state] || s.state)}</span>

      <div class="head-actions">
        {#if s.tmuxAlive}
          <!-- modèle/effort + mode de permission vivent dans le menu ⋯ ; seul le retour
               éphémère d'un changement (✓ Auto, ✗ failed…) s'affiche ici. -->
          {#if modeStatus || meStatus}<span class="strip-status">{modeStatus || meStatus}</span>{/if}
          <button class="stop-btn" disabled={archiving} onclick={archive}
                  title="Stop the tmux session and move it to Archived">{archiving ? '⏳' : '📥 Archive'}</button>
        {:else}
          <button class="resume-btn" onclick={resume}>▶ Resume</button>
        {/if}
        {#if !inSplit}
          <button class="hdr-icon-btn" title="Split with the most recent session (⌘/Ctrl+⇧+S)"
                  aria-label="Split view" disabled={!canSplit()} onclick={() => splitWithMostRecent(id)}>⊞</button>
        {/if}
        <details class="hdr-more">
          <summary title="More actions" aria-label="More actions">⋯</summary>
          <div class="hdr-menu">
            <!-- Réglages fréquents (modèle/effort + mode de permission) : rangés ici en
                 permanence pour garder l'en-tête compact — le titre reste l'info principale. -->
            {#if s.tmuxAlive}
              {@const cur = modeMeta(modeView)}
              <div class="hdr-menu-cmds">
                {#if sb.modelEffort !== false}
                  <ModelEffort compact bind:model={editModel} bind:effort={editEffort} onchange={applyModelEffort} disabled={meBusy} />
                {/if}
                {#if sb.permissionMode !== false}
                  <div class="strip-modes wrap">
                    {#if !PERMISSION_MODES.some((m) => m.key === modeView)}
                      <span class="mode-now mode-{modeView}" title={cur.title}><span class="mode-ico">{cur.icon}</span>{cur.label}</span>
                    {/if}
                    {#each PERMISSION_MODES as m}
                      <button class="mode-chip" class:active={modeView === m.key} disabled={modeBusy}
                              onclick={() => switchMode(m.key)} title={m.title}><span class="mode-ico">{m.icon}</span>{m.label}</button>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="hdr-div cmds-div"></div>
            {/if}
            <button class="vscode-btn" onclick={() => openModal('cost')} title="Estimated cost breakdown">💰 Cost · {fmtCost(s.cost)}{#if s.subagentCost > 0} (+{fmtCost(s.subagentCost)} agents){/if}</button>
            <div class="hdr-div"></div>
            <button class="vscode-btn" title="Copy a shareable link that opens this session in hooked" onclick={copyLink}>{linkCopied ? '✓ copied' : '🔗 Copy link'}</button>
            {#if s.tmuxAlive && s.tmuxAttach}
              <button class="vscode-btn" title={s.tmuxAttach} onclick={copyAttach}>{attachCopied ? '✓ copied' : '⧉ Copy attach'}</button>
            {/if}
            <button class="vscode-btn" disabled={vscodeBusy} onclick={openVscode} title="Open the entire project in VS Code">{vscodeBusy ? '⏳' : '⧉'} Open in VS Code</button>
            <button class="vscode-btn" disabled={ghosttyBusy} onclick={openGhostty} title="Open the session in Ghostty (attaches tmux if alive)">{ghosttyBusy ? '⏳' : '⧉'} Open in Ghostty</button>
            <button class="vscode-btn" onclick={copyExport} title="Copy the conversation as Markdown to the clipboard">{exportCopied ? '✓ copied' : '⧉ Copy as Markdown'}</button>
            <button class="vscode-btn" onclick={() => openModal('editTags', { sessionId: id })} title="Add or remove tags on this session (PR review tags are automatic)">🏷 Edit tags</button>
            {#if sb.focusBtn !== false}<button class="vscode-btn" class:on={ui.focus} onclick={toggleFocus} title="Focus mode: full-screen conversation">⛶ {ui.focus ? 'Exit focus' : 'Focus'}</button>{/if}
            <button class="vscode-btn" class:on={ui.toolsOpen} onclick={() => (ui.toolsOpen = !ui.toolsOpen)} title="Expand every tool call's input/result inline (this session only, off on reload)">🔧 {ui.toolsOpen ? 'Collapse tool details' : 'Expand tool details'}</button>
            <div class="hdr-div"></div>
            <button class="vscode-btn" onclick={archive} title={archived ? 'Restore this session to the live fleet' : 'Stop the tmux session and move it to Archived'}>{archived ? '↩ Unarchive' : '📥 Archive'}</button>
            <button class="vscode-btn del-btn" disabled={deleting} onclick={del} title="Move to trash: removes from dashboard; transcript kept in bin/ (recoverable)">{deleting ? '⏳' : '🗑'} Delete</button>
          </div>
        </details>
      </div>
    </div>
    <div class="subtabs lenses">
      {#each shownLenses as l (l.key)}
        <button class="subtab" class:active={tab === l.key} onclick={() => { tab = l.key; }}
                title="{l.label} — key {l.kbd}">
          {l.icon} {l.label}
          {#if lensCount[l.key]}<span class="count">{lensCount[l.key]}</span>{/if}
          <kbd class="lens-kbd">{l.kbd}</kbd>
        </button>
      {/each}
    </div>
  </div>

  <div class="body-row">
  <div class="pane-body" class:flush={tab === 'ship'} bind:this={body}
       onscroll={() => { if (body) stickToBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 60; }}>
    <!-- la conversation reste montée en lentille Build (colonne copilote à côté de l'IDE) -->
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
          {#each (s.messages || []).slice(startIdx) as m, j (startIdx + j)}<ChatBubble {m} onfork={quickFork} onforkadvanced={openFork} {forkState} session={id} />{/each}
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
            <span class="fu-ico">💡</span> Prompt de follow-up suggéré
            <button class="fu-x" title="Dismiss" aria-label="Dismiss" onclick={() => (dismissedFollowup = followup)}>✕</button>
          </div>
          <div class="fu-text">{followup}</div>
          <button class="fu-take" onclick={takeFollowup}>↵ Envoyer</button>
        </div>
      {/if}
      {#if s.tmuxPane}
        <Composer bind:this={composer} {id} alive={s.tmuxAlive} project={s.project}
                  resumeModel={s.launchModel} resumeEffort={s.effort} lastPrompt={s.lastPrompt || ''} {onSent} />
      {/if}
    </div>

    <!-- Lentille Ship : relecture des changements de Claude + expédition (composant dédié). -->
    <div class="pane pane-flush" class:active={tab === 'ship'}>
      {#if seen.ship}
        <Ship {s} {id} onReview={reviewChanges} canReview={!!(s.tmuxPane)} active={tab === 'ship'} />
      {/if}
    </div>

  </div>

  <!-- dock contextuel (lentille Converse) : tasks / changements / agents / jobs / liens.
       Masquable par l'utilisateur (persisté ui.dockHidden) → rail fin pour le rouvrir.
       Pas rendu du tout (ni le rail) quand la session n'a AUCUN contenu contextuel. -->
  {#if tab === 'chat' && dockHasContent && !(inSplit && ui.splitCompact)}
    {#if ui.dockHidden}
      <button class="dock-reopen" onclick={() => (ui.dockHidden = false)} title="Show the context panel" aria-label="Show the context panel">‹</button>
    {:else}
      <Dock {s} {id} onship={() => (tab = 'ship')} />
    {/if}
  {/if}
  </div>

  <!-- Shell : panneau bas redimensionnable façon VS Code (1/3 de fenêtre par défaut), visible
       quelle que soit la lentille active. Le tiroir dessous le toggle (touche 2). -->
  {#if shellOpen && terminals.length}
    <div class="shell-panel" style="height:{ui.shellHeight ? ui.shellHeight + 'px' : '33vh'}">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="shell-resize" onpointerdown={startShellResize} title="Drag to resize"></div>
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
                title={termFit ? 'Fit: the tmux pane fills the panel' : 'Fixed tmux pane size'}>
          {termFit ? '⤢ Fit' : '▭ Fixed'}
        </button>
        <button class="term-mode" class:on={termInteractive} onclick={() => (termInteractive = !termInteractive)}
                title={termInteractive ? 'Interactive: your keystrokes go to the tmux pane' : 'Read-only: observation'}>
          {termInteractive ? '⌨ Interactive' : '👁 Read-only'}
        </button>
        <button class="term-mode" onclick={() => (shellOpen = false)} title="Close the shell panel (key 2)">✕</button>
      </div>
      {#if termPane}
        {#key termPane + ':' + termInteractive + ':' + termFit}<Terminal pane={termPane} interactive={termInteractive} theme={termThemeObj} fontFamily={termFontFamily} fit={termFit} fitContainer />{/key}
      {/if}
    </div>
  {/if}
  <!-- tiroir terminal : toggle du panneau shell (ou touche 2) -->
  {#if terminals.length}
    <button class="term-drawer" onclick={() => (shellOpen = !shellOpen)} title="Toggle the shell panel (key 2)">
      <span class="td-name">🖥 Shell</span>
      <span class="td-prompt">❯</span>
      <span class="td-info">{s.tmuxAlive ? (s.state === 'working' && s.activity ? s.activity + '…' : 'tmux alive') : 'tmux closed'}{#if shownPanes.length} · {shownPanes.length + 1} panes{/if}</span>
      <span class="td-open">{shellOpen ? 'close' : 'open'} <kbd>2</kbd> {shellOpen ? '▼' : '▲'}</span>
    </button>
  {/if}
  </div>
  </div>
{/if}

<style>
  .detail-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  /* split pane: the ✕ close is always shown, and the focused pane gets an accent rail. */
  .detail-shell.in-split :global(.pane-back) { display: inline-flex; }
  .detail-shell.in-split.focused { box-shadow: inset 3px 0 0 var(--accent); }
  .detail-shell.in-split:not(.focused) { opacity: .92; }
  .detail-main { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }

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
  /* En-tête compact sur une seule ligne : nom · repo/branche · état · actions à droite.
     Les réglages fréquents (modèle/effort + mode) vivent en PERMANENCE dans le menu ⋯. */
  .head-line { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .hdr-menu-cmds { display: flex; flex-direction: column; gap: 8px; padding: 4px 6px 2px; }
  .hdr-menu-cmds .strip-modes.wrap { flex-wrap: wrap; }
  .cmds-div { display: block; }
  .sess-name {
    /* Le TITRE est l'info prioritaire : il PREND l'espace libre (flex-grow) et garde un plancher
       lisible (min-width), au lieu d'être le premier écrasé. Ce sont la branche/le statut puis les
       boutons (repliés par les container queries plus bas) qui cèdent la place avant lui. */
    flex: 1 1 auto; min-width: 96px; max-width: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: none; border: none; padding: 0; font: inherit; font-size: 15px; font-weight: 800;
    letter-spacing: -.01em; color: var(--text); cursor: text; text-align: left;
  }
  .sess-name:hover { color: var(--accent-d); }
  .sess-rename-inline {
    flex: 0 1 auto; min-width: 120px; max-width: 40vw; font: inherit; font-size: 15px; font-weight: 800;
    background: var(--input); border: 1px solid var(--accent); border-radius: 7px; padding: 2px 8px; color: var(--text);
  }
  .sess-rename-inline:focus { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
  .sess-restore { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; padding: 0 2px; flex: 0 0 auto; }
  .sess-restore:hover { color: var(--text); }
  .head-meta {
    flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--mono); font-size: 11px; color: var(--muted);
  }
  /* tags de session dans l'en-tête : compacts, cliquables (→ éditeur de tags) */
  .head-tags {
    flex: 0 1 auto; min-width: 0; display: inline-flex; gap: 4px; overflow: hidden;
    background: none; border: none; padding: 0; cursor: pointer;
  }
  .head-tag {
    font: 600 9.5px var(--mono); line-height: 1.7; padding: 0 6px; border-radius: 0;
    color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); white-space: nowrap;
  }
  .head-tags:hover .head-tag { filter: brightness(1.15); }
  .head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .hdr-icon-btn {
    width: 30px; height: 28px; border: 1px solid var(--border2); border-radius: 8px;
    background: transparent; color: var(--muted); font-size: 15px; line-height: 1; cursor: pointer; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .hdr-icon-btn:hover:not(:disabled) { background: var(--bg3); color: var(--text); border-color: var(--accent); }
  .hdr-icon-btn:disabled { opacity: .4; cursor: default; }
  /* compact : moins de padding vertical, onglets serrés sous la ligne unique.
     container-type → les container queries plus bas mesurent la LARGEUR RÉELLE de l'en-tête
     (donc aussi celle d'un pane de split étroit, pas seulement le viewport). */
  .pane-head { padding: 9px 18px 0; container-type: inline-size; }

  /* Repli progressif de l'en-tête (du moins important au plus important) ;
     le TITRE de la session reste toujours lisible. */
  @container (max-width: 620px) {
    /* 1) le bouton ⊞ (split) se replie (reste accessible au raccourci / à la palette). */
    .hdr-icon-btn { display: none; }
  }
  @container (max-width: 520px) {
    /* 2) l'Archive inline se replie (il reste dans le menu ⋯) — seuls ⋯ (et Resume) subsistent. */
    .stop-btn { display: none; }
  }
  @container (max-width: 440px) {
    /* 3) enfin le statut et la branche disparaissent ; le TITRE, lui, reste toujours lisible. */
    .head-meta, .s-badge, .head-tags { display: none; }
  }
  .head-line + :global(.subtabs) { margin-top: 9px; }
  .strip-modes { display: flex; gap: 4px; }
  .strip-status { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }

  /* corps du workspace : la zone scrollable + le dock contextuel côte à côte */
  .body-row { flex: 1 1 auto; min-height: 0; display: flex; }
  .body-row :global(.pane-body) { min-width: 0; }
  /* rail fin pour rouvrir le dock quand il est masqué */
  .dock-reopen {
    flex: 0 0 auto; width: 18px; border: none; border-left: 1px solid var(--border);
    background: var(--bg2); color: var(--muted); cursor: pointer; font-size: 12px; padding: 0;
    transition: background .12s, color .12s;
  }
  .dock-reopen:hover { background: var(--hover); color: var(--text); }

  /* badge clavier des lentilles (1-4) */
  .lens-kbd {
    font: 9px/1 var(--mono); color: var(--muted);
    background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px;
    margin-left: 2px;
  }
  .subtab.active .lens-kbd { color: inherit; background: transparent; border-color: currentColor; opacity: .7; }

  /* Panneau shell bas (façon VS Code) : hauteur pilotée par l'utilisateur (drag), le terminal
     remplit le reste (Terminal en mode fitContainer). */
  .shell-panel {
    flex: 0 0 auto; position: relative; display: flex; flex-direction: column; min-height: 0;
    border-top: 1px solid var(--border); background: var(--bg2);
  }
  .shell-panel > :global(.term-wrap) { flex: 1 1 auto; min-height: 0; }
  .shell-panel :global(.term-bar) { margin: 0; padding: 5px 10px; border-bottom: 1px solid var(--border); }
  .shell-resize { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: row-resize; z-index: 6; }
  .shell-resize:hover { background: var(--accent); opacity: .5; }

  /* tiroir terminal sous la conversation : statut du shell, un clic ouvre la lentille Shell */
  .term-drawer {
    flex: 0 0 auto; display: flex; align-items: center; gap: 9px;
    margin: 0; padding: 7px 16px; width: 100%;
    background: var(--code-bg); border: none; border-top: 1px solid var(--border);
    color: #8f96a3; font-family: var(--mono); font-size: 11px; cursor: pointer; text-align: left;
  }
  .term-drawer:hover .td-open { color: var(--accent); }
  .td-name { color: #c9cedb; font-weight: 600; }
  .td-prompt { color: var(--success); }
  .td-info { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .td-open { margin-left: auto; flex: 0 0 auto; color: #6a7180; }
  .td-open kbd {
    font: 9px/1 var(--mono); border: 1px solid #3a3f4a; border-radius: 4px; padding: 1px 4px;
  }

  /* lentille Ship : le composant Ship gère ses 3 colonnes → on retire le padding/scroll du
     pane-body pour qu'il occupe toute la hauteur (Ship a ses propres zones scrollables). */
  .pane-body.flush { padding: 0; overflow: hidden; }
  .pane-flush { padding-top: 0; }
  .pane-flush.active { display: flex; height: 100%; min-height: 0; min-width: 0; }
  /* min-width:0 is essential: without it the flex child won't shrink below its content, the
     split-diff 1fr columns expand to content width and the ship panel gets pushed off-screen. */
  .pane-flush.active > :global(*) { flex: 1 1 auto; min-height: 0; min-width: 0; }
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
