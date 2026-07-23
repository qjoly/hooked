<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ui, data, startLive, toggleFocus, toggleSidebarPeek, cycleTheme, toggleNotify, toggleNotifyPinnedOnly, openModal } from '$lib/state.svelte.js';
  import Modal from '$lib/components/Modal.svelte';
  import '../app.css';

  let { children } = $props();
  onMount(startLive);

  // Deep-links de session (`[label](/session/<id>)` rendus par autolink) : le routeur client
  // SvelteKit intercepte déjà le clic (nav interne, sans reload). On ajoute juste window.focus()
  // pour remonter la fenêtre au premier plan en multi-fenêtres — sans preventDefault, pour laisser
  // SvelteKit faire la navigation. Miroir du handler de clic des notifications (state.svelte.js).
  onMount(() => {
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest && e.target.closest('a[data-session-link]');
      if (a) { try { window.focus(); } catch (_) {} }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  });

  // Bouton de thème : cycle Système → Clair → Sombre. L'icône reflète le choix courant.
  const themeLabel = $derived({ system: 'System', light: 'Light', dark: 'Dark' }[ui.theme] ?? 'System');

  // Le rail et l'inbox vivent dans deux layouts distincts ; <body> est leur ancêtre commun →
  // on reflète le mode focus sur body et tout le CSS focus s'y accroche.
  $effect(() => {
    document.body.classList.toggle('focus', ui.focus);
    document.body.classList.toggle('sidebar-peek', ui.focus && ui.sidebarPeek);
  });

  const onStats = $derived(page.url.pathname.startsWith('/stats'));
  const onSearch = $derived(page.url.pathname.startsWith('/search'));
  const onSettings = $derived(page.url.pathname.startsWith('/settings'));
  const onNew = $derived(page.url.pathname.startsWith('/new'));
  const onBoard = $derived(page.url.pathname.startsWith('/board'));
  const onSessions = $derived(!onStats && !onSearch && !onSettings && !onNew && !onBoard);

  // pastille « à traiter » sur l'icône Sessions du rail : question/plan en attente, ou état
  // waiting/attention (Claude t'attend). Miroir logique du badge d'onglet (notify.js).
  const needsReply = $derived(
    data.sessions.filter((s) => s.hasQuestion || s.hasPlan || s.state === 'waiting' || s.state === 'attention').length,
  );
</script>

<div class="shell">
  <nav class="rail" aria-label="Primary">
    <a class="rail-logo" class:active={onBoard} href="/board" title="Board — overview of all sessions" aria-label="Board">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-9-5.2M6 16a6 6 0 0 0 9 5.2"/><circle cx="12" cy="12" r="3"/></svg>
    </a>

    <a class="rail-item" class:active={onSessions} href="/" title="Sessions" aria-label="Sessions">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
      {#if needsReply > 0}<span class="rail-dot" title="{needsReply} awaiting your reply"></span>{/if}
    </a>
    <a class="rail-item" class:active={onNew} href="/new" title="New session" aria-label="New session">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
    </a>
    <a class="rail-item" class:active={onSearch} href="/search" title="Search" aria-label="Search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    </a>
    <a class="rail-item" class:active={onStats} href="/stats" title="Stats & usage" aria-label="Stats and usage">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
    </a>

    <div class="rail-spacer"></div>

    <button class="rail-item" class:on={ui.notify} onclick={toggleNotify} aria-label="Toggle browser notifications"
            title={ui.notify ? 'Browser notifications: on — click to turn off' : 'Browser notifications: off — click to turn on'}>
      {#if ui.notify}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      {:else}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.4 4 .9 5.3M18 8c0 7 3 9 3 9H7M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
      {/if}
    </button>
    <button class="rail-item" class:on={ui.notifyPinnedOnly} onclick={toggleNotifyPinnedOnly} disabled={!ui.notify}
            aria-label="Toggle pinned-only notifications"
            title={!ui.notify ? 'Enable notifications first' : ui.notifyPinnedOnly ? 'Notifying pinned sessions only — click to notify all' : 'Notifying all sessions — click to restrict to pinned only'}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8"/><path d="M15 6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8"/><path d="M5 17h14l-1.1-2.2A2 2 0 0 0 16.1 14H7.9a2 2 0 0 0-1.8 1.1z"/></svg>
    </button>
    <button class="rail-item" onclick={() => openModal('trash')} title="Trash — deleted sessions (recoverable)" aria-label="Trash">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
    </button>
    <a class="rail-item" class:active={onSettings} href="/settings" title="Settings" aria-label="Settings">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </a>
    <button class="rail-item" onclick={cycleTheme} title={`Theme: ${themeLabel} — click to change`} aria-label={`Theme: ${themeLabel}. Click to change.`}>
      {#if ui.theme === 'light'}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      {:else if ui.theme === 'dark'}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>
      {:else}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      {/if}
    </button>
    <div class="rail-avatar" class:live={ui.live} title={ui.live ? 'Live — connected' : 'Reconnecting…'}>BT</div>
  </nav>

  <main>
    {@render children()}
  </main>

  <!-- Contrôles du mode focus (flottants) : ré-ouvrir l'inbox (☰) et quitter le focus (✕). -->
  <div class="focus-ctl">
    <button class="focus-fab-btn" onclick={toggleSidebarPeek}
            title={ui.sidebarPeek ? 'Collapse inbox' : 'Re-open inbox'} aria-label="Toggle inbox">☰</button>
    <button class="focus-fab-btn" onclick={toggleFocus} title="Exit focus mode" aria-label="Exit focus">✕</button>
  </div>
</div>

<Modal />

<style>
  .shell { flex: 1 1 auto; min-height: 0; display: flex; }

  .rail {
    width: 58px; flex: 0 0 auto; background: var(--bg2);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center;
    padding: 14px 0; gap: 6px; overflow-y: auto;
  }
  .rail-logo {
    width: 32px; height: 32px; border-radius: 9px; background: var(--accent); color: var(--accent-fg);
    display: flex; align-items: center; justify-content: center; margin-bottom: 12px; flex: 0 0 auto;
    text-decoration: none; cursor: pointer; transition: box-shadow .12s, transform .05s;
  }
  .rail-logo:hover { box-shadow: 0 0 0 3px var(--accent-soft); }
  .rail-logo:active { transform: translateY(1px); }
  .rail-logo.active { box-shadow: 0 0 0 3px var(--accent-soft); }
  .rail-item {
    position: relative; width: 38px; height: 38px; border-radius: 10px; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    color: var(--muted); background: transparent; border: none; cursor: pointer; padding: 0;
    text-decoration: none; transition: background .12s, color .12s;
  }
  .rail-item:hover { background: var(--hover); color: var(--text); }
  .rail-item.active { background: var(--accent-soft); color: var(--accent); }
  .rail-item.on { color: var(--accent); }
  .rail-item:disabled { opacity: .4; cursor: default; }
  .rail-item:disabled:hover { background: transparent; color: var(--muted); }
  .rail-dot {
    position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border-radius: 50%;
    background: var(--warn); border: 1.5px solid var(--bg2);
  }
  .rail-spacer { flex: 1 1 auto; }
  .rail-avatar {
    position: relative; width: 32px; height: 32px; border-radius: 50%; flex: 0 0 auto;
    background: var(--chip); color: var(--muted); margin-top: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; letter-spacing: .02em;
  }
  .rail-avatar::after {
    content: ""; position: absolute; bottom: 0; right: 0; width: 9px; height: 9px; border-radius: 50%;
    background: var(--idle); border: 2px solid var(--bg2);
  }
  .rail-avatar.live::after { background: var(--success); }

  /* Contrôles focus : flottants en haut à droite, seulement en mode focus. */
  .focus-ctl { display: none; position: fixed; top: 12px; right: 14px; gap: 6px; z-index: 20; }
  :global(body.focus) .focus-ctl { display: flex; }
  .focus-fab-btn {
    width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: 14px;
    border: 1px solid var(--border2); background: var(--bg2); color: var(--text); border-radius: 9px; cursor: pointer;
    box-shadow: var(--shadow-sm); opacity: .85; transition: opacity .12s, background .12s;
  }
  .focus-fab-btn:hover { opacity: 1; background: var(--hover); }

  @media (max-width: 560px) {
    .rail { width: 50px; }
    .rail-logo { width: 30px; height: 30px; }
    .rail-item { width: 36px; height: 36px; }
  }
</style>
