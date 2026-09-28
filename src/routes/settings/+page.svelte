<script>
  import { untrack, onMount } from 'svelte';
  import { data, ui, settings, updateSettings, setTheme, setScheme, setCorners, loadSessions, allTags, tagUsage, deleteTag } from '$lib/state.svelte.js';
  import { tagColor } from '$lib/format.js';
  import { resync, getGit, checkoutBranch, dismissRestartNotice, getClaudeVersion, upgradeClaude, restartClaudeSession, pickFolder, getRemoteControl, getCapabilities, getWarmup, runWarmup } from '$lib/api.js';
  import { COMPACT_LEAD_MS, CACHED_READ_SHARE } from '$lib/promptCache.js';
  import { isHideableModel } from '$lib/models.js';
  import { getAllBindings, setBinding, resetBinding, resetAll as resetAllShortcuts, formatKeys, keysFromEvent } from '$lib/shortcuts.js';
  import { NAV_TABS } from '$lib/nav.js';
  import ModelEffort from '$lib/components/ModelEffort.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { EDITORS } from '$lib/editors.js';
  import { fold, findTermRanges } from '$lib/textMatch.js';
  import { highlightsSupported } from '$lib/codeHit.js';

  // Navigation de section (rail gauche collant). Chaque entrée pointe l'id d'une carte ;
  // les cartes secondaires appartiennent à la section la plus proche au-dessus.
  const NAV = [
    { id: 'pset-appearance', label: 'Appearance' },
    { id: 'pset-sidebar', label: 'Sidebar' },
    { id: 'pset-editor', label: 'Editor' },
    { id: 'pset-speech', label: 'Voice dictation' },
    { id: 'pset-new', label: 'New session defaults' },
    { id: 'pset-models', label: 'Models' },
    { id: 'pset-project', label: 'Default project' },
    { id: 'pset-remote-control', label: 'Remote control' },
    { id: 'pset-digest', label: 'Daily digest' },
    { id: 'pset-warmup', label: '5-hour window' },
    { id: 'pset-autocompact', label: 'Auto-compact' },
    { id: 'pset-live', label: 'Live state' },
    { id: 'pset-claude', label: 'Claude Code' },
    { id: 'pset-git', label: 'Git' },
    { id: 'pset-tags', label: 'Tags' },
    { id: 'pset-shortcuts', label: 'Keyboard shortcuts' },
    { id: 'pset-interface', label: 'Interface' },
  ];
  // Locales offered for voice dictation (Web Speech API). Recognition quality depends on the
  // browser's own support for the chosen language.
  const SPEECH_LOCALES = [
    { key: 'fr-FR', label: 'Français (France)' },
    { key: 'fr-CA', label: 'Français (Canada)' },
    { key: 'en-US', label: 'English (US)' },
    { key: 'en-GB', label: 'English (UK)' },
    { key: 'es-ES', label: 'Español (España)' },
    { key: 'de-DE', label: 'Deutsch' },
    { key: 'it-IT', label: 'Italiano' },
    { key: 'pt-PT', label: 'Português' },
    { key: 'nl-NL', label: 'Nederlands' },
  ];
  let activeSec = $state(NAV[0].id);

  // ─── 5-hour window ───────────────────────────────────────────────────────────────────────
  // The plan (anchor + the day's windows) is computed server-side and refetched after every edit:
  // the anchor is derived from the working hours, so it must never be guessed twice.
  const DAY_LABELS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
  let warmupPlan = $state(null);
  let warmupPinging = $state(false);
  let warmupStatusMsg = $state('');
  const wu = $derived(settings.warmup || {});
  // Auto-compact (cf. server/agent.js → shouldAutoCompact); the figures come from the cache model.
  const ac = $derived(settings.autoCompact || {});
  const saveAutoCompact = (patch) => updateSettings({ autoCompact: { ...settings.autoCompact, ...patch } });
  const saveSidebarCache = (patch) => updateSettings({ sidebarCache: { ...settings.sidebarCache, ...patch } });
  const AC_LEAD_MIN = Math.round(COMPACT_LEAD_MS / 60000);
  const AC_READ_PCT = Math.round(CACHED_READ_SHARE * 100);
  async function loadWarmupPlan() {
    try { warmupPlan = await getWarmup(); } catch (_) {}
  }
  async function saveWarmup(patch) {
    await updateSettings({ warmup: { ...settings.warmup, ...patch } });
    loadWarmupPlan();
  }
  function setSlot(i, edge, value) {
    const slots = (wu.workHours || []).map((s) => [...s]);
    if (!slots[i]) return;
    slots[i][edge] = value;
    if (slots[i][0] >= slots[i][1]) return; // rejected by the server anyway — don't round-trip it
    saveWarmup({ workHours: slots });
  }
  function addSlot() {
    saveWarmup({ workHours: [...(wu.workHours || []), ['14:00', '18:00']] });
  }
  function removeSlot(i) {
    saveWarmup({ workHours: (wu.workHours || []).filter((_, j) => j !== i) });
  }
  function toggleDay(d) {
    const days = new Set(wu.days || []);
    if (days.has(d)) days.delete(d); else days.add(d);
    saveWarmup({ days: [...days].sort() });
  }
  async function pingNow() {
    warmupPinging = true;
    warmupStatusMsg = '';
    const res = await runWarmup();
    warmupPinging = false;
    const r = res.data?.result;
    warmupStatusMsg = r?.ok
      ? 'Ping sent — the 5h gauge picks up the new window within a minute.'
      : 'Failed: ' + (r?.error || res.data?.error || 'unknown error');
    loadWarmupPlan();
  }
  const fmtWork = (min) => (min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60}`);
  // Tag deletion is two-click (arm → confirm) to avoid removing a tag from every session by mistake.
  let confirmTag = $state(null);
  function removeTag(tag) {
    if (confirmTag !== tag) { confirmTag = tag; return; }
    deleteTag(tag);
    confirmTag = null;
  }
  function goTo(id) {
    activeSec = id;
    let el = document.getElementById(id);
    // While searching, the section's own card may be filtered out → land on its first visible card.
    while (el?.hidden && el.nextElementSibling && !el.nextElementSibling.hasAttribute('data-sec')) el = el.nextElementSibling;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // scroll-spy : la section dont le haut franchit la bande supérieure devient active.
  onMount(() => {
    const root = document.getElementById('view-settings');
    if (!root) return;
    const secs = [...root.querySelectorAll('[data-sec]')];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) activeSec = e.target.id;
    }, { root, rootMargin: '-8% 0px -80% 0px', threshold: 0 });
    secs.forEach((s) => io.observe(s));
    loadWarmupPlan();
    return () => io.disconnect();
  });

  // ── Search ────────────────────────────────────────────────────────────────────────────────────
  // Filters the cards on their RENDERED text (title, hints, checkbox / chip / option labels,
  // shortcut names, tags, model versions…) prefixed with the label of the section they belong
  // to, so both a category ("Appearance") and one buried setting ("stash", "haiku") are found.
  // Reading the DOM instead of a hand-kept keyword index keeps every new control searchable for
  // free. Cards are hidden with the `hidden` attribute — Svelte never touches it here, so the two
  // don't fight. A MutationObserver re-applies the filter when a card's content shows up
  // asynchronously (model list, claude version, tags…), otherwise a query typed before the load
  // would keep that card hidden for good. All terms must match (AND), accents/case are ignored.
  let query = $state('');
  let cardsEl = $state(null);
  let navEl = $state(null);
  let matchSecs = $state.raw(null);   // null = no filter ; Set<section id> with ≥1 visible card
  let matchCount = $state(0);
  const termsOf = (q) => fold(q).split(/\s+/).filter(Boolean);
  const NAV_LABEL = Object.fromEntries(NAV.map((n) => [n.id, fold(n.label)]));
  function applyFilter() {
    if (!cardsEl) return;
    const cards = [...cardsEl.querySelectorAll('.card')];
    const terms = termsOf(query);
    if (!terms.length) {
      for (const c of cards) c.hidden = false;
      matchSecs = null; matchCount = cards.length;
      return;
    }
    const secs = new Set();
    let sec = '', n = 0;
    for (const c of cards) {
      if (c.hasAttribute('data-sec')) sec = c.id;
      const hay = (NAV_LABEL[sec] || '') + ' ' + fold(c.textContent || '');
      const ok = terms.every((t) => hay.includes(t));
      c.hidden = !ok;
      if (ok) { n++; if (sec) secs.add(sec); }
    }
    matchSecs = secs; matchCount = n;
    if (n && !secs.has(activeSec)) activeSec = secs.values().next().value;
  }
  // Only `query` / `cardsEl` are tracked: applyFilter also reads `activeSec` (scroll-spy), which
  // must not re-run the filter on every scroll.
  $effect(() => { query; cardsEl; untrack(applyFilter); });
  onMount(() => {
    // Attributes are deliberately not observed: applyFilter sets `hidden` itself.
    const mo = new MutationObserver(() => { if (query) applyFilter(); });
    mo.observe(cardsEl, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  });
  // Paint every copy of the typed terms — visible cards and rail labels — with the CSS Custom
  // Highlight API, as DiffView does for its occurrence echo: no node is added or split, so Svelte's
  // text-node references stay valid and the MutationObserver above is never tripped. It keys on
  // `matchSecs` rather than running inside applyFilter so it sees the rail AFTER Svelte re-rendered
  // it (a section that comes back gets its label painted too); applyFilter builds a fresh Set per
  // pass, so an observer-triggered re-filter over new content repaints as well. No API → no paint.
  const HL = 'settings-search';
  $effect(() => {
    query; matchSecs; cardsEl; navEl;
    if (!highlightsSupported()) return;
    const terms = termsOf(query);
    if (!terms.length || !cardsEl) { CSS.highlights.delete(HL); return; }
    const ranges = [];
    const roots = [...(navEl?.querySelectorAll('a') ?? []), ...cardsEl.querySelectorAll('.card:not([hidden])')];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()); ) {
        for (const [s, e] of findTermRanges(node.nodeValue, terms)) {
          const r = new Range();
          r.setStart(node, s); r.setEnd(node, e);
          ranges.push(r);
        }
      }
    }
    CSS.highlights.set(HL, new Highlight(...ranges));
    return () => CSS.highlights.delete(HL);
  });

  // Optional controls of the session header's ⋯ menu that can be hidden (mirror of server/settings.js).
  const STATUS_BAR_META = {
    permissionMode: { label: 'Permission-mode control (Normal / Auto / Plan) and auto-approve' },
    modelEffort:    { label: 'Model / effort control' },
    focusBtn:       { label: 'Focus button' },
  };

  const THEMES = [
    { key: 'system', icon: 'theme-system', label: 'System' },
    { key: 'light',  icon: 'theme-light', label: 'Light' },
    { key: 'dark',   icon: 'theme-dark', label: 'Dark' },
  ];
  // Palette (axe orthogonal au clair/sombre). 'default' = refonte indigo ; 'legacy' = ancien thème crème.
  const SCHEMES = [
    { key: 'default', icon: 'dot', color: '#7d74f5', label: 'Default' },
    { key: 'legacy',  icon: 'dot', color: '#a07a55', label: 'Legacy' },
    { key: 'datadog', icon: 'dot', color: '#632ca6', label: 'Datadog' },
    { key: 'gruvbox', icon: 'dot', color: '#d65d0e', label: 'Gruvbox' },
  ];
  // Forme des angles (3e axe orthogonal : se combine avec n'importe quel clair/sombre et palette).
  const CORNERS = [
    { key: 'round', icon: 'dot', label: 'Rounded' },
    { key: 'sharp', icon: 'pane', label: 'Square' },
  ];

  // Défauts de session (modèle / effort / mode de permission) pré-sélectionnés dans les formulaires
  // Nouvelle session et Resume. '' = hériter de la config Claude Code (~/.claude). Champs locaux
  // resynchronisés depuis le store, persistés à chaque changement du sélecteur.
  let defModel = $state(settings.defaultModel || '');
  let defEffort = $state(settings.defaultEffort || '');
  let defMode = $state(settings.defaultMode || '');
  $effect(() => { defModel = settings.defaultModel || ''; defEffort = settings.defaultEffort || ''; defMode = settings.defaultMode || ''; });
  function saveDefaults() {
    updateSettings({ defaultModel: defModel, defaultEffort: defEffort, defaultMode: defMode });
  }

  // Filtre des modèles affichés dans les sélecteurs. La liste complète vient du binaire claude
  // (/api/capabilities, mémoïsé) ; le réglage est une LISTE NOIRE (cf. src/lib/models.js) → une
  // version fraîchement livrée par une mise à jour de Claude Code apparaît sans rien cocher ici.
  let allModelGroups = $state([]);
  $effect(() => {
    let alive = true;
    getCapabilities().then((c) => { if (alive) allModelGroups = c.models || []; }).catch(() => {});
    return () => { alive = false; };
  });
  const hiddenModels = $derived(new Set(settings.hiddenModels || []));
  function toggleModel(id) {
    const cur = (settings.hiddenModels || []).filter(isHideableModel);
    updateSettings({ hiddenModels: cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id] });
  }

  // Projet de démarrage rapide : cwd utilisé quand une session est lancée sans dossier (p.ex. un
  // raccourci macOS qui POST /api/launch avec juste un prompt). Liste = projets connus (comme la
  // Nouvelle session), + « Other folder… » via le sélecteur natif. '' = aucun (cwd requis comme avant).
  const projs = $derived.by(() => {
    const m = new Map();
    for (const s of data.sessions) {
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
  });
  const quickProject = $derived(settings.quickLaunchProject || '');
  let picking = $state(false);
  async function browseQuickProject() {
    if (picking) return;
    picking = true;
    try {
      const r = await pickFolder(quickProject || undefined);
      if (r.ok && r.data?.dir) updateSettings({ quickLaunchProject: r.data.dir });
    } finally {
      picking = false;
    }
  }

  // ── Remote control ────────────────────────────────────────────────────────────────────────────
  // Projects the hooked server keeps a `claude --remote-control` daemon alive for → start sessions
  // on them from the Claude app. The list lives in settings.remoteControlProjects; the server
  // reconciles the detached daemon processes on every write. We poll /api/remote-control for the
  // per-project daemon status (up / down / missing path).
  const rcProjects = $derived(settings.remoteControlProjects || []);
  let rcStatus = $state([]);          // [{ project, name, running, exists }]
  let rcPicking = $state(false);
  const rcStatusFor = (p) => rcStatus.find((r) => r.project === p) || null;
  async function loadRcStatus() {
    try { rcStatus = (await getRemoteControl()).projects || []; } catch (_) { rcStatus = []; }
  }
  function addRcProject(cwd) {
    if (!cwd || rcProjects.includes(cwd)) return;
    updateSettings({ remoteControlProjects: [...rcProjects, cwd] }).then(loadRcStatus);
  }
  function removeRcProject(cwd) {
    updateSettings({ remoteControlProjects: rcProjects.filter((p) => p !== cwd) }).then(loadRcStatus);
  }
  async function browseRcProject() {
    if (rcPicking) return;
    rcPicking = true;
    try {
      const r = await pickFolder();
      if (r.ok && r.data?.dir) addRcProject(r.data.dir);
    } finally {
      rcPicking = false;
    }
  }
  onMount(() => {
    loadRcStatus();
    // Le démon peut mettre un instant à monter après un ajout → rafraîchit périodiquement le statut.
    const t = setInterval(loadRcStatus, 4000);
    return () => clearInterval(t);
  });

  // ⋯ menu controls: read / toggle one entry.
  const sbOn = (k) => settings.statusBar?.[k] !== false;
  function toggleStatusBar(key) {
    updateSettings({ statusBar: { ...settings.statusBar, [key]: !sbOn(key) } });
  }
  // Resync live states: recomputes every session's state now instead of waiting for the poll.
  let resyncing = $state(false);
  let resyncStatus = $state('');
  async function doResync() {
    if (resyncing) return;
    resyncing = true; resyncStatus = '';
    const res = await resync().catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      await loadSessions(); ui.tick++;         // push the refreshed states into the UI
      resyncStatus = `✓ resynced ${res.data.count} sessions`;
    } else {
      resyncStatus = '✗ ' + (res.data?.error || 'failed');
    }
    resyncing = false;
    setTimeout(() => { resyncStatus = ''; }, 3000);
  }

  // ── Claude Code version (installed binary + outdated live sessions) ───────────────────────────
  // A session keeps running the version it started with: upgrading the binary doesn't touch live
  // sessions until they're restarted (kill + `claude --resume`). We surface which live sessions run
  // an older version than installed, let the user upgrade the binary (never sudo), and reconnect.
  let claude = $state(null);           // { install, installed, outdated } | { error }
  let claudeLoading = $state(false);
  let claudeStatus = $state('');
  let upgrading = $state(false);
  let restartingId = $state('');       // session id currently restarting (single-flight)
  let bulkBusy = $state(false);        // "Upgrade & reconnect all" in flight
  const restarted = $state(new Set()); // ids restarted this visit → filtered out (transcript version lags until it next writes)

  const outdatedRows = $derived((claude?.outdated || []).filter((r) => !restarted.has(r.id)));

  async function loadClaude() {
    claudeLoading = true;
    try {
      claude = await getClaudeVersion();
    } catch (e) {
      claude = { error: e.message || 'failed to load claude version' };
    }
    claudeLoading = false;
  }

  async function doUpgrade() {
    if (upgrading || !claude?.install) return;
    upgrading = true; claudeStatus = '⏳ upgrading…';
    const res = await upgradeClaude().catch((e) => ({ ok: false, data: { error: e.message } }));
    upgrading = false;
    if (res.ok) {
      claudeStatus = `✓ upgraded to ${res.data.installed}`;
      await loadClaude();
    } else if (res.data?.needsSudo) {
      claudeStatus = '✗ ' + (res.data.warning || 'upgrade needs elevated permissions');
    } else {
      claudeStatus = '✗ ' + (res.data?.warning || res.data?.error || 'upgrade failed');
    }
    setTimeout(() => { claudeStatus = ''; }, 6000);
  }

  // Restart one session so it picks up the installed version. A session that's actively working is
  // guarded behind a confirm (kill + resume loses in-memory state; the transcript is reloaded).
  async function doRestart(row) {
    if (restartingId || bulkBusy) return false;
    if (row.state === 'working' && !confirm(`“${row.projectName || row.id}” is working right now.\nRestart it? In-memory state is lost; the session resumes from its transcript.`)) return false;
    restartingId = row.id; claudeStatus = '';
    const res = await restartClaudeSession(row.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    restartingId = '';
    if (res.ok) { restarted.add(row.id); claude = { ...claude }; return true; }
    claudeStatus = '✗ ' + (res.data?.error || 'restart failed');
    setTimeout(() => { claudeStatus = ''; }, 5000);
    return false;
  }

  // Upgrade the binary first (if possible), then reconnect every still-outdated session in sequence.
  async function doUpgradeAndReconnect() {
    if (bulkBusy || restartingId) return;
    bulkBusy = true;
    try {
      if (claude?.install?.upgrade && !claude.install.needsSudo) {
        claudeStatus = '⏳ upgrading…';
        const up = await upgradeClaude().catch((e) => ({ ok: false, data: { error: e.message } }));
        if (up.ok) { await loadClaude(); }
        else { claudeStatus = '✗ ' + (up.data?.warning || up.data?.error || 'upgrade failed'); bulkBusy = false; setTimeout(() => { claudeStatus = ''; }, 6000); return; }
      }
      const rows = [...(claude?.outdated || [])].filter((r) => !restarted.has(r.id));
      let done = 0;
      for (const r of rows) {
        claudeStatus = `⏳ reconnecting ${done + 1}/${rows.length}…`;
        const res = await restartClaudeSession(r.id).catch(() => ({ ok: false }));
        if (res.ok) { restarted.add(r.id); done++; }
      }
      claude = { ...claude };
      claudeStatus = `✓ reconnected ${done} session${done === 1 ? '' : 's'}`;
    } finally {
      bulkBusy = false;
      setTimeout(() => { claudeStatus = ''; }, 6000);
    }
  }

  // ── Git branch of the running hooked instance ─────────────────────────────────────────────────
  // Operates on the repo the server itself lives in (resolved server-side at runtime).
  let git = $state(null);          // { current, dirty, ahead, behind, upstream, branches, sync } | { error }
  let gitLoading = $state(false);
  let selected = $state('');       // branch chosen in the picker
  let checkoutStatus = $state(''); // feedback line
  let showOverrides = $state(false); // dirty deny → offer stash / force
  let checkingOut = $state(false);

  async function loadGit() {
    gitLoading = true;
    try {
      const d = await getGit();
      git = d;
      if (d && !d.error && !selected) selected = d.current || '';
    } catch (e) {
      git = { error: e.message || 'failed to load git status' };
    }
    gitLoading = false;
  }
  onMount(() => { loadGit(); loadClaude(); });

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────────────────────
  let shortcuts = $state(getAllBindings());
  let recordingId = $state(null);
  function startRecording(id) { recordingId = id; }
  function cancelRecording() { recordingId = null; }
  function doResetBinding(id) {
    resetBinding(id);
    shortcuts = getAllBindings();
  }
  function doResetAll() {
    resetAllShortcuts();
    shortcuts = getAllBindings();
  }

  async function doCheckout(strategy) {
    if (!selected || checkingOut) return;
    checkingOut = true; checkoutStatus = strategy === 'block' ? '' : '';
    const res = await checkoutBranch(selected, strategy).catch((e) => ({ ok: false, data: { error: e.message } }));
    checkingOut = false;
    if (res.ok) {
      showOverrides = false;
      checkoutStatus = `✓ on ${res.data.status?.current ?? selected}` + (res.data.stashRef ? ` (stashed: ${res.data.stashRef})` : '');
      await loadGit();
      setTimeout(() => { checkoutStatus = ''; }, 4000);
    } else if (res.data?.dirty) {
      showOverrides = true;
      checkoutStatus = '✗ working tree is dirty — choose how to proceed';
    } else {
      showOverrides = false;
      checkoutStatus = '✗ ' + (res.data?.error || 'checkout failed');
      setTimeout(() => { checkoutStatus = ''; }, 5000);
    }
  }

  async function dismissRestart() {
    const res = await dismissRestartNotice().catch(() => null);
    if (res?.ok && git) git = { ...git, sync: res.data.sync };
  }
</script>

<svelte:window onkeydown={(e) => {
  if (!recordingId) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { recordingId = null; return; }
  const keys = keysFromEvent(e);
  if (!keys) return;
  setBinding(recordingId, keys);
  recordingId = null;
  shortcuts = getAllBindings();
}} />

<section id="view-settings" class="view active">
  <div class="set-wrap">
    <nav class="set-nav" bind:this={navEl}>
      <div class="set-nav-title">Settings</div>
      {#each NAV.filter((n) => !matchSecs || matchSecs.has(n.id)) as n (n.id)}
        <a href="#{n.id}" class:active={activeSec === n.id} onclick={(e) => { e.preventDefault(); goTo(n.id); }}>{n.label}</a>
      {/each}
    </nav>

    <div class="settings">
    <h1>Settings</h1>
    <p class="lead">Persisted server-side (shared across browsers). More will be added as needed.</p>

    <div class="set-search">
      <div class="set-search-box">
        <span class="set-search-icon"><Icon name="search" size={15} /></span>
        <input type="search" placeholder="Search settings…" aria-label="Search settings"
               autocomplete="off" spellcheck="false" bind:value={query}
               onkeydown={(e) => { if (e.key !== 'Escape') return; e.stopPropagation(); if (query) query = ''; else e.currentTarget.blur(); }} />
        {#if query}
          <button class="set-search-clear" onclick={() => (query = '')} title="Clear search" aria-label="Clear search"><Icon name="close" size={13} /></button>
        {/if}
      </div>
    </div>

    <div class="cards" bind:this={cardsEl}>
    <div class="card" id="pset-appearance" data-sec>
      <h2>Theme</h2>
      <p class="hint">Interface appearance. (Per-browser preference.)</p>
      <div class="chips">
        {#each THEMES as t (t.key)}
          <button class="chip" class:active={ui.theme === t.key} onclick={() => setTheme(t.key)}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        {/each}
      </div>

      <h2 style="margin-top:22px">Corners</h2>
      <p class="hint"><strong>Square</strong> removes every rounded corner — cards, buttons, chips, status dots, the lot. Combines with any theme and palette. (Per-browser preference.)</p>
      <div class="chips">
        {#each CORNERS as c (c.key)}
          <button class="chip" class:active={ui.corners === c.key} onclick={() => setCorners(c.key)}>
            <Icon name={c.icon} size={14} /> {c.label}
          </button>
        {/each}
      </div>

      <h2 style="margin-top:22px">Color scheme</h2>
      <p class="hint">Palette used for both light and dark. <strong>Legacy</strong> restores the previous warm cream / terracotta look; <strong>Datadog</strong> is a cool purple, tighter corners and flatter surfaces, closer to a monitoring console; <strong>Gruvbox</strong> is the retro warm palette of the editor theme of the same name. (Per-browser preference.)</p>
      <div class="chips">
        {#each SCHEMES as s (s.key)}
          <button class="chip" class:active={ui.scheme === s.key} onclick={() => setScheme(s.key)}>
            <Icon name={s.icon} color={s.color} size={14} /> {s.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="card">
      <h2>Companion</h2>
      <p class="hint">A little pixel buddy dancing above the interface. Drag it anywhere — it stays where you drop it. (Per-browser preference.)</p>
      <label class="check">
        <input type="checkbox" checked={ui.companion} onchange={(e) => (ui.companion = e.currentTarget.checked)} />
        <span>Show the companion</span>
      </label>
    </div>

    <div class="card" id="pset-sidebar" data-sec>
      <h2>Navigation</h2>
      <p class="hint">Which spaces show as tabs next to the Deck in the top bar. Hidden ones stay reachable from the omnibar (⌘P). (Shared setting.)</p>
      <div class="navtabs-edit">
        {#each NAV_TABS as t (t.key)}
          {@const on = (settings.navTabs || []).includes(t.key)}
          <label class="check">
            <input type="checkbox" checked={on}
                   onchange={() => updateSettings({ navTabs: on ? settings.navTabs.filter((k) => k !== t.key) : [...(settings.navTabs || []), t.key] })} />
            <span><Icon name={t.icon} size={14} /> {t.label}</span>
          </label>
        {/each}
      </div>
      <h2 style="margin-top:16px">Default page</h2>
      <p class="hint">Which space opens when you first load hooked (also where the logo goes).</p>
      <label class="filter" style="margin-bottom:16px">
        <select value={settings.defaultPage} onchange={(e) => updateSettings({ defaultPage: e.currentTarget.value })}>
          <option value="deck">Deck (triage)</option>
          {#each NAV_TABS as t (t.key)}<option value={t.key}>{t.label}</option>{/each}
        </select>
      </label>
      <h2 style="margin-top:6px">Prompt cache countdown</h2>
      <p class="hint">Time left before a session's prompt cache expires, on its sidebar row. Replying before then re-reads the conversation at the cached rate.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap">
        <label class="filter">
          <select value={settings.sidebarCache.display} onchange={(e) => saveSidebarCache({ display: e.currentTarget.value })}>
            <option value="badge">Badge beside the elapsed time</option>
            <option value="replace">In place of the elapsed time</option>
          </select>
        </label>
        <label class="filter">
          <select value={settings.sidebarCache.windowMin} onchange={(e) => saveSidebarCache({ windowMin: parseInt(e.currentTarget.value, 10) })}>
            <option value={5}>Last 5 min</option>
            <option value={15}>Last 15 min</option>
            <option value={30}>Last 30 min</option>
            <option value={0}>Always</option>
          </select>
        </label>
      </div>
    </div>

    <div class="card" id="pset-editor" data-sec>
      <h2>Code editor</h2>
      <p class="hint">Editor used by the <strong>editor</strong> links in the Ship / Files lenses (open one file) and by <strong>Open in …</strong> (open the whole project folder). Opening a file goes through the editor's URL scheme — the editor must be installed and, on first use, the browser will ask to allow it. Opening a folder runs the editor's CLI on the server, so that command must be in <code>PATH</code> (<code>{EDITORS.find((e) => e.key === (settings.editor || 'vscode'))?.cli}</code> for the current choice). (Shared setting.)</p>
      <div class="chips">
        {#each EDITORS as ed (ed.key)}
          <button class="chip" class:active={(settings.editor || 'vscode') === ed.key} onclick={() => updateSettings({ editor: ed.key })}>
            <Icon name={ed.icon} size={14} /> {ed.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="card" id="pset-speech" data-sec>
      <h2>Voice dictation</h2>
      <p class="hint">Locale used by the composer's microphone (speech to text, Web Speech API). The mic button only shows up on a browser that supports recognition. (Shared setting.)</p>
      <label class="check">
        <input type="checkbox" checked={settings.speechEnabled !== false}
               onchange={(e) => updateSettings({ speechEnabled: e.currentTarget.checked })} />
        <span>Show the mic button in the composer</span>
      </label>
      <div class="cmd-row">
        <select class="cmd-input" disabled={settings.speechEnabled === false} value={settings.speechLang} onchange={(e) => updateSettings({ speechLang: e.currentTarget.value })}>
          {#each SPEECH_LOCALES as l (l.key)}
            <option value={l.key}>{l.label} — {l.key}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="card" id="pset-new" data-sec>
      <h2>New session defaults</h2>
      <p class="hint">Model, reasoning effort and permission mode pre-selected when you start a new session or resume one. <strong>Inherit</strong> falls back to your Claude Code config (<code>~/.claude</code>).</p>
      <ModelEffort showMode allowInherit bind:model={defModel} bind:effort={defEffort} bind:mode={defMode} onchange={saveDefaults} />
    </div>

    <div class="card" id="pset-models" data-sec>
      <h2>Visible models</h2>
      <p class="hint">Which model versions appear in the model selectors (new session, resume, and the live switch in a session header). The list itself comes from your installed <code>claude</code> binary — this only <strong>hides</strong> versions, so a version shipped by a future Claude Code update shows up on its own. Hiding is cosmetic: a hidden model stays valid, and a session already running on one keeps showing it. Family defaults (<em>Opus</em>, <em>Sonnet</em>…) are never hidden. (Shared setting.)</p>
      {#each allModelGroups as g (g.label)}
        <div class="mf-row">
          <span class="mf-fam">{g.label}</span>
          <div class="chips">
            {#each g.opts as [id, label] (id)}
              {#if isHideableModel(id)}
                {@const off = hiddenModels.has(id)}
                <button class="chip" class:active={!off} onclick={() => toggleModel(id)}
                        title={off ? `${id} — hidden, click to show` : `${id} — shown, click to hide`}>
                  <Icon name={off ? 'eye-off' : 'eye'} size={13} /> {label}
                </button>
              {:else}
                <span class="chip mf-locked" title="Family default — always shown">{label}</span>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
      {#if !allModelGroups.length}
        <p class="hint">No model list available — hooked could not resolve a <code>claude</code> binary.</p>
      {/if}
    </div>

    <div class="card" id="pset-project" data-sec>
      <h2>Default project</h2>
      <p class="hint">Working directory used when a session is launched <strong>without</strong> a folder — e.g. from a macOS shortcut that posts to <code>/api/launch</code> with only a prompt. Leave empty to keep requiring an explicit folder.</p>
      <div class="cmd-row">
        <select class="cmd-input" value={quickProject} onchange={(e) => updateSettings({ quickLaunchProject: e.currentTarget.value })}>
          <option value="">— None —</option>
          {#each projs as [cwd, name] (cwd)}
            <option value={cwd}>{name} — {cwd}</option>
          {/each}
          {#if quickProject && !projs.some(([c]) => c === quickProject)}
            <option value={quickProject}>{quickProject}</option>
          {/if}
        </select>
        <button class="save" onclick={browseQuickProject} disabled={picking}>{#if picking}<Icon name="queued" size={14} />{:else}<Icon name="folder-open" size={14} />{/if} Browse…</button>
      </div>
    </div>

    <div class="card" id="pset-remote-control" data-sec>
      <h2>Remote control</h2>
      <p class="hint">Projects the hooked server keeps a <code>claude remote-control</code> server running for, so each shows up as a launchable <strong>environment</strong> in the Claude app (start new sessions on it from claude.ai/code or mobile). Each daemon runs as a detached process (supervised by a restart loop, so it self-heals if it exits) and is hidden from the dashboard. Removing a project stops its daemon.</p>
      <div class="cmd-row">
        <select class="cmd-input" value="" onchange={(e) => { addRcProject(e.currentTarget.value); e.currentTarget.value = ''; }}>
          <option value="">— Add a project… —</option>
          {#each projs as [cwd, name] (cwd)}
            {#if !rcProjects.includes(cwd)}
              <option value={cwd}>{name} — {cwd}</option>
            {/if}
          {/each}
        </select>
        <button class="save" onclick={browseRcProject} disabled={rcPicking}>{#if rcPicking}<Icon name="queued" size={14} />{:else}<Icon name="folder-open" size={14} />{/if} Browse…</button>
      </div>
      {#if rcProjects.length}
        <ul class="rc-list">
          {#each rcProjects as cwd (cwd)}
            {@const st = rcStatusFor(cwd)}
            <li class="rc-row">
              <span class="rc-dot" class:on={st?.running} class:err={st && !st.exists} title={st ? (!st.exists ? 'Path is not a directory' : st.running ? 'Daemon running' : 'Daemon down') : 'Unknown'}></span>
              <span class="rc-path" title={cwd}>{cwd}</span>
              <span class="rc-state">{st ? (!st.exists ? 'missing path' : st.running ? 'running' : 'starting…') : ''}</span>
              <button class="rc-rm" onclick={() => removeRcProject(cwd)} title="Stop daemon & remove" aria-label="Stop daemon & remove"><Icon name="close" size={13} /></button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint" style="margin-top:8px">No projects yet — add one to expose it to the Claude app.</p>
      {/if}
    </div>

    <div class="card" id="pset-digest" data-sec>
      <h2>Daily digest</h2>
      <p class="hint">Generate an AI recap of the previous day's sessions each morning — see the <strong>Digest</strong> tab. Runs a headless <code>claude -p</code> pass. Manual generation from the tab always works, even with auto off.</p>
      <label class="check">
        <input type="checkbox" checked={settings.digest?.auto ?? true}
               onchange={(e) => updateSettings({ digest: { ...settings.digest, auto: e.currentTarget.checked } })} />
        <span>Generate yesterday's digest automatically each day</span>
      </label>
      <div class="cmd-row" style="margin-top:6px">
        <label class="dg-field">At
          <select class="dg-sel" value={String(settings.digest?.hour ?? 7)} disabled={!(settings.digest?.auto ?? true)}
                  onchange={(e) => updateSettings({ digest: { ...settings.digest, hour: parseInt(e.currentTarget.value, 10) } })}>
            {#each Array.from({ length: 24 }, (_, h) => h) as h}<option value={String(h)}>{String(h).padStart(2, '0')}:00</option>{/each}
          </select>
          local time
        </label>
        <label class="dg-field">Model
          <select class="dg-sel" value={settings.digest?.model ?? ''}
                  onchange={(e) => updateSettings({ digest: { ...settings.digest, model: e.currentTarget.value } })}>
            <option value="">Inherit (your default)</option>
            <option value="haiku">haiku</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
          </select>
        </label>
      </div>
      <p class="hint" style="margin:12px 0 0">A cheaper model (e.g. <code>haiku</code>/<code>sonnet</code>) keeps daily cost low on busy days.</p>
    </div>

    <div class="card" id="pset-warmup" data-sec>
      <h2>5-hour window</h2>
      <p class="hint">Claude's usage window is anchored to your <strong>first message</strong> and lasts 5 hours — it is not aligned on round hours, so the first prompt of the day decides where every later boundary, and every fresh budget, falls. hooked opens one with a throwaway <code>claude -p</code> ping before you start, then reopens one whenever a boundary passes while you are away from the keyboard.</p>
      <label class="check">
        <input type="checkbox" checked={!!wu.enabled}
               onchange={(e) => saveWarmup({ enabled: e.currentTarget.checked })} />
        <span>Keep a 5-hour window open across my working hours</span>
      </label>

      <p class="hint" style="margin:14px 0 6px">Working hours — the anchor is derived from them, so this is the only thing worth tuning.</p>
      {#each wu.workHours || [] as slot, i}
        <div class="cmd-row" style="margin-bottom:6px">
          <input type="time" class="dg-sel" value={slot[0]} aria-label="Start of working slot"
                 onchange={(e) => setSlot(i, 0, e.currentTarget.value)} />
          <span class="status">to</span>
          <input type="time" class="dg-sel" value={slot[1]} aria-label="End of working slot"
                 onchange={(e) => setSlot(i, 1, e.currentTarget.value)} />
          {#if (wu.workHours || []).length > 1}
            <button class="rc-rm" onclick={() => removeSlot(i)} title="Remove this slot" aria-label="Remove this slot"><Icon name="close" size={13} /></button>
          {/if}
        </div>
      {/each}
      <div class="cmd-row">
        <button class="save" onclick={addSlot}>Add a slot</button>
        <div class="wu-days">
          {#each DAY_LABELS as [label, d] (d)}
            <button class="wu-day" class:on={(wu.days || []).includes(d)} onclick={() => toggleDay(d)}>{label}</button>
          {/each}
        </div>
      </div>

      {#if warmupPlan?.windows?.length}
        <div class="wu-plan">
          <div class="wu-head">First prompt at <strong>{warmupPlan.anchor}</strong> — {warmupPlan.windows.length} window{warmupPlan.windows.length > 1 ? 's' : ''} covering your day</div>
          {#each warmupPlan.windows as w (w.start)}
            <div class="wu-row">
              <span class="wu-span">{w.start} → {w.end}</span>
              <span class="wu-bar"><span class="wu-fill" style="width:{Math.round((w.workMin / 300) * 100)}%"></span></span>
              <span class="wu-work">{fmtWork(w.workMin)}</span>
            </div>
          {/each}
        </div>
      {/if}

      <div class="cmd-row" style="margin-top:12px">
        <label class="dg-field">Ping model
          <select class="dg-sel" value={wu.model ?? 'haiku'}
                  onchange={(e) => saveWarmup({ model: e.currentTarget.value })}>
            <option value="haiku">haiku</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
          </select>
        </label>
        <label class="dg-field">Skip above
          <select class="dg-sel" value={String(wu.skipIfWeeklyOver ?? 90)}
                  onchange={(e) => saveWarmup({ skipIfWeeklyOver: parseInt(e.currentTarget.value, 10) })}>
            {#each [0, 70, 80, 85, 90, 95] as p}<option value={String(p)}>{p === 0 ? 'never skip' : p + '% weekly'}</option>{/each}
          </select>
        </label>
      </div>
      <p class="hint" style="margin:8px 0 0">The ping has to stay tiny — it spends the very budget it just unlocked. The weekly guard matters more than it looks: once the 7-day budget is the binding limit, opening extra 5-hour windows only helps you exhaust it sooner.</p>

      <div class="cmd-row" style="margin-top:12px">
        <button class="save" onclick={pingNow} disabled={warmupPinging}>{#if warmupPinging}<Icon name="queued" size={14} /> Pinging…{:else}<Icon name="refresh" size={14} /> Ping now{/if}</button>
        {#if warmupStatusMsg}<span class="status">{warmupStatusMsg}</span>{/if}
      </div>
      {#if warmupPlan?.decision}
        <p class="hint" style="margin:8px 0 0">Scheduler right now: <strong>{warmupPlan.decision.act ? 'ping due' : warmupPlan.decision.reason}</strong>{#if warmupPlan.fiveHour} · window open until {warmupPlan.fiveHour.at} ({warmupPlan.fiveHour.pct}% used){/if}</p>
      {/if}
    </div>

    <div class="card" id="pset-autocompact" data-sec>
      <h2>Auto-compact</h2>
      <p class="hint">Anthropic caches a session's conversation for <strong>1 hour</strong> after each request. Past that, the next message re-writes all of it at the cache-write rate (2× input) — whether the session stayed open or is resumed. On a subscription, one cold prompt on a large session has been measured at ~20 % of a 5-hour window.</p>
      <label class="check">
        <input type="checkbox" checked={!!ac.enabled}
               onchange={(e) => saveAutoCompact({ enabled: e.currentTarget.checked })} />
        <span>Compact sessions left waiting for me, just before their cache expires</span>
      </label>
      <p class="hint" style="margin:10px 0 0">hooked runs <code>/compact</code> about {AC_LEAD_MIN} min before expiry on a driven session waiting for your reply — never while it works or while a question is pending, never once the cache is already cold. The conversation is re-read at the cached rate (≈ {AC_READ_PCT} % of a cold re-write) and replaced by a summary: coming back two hours or a day later re-caches the summary, not the thread, and every later turn is lighter too.</p>
      <div class="cmd-row" style="margin-top:10px">
        <label class="dg-field">Only above
          <select class="dg-sel" value={String(ac.minContextK ?? 100)} disabled={!ac.enabled}
                  onchange={(e) => saveAutoCompact({ minContextK: parseInt(e.currentTarget.value, 10) })}>
            {#each [0, 50, 100, 200, 400] as k}<option value={String(k)}>{k === 0 ? 'any size' : k + 'k tokens'}</option>{/each}
          </select>
          of context
        </label>
      </div>
      <p class="hint" style="margin:8px 0 0"><strong>It is lossy</strong>: exact outputs, file contents and reasoning of earlier turns give way to a summary, and Claude may re-read files to pick the thread back up. Worth it if you often leave sessions for more than an hour; skip it if you usually come back within the hour — the cache is still warm then. Below the size threshold a cold resume is cheap anyway, so nothing is compacted.</p>
    </div>

    <div class="card" id="pset-live" data-sec>
      <h2>Live state</h2>
      <p class="hint">Recomputes every session's live state now to fix a stale status — e.g. a session stuck on “working” after it finished.</p>
      <div class="cmd-row">
        <button class="save" onclick={doResync} disabled={resyncing}>{#if resyncing}<Icon name="queued" size={14} /> Resyncing…{:else}<Icon name="refresh" size={14} /> Resync live states{/if}</button>
        {#if resyncStatus}<span class="status">{resyncStatus}</span>{/if}
      </div>
    </div>

    <div class="card" id="pset-claude" data-sec>
      <h2>Claude Code</h2>
      <p class="hint">A running session keeps the claude version it started with. Upgrading the binary doesn't touch live sessions until they restart — reconnecting resumes them from their transcript on the new version. In-memory state is lost by design.</p>

      {#if claudeLoading && !claude}
        <p class="hint">Loading…</p>
      {:else if claude?.error}
        <p class="hint"><Icon name="close" size={13} /> {claude.error}</p>
      {:else if claude}
        <p class="hint" style="margin-bottom:12px">
          {#if claude.install?.method === 'absent'}
            <strong>claude not found on PATH</strong>
          {:else}
            Installed: <strong>{claude.installed || '(unknown)'}</strong>
            <span class="badge">{claude.install?.label || claude.install?.method || 'unknown'}</span>
            {#if claude.install?.real}<span class="path" title={claude.install.real}>{claude.install.real}</span>{/if}
          {/if}
        </p>

        {#if claude.install?.method !== 'absent'}
          {#if claude.install?.needsSudo}
            <div class="restart-notice">
              <span><Icon name="lock" size={14} /> Upgrade needs elevated permissions (install prefix not writable). Run <code>{claude.install.upgrade}</code> in a terminal.</span>
            </div>
          {:else if claude.install?.upgrade}
            <div class="cmd-row" style="margin-bottom:12px">
              <button class="save" onclick={doUpgrade} disabled={upgrading || bulkBusy}>{#if upgrading}<Icon name="queued" size={14} /> Upgrading…{:else}<Icon name="arrow-up" size={14} /> Upgrade claude{/if}</button>
              <span class="hint" style="margin:0"><code>{claude.install.upgrade}</code></span>
            </div>
          {:else}
            <p class="hint" style="margin-bottom:12px">Unknown install method — upgrade claude manually.</p>
          {/if}
        {/if}

        {#if outdatedRows.length}
          <div class="cmd-row" style="margin-bottom:10px">
            <strong style="font-size:13px">{outdatedRows.length} live session{outdatedRows.length === 1 ? '' : 's'} running an older version</strong>
            <button class="save" onclick={doUpgradeAndReconnect} disabled={bulkBusy || !!restartingId || upgrading}>{#if bulkBusy}<Icon name="queued" size={14} /> Working…{:else}<Icon name="arrow-up" size={14} /> Upgrade & reconnect all{/if}</button>
          </div>
          <ul class="reorder">
            {#each outdatedRows as row (row.id)}
              <li>
                <span class="ro-name">{row.projectName || row.id}</span>
                <span class="ver">{row.version} <Icon name="arrow-right" size={12} /> {row.installed}</span>
                {#if row.state === 'working'}<span class="badge dirty">working</span>{/if}
                <span class="ro-actions">
                  <button class="mini wide" disabled={!!restartingId || bulkBusy} onclick={() => doRestart(row)}>
                    {#if restartingId === row.id}<Icon name="queued" size={13} />{:else}<Icon name="refresh" size={13} /> Restart & reconnect{/if}
                  </button>
                </span>
              </li>
            {/each}
          </ul>
        {:else if claude.installed}
          <p class="hint" style="margin:0"><Icon name="check" size={13} /> All live sessions are on the installed version.</p>
        {/if}
        {#if claudeStatus}<p class="status" style="margin:10px 0 0">{claudeStatus}</p>{/if}
      {/if}
    </div>

    <div class="card" id="pset-git" data-sec>
      <h2>Git branch</h2>
      <p class="hint">Branch of the running hooked instance itself (the repo the server lives in). Checkout is blocked when the working tree is dirty; overrides let you stash or force.</p>

      {#if git?.sync?.restartNeeded}
        <div class="restart-notice">
          <span><Icon name="refresh" size={14} /> {git.sync.note || 'A restart is needed to finish applying an update.'}</span>
          <button class="mini" onclick={dismissRestart}>Dismiss</button>
        </div>
      {:else if git?.sync?.note}
        <p class="hint" style="margin-bottom:12px"><Icon name="info" size={14} /> {git.sync.note}</p>
      {/if}

      {#if gitLoading && !git}
        <p class="hint">Loading…</p>
      {:else if git?.error}
        <p class="hint"><Icon name="close" size={13} /> {git.error}</p>
      {:else if git}
        <p class="hint" style="margin-bottom:12px">
          Current: <strong>{git.detached ? '(detached HEAD)' : git.current}</strong>
          {#if git.dirty}<span class="badge dirty">dirty</span>{/if}
          {#if git.behind}<span class="badge"><Icon name="arrow-down" size={12} />{git.behind} behind</span>{/if}
          {#if git.ahead}<span class="badge"><Icon name="arrow-up" size={12} />{git.ahead} ahead</span>{/if}
          {#if git.upstream}<span class="badge"><Icon name="arrow-right" size={12} /> {git.upstream}</span>{/if}
        </p>
        <div class="cmd-row">
          <select class="cmd-input" bind:value={selected}>
            {#each git.branches as b (b.name + (b.remote ? ':r' : ''))}
              <option value={b.name} disabled={b.locked}>
                {b.current ? '● ' : ''}{b.name}{b.remote ? ' (remote)' : ''}{b.locked ? ' — in worktree' : ''}
              </option>
            {/each}
          </select>
          <button class="save" onclick={() => doCheckout('block')} disabled={checkingOut || !selected || selected === git.current}>
            {#if checkingOut}<Icon name="queued" size={14} />{:else}Checkout{/if}
          </button>
          {#if checkoutStatus}<span class="status">{checkoutStatus}</span>{/if}
        </div>
        {#if showOverrides}
          <div class="cmd-row" style="margin-top:10px">
            <span class="hint" style="margin:0">Working tree is dirty:</span>
            <button class="chip" onclick={() => doCheckout('stash')} disabled={checkingOut}><Icon name="package" size={14} /> Stash &amp; checkout</button>
            <button class="chip danger" onclick={() => doCheckout('force')} disabled={checkingOut}><Icon name="warning" size={14} tint={false} /> Force (discard changes)</button>
          </div>
        {/if}
      {/if}
    </div>

    <div class="card">
      <h2>Auto git sync</h2>
      <p class="hint">When enabled, periodically <code>git fetch</code> then <code>git pull --ff-only</code> — only if the working tree is clean and the branch is behind a fast-forwardable upstream. Never destructive; a dirty tree fetches only.</p>
      <label class="check">
        <input type="checkbox" checked={settings.autoGitSync} onchange={(e) => updateSettings({ autoGitSync: e.currentTarget.checked })} />
        <span>Enable background fetch + fast-forward pull</span>
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.gitAutoRestartOnLock} onchange={(e) => updateSettings({ gitAutoRestartOnLock: e.currentTarget.checked })} />
        <span>Auto-restart the service when a pull changes <code>package-lock.json</code> (re-installs deps)</span>
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.gitRestartNotice} onchange={(e) => updateSettings({ gitRestartNotice: e.currentTarget.checked })} />
        <span>Show a “restart needed / restarted” notice in the UI</span>
      </label>
    </div>

    <div class="card">
      <h2>Conversation diffs</h2>
      <p class="hint">How file edits render inline in the conversation. (Per-browser preference.)</p>
      <div class="chips">
        <button class="chip" class:active={!ui.diffSplit} onclick={() => (ui.diffSplit = false)}><Icon name="menu" size={14} /> Unified</button>
        <button class="chip" class:active={ui.diffSplit} onclick={() => (ui.diffSplit = true)}><Icon name="pane" size={14} /> Side-by-side</button>
      </div>
    </div>

    <div class="card" id="pset-tags" data-sec>
      <h2>Tags</h2>
      <label class="check">
        <input type="checkbox" checked={settings.autoPrReviewTag} onchange={(e) => updateSettings({ autoPrReviewTag: e.currentTarget.checked })} />
        <span>Auto-tag a session <code>pr-approved</code> / <code>pr-changes-requested</code> when its most recent linked PR gets reviewed on GitHub (checked every 5 min via <code>gh</code>, read-only)</span>
      </label>
      <p class="hint">Tags live only through the sessions that carry them — deleting one removes it from every session and clears it from any active filter. This can't be undone.</p>
      {#if allTags().length}
        <ul class="taglist">
          {#each allTags() as t (t)}
            {@const n = tagUsage(t)}
            <li>
              <span class="pt-pill" style="--c:{tagColor(t)}"># {t}</span>
              <span class="tl-count">{n} session{n === 1 ? '' : 's'}</span>
              <span class="tl-actions">
                {#if confirmTag === t}
                  <button class="mini danger" onclick={() => removeTag(t)} title="Confirm deletion">Confirm</button>
                  <button class="mini" onclick={() => (confirmTag = null)} title="Cancel">Cancel</button>
                {:else}
                  <button class="mini" onclick={() => removeTag(t)} title="Delete tag" aria-label="Delete tag"><Icon name="trash" size={14} /></button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint tl-empty">No tags yet. Add tags to a session from its ⋯ menu in the sidebar.</p>
      {/if}
    </div>

    <div class="card" id="pset-shortcuts" data-sec>
      <h2>Keyboard shortcuts</h2>
      <p class="hint">Click a shortcut to record a new binding. All shortcuts are stored per-browser.</p>
      {#each ['Navigation', 'Actions', 'Review'] as section}
        <h3 class="sc-section">{section}</h3>
        <ul class="reorder">
          {#each shortcuts.filter(s => s.section === section) as sc (sc.id)}
            <li>
              <span class="ro-name">{sc.label}</span>
              <span class="ro-actions sc-actions">
                {#if recordingId === sc.id}
                  <kbd class="sc-recording">Press a key combo…</kbd>
                  <button class="mini" onclick={cancelRecording} title="Cancel" aria-label="Cancel"><Icon name="close" size={13} /></button>
                {:else}
                  <button class="sc-key" onclick={() => startRecording(sc.id)} title="Click to remap">
                    {formatKeys(sc.keys)}
                  </button>
                  {#if sc.isCustom}
                    <button class="mini" onclick={() => doResetBinding(sc.id)} title="Reset to default" aria-label="Reset to default"><Icon name="refresh" size={13} /></button>
                  {/if}
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/each}
      <div class="cmd-row" style="margin-top:14px">
        <button class="chip" onclick={doResetAll}>Reset all to defaults</button>
      </div>
    </div>

    <div class="card" id="pset-interface" data-sec>
      <h2>Session menu</h2>
      <p class="hint">Optional controls of the session header's ⋯ menu. Click the eye to hide or show each one.</p>
      <ul class="reorder">
        {#each Object.keys(STATUS_BAR_META) as key (key)}
          <li class:row-off={!sbOn(key)}>
            <span class="ro-name">{STATUS_BAR_META[key].label}</span>
            <span class="ro-actions">
              <button class="mini vis" class:off={!sbOn(key)} onclick={() => toggleStatusBar(key)}
                      title={sbOn(key) ? 'Shown — click to hide' : 'Hidden — click to show'}
                      aria-label="Toggle visibility">{#if sbOn(key)}<Icon name="eye" size={13} />{:else}<Icon name="eye-off" size={13} />{/if}</button>
            </span>
          </li>
        {/each}
      </ul>
    </div>
    </div>

    {#if query && !matchCount}
      <div class="no-match">
        <Icon name="search" size={18} />
        <p>No setting matches <strong>“{query}”</strong>.</p>
        <button class="chip" onclick={() => (query = '')}>Clear search</button>
      </div>
    {/if}

    </div>
  </div>
</section>

<style>
  #view-settings { overflow-y: auto; padding: 26px; }
  .set-wrap { display: flex; align-items: flex-start; gap: 32px; max-width: 1000px; margin: 0 auto; }
  .set-nav { position: sticky; top: 0; flex: 0 0 190px; width: 190px; display: flex; flex-direction: column; gap: 2px; padding-top: 40px; }
  .set-nav-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 6px 10px; }
  .set-nav a { display: block; padding: 7px 10px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; transition: background .12s, color .12s; }
  .set-nav a:hover { color: var(--text); background: var(--hover); }
  .set-nav a.active { color: var(--accent); background: var(--accent-soft); }
  .settings { flex: 1; min-width: 0; max-width: 720px; }
  .card { scroll-margin-top: 64px; }   /* clears the sticky search bar */
  h1 { font-size: 24px; font-weight: 800; letter-spacing: -.01em; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; margin-bottom: 20px; }
  h2 { font-size: 15px; font-weight: 800; margin: 0 0 4px; }
  @media (max-width: 780px) {
    .set-nav { display: none; }
    .settings { max-width: none; }
  }
  .hint { color: var(--muted); font-size: 12.5px; margin: 0 0 14px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 20px; padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .chip:hover { border-color: var(--border2); }
  .chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-d); }
  .reorder { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .reorder li { display: flex; align-items: center; gap: 12px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
  .ro-name { flex: 1; font-weight: 600; font-size: 13.5px; }
  .ro-actions { display: flex; gap: 4px; }
  .mini { background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 6px; width: 28px; height: 26px; cursor: pointer; font-size: 11px; }
  .mini:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-d); }
  .mini:disabled { opacity: .35; cursor: default; }
  .cmd-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cmd-input { flex: 1; min-width: 240px; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 9px 12px; color: var(--text); font-size: 13px; font-family: inherit; }
  .cmd-input:focus { outline: none; border-color: var(--accent); }
  .save { background: var(--accent); border: none; color: #fff; border-radius: 8px; padding: 9px 16px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .save:hover { background: var(--accent-d); }
  .status { color: var(--muted); font-size: 12.5px; }
  .rc-list { list-style: none; padding: 0; margin: 14px 0 0; display: flex; flex-direction: column; gap: 6px; }
  .rc-row { display: flex; align-items: center; gap: 10px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
  .rc-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .rc-dot.on { background: #12b76a; }
  .rc-dot.err { background: #f04438; }
  .rc-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-family: var(--mono, ui-monospace, monospace); }
  .rc-state { flex: 0 0 auto; color: var(--muted); font-size: 11.5px; }
  .rc-rm { flex: 0 0 auto; background: var(--surface); border: 1px solid var(--border); color: var(--muted); border-radius: 6px; width: 26px; height: 24px; cursor: pointer; font-size: 11px; }
  .rc-rm:hover { border-color: #f04438; color: #f04438; }
  .badge { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; background: var(--bg3); border: 1px solid var(--border); color: var(--muted); vertical-align: middle; }
  .badge.dirty { color: var(--accent-d); border-color: var(--accent); background: var(--accent-soft); }
  .chip.danger { color: #b42318; border-color: #f0a99f; background: #fef3f2; }
  .chip.danger:hover { border-color: #d92d20; }
  /* Filtre des modèles : une ligne par famille (libellé à gauche, pilules de versions à droite). */
  .mf-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; flex-wrap: wrap; }
  .mf-fam { flex: 0 0 70px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  /* La famille reste sur la même ligne que ses pilules, qui débordent en interne (Opus en a 8). */
  .mf-row .chips { flex: 1 1 0; min-width: 0; }
  .mf-row .chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; }
  .mf-locked { cursor: default; color: var(--muted); opacity: .75; }
  .check { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; margin-bottom: 10px; cursor: pointer; }
  .check:last-child { margin-bottom: 0; }
  .check input { margin-top: 2px; }
  .check code { font-size: 12px; background: var(--bg3); padding: 1px 5px; border-radius: 4px; }
  .restart-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--accent-soft); border: 1px solid var(--accent); color: var(--accent-d); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
  /* bouton œil (masquer/afficher) + lignes masquées + aperçus (sous-onglets & barre de statut). */
  .vis { font-size: 12px; }
  .vis.off { color: var(--muted); }
  .mini.vis:disabled { opacity: .3; }
  .row-off { opacity: .55; }
  .row-off .ro-name { text-decoration: line-through; }
  /* Claude Code card: resolved binary path + running→installed version + wide restart button. */
  .path { display: inline-block; margin-left: 8px; font-size: 11px; color: var(--muted); max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
  .ver { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mini.wide { width: auto; padding: 0 12px; font-weight: 600; }
  .mini.danger { width: auto; padding: 0 12px; font-weight: 600; color: #b42318; border-color: #f0a99f; background: #fef3f2; }
  .mini.danger:hover:not(:disabled) { border-color: #d92d20; color: #b42318; }

  .taglist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .taglist li { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid var(--border); }
  .taglist li:last-child { border-bottom: 0; }
  .taglist .pt-pill {
    font-family: var(--mono); font-size: 11px; font-weight: 600; line-height: 1.7;
    color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent);
    border-radius: 6px; padding: 1px 8px;
  }
  .wu-days { display: flex; gap: 4px; margin-left: auto; }
  .wu-day { background: var(--surface); border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 5px 8px; font-size: 11.5px; font-family: inherit; cursor: pointer; }
  .wu-day.on { border-color: var(--accent); color: var(--text); }
  .wu-plan { margin-top: 14px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .wu-head { font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
  .wu-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
  .wu-span { flex: 0 0 auto; width: 110px; font-size: 12.5px; font-family: var(--mono, ui-monospace, monospace); }
  .wu-bar { flex: 1; min-width: 0; height: 6px; background: var(--surface); border-radius: 3px; overflow: hidden; }
  .wu-fill { display: block; height: 100%; background: var(--accent); }
  .wu-work { flex: 0 0 auto; width: 56px; text-align: right; color: var(--muted); font-size: 11.5px; }
  .dg-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .dg-sel { background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 7px 10px; color: var(--text); font-size: 13px; font-family: inherit; }
  .dg-sel:focus { outline: none; border-color: var(--accent); }
  .dg-sel:disabled { opacity: .5; }
  .tl-count { color: var(--muted); font-size: 12px; }
  .tl-actions { margin-left: auto; display: flex; gap: 6px; }
  .tl-empty { margin: 0; }

  /* Keyboard shortcuts */
  .sc-section { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 14px 0 6px; }
  .sc-section:first-of-type { margin-top: 0; }
  .sc-actions { display: flex; gap: 4px; align-items: center; }
  .sc-key {
    display: inline-flex; align-items: center; gap: 4px;
    font: 12px/1 var(--mono); color: var(--text);
    background: var(--bg3); border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 10px; cursor: pointer; white-space: nowrap;
    transition: border-color .12s, background .12s;
  }
  .sc-key:hover { border-color: var(--accent); background: var(--accent-soft); }
  .sc-recording {
    display: inline-flex; align-items: center;
    font: 12px/1 var(--mono); color: var(--accent);
    background: var(--accent-soft); border: 2px solid var(--accent); border-radius: 6px;
    padding: 4px 10px; white-space: nowrap; outline: none;
    animation: sc-pulse 1s ease-in-out infinite;
  }
  @keyframes sc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }

  /* Search: sticky so it stays reachable while scrolling; cards slide under its opaque background. */
  .set-search { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 6px 0 14px; margin-bottom: 6px; }
  .set-search-box { position: relative; display: flex; align-items: center; }
  .set-search-icon { position: absolute; left: 12px; display: flex; color: var(--muted); pointer-events: none; }
  .set-search input { width: 100%; box-sizing: border-box; padding: 9px 40px 9px 36px; border-radius: 10px; font-size: 13.5px; }
  .set-search input::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
  .set-search-clear { position: absolute; right: 8px; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; }
  .set-search-clear:hover { border-color: var(--accent); color: var(--accent-d); }
  .no-match { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 36px 24px; border: 1px dashed var(--border2); border-radius: 14px; color: var(--muted); text-align: center; }
  .no-match p { margin: 0; font-size: 13.5px; }
</style>
