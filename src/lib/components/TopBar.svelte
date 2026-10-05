<script>
  // Global top bar (redesign shell): spaces (Deck / Archive), omnibar trigger, account usage
  // gauges (5h / 7d / model-scoped), quick actions (notifications, theme, settings) and the primary
  // "+ Session" button. Replaces the old 14-icon left rail.
  import { page } from '$app/state';
  import { ui, data, settings, account, cycleTheme, toggleNotify, toggleIncognitoMode, openModal, isArchived, isSessionArchived, snoozeUntil } from '$lib/state.svelte.js';
  import { getUsage } from '$lib/api.js';
  import { initials, needsDecision, sessionDot } from '$lib/format.js';
  import { NAV_TABS, NAV_KEYS, pageHref } from '$lib/nav.js';
  import Icon from '$lib/components/Icon.svelte';
  import FleetWheel from '$lib/components/FleetWheel.svelte';

  let { onOmnibar } = $props();

  const path = $derived(page.url.pathname);
  // The logo goes to the user's default page (same as cold start).
  const homeHref = $derived(pageHref(settings.defaultPage || 'deck'));
  const onDeck = $derived(path === '/');
  const onSettings = $derived(path.startsWith('/settings'));
  // Nav tabs the user chose to show (settings.navTabs). '/sessions' also lights up on /session/* & /new.
  const tabs = $derived(NAV_TABS.filter((t) => (settings.navTabs || NAV_KEYS).includes(t.key)));
  const tabActive = (t) => t.key === 'sessions'
    ? (path === '/sessions' || path.startsWith('/session/') || path.startsWith('/new'))
    : path.startsWith(t.href);

  // decisions badge: sessions awaiting a human decision (question / plan / permission / waiting).
  // A session snoozed from the Deck doesn't count — snoozing means "stop nagging me about it".
  // Minute clock so the badge comes back when a snooze expires, without waiting for a live tick.
  let nowMin = $state(Date.now());
  $effect(() => { const iv = setInterval(() => (nowMin = Date.now()), 30_000); return () => clearInterval(iv); });
  // The logo is the live fleet wheel: on every page, red or caramel in the corner means someone waits.
  const fleet = $derived(data.sessions.filter((s) => !isSessionArchived(s)));
  const pending = $derived(data.sessions.filter((s) =>
    needsDecision(s) && !isArchived(s.id) && !(snoozeUntil(s.id) > nowMin)));
  const decisions = $derived(pending.length);
  // The badge wears the worst family waiting: cherry only when something actually blocks Claude.
  const blocking = $derived(pending.some((s) => sessionDot(s) === 'attention'));

  // Account rate-limit gauges (statusline snapshots + Claude Code usage cache). Refreshed on
  // every live tick.
  let usage = $state(null);
  $effect(() => {
    ui.tick;
    getUsage().then((u) => { usage = u; }).catch(() => {});
  });
  const g5 = $derived(usage?.account?.fiveHour?.pct ?? null);
  const g7 = $derived(usage?.account?.sevenDay?.pct ?? null);
  // Fable weekly bucket: model-scoped limit, only present on accounts that have one — no bucket,
  // no gauge (the 5h / 7d ones always apply). Comes from the account usage endpoint (or, if we
  // can't reach it, Claude Code's own cache), not the statusline — so it carries both its own reset
  // countdown and its own age. Age is worth showing: the cache fallback can be hours old, and a
  // frozen gauge that looks live is worse than one that says so.
  const fable = $derived(usage?.account?.fable ?? null);
  const src = $derived(usage?.account?.usage ?? null);
  const fableAge = $derived(fable?.at ? Math.max(0, Math.round((nowMin - Date.parse(fable.at)) / 60000)) : null);
  const fableStale = $derived(fableAge != null && fableAge >= 10);
  const barW = (pct) => Math.max(0, Math.min(100, pct || 0));
  const resetHint = (min) => (min == null ? '' : ` — resets in ${min >= 60 ? Math.round(min / 60) + 'h' : min + 'm'}`);
  const ageHint = $derived(fableAge == null ? ''
    : `\n${src?.source === 'live' ? 'live' : 'from Claude Code cache'} — ${fableAge < 1 ? 'just now' : fableAge + 'min ago'}`
      + (src?.error ? ` (live fetch: ${src.error})` : ''));

  const themeLabel = $derived({ system: 'System', light: 'Light', dark: 'Dark' }[ui.theme] ?? 'System');
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const avatarInitials = $derived(initials(account.displayName, account.email));
  const avatarTitle = $derived(
    (account.displayName || account.email || 'Account')
    + (account.organizationName ? ` — ${account.organizationName}` : '')
    + '\n' + (ui.live ? 'Live — connected' : 'Reconnecting…'),
  );
</script>

<header class="topbar">
  <a class="tb-logo" href={homeHref} title="hooked — home" aria-label="hooked — home">
    <FleetWheel mini sessions={fleet} />
    <!-- the wordmark yields first when every nav tab is shown: the search field matters more -->
    {#if tabs.length <= 3}<span class="tb-word">hooked</span>{/if}
  </a>

  <nav class="tb-spaces" aria-label="Spaces">
    <a class="tb-space" class:on={onDeck} href="/">
      <Icon name="deck" size={14} /> <span class="tb-lbl">Deck</span>
      {#if decisions > 0}<span class="tb-badge" class:wait={!blocking} title="{decisions} decision{decisions > 1 ? 's' : ''} awaiting you">{decisions}</span>{/if}
    </a>
    {#each tabs as t (t.key)}
      <a class="tb-space" class:on={tabActive(t)} href={t.href} style={t.tint ? `--tab-tint:${t.tint}` : null} aria-label={t.label}><Icon name={t.icon} size={14} /> <span class="tb-lbl">{t.label}</span></a>
    {/each}
  </nav>

  <button class="tb-omni" onclick={() => onOmnibar && onOmnibar()} title="Search, launch, command…">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <span class="tb-omni-ph">Search, launch, command…</span>
    <kbd>{isMac ? '⌘' : 'Ctrl'}P</kbd>
  </button>

  <!-- `crit` (>=90%) is a second threshold above `warn` (>=75%). Only the datadog scheme styles
       it (app.css); everywhere else it is an inert class, so nothing changes visually. -->
  <div class="tb-gauges" title="Account rate limits">
    <div class="tb-gauge" class:warn={g5 != null && g5 >= 75} class:crit={g5 != null && g5 >= 90}>
      <div class="tb-g-lbl"><span>5H</span><span>{g5 != null ? g5 + '%' : '—'}</span></div>
      <div class="tb-g-track"><div class="tb-g-fill" style="width:{barW(g5)}%"></div></div>
    </div>
    <div class="tb-gauge" class:warn={g7 != null && g7 >= 75} class:crit={g7 != null && g7 >= 90}>
      <div class="tb-g-lbl"><span>7J</span><span>{g7 != null ? g7 + '%' : '—'}</span></div>
      <div class="tb-g-track"><div class="tb-g-fill" style="width:{barW(g7)}%"></div></div>
    </div>
    {#if fable}
      <div class="tb-gauge" class:warn={fable.pct != null && fable.pct >= 75} class:crit={fable.pct != null && fable.pct >= 90} class:stale={fableStale}
           title="{fable.label} weekly limit{resetHint(fable.resetInMin)}{ageHint}">
        <div class="tb-g-lbl"><span>FABLE</span><span>{fable.pct != null ? fable.pct + '%' : '—'}</span></div>
        <div class="tb-g-track"><div class="tb-g-fill" style="width:{barW(fable.pct)}%"></div></div>
      </div>
    {/if}
  </div>

  <div class="tb-actions">
    <!-- Incognito: hides every session that wasn't created in this mode (screen sharing). Wears its
         name when on — a mode that empties the dashboard must never be mistaken for a bug. -->
    <button class="tb-icon" class:incog={ui.incognito} onclick={toggleIncognitoMode} aria-label="Toggle incognito mode"
            aria-pressed={ui.incognito}
            title={ui.incognito
              ? 'Incognito: on — only sessions started in this mode are shown. Click to show everything again.'
              : 'Incognito: off — click to show only the sessions you start from now on (screen sharing)'}>
      <Icon name={ui.incognito ? 'eye-off' : 'eye'} size={16} tint={false} />
      {#if ui.incognito}<span class="tb-incog-lbl">Incognito</span>{/if}
    </button>
    <button class="tb-icon" class:on={ui.notify} onclick={toggleNotify} aria-label="Toggle notifications"
            title={ui.notify ? 'Notifications: on' : 'Notifications: off'}>
      {#if ui.notify}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.4 4 .9 5.3M18 8c0 7 3 9 3 9H7M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
      {/if}
    </button>
    <button class="tb-icon" onclick={cycleTheme} title={`Theme: ${themeLabel}`} aria-label={`Theme: ${themeLabel}`}>
      {#if ui.theme === 'light'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      {:else if ui.theme === 'dark'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      {/if}
    </button>
    <button class="tb-icon" onclick={() => openModal('trash')} title="Trash — deleted sessions (recoverable)" aria-label="Trash">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
    </button>
    <a class="tb-icon" class:active={onSettings} href="/settings" title="Settings" aria-label="Settings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </a>
  </div>

  <a class="tb-new" href="/new"><Icon name="plus" size={14} /> Session</a>
  <button class="tb-avatar" class:live={ui.live} title={avatarTitle} aria-label="Account" onclick={() => openModal('account')}>
    {avatarInitials}
  </button>
</header>

<style>
  /* The espresso bar: the shell's one committed surface (--shell-*). Every scheme other than the
     coffee default maps those tokens back onto its own panel colours, so it keeps its old bar. */
  .topbar {
    flex: 0 0 auto; display: flex; align-items: stretch; gap: 12px;
    padding: 0 14px 0 0; background: var(--shell-bg); color: var(--shell-fg);
    border-bottom: 1px solid var(--shell-line); min-height: 48px;
  }
  :global(body.focus) .topbar { display: none; }

  .tb-logo {
    align-self: stretch; display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
    padding: 0 14px 0 12px; border-right: 1px solid var(--shell-line);
    color: var(--shell-fg); text-decoration: none; transition: background .12s;
  }
  .tb-logo:hover { background: var(--shell-hover); }
  .tb-word {
    font-family: var(--font-display); font-size: var(--t-title); font-weight: 700; letter-spacing: -.02em;
    font-variation-settings: "opsz" 24; line-height: 1;
  }

  .tb-spaces { display: flex; gap: 0; flex: 0 0 auto; align-items: stretch; }
  .tb-space {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 0 13px; font-size: var(--t-ui); font-weight: 600;
    color: var(--shell-muted); text-decoration: none; white-space: nowrap;
    box-shadow: inset 0 -2px 0 transparent; transition: color .12s, box-shadow .12s;
  }
  .tb-space:hover { color: var(--shell-fg); }
  /* Active tab: the bar's own tab colour (latte on espresso), or the tab's tint in other schemes. */
  .tb-space.on { color: var(--shell-fg); box-shadow: inset 0 -2px 0 var(--shell-tab, var(--tab-tint, var(--accent))); }
  .tb-space.on :global(svg) { color: var(--shell-tab, var(--tab-tint, var(--accent))); }
  .tb-badge {
    min-width: 17px; height: 17px; padding: 0 5px; border-radius: 999px;
    background: var(--attention); color: var(--accent-fg); font-size: var(--t-micro); font-weight: 800;
    display: inline-flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums;
  }
  .tb-badge.wait { background: var(--waiting); color: var(--on-state); }

  .tb-omni {
    align-self: center;
    flex: 1 1 auto; max-width: 430px; min-width: 0;
    display: flex; align-items: center; gap: 9px; padding: 7px 12px;
    background: var(--shell-input); border: 1px solid var(--shell-line); border-radius: 10px;
    color: var(--shell-muted); font: inherit; font-size: var(--t-ui); cursor: pointer; text-align: left;
    transition: border-color .12s, background .12s;
  }
  .tb-omni:hover { border-color: color-mix(in srgb, var(--shell-accent) 55%, transparent); background: var(--shell-hover); }
  .tb-omni-ph { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tb-omni kbd {
    font: 10.5px/1 var(--mono); color: var(--shell-muted);
    background: var(--shell-hover); border: 1px solid var(--shell-line); border-radius: 4px; padding: 2px 6px;
  }

  .tb-gauges { display: flex; gap: 14px; margin-left: auto; flex: 0 0 auto; align-self: center; }
  .tb-gauge { display: flex; flex-direction: column; gap: 4px; width: 82px; }
  .tb-g-lbl {
    display: flex; justify-content: space-between;
    font-size: var(--t-micro); font-weight: 700; color: var(--shell-muted); letter-spacing: .06em;
    font-variant-numeric: tabular-nums;
  }
  .tb-g-lbl span:last-child { color: var(--shell-fg); }
  .tb-g-track { height: 4px; border-radius: 2px; background: var(--shell-line); overflow: hidden; }
  .tb-g-fill { height: 100%; border-radius: 2px; background: var(--shell-accent); transition: width .3s ease; }
  .tb-gauge.warn .tb-g-fill { background: var(--waiting); }
  .tb-gauge.crit .tb-g-fill { background: var(--attention); }
  /* Stale bucket (source older than 10 min): dimmed + hatched, so a frozen number never
     passes for a live one. The tooltip says how old and why. */
  .tb-gauge.stale { opacity: .55; }
  .tb-gauge.stale .tb-g-fill {
    background-image: repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,.35) 2px 4px);
  }

  .tb-actions { display: flex; gap: 2px; flex: 0 0 auto; align-self: center; }
  .tb-icon {
    width: 32px; height: 32px; border-radius: 8px; border: none; background: transparent;
    display: flex; align-items: center; justify-content: center; color: var(--shell-muted);
    cursor: pointer; padding: 0; text-decoration: none; transition: background .12s, color .12s;
  }
  .tb-icon:hover { background: var(--shell-hover); color: var(--shell-fg); }
  .tb-icon.on { color: var(--shell-fg); }
  /* On : le bouton s'élargit et s'annonce — impossible de laisser le mode actif sans le voir. */
  .tb-icon.incog {
    width: auto; gap: 5px; padding: 0 9px; background: var(--shell-accent); color: var(--shell-accent-fg);
  }
  .tb-incog-lbl { font-size: var(--t-meta); font-weight: 700; letter-spacing: .02em; }
  .tb-icon.active { background: var(--shell-hover); color: var(--shell-fg); }

  .tb-new {
    align-self: center;
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
    background: var(--shell-accent); color: var(--shell-accent-fg); border-radius: 999px;
    padding: 7px 15px 7px 12px; font-size: var(--t-ui); font-weight: 700; text-decoration: none;
    transition: background .12s; white-space: nowrap;
  }
  .tb-new:hover { background: var(--shell-accent-d); }

  .tb-avatar {
    align-self: center;
    position: relative; width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
    background: var(--shell-input); color: var(--shell-fg); border: 1px solid var(--shell-line);
    font: inherit; padding: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: var(--t-micro); font-weight: 700; letter-spacing: .02em;
    transition: background .12s;
  }
  .tb-avatar:hover { background: var(--shell-hover); }
  .tb-avatar::after {
    content: ""; position: absolute; bottom: -1px; right: -1px; width: 9px; height: 9px; border-radius: 50%;
    background: var(--idle); border: 2px solid var(--shell-bg);
  }
  .tb-avatar.live::after { background: var(--success); }

  @media (max-width: 1180px) { .tb-word { display: none; } .tb-logo { padding: 0 11px; } }
  @media (max-width: 900px) {
    .tb-gauges, .tb-omni kbd { display: none; }
    .tb-omni { max-width: none; }
  }
  /* Au doigt, la barre est le seul chrome permanent de l'écran : ses commandes passent le
     plancher tactile au lieu de garder leur gabarit de curseur. */
  @media (pointer: coarse) {
    .topbar { min-height: 52px; }
    .tb-icon { width: 40px; height: 40px; }
    .tb-avatar { width: 36px; height: 36px; }
    .tb-new { padding: 10px 14px; }
  }
  @media (max-width: 640px) {
    /* Les actions quittent la barre, pas l'application : thème, notifications, incognito,
       corbeille et réglages vivent tous dans la palette, ouverte ici par la loupe. */
    .tb-actions { display: none; }
    .topbar { gap: 6px; padding: 0 8px 0 0; }
    .tb-logo { padding: 0 8px; }
    /* Spaces scroll sideways instead of pushing the omnibar and "+ Session" off-screen. */
    .tb-spaces { flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .tb-spaces::-webkit-scrollbar { display: none; }
    /* Icons only on a phone: three labelled tabs overflowed under the search button. */
    .tb-space { padding: 0 12px; min-width: 44px; justify-content: center; }
    .tb-lbl { display: none; }
    /* Omnibar collapses to its magnifier — the placeholder alone eats the whole width. */
    .tb-omni { flex: 0 0 auto; padding: 10px 11px; }
    .tb-omni-ph { display: none; }
    /* Le libellé tombe, la cible reste ronde et pleine : un « + » de 28px ne s'attrape pas. */
    .tb-new { width: 40px; padding: 0; font-size: 0; gap: 0; justify-content: center; align-self: center; height: 40px; }
  }
</style>
