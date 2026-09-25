<script module>
  // The active lens, remembered PER SESSION across remounts. SessionDetail is keyed by session id,
  // and the single↔split markup swap re-keys it too: adding a split used to destroy the component
  // and its `tab` state, so the pane came back on Converse whatever lens was open. Module scope
  // survives remounts; it is display memory, not data — deliberately not persisted.
  const lastLens = new Map(); // session id → lens key
</script>

<script>
  import { copyText } from '$lib/clipboard.js';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, settings, loadSessions, openModal, sessionTitle, sessionTags, renameSession, toggleFocus, splitWithMostRecent, canSplit, toggleArchive, isArchived, unarchive } from '$lib/state.svelte.js';
  import { getSession, setMode, setModelEffort, setAutoApprove, openInEditor, openInGhostty, fork, launch, deleteSession, connectSessionStream, listTerminals, openTerminal, killTerminal } from '$lib/api.js';
  import { promptCacheState } from '$lib/promptCache.js';
  import { STATE_LABEL, fmtCost, fmtTokens, shortModel, PERMISSION_MODES, modeLabel, modeMeta, modelAlias, tagColor, resumeCommand, parseBang, isBlockForCommand } from '$lib/format.js';
  import { page } from '$app/state';
  import ModelEffort from './ModelEffort.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Plan from './Plan.svelte';
  import Composer from './Composer.svelte';
  import Ship from './Ship.svelte';
  import Branch from './Branch.svelte';
  import Dock from './Dock.svelte';
  import Terminal from './Terminal.svelte';
  import Mcp from './Mcp.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { editorFor } from '$lib/editors.js';
  import { conversationToMarkdown } from '$lib/exportConversation.js';
  import { getBinding, matchesEvent, formatKeys } from '$lib/shortcuts.js';

  // `inSplit`/`focused`: rendered as one pane of the split view (several sessions side by side).
  // In split, only the focused pane reacts to the keyboard (lenses, Escape).
  let { id, inSplit = false, focused = true } = $props();
  // $state.raw (pas $state) : le détail contient un tableau `messages` de 1000+ objets profonds.
  // $state proxifie récursivement à l'affectation `s = d` → tâche synchrone de plusieurs centaines
  // de ms qui GÈLE l'UI au changement de session. On ne mute jamais un message en place (on
  // remplace `s` en entier au refetch), donc raw est correct : réactif à la réaffectation, sans
  // proxy profond. Coût de `s = d` : O(1) au lieu de O(nombre de nœuds du transcript).
  let s = $state.raw(null);      // détail de session
  // Lentille active : 'chat' (Converse + dock) / 'ship' (relecture des diffs + liens) /
  // 'branch' / 'mcp'. Touches 1, 3, 4, 5. Réouverte là où la session a été laissée (cf. lastLens).
  let tab = $state(lastLens.get(id) || 'chat');
  $effect(() => { const t = tab; untrack(() => lastLens.set(id, t)); });
  let body;                      // ref .pane-body (conteneur scrollable)
  let composer;                  // ref Composer (pour déclencher interruption + édition via Échap)
  let lastActivity = null;
  let archiving = $state(false);
  // changement de mode de permission (Normal / Auto / Plan) — requête de contrôle de l'Agent SDK.
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

  // Le dock droit n'apparaît que s'il a quelque chose à montrer (tasks / changes / workflows /
  // agents / sub-sessions / jobs / liens) — sinon ni panneau ni rail de réouverture.
  const dockHasContent = $derived(!!s && !!(
    (s.todos || []).length || (s.changes || []).length || (s.subagents || []).length ||
    (s.workflows || []).length ||
    (s.subSessions || []).length || (s.bgJobs || []).length ||
    (s.prLinks || []).length || (s.issueLinks || []).length || (s.screenshots || []).length
  ));

  // Lentilles du workspace : Converse, Ship, Branch et MCP. Le panneau Shell (mirroir xterm d'un
  // pane tmux) a disparu avec la migration hors tmux : il n'y a plus de terminal à mirrorer, la
  // session est pilotée en processus par l'Agent SDK et tout son fil passe par Converse.
  // MCP était une page de nav avec son propre sélecteur de projet : les scopes MCP étant
  // par-répertoire, la lentille prend le projet de la session et le sélecteur disparaît.
  const LENSES = [
    { key: 'chat', icon: 'converse', label: 'Converse', kbd: '1' },
    { key: 'ship', icon: 'ship', label: 'Ship', kbd: '3' },
    { key: 'branch', icon: 'git-branch', label: 'Branch', kbd: '4' },
    { key: 'mcp', icon: 'mcp', label: 'MCP', kbd: '5' },
  ];
  const lensCount = $derived({
    chat: (s?.messages || []).length,
    ship: (s?.changes || []).length,
  });
  // Deep-link ?lens=<key> (dock « open Ship », palette…). Réactif à l'URL : naviguer vers la même
  // session avec un autre ?lens= bascule la lentille sans remount. Les anciens liens `?lens=shell`
  // et `?lens=terminal` retombent sur Converse (le panneau Shell n'existe plus).
  $effect(() => {
    const lens = page.url.searchParams.get('lens');
    if (inSplit) return;
    if (LENSES.some((l) => l.key === lens)) untrack(() => { tab = lens; });
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
  // ── Streaming temps réel du tour en cours ─────────────────────────────────────────────────────
  // Le transcript n'est écrit qu'au FLUSH de chaque message : entre deux, la conversation paraît
  // figée alors que Claude écrit. On s'abonne donc au flux par session (/api/session/stream) et on
  // rend le texte en cours sous la dernière bulle. Ce n'est qu'un tampon d'affichage : dès que le
  // message tombe dans le transcript, le refetch normal l'affiche et le serveur vide le tampon.
  let live = $state(null);   // { state, busy, activity, text, thinking, tool } | null
  $effect(() => {
    const sid = id;                       // dep suivie lue AVANT toute garde (piège Svelte 5)
    const driven = !!(s && s.live);       // idem : on veut se réabonner quand la session devient pilotée
    if (!sid || !driven) { if (live !== null) untrack(() => { live = null; }); return; }
    const close = connectSessionStream(sid, (snap) => {
      live = snap && snap.live ? snap : null;
    });
    return close;                         // changement de session / session non pilotée → on ferme
  });
  // Texte en cours d'écriture, seulement quand il y a de quoi montrer. On n'affiche rien si le
  // transcript a déjà rattrapé (le serveur remet le tampon à zéro à la fin du tour).
  const liveText = $derived(live && typeof live.text === 'string' ? live.text : '');
  const liveThinking = $derived(live && typeof live.thinking === 'string' ? live.thinking : '');
  const liveTool = $derived(live ? live.tool : null);

  // ── Terminaux shell ───────────────────────────────────────────────────────────────────────────
  // Panneau bas redimensionnable, un onglet par terminal. Ce sont de vrais shells (PTY) ouverts sur
  // le dossier du projet — ils ne parlent PAS à la session Claude et lui survivent : fermer l'onglet
  // du navigateur ou recharger la page ne les tue pas, ils vivent dans le processus hooked. C'est ce
  // qui remplace le mirroir de pane tmux, réduit à ce qu'on lui demandait : lancer des commandes.
  let terms = $state([]);
  let termId = $state(null);
  let termOpen = $state(false);
  let termBusy = $state(false);
  async function refreshTerms() {
    // jget renvoie le corps BRUT (`{ok, terminals}`), pas la forme `{ok, data}` de jpost. Chercher
    // la liste sous `data` levait donc une TypeError à chaque appel, et `terms` restait vide.
    const res = await listTerminals(id).catch(() => null);
    if (!res || !res.ok) return;
    // Inline PTYs (a `!!command` rendered in the conversation) are tagged with the session so they
    // close with it, but they are not tabs here: two xterms on one PTY would fight over its size.
    terms = (res.terminals || []).filter((t) => !t.inline);
    if (!terms.some((t) => t.id === termId)) termId = terms.length ? terms[terms.length - 1].id : null;
    // Seul endroit où `terms` est réassigné, donc seul endroit où poser l'invariant : plus de
    // terminal ⇒ on replie. Sans ça, changer de session vidait la liste en laissant le panneau
    // « ouvert » sur rien — ni panneau ni tiroir affiché, et aucun moyen de revenir.
    if (!terms.length) termOpen = false;
  }
  // Au changement de session : on récupère SES terminaux (ceux d'une autre session restent ouverts
  // côté serveur, simplement pas listés ici).
  $effect(() => { const sid = id; if (sid) untrack(() => { refreshTerms(); }); });
  async function newTerm() {
    if (termBusy || !s || !s.project) return;
    termBusy = true;
    const res = await openTerminal(s.project, id).catch((e) => ({ ok: false, data: { error: e.message } }));
    termBusy = false;
    if (res.ok) { termOpen = true; termId = res.data.id; await refreshTerms(); }
    else alert('✗ ' + (res.data.error || 'failed to open a terminal'));
  }
  async function closeTerm(tid) {
    if (termBusy) return;
    termBusy = true;
    await killTerminal(tid).catch(() => {});
    termBusy = false;
    await refreshTerms();
  }
  // le composant signale la fin du flux (shell sorti, ou terminal tué ailleurs) → on resynchronise.
  function onTermClosed() { refreshTerms(); }
  // Bascule du panneau, partagée par la touche 2, le raccourci `open-terminal` et le tiroir : replier
  // un panneau vide n'a aucun sens, donc quand il n'y a aucun shell la bascule en OUVRE un.
  function toggleTerm() {
    if (!terms.length) newTerm();
    else termOpen = !termOpen;
  }
  // libellés des raccourcis, relus depuis les bindings (donc justes après un remappage en Settings).
  const termToggleKeys = formatKeys(getBinding('open-terminal'));
  const termNewKeys = formatKeys(getBinding('new-terminal'));

  function startTermResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = ui.termHeight || Math.round(window.innerHeight / 3);
    const move = (ev) => { ui.termHeight = Math.max(120, Math.min(Math.round(window.innerHeight * 0.8), startH + (startY - ev.clientY))); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

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
  let dismissedFollowup = $state(null); // suggestion masquée (revient si le texte de la suggestion change)
  // Le masquage est PERSISTÉ, comme le brouillon du composer : sinon un rechargement ramène la
  // carte alors que son texte est déjà dans la zone de saisie, et son « Envoyer » écraserait la
  // version retouchée. Même idiome de clé que le brouillon, indexé par session.
  const fuKey = (sid) => 'hooked:fu-dismissed:' + (sid || '');
  $effect(() => {
    const sid = id; // dépendance suivie AVANT toute garde (règle réactivité Svelte 5)
    try { dismissedFollowup = localStorage.getItem(fuKey(sid)); } catch (_) { dismissedFollowup = null; }
  });
  function dismissFollowup(text) {
    dismissedFollowup = text;
    try { if (text) localStorage.setItem(fuKey(id), text); } catch (_) {}
  }
  const followup = $derived(
    (s && s.followupSuggestion && !s.pendingQuestion && !s.pendingPlan) ? s.followupSuggestion : null,
  );
  const showFollowup = $derived(followup && followup !== dismissedFollowup && !queued.length);

  // Visibility of the ⋯ menu's optional controls (settings.statusBar). Read BEFORE any guard
  // (Svelte 5 reactivity rule: a dependency behind a short-circuit is not tracked).
  const sb = $derived(settings.statusBar || {});

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
    // deep-link #msg-<ts> (omnibar « Citations ») : la cible peut être hors fenêtre → tout rendre
    // une fois pour que scrollToHashMsg la trouve.
    if (!isRefresh && typeof window !== 'undefined' && (window.location.hash || '').startsWith('#msg-'))
      visibleCount = (d.messages || []).length;
    await tick();
    // ancre #msg-<ts> (depuis l'omnibar) : scroll vers la bulle ciblée au 1er load.
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
    // Une commande (`!` / `!!`) n'est PAS un message en attente : elle est déjà exécutée, et son
    // résultat arrive comme bloc `console` ou terminal `pty`. L'afficher « queued » laissait croire à
    // un envoi bloqué — et le dédoublonnage ne pouvait jamais l'effacer, puisque le transcript
    // contient le bloc, pas le texte tapé. On la marque donc comme commande.
    const bang = parseBang(t);
    queued = [...queued, { text: t, ts: new Date().toISOString(), kind: bang && bang.kind, cmd: bang ? bang.command : '' }];
    forceBottom = true;
    stickToBottom = true;            // après un envoi, on re-suit la conversation
    scheduleQueuedDrain();
    await tick();
    if (body) body.scrollTop = body.scrollHeight;
  }

  // La bulle optimiste ne s'efface que dans load(), déclenché par un tick SSE — donc par un hook.
  // Un tour qui n'appelle AUCUN outil n'en produit presque pas : la bulle restait jaune plusieurs
  // minutes à côté de son propre message déjà affiché dans le fil. On relance donc quelques load()
  // espacés, tant qu'il reste une bulle à résoudre. Les bulles de commande (`!`) sont exclues :
  // elles ne se résolvent pas par texte mais en s'attachant à leur bloc d'écho, et resteraient là.
  const QUEUED_RETRY_MS = [1000, 3000, 8000];
  let queuedRetry = null;
  const hasPendingQueued = () => queued.some((q) => !q.kind);
  function scheduleQueuedDrain(i = 0) {
    clearTimeout(queuedRetry);
    if (i >= QUEUED_RETRY_MS.length) return;
    queuedRetry = setTimeout(async () => {
      if (!hasPendingQueued()) return;
      await load(true);
      if (hasPendingQueued()) scheduleQueuedDrain(i + 1);
    }, QUEUED_RETRY_MS[i]);
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
  // conteneur scrollable (.pane-body) → en revenant de Ship/Branch, il gardait la position
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
  //  • 1, 3, 4, 5 (hors saisie) : bascule de lentille (Converse / Ship / Branch / MCP) ;
  //  • Échap dans la vue chat (hors textarea — le composer gère lui-même quand il a le focus) :
  //    interrompt Claude et recharge le dernier prompt pour l'éditer, comme dans le CLI.
  const LENS_KEYS = { 1: 'chat', 3: 'ship', 4: 'branch', 5: 'mcp' };
  function onWindowKey(e) {
    if (ui.modal) return;
    if (inSplit && !focused) return; // in split, only the focused pane reacts to keys
    // Terminal : testé AVANT la garde `isInput`, donc utilisable depuis le composer et depuis le
    // terminal lui-même (xterm laisse passer ces deux combos, cf. Terminal.svelte) — c'est tout
    // l'intérêt d'avoir un raccourci modifié en plus de la touche 2 nue.
    if (matchesEvent(getBinding('open-terminal'), e)) {
      e.preventDefault();
      toggleTerm();
      return;
    }
    if (matchesEvent(getBinding('new-terminal'), e)) {
      e.preventDefault();
      newTerm();
      return;
    }
    if (matchesEvent(getBinding('toggle-dock'), e)) {
      if (dockHasContent) { e.preventDefault(); ui.dockHidden = !ui.dockHidden; }
      return;
    }
    const t = e.target;
    const isInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey && LENS_KEYS[e.key]) {
      e.preventDefault();
      tab = LENS_KEYS[e.key];
      return;
    }
    // 2 = bascule du panneau terminal (il n'est pas une lentille : il reste visible par-dessus
    // n'importe laquelle). Ouvre un premier shell s'il n'y en a aucun.
    if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '2') {
      e.preventDefault();
      toggleTerm();
      return;
    }
    if (e.key !== 'Escape' || tab !== 'chat') return;
    if (t && t.id === 'reply-text') return; // déjà géré par le composer focalisé
    if (!composer) return;
    e.preventDefault();
    composer.interruptEdit();
  }
  onMount(() => { window.addEventListener('keydown', onWindowKey); });
  onDestroy(() => { window.removeEventListener('keydown', onWindowKey); clearTimeout(queuedRetry); });

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
      // avancé), follow-up (dis)paru, ou chat d'une session qui travaille.
      if (qChanged || activityChanged || followupChanged || (tab === 'chat' && sess.state === 'working')) load(true);
    });
  });

  // One-click resume: re-runs `claude --resume` directly — same effort, the permission mode from
  // Settings' default (Normal when unset), no model (see below) — no modal and no message; the
  // Composer takes over once the session is back up.
  let resuming = $state(false);
  let resumeStatus = $state('');
  async function resume() {
    if (resuming) return;
    resuming = true;
    resumeStatus = '';
    // No model on a resume: the CLI restores the session's own, and forcing another one empties its
    // prompt cache (caches are per model). The effort is repeated as-is for the same reason.
    const res = await launch({
      resumeId: s.id, prompt: '',
      effort: s.effort || undefined,
      permissionMode: settings.defaultMode || 'default',
    }).catch((e) => ({ ok: false, data: { error: e?.message || 'failed' } }));
    if (res.ok) {
      unarchive(s.id);
      // Explicit refetch of THIS session's detail (alive, permissionMode…): the tick effect above
      // only reloads on specific diffs against the sidebar list (question/activity/followup change),
      // which a just-resumed session doesn't necessarily trip right away — without this, the pane
      // kept showing the stale "ended" detail (composer disabled) until a manual page refresh.
      setTimeout(() => { loadSessions(); load(true); ui.tick++; resuming = false; }, 1200);
    } else {
      resuming = false;
      resumeStatus = '✗ ' + (res.data?.error || 'failed');
      setTimeout(() => { resumeStatus = ''; }, 5000);
    }
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
  // courante, message vide) et reprend la branche dans une nouvelle session — elle attend. Retour inline
  // sur la bulle ; la nouvelle session apparaît ensuite toute seule dans la sidebar.
  let forkState = $state(null); // { uuid, phase: 'busy'|'done'|'err', text }
  async function quickFork(m) {
    if (!m.forkUuid || forkState?.phase === 'busy') return;
    forkState = { uuid: m.forkUuid, phase: 'busy', text: '⑂ fork…' };
    const payload = { id: s.id, forkUuid: m.forkUuid, prompt: '', model: s.launchModel || modelAlias(s.model), effort: s.effort };
    const res = await fork(payload).catch((e) => ({ ok: false, data: { error: e?.message || 'failed' } }));
    if (res.ok) {
      forkState = { uuid: m.forkUuid, phase: 'done', text: '✓ branch created' + (res.data?.sessionId ? ' → ' + res.data.sessionId.slice(0, 8) : '') };
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
  async function applyModelEffort(force = false) {
    if (meBusy) return;
    meBusy = true;
    meStatus = '…';
    const model = editModel, effort = editEffort;
    const res = await setModelEffort(s.id, model, effort, force).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok && res.data.held) {
      // The prompt cache is warm and a model switch would drop it (server/agent.js →
      // decideModelSwitch): show the CLI's own figures, put the picker back, and only re-apply with
      // `force` once the user confirms.
      const ci = res.data.cacheImpact || {};
      meStatus = '';
      meBusy = false;
      editModel = s.launchModel || modelAlias(s.model) || editModel;
      openModal('confirm', {
        title: 'Switch model and drop a warm cache?',
        message: 'This conversation (' + fmtTokens(ci.contextTokens || 0) + ' tokens) is cached for ' + shortModel(ci.fromModel || s.model || 'the current model')
          + '. Caches are per model: switching to ' + shortModel(ci.toModel || model) + ' re-caches all of it'
          + (ci.estimatedCacheWriteUsd ? ' (≈ ' + fmtCost(ci.estimatedCacheWriteUsd) + ' at the cache-write rate)' : '')
          + '.\n\nWait for the cache to expire, or switch now.',
        confirmLabel: 'Switch anyway',
        onConfirm: () => { editModel = model; editEffort = effort; applyModelEffort(true); },
      });
      return;
    }
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
  // Archive replaces the old Stop: it stops the running session AND moves it to Archived
  // (the two are no longer distinct). `toggleArchive` performs the kill; we just leave the view.
  const archived = $derived(!!s && isArchived(s.id));
  function archive() {
    const delay = archived ? 400 : 800; // stopping a live session takes a moment to settle
    archiving = true;
    toggleArchive(s.id);
    setTimeout(() => { loadSessions(); ui.tick++; archiving = false; }, delay);
  }
  let deleting = $state(false);
  function del() {
    openModal('confirm', {
      title: 'Move to trash?',
      message: 'The transcript is kept in bin/ (recoverable) and the session leaves the dashboard.',
      confirmLabel: 'Move to trash', confirmIcon: 'trash', danger: true, onConfirm: doDel,
    });
  }
  async function doDel() {
    deleting = true;
    const res = await deleteSession(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) { loadSessions(); ui.tick++; }
    else { deleting = false; alert('✗ ' + (res.data.error || 'failed')); }
  }
  // Auto-approbation des permissions d'outil. `autoView` est optimiste tant que le refetch n'a pas
  // confirmé, comme pour le mode de permission.
  let autoBusy = $state(false);
  let autoOverride = $state(null);
  const autoView = $derived(autoOverride ?? (s ? !!s.autoApprove : false));
  async function toggleAuto() {
    if (autoBusy || !s) return;
    autoBusy = true;
    const target = !autoView;
    const res = await setAutoApprove(s.id, target).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      autoOverride = res.data.autoApprove;
      modeStatus = target ? '✓ auto-approve on' : '✓ auto-approve off';
      setTimeout(() => { modeStatus = ''; }, 2000);
      setTimeout(() => { loadSessions(); ui.tick++; }, 400);
    } else {
      modeStatus = '✗ ' + (res.data.error || 'failed');
      setTimeout(() => { modeStatus = ''; }, 3000);
    }
    autoBusy = false;
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
  // Rattachement de l'écho d'une commande au bloc qu'elle a produit, pour l'afficher JUSTE AVANT son
  // terminal. Sans ça l'écho tombait après toute la boucle des messages, donc sous le bloc — on lisait
  // le résultat avant la commande. Une entrée ne s'attache qu'à UN message (le premier qui matche),
  // sinon deux `!!id` identiques colleraient leur écho au même bloc.
  const cmdEchoes = $derived.by(() => {
    const map = new Map();
    const cmds = queued.filter((q) => q.kind && q.cmd);
    if (!cmds.length) return map;
    const msgs = (s && s.messages) || [];
    const used = new Set();
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'user') continue;
      const hit = cmds.find((q) => !used.has(q.ts) && isBlockForCommand(msgs[i].text, q.cmd));
      if (!hit) continue;
      used.add(hit.ts);
      map.set(i, [...(map.get(i) || []), hit]);
    }
    return map;
  });
  // Celles dont le bloc n'est pas encore arrivé : rendues en bas, elles remonteront d'elles-mêmes.
  const pendingQueued = $derived.by(() => {
    const attached = new Set([...cmdEchoes.values()].flat().map((q) => q.ts));
    return queued.filter((q) => !attached.has(q.ts));
  });

  // Copie le deep-link ABSOLU vers cette session (partageable / ouverture à froid). L'origine réelle
  // du navigateur est utilisée → correct quel que soit l'accès (localhost / IP LAN / MagicDNS).
  let linkCopied = $state(false);
  async function copyLink() {
    if (await copyText(location.origin + '/session/' + s.id)) { linkCopied = true; setTimeout(() => (linkCopied = false), 1500); }
  }
  let exportCopied = $state(false);
  async function copyExport() {
    if (await copyText(conversationToMarkdown(s))) { exportCopied = true; setTimeout(() => (exportCopied = false), 1500); }
  }
  // Commande de reprise manuelle. Utile quand on veut la session dans son propre terminal plutôt
  // que dans hooked (un TUI, un pager, du copier-coller lourd) — c'est la MÊME session, l'Agent SDK
  // spawne exactement cette ligne.
  let cmdCopied = $state(false);
  async function copyResumeCmd() {
    const cmd = resumeCommand(s);
    if (!cmd) return;
    if (await copyText(cmd)) { cmdCopied = true; setTimeout(() => (cmdCopied = false), 1500); }
  }
  // Éditeur préféré (réglage partagé) : sert au libellé du bouton et à l'icône.
  const prefEditor = $derived(editorFor(settings.editor));
  let editorBusy = $state(false);
  async function openEditor() {
    if (editorBusy) return;
    editorBusy = true;
    const res = await openInEditor(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!res.ok) alert('✗ ' + (res.data.error || 'failed'));
    editorBusy = false;
  }
  let ghosttyBusy = $state(false);
  async function openGhostty() {
    if (ghosttyBusy) return;
    ghosttyBusy = true;
    const res = await openInGhostty(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!res.ok) alert('✗ ' + (res.data.error || 'failed'));
    ghosttyBusy = false;
  }

  // ---- Context-window fill (header) ----
  // `s.context` = { pct, size }, derived from the session's latest status snapshot. A snapshot is
  // only written from the first turn onwards; before that there is nothing to show, and a gauge at
  // 0% would lie. On a stopped session the value is the LAST known one: we keep it (it is still
  // true as of a Resume) but render it muted (`cold`).
  const ctx = $derived(s && s.context && s.context.pct != null ? s.context : null);
  const ctxTitle = $derived(!ctx ? '' :
    `Context window: ${ctx.pct}% used`
    + (ctx.size ? ` of ${fmtTokens(ctx.size)} tokens` : '')
    + (s.live ? '' : ' — last known value, session is not running'));

  // ── Prompt cache ──────────────────────────────────────────────────────────────────────────────
  // s.cache = the session's cache clock (server/stats.js → sessionCache). Warm/cold is derived here
  // against the local clock (nowMs) so the badge counts down without a refetch.
  const cache = $derived(s && s.cache ? promptCacheState(s.cache, nowMs) : null);
  const cacheKnown = $derived(!!cache && cache.known);
  const fmtMins = (ms) => Math.max(1, Math.ceil(ms / 60000)) + ' min';
  const cacheLabel = $derived(!cacheKnown ? '' : cache.warm ? 'Cache · ' + fmtMins(cache.remainingMs) : 'Cache cold');
  const cacheTitle = $derived(!cacheKnown ? '' : cache.warm
    ? 'Prompt cache warm for ' + fmtMins(cache.remainingMs) + ' more (' + cache.ttl + ' TTL): the next message re-reads the conversation at the cached rate.'
    : 'Prompt cache expired (' + cache.ttl + ' TTL): the next message' + (s.live ? '' : ' or a resume') + ' re-caches the whole conversation'
      + (cache.contextTokens ? ' — about ' + fmtTokens(cache.contextTokens) + ' tokens at the cache-write rate' : '') + '.');
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
        <button class="pane-back" onclick={() => goto('/')} title="Back to list"><Icon name="arrow-left" /></button>
      {/if}
      {#if renaming}
        <span class="sess-rename-wrap" class:has-restore={!!ui.names[s.id]}>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="sess-rename-inline" autofocus bind:value={renameVal}
                 placeholder={s.title || 'Session title'}
                 onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = false; }}
                 onblur={commitRename} />
          <!-- Restaurer le titre auto : DANS le champ, et seulement en édition — hors édition il
               n'avait rien à proposer d'actionnable et occupait la ligne en permanence.
               `mousedown` annulé : sans ça le blur du champ commit le renommage et démonte le
               bouton avant que son clic n'arrive. -->
          {#if ui.names[s.id]}
            <button class="sess-restore"
                    title={`Drop the custom name and restore the automatic title${s.title ? ` (“${s.title}”)` : ''}`}
                    aria-label="Restore automatic title"
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => { renaming = false; renameSession(s.id, ''); }}><Icon name="restore" size={14} /></button>
          {/if}
        </span>
      {:else}
        <button class="sess-name" onclick={startRename} title="Rename this session (local)">{sessionTitle(s)}</button>
      {/if}
      <span class="head-meta" title={s.project || ''}>{s.repo || s.projectName || '?'}{#if s.gitBranch} · <Icon name="git-branch" size={13} /> {s.gitBranch}{/if}</span>
      {#if sessionTags(id).length}
        <!-- tags de session (manuels + auto-tag PR) : cliquer ouvre l'éditeur -->
        <button class="head-tags" onclick={() => openModal('editTags', { sessionId: id })} title="Edit tags">
          {#each sessionTags(id) as t (t)}<span class="head-tag" style="--c:{tagColor(t)}">#{t}</span>{/each}
        </button>
      {/if}
      <span class="badge s-badge"><span class="bdot"></span>{s.state === 'working' && s.activity ? s.activity + '…' : (STATE_LABEL[s.state] || s.state)}</span>
      <!-- Context-window fill (s.context, cf. server/status.js): the one TUI reading the dashboard
           could not surface, though it decides whether to compact or fork. Two producers, one
           format: statusline-tap.sh for a session opened by hand, server/agent-status.js for a
           driven one. Missing as long as no snapshot exists (very young session) → render nothing. -->
      {#if ctx}
        <span class="ctx-gauge" class:warn={ctx.pct >= 75} class:crit={ctx.pct >= 90} class:cold={!s.live}
              title={ctxTitle}>
          <span class="ctx-lbl">CTX</span>
          <span class="ctx-track"><span class="ctx-fill" style="width:{Math.min(100, ctx.pct)}%"></span></span>
          <span class="ctx-pct">{ctx.pct}%</span>
        </span>
      {/if}

      <div class="head-actions">
        <!-- Prompt-cache clock (s.cache): warm = the next message re-reads the conversation at the
             cached rate, cold = it re-caches all of it. For an ended session this is what a Resume
             costs right now. Counts down locally. -->
        {#if cacheKnown}
          <span class="cache-badge" class:warm={cache.warm} title={cacheTitle}>
            <Icon name={cache.warm ? 'zap' : 'clock'} size={12} tint={false} /> {cacheLabel}
          </span>
        {/if}
        {#if s.live}
          <!-- modèle/effort + mode de permission vivent dans le menu ⋯ ; seul le retour
               éphémère d'un changement (✓ Auto, ✗ failed…) s'affiche ici. -->
          {#if modeStatus || meStatus}<span class="strip-status">{modeStatus || meStatus}</span>{/if}
        {:else}
          {#if resumeStatus}<span class="strip-status err">{resumeStatus}</span>{/if}
          <button class="resume-btn" disabled={resuming} onclick={resume}
                  title="Re-run claude --resume, driven by hooked">{#if resuming}<Icon name="queued" size={14} />{:else}<Icon name="in-progress" size={14} tint={false} />{/if} Resume</button>
        {/if}
        <!-- The one Archive control: stops the session when it runs, hides it, reversible. -->
        <button class="archive-btn" disabled={archiving} onclick={archive}
                title={archived ? 'Restore this session to the live fleet' : s.live ? 'Stop the running session and move it to Archived' : 'Move this session to Archived'}>{#if archiving}<Icon name="queued" size={14} tint={false} />{:else if archived}<Icon name="unarchive" size={14} tint={false} /> Unarchive{:else}<Icon name="archive" size={14} tint={false} /> Archive{/if}</button>
        {#if !inSplit}
          <button class="hdr-icon-btn" title="Split with the most recent session (⌘/Ctrl+⇧+S)"
                  aria-label="Split view" disabled={!canSplit()} onclick={() => splitWithMostRecent(id)}><Icon name="pane" size={16} /></button>
        {/if}
        <details class="hdr-more">
          <summary title="More actions" aria-label="More actions"><Icon name="menu" size={18} /></summary>
          <div class="hdr-menu">
            <!-- Réglages fréquents (modèle/effort + mode de permission) : rangés ici en
                 permanence pour garder l'en-tête compact — le titre reste l'info principale. -->
            {#if s.live}
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
                    <!-- Orthogonal au mode : le mode décide QUI escalade (règles, classifieur du
                         mode auto), ceci décide si hooked te pose la question quand ça escalade. -->
                    <button class="mode-chip auto-chip" class:active={autoView} disabled={autoBusy}
                            onclick={toggleAuto}
                            title={autoView
                              ? 'Auto-approve is ON: tool permission requests are allowed without asking. Questions and plans still come to you.'
                              : 'Auto-approve tool permissions: stop asking for each escalated tool call. Questions and plans still come to you.'}>
                      <span class="mode-ico">⚡</span>Auto-approve · {autoView ? 'on' : 'off'}</button>
                  </div>
                {/if}
              </div>
              <div class="hdr-div cmds-div"></div>
            {/if}
            <button class="vscode-btn" onclick={() => openModal('cost', { sessionId: id })} title="Estimated cost breakdown for this session"><Icon name="cost" size={14} /> Cost · {fmtCost(s.cost)}{#if s.subagentCost > 0} (+{fmtCost(s.subagentCost)} agents){/if}</button>
            <div class="hdr-div"></div>
            <button class="vscode-btn" title="Copy a shareable link that opens this session in hooked" onclick={copyLink}>{#if linkCopied}<Icon name="check" size={14} /> copied{:else}<Icon name="link" size={14} /> Copy link{/if}</button>
            <button class="vscode-btn" disabled={editorBusy} onclick={openEditor} title="Open the entire project in {prefEditor.label} (change it in Settings → Editor)">{#if editorBusy}<Icon name="queued" size={14} />{:else}<Icon name={prefEditor.icon} size={14} />{/if} Open in {prefEditor.label}</button>
            <button class="vscode-btn" disabled={ghosttyBusy} onclick={openGhostty} title="Open the project folder in Ghostty">{#if ghosttyBusy}<Icon name="queued" size={14} />{:else}<Icon name="ghostty" size={14} />{/if} Open in Ghostty</button>
            <button class="vscode-btn" onclick={copyResumeCmd}
                    title={s.live
                      ? 'Copy `claude --resume` for this session — WARNING: hooked is driving it right now, running the command too would fight over the session lock'
                      : 'Copy `claude --resume` for this session, to reopen it in your own terminal'}>{#if cmdCopied}<Icon name="check" size={14} /> copied{:else}<Icon name="shell" size={14} /> Copy resume command{/if}</button>
            <button class="vscode-btn" onclick={copyExport} title="Copy the conversation as Markdown to the clipboard">{#if exportCopied}<Icon name="check" size={14} /> copied{:else}<Icon name="copy" size={14} /> Copy as Markdown{/if}</button>
            <button class="vscode-btn" onclick={() => openModal('editTags', { sessionId: id })} title="Add or remove tags on this session (PR review tags are automatic)"><Icon name="tag" size={14} /> Edit tags</button>
            {#if sb.focusBtn !== false}<button class="vscode-btn" class:on={ui.focus} onclick={toggleFocus} title="Focus mode: full-screen conversation"><Icon name="maximize" size={14} /> {ui.focus ? 'Exit focus' : 'Focus'}</button>{/if}
            <button class="vscode-btn" class:on={ui.toolsOpen} onclick={() => (ui.toolsOpen = !ui.toolsOpen)} title="Expand every tool call's input/result inline (this session only, off on reload)"><Icon name="tool" size={14} /> {ui.toolsOpen ? 'Collapse tool details' : 'Expand tool details'}</button>
            <div class="hdr-div"></div>
            <button class="vscode-btn del-btn" disabled={deleting} onclick={del} title="Move to trash: removes from dashboard; transcript kept in bin/ (recoverable)">{#if deleting}<Icon name="queued" size={14} tint={false} />{:else}<Icon name="trash" size={14} tint={false} />{/if} Delete</button>
          </div>
        </details>
      </div>
    </div>
    <div class="subtabs lenses">
      {#each LENSES as l (l.key)}
        <button class="subtab" class:active={tab === l.key} onclick={() => { tab = l.key; }}
                title="{l.label} — key {l.kbd}">
          <Icon name={l.icon} size={14} /> {l.label}
          {#if lensCount[l.key]}<span class="count">{lensCount[l.key]}</span>{/if}
          <kbd class="lens-kbd">{l.kbd}</kbd>
        </button>
      {/each}
    </div>
  </div>

  <div class="body-row">
  <div class="pane-body" class:flush={tab === 'ship' || tab === 'branch'} bind:this={body}
       onscroll={() => { if (body) stickToBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 60; }}>
    <!-- la conversation reste montée en lentille Build (colonne copilote à côté de l'IDE) -->
    <div class="pane" class:active={tab === 'chat'}>
      <div class="chat">
        <!-- Une seule définition : la même bulle est rendue soit au-dessus de son bloc (écho rattaché),
             soit en bas du fil tant que le bloc n'est pas arrivé. -->
        {#snippet commandBubble(q)}
          <div class="bubble user" class:queued={!q.kind} class:command={q.kind}>
            <div class="who"><Icon name="user" size={14} /> You
              {#if q.kind}
                <span class="t"><Icon name="shell" size={13} /> {q.kind === 'interactive' ? 'interactive command' : 'command'}</span>
              {:else}
                <span class="t"><Icon name="queued" size={13} /> queued</span>
              {/if}
            </div>
            <div class="md">{q.text}</div>
          </div>
        {/snippet}
        {#if startIdx > 0}
          <button class="show-earlier" onclick={showEarlier}><Icon name="arrow-up" size={14} /> Show earlier messages · {startIdx} hidden</button>
        {/if}
        {#if (s.messages || []).length}
          <!-- key by stable ABSOLUTE index (startIdx + j), NOT m.ts: the streaming turn's ts advances on every
               block (conversation.js rewrites prev.ts), so a ts-based key destroys+recreates the whole live bubble
               each tick → the "jumps". Transcript is append/merge-only, so a message's absolute index never moves,
               even as the render window slides → the key stays stable across MSG_STEP expansions and new ticks. -->
          {#each (s.messages || []).slice(startIdx) as m, j (startIdx + j)}
            {#each cmdEchoes.get(startIdx + j) || [] as q (q.ts)}{@render commandBubble(q)}{/each}
            <ChatBubble {m} onfork={quickFork} onforkadvanced={openFork} {forkState} session={id} />
          {/each}
        {:else if !queued.length}
          <div class="pane-empty">Empty conversation.</div>
        {/if}
        {#each pendingQueued as q (q.ts)}{@render commandBubble(q)}{/each}
        <!-- Lead-in of the pending question / plan (server: pendingLeadIn — the prose Claude streamed
             before handing over). Until you answer, Claude Code writes nothing of this turn to the
             transcript → without it the question card arrived without the text explaining it. -->
        {#if s.pendingLeadIn && tab === 'chat'}
          <div class="bubble assistant leadin">
            <div class="who"><Icon name="bot" size={14} /> Claude
              <span class="t" title="Claude Code only writes this turn to the transcript once you have answered — this text comes from the live stream">
                <Icon name="activity" size={13} /> live stream
              </span>
            </div>
            <pre class="leadin-txt">{s.pendingLeadIn}</pre>
          </div>
        {/if}
        <!-- Tour en cours, en direct : le texte tel qu'il s'écrit, avant que le message ne soit
             flushé dans le transcript. Remplacé par la vraie bulle au refetch suivant. Masqué tant
             qu'une question / un plan attend : le lead-in ci-dessus porte déjà cette prose (le tampon
             de flux n'est vidé qu'au `result`), l'afficher aussi la doublait. -->
        {#if tab === 'chat' && (liveText || liveThinking) && !s.pendingLeadIn}
          <div class="bubble assistant streaming">
            <div class="who"><Icon name="bot" size={14} /> Claude
              <span class="t"><span class="sd-dot" aria-hidden="true"></span> en direct</span>
            </div>
            {#if liveThinking}<pre class="sd-thinking">{liveThinking}</pre>{/if}
            {#if liveText}<div class="md sd-text">{liveText}</div>{/if}
          </div>
        {/if}
        {#if s.state === 'working' && tab === 'chat'}
          <div class="working-live" title="Claude is working — new messages appear once flushed">
            <span class="wl-dots" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="wl-verb">{liveTool || s.activity || 'Working'}…</span>
            {#if workElapsed}<span class="wl-sep">·</span><span class="wl-time">{workElapsed}</span>{/if}
          </div>
        {/if}
      </div>
      {#if s.pendingQuestion}<Question {id} pq={s.pendingQuestion} />{/if}
      {#if s.pendingPlan}<Plan {id} pp={s.pendingPlan} />{/if}
      {#if s.live}
        <!-- La carte de follow-up est rendue PAR le composer, dans son socle : elle ne défile plus
             avec le transcript. Elle n'existait de toute façon que pour une session pilotée
             (`followupSuggestion` vient du registre de l'Agent SDK), donc rien n'est perdu à la
             faire dépendre de ce `{#if}`. Seul le masquage remonte ici, car il est persisté. -->
        <Composer bind:this={composer} {id} project={s.project} lastPrompt={s.lastPrompt || ''} {onSent}
                  followup={showFollowup ? followup : null} onFollowupDismiss={dismissFollowup} />
      {/if}
    </div>

    <!-- Lentille Ship : relecture des changements de Claude + expédition (composant dédié). -->
    <div class="pane pane-flush" class:active={tab === 'ship'}>
      {#if seen.ship}
        <Ship {s} {id} onReview={reviewChanges} canReview={!!(s.live)} active={tab === 'ship'} />
      {/if}
    </div>

    <!-- Lentille Branch : le diff COMPLET d'une branche vs une base (merge-base → tête),
         façon « Files changed » d'une PR, avec sélecteur de branche. -->
    <div class="pane pane-flush" class:active={tab === 'branch'}>
      {#if seen.branch}
        <Branch {s} {id} onReview={reviewChanges} canReview={!!(s.live)} active={tab === 'branch'} />
      {/if}
    </div>

    <!-- Lentille MCP : santé des serveurs MCP du projet de la session + ré-authentification. -->
    <div class="pane" class:active={tab === 'mcp'}>
      {#if seen.mcp}
        <Mcp project={s.project || ''} />
      {/if}
    </div>

  </div>

  <!-- dock contextuel (lentille Converse) : tasks / changements / agents / jobs / liens.
       Masquable par l'utilisateur (persisté ui.dockHidden) → rail fin pour le rouvrir.
       Pas rendu du tout (ni le rail) quand la session n'a AUCUN contenu contextuel. -->
  {#if tab === 'chat' && dockHasContent && !(inSplit && ui.splitCompact)}
    {#if ui.dockHidden}
      <button class="dock-reopen" onclick={() => (ui.dockHidden = false)} title="Show the context panel" aria-label="Show the context panel"><Icon name="arrow-left" size={14} /></button>
    {:else}
      <Dock {s} {id} onship={() => (tab = 'ship')} />
    {/if}
  {/if}
  </div>

  <!-- Terminaux shell : panneau bas redimensionnable, visible quelle que soit la lentille active.
       Le tiroir dessous le bascule (touche 2). Ces shells sont indépendants de la session Claude et
       lui survivent — recharger la page ne les tue pas, ils vivent dans le processus hooked. -->
  {#if termOpen}
    <div class="term-panel" style="height:{ui.termHeight ? ui.termHeight + 'px' : '33vh'}">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="term-resize" onpointerdown={startTermResize} title="Drag to resize"></div>
      <div class="term-bar">
        <div class="term-tabs">
          {#each terms as t (t.id)}
            <div class="term-chip" class:active={termId === t.id} class:dead={t.exited}>
              <button class="term-tab" onclick={() => (termId = t.id)} title={t.cwd}>
                <Icon name="shell" size={13} /> {t.id.slice(-4)}{#if t.exited} · exited{/if}
              </button>
              <button class="term-x" title="Close this terminal" disabled={termBusy}
                      onclick={() => closeTerm(t.id)}><Icon name="close" size={13} /></button>
            </div>
          {/each}
          <button class="term-new" title={`New shell in this project (${termNewKeys})`} disabled={termBusy || !s.project}
                  onclick={newTerm}><Icon name="plus" size={13} /></button>
        </div>
        <button class="term-close" onclick={() => (termOpen = false)} title={`Hide the terminal panel (key 2 or ${termToggleKeys})`}>
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
      <!-- key : remonter le composant au changement d'onglet, chaque terminal a son propre flux -->
      {#key termId}
        {#if termId}
          <Terminal id={termId} onclosed={onTermClosed} />
        {:else}
          <div class="term-void">{termBusy ? 'opening a shell…' : 'no shell here yet — hit + to open one'}</div>
        {/if}
      {/key}
    </div>
  {/if}
  <!-- tiroir : ouvre le panneau, ou crée le premier shell s'il n'y en a aucun -->
  {#if !termOpen}
    <button class="term-drawer" onclick={toggleTerm}
            title={`Shell in this project (key 2 or ${termToggleKeys})`}>
      <span class="td-name"><Icon name="shell" size={13} /> Terminal</span>
      <span class="td-info">{terms.length ? terms.length + ' open' : 'open a shell in ' + (s.projectName || 'this project')}</span>
      <span class="td-open">open <kbd>2</kbd> <kbd>{termToggleKeys}</kbd> <Icon name="arrow-up" size={13} /></span>
    </button>
  {/if}
  </div>
  </div>
{/if}

<style>
  .detail-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  /* split pane: the focused pane gets an accent rail. */
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
  /* Le titre et son champ d'édition partagent EXACTEMENT la même boîte (flex, min-width, padding,
     bordure, marges de compensation). Toute différence — l'input ne grandissait pas, était plus
     haut de 6px à cause du padding + bordure — décale la branche, le badge et les actions dès
     qu'on bascule en édition.
     Le TITRE est l'info prioritaire : il PREND l'espace libre (flex-grow) et garde un plancher
     lisible (min-width), au lieu d'être le premier écrasé. Ce sont la branche/le statut puis les
     boutons (repliés par les container queries plus bas) qui cèdent la place avant lui.
     Les marges négatives annulent padding + bordure : la ligne garde la hauteur et la position
     du texte qu'elle avait sans champ. */
  .sess-name, .sess-rename-inline {
    flex: 1 1 auto; width: 0; min-width: 96px; max-width: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: inherit; font-size: 15px; font-weight: 800; letter-spacing: -.01em;
    padding: 2px 6px; margin: -3px -6px; border: 1px solid transparent; border-radius: 7px;
    color: var(--text); text-align: left;
  }
  .sess-name { background: none; cursor: text; }
  .sess-name:hover { color: var(--accent-d); }
  .sess-rename-inline { background: var(--input); border-color: var(--accent); }
  .sess-rename-inline:focus { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
  /* Le champ d'édition devient l'enfant flex : c'est l'enveloppe qui porte la largeur, pour que le
     bouton de restauration puisse se poser DANS le champ sans sortir du flux de la ligne. */
  .sess-rename-wrap { position: relative; display: flex; align-items: center; flex: 1 1 auto; width: 0; min-width: 96px; }
  .sess-rename-wrap .sess-rename-inline { flex: 1 1 auto; width: 100%; min-width: 0; }
  .sess-rename-wrap.has-restore .sess-rename-inline { padding-right: 26px; }
  .sess-restore {
    position: absolute; right: 0; display: inline-flex; align-items: center;
    background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; padding: 0 2px;
  }
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
  /* Header context gauge: same visual vocabulary as the account gauges of the TopBar (label +
     track + %), in a single-line version. `warn` (>=75%) and `crit` (>=90%) reuse the same
     thresholds, so one glance is enough to know whether it is time to compact. */
  .ctx-gauge {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
    font: 600 9.5px var(--mono); letter-spacing: .04em; color: var(--muted);
    padding: 2px 7px; border: 1px solid var(--border2); border-radius: 999px;
  }
  .ctx-lbl { opacity: .8; }
  .ctx-track { width: 42px; height: 4px; border-radius: 999px; background: var(--bg3); overflow: hidden; }
  .ctx-fill { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
  .ctx-pct { color: var(--text); font-variant-numeric: tabular-nums; }
  .ctx-gauge.warn .ctx-fill { background: var(--warn); }
  .ctx-gauge.warn { border-color: rgba(var(--warn-rgb), .45); }
  .ctx-gauge.crit .ctx-fill { background: var(--danger); }
  .ctx-gauge.crit { border-color: rgba(var(--warn-rgb), .7); }
  /* stopped session: last known value, hence muted (cf. ctxTitle). */
  .ctx-gauge.cold { opacity: .55; }
  /* Prompt-cache clock: same pill as the context gauge; warm = readable, cold = muted. */
  .cache-badge {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px;
    font: 600 9.5px var(--mono); letter-spacing: .04em; color: var(--muted); font-variant-numeric: tabular-nums;
    padding: 2px 7px; border: 1px solid var(--border2); border-radius: 999px;
  }
  .cache-badge.warm { color: var(--text); border-color: rgba(var(--warn-rgb), .45); }
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
  }
  @container (max-width: 440px) {
    /* 3) enfin le statut et la branche disparaissent ; le TITRE, lui, reste toujours lisible. */
    .head-meta, .s-badge, .head-tags, .ctx-gauge, .cache-badge { display: none; }
  }
  .head-line + :global(.subtabs) { margin-top: 9px; }
  .strip-modes { display: flex; gap: 4px; }
  /* chip auto-approve : visuellement distinct des modes (c'est un interrupteur, pas un choix
     exclusif dans le cycle) → liseré en pointillés quand inactif. */
  /* Bulle du tour en cours : même forme qu'une bulle assistant, mais signalée comme provisoire
     (liseré d'accent + texte préformaté pour ne pas reflower du markdown incomplet). */
  .bubble.streaming { border-left: 2px solid var(--accent); opacity: .92; }
  /* Commande envoyée depuis le composer : rose, pour la distinguer d'un vrai message ET d'un envoi
     en attente (ambre). Couleur en dur plutôt qu'une variable de thème : il n'y a pas de rose dans
     la palette, et en inventer une pour un seul usage serait une variable de plus à maintenir. */
  .bubble.user.command {
    background: #b8377f; box-shadow: none;
    border: 1px dashed rgba(255, 255, 255, .5);
  }
  .bubble.user.command .who .t { font-weight: 600; opacity: .95; display: inline-flex; align-items: center; gap: 4px; }
  .bubble.user.command .md { font-family: var(--mono); font-size: 12px; }
  .sd-text { white-space: pre-wrap; }
  .sd-thinking {
    margin: 0 0 8px; padding: 6px 8px; border-radius: 6px;
    background: var(--bg3); color: var(--muted);
    font: 11.5px/1.5 var(--mono); white-space: pre-wrap; max-height: 160px; overflow-y: auto;
  }
  .sd-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent); animation: sd-pulse 1s ease-in-out infinite;
  }
  @keyframes sd-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }

  /* Panneau terminal bas : hauteur pilotée par l'utilisateur (drag), xterm remplit le reste.
     Styles gardés DANS le composant plutôt que dans app.css — scoping Svelte, et app.css est
     retravaillé en parallèle pour le thème Datadog. */
  .term-panel {
    flex: 0 0 auto; position: relative; display: flex; flex-direction: column; min-height: 0;
    border-top: 1px solid var(--border); background: var(--bg2);
  }
  .term-resize { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: row-resize; z-index: 6; }
  .term-resize:hover { background: var(--accent); opacity: .5; }
  .term-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--bg3);
  }
  .term-tabs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
  .term-chip { display: inline-flex; align-items: center; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .term-chip.active { border-color: var(--accent); }
  .term-chip.active .term-tab { color: var(--accent-d); }
  .term-chip.dead .term-tab { opacity: .55; }
  .term-tab {
    background: none; border: none; color: var(--muted); padding: 3px 8px; cursor: pointer;
    font-family: var(--mono); font-size: 11px; display: inline-flex; align-items: center; gap: 5px;
  }
  .term-tab:hover { color: var(--text); }
  .term-x { background: none; border: none; border-left: 1px solid var(--border); color: var(--muted); cursor: pointer; padding: 3px 5px; line-height: 1; }
  .term-x:hover:not(:disabled) { color: var(--danger); background: rgba(var(--danger-rgb), .12); }
  .term-new {
    background: var(--bg2); border: 1px dashed var(--border2); color: var(--muted);
    border-radius: 6px; padding: 3px 9px; cursor: pointer; line-height: 1;
  }
  .term-new:hover:not(:disabled) { color: var(--accent-d); border-color: var(--accent); }
  .term-new:disabled { opacity: .4; cursor: default; }
  .term-close { margin-left: auto; flex: 0 0 auto; background: none; border: none; color: var(--muted); cursor: pointer; padding: 2px 4px; }
  .term-close:hover { color: var(--text); }
  /* panneau ouvert sans terminal actif (le temps d'en créer un, ou après avoir fermé le dernier) */
  .term-void {
    flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
    font-family: var(--mono); font-size: 11px; color: var(--muted); background: var(--code-bg);
  }

  /* tiroir sous la conversation : un clic ouvre le panneau (ou crée le premier shell) */
  .term-drawer {
    flex: 0 0 auto; display: flex; align-items: center; gap: 9px;
    margin: 0; padding: 6px 16px; width: 100%;
    background: var(--bg3); border: none; border-top: 1px solid var(--border);
    color: var(--muted); font-family: var(--mono); font-size: 11px; cursor: pointer; text-align: left;
  }
  .term-drawer:hover { background: var(--hover); color: var(--text); }
  .term-drawer:hover .td-open { color: var(--accent); }
  .td-name { color: var(--text); font-weight: 600; }
  .td-info { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .td-open { margin-left: auto; flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; }
  .td-open kbd { font: 9px/1 var(--mono); border: 1px solid var(--border2); border-radius: 4px; padding: 1px 4px; }

  .auto-chip { border-style: dashed; }
  .auto-chip.active { border-style: solid; }
  .strip-status { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
  .strip-status.err { color: var(--danger); }

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
    display: flex; align-items: center; gap: 8px; width: 100%; justify-content: flex-start; text-align: left;
    border: none; border-radius: 8px; padding: 7px 10px;
  }
  /* bulle « lu dans le terminal » : introduction d'une question en attente, absente du transcript
     tant qu'on n'a pas répondu. Liseré pointillé = contenu volatile (relu dans la pane). */
  .bubble.leadin { border-style: dashed; max-width: 100%; }
  .bubble.leadin .who .t { color: var(--success); font-weight: 600; display: inline-flex; align-items: center; gap: 4px; }
  .leadin-txt { margin: 0; white-space: pre-wrap; overflow-x: auto; font: 12px/1.55 var(--mono); }

  /* bouton « révéler les messages plus anciens » en tête du transcript fenêtré */
  .show-earlier {
    display: block; margin: 4px auto 10px; padding: 5px 14px;
    font-size: 12.5px; color: var(--muted); font-weight: 600;
    background: var(--bg2); border: 1px dashed var(--border); border-radius: 999px;
    cursor: pointer;
  }
  .show-earlier:hover { color: var(--text); background: var(--bg3); border-color: var(--accent); }
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
