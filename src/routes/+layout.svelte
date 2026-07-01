<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ui, startLive, toggleFocus, toggleSidebarPeek, cycleTheme, toggleNotify } from '$lib/state.svelte.js';
  import Modal from '$lib/components/Modal.svelte';
  import '../app.css';

  let { children } = $props();
  onMount(startLive);

  // Bouton de thème : cycle Système → Clair → Sombre. L'icône reflète le choix courant
  // (🖥️ = suit le système, ☀️ = clair forcé, 🌙 = sombre forcé).
  const THEME_UI = {
    system: { icon: '🖥️', label: 'Système' },
    light:  { icon: '☀️', label: 'Clair' },
    dark:   { icon: '🌙', label: 'Sombre' },
  };
  const themeUi = $derived(THEME_UI[ui.theme] ?? THEME_UI.system);

  // Le header et la sidebar vivent dans deux layouts distincts ; <body> est leur ancêtre
  // commun → on reflète le mode focus sur body et tout le CSS focus s'y accroche.
  $effect(() => {
    document.body.classList.toggle('focus', ui.focus);
    document.body.classList.toggle('sidebar-peek', ui.focus && ui.sidebarPeek);
  });

  const onStats = $derived(page.url.pathname.startsWith('/stats'));
  const onSearch = $derived(page.url.pathname.startsWith('/search'));
  const onSessions = $derived(!onStats && !onSearch);
</script>

<header>
  <div class="brand">🪝 <span>hooked</span></div>
  <nav class="tabs">
    <a class="tab" class:active={onSessions} href="/">Sessions</a>
    <a class="tab" class:active={onSearch} href="/search">Recherche</a>
    <a class="tab" class:active={onStats} href="/stats">Stats &amp; usage</a>
  </nav>
  <div class="status">
    <span class="dot" class:on={ui.live}></span>
    <span>{ui.live ? 'live' : 'reconnexion…'}</span>
  </div>
  <button class="theme-btn" onclick={toggleNotify}
          title={ui.notify ? 'Notifications navigateur : activées — cliquer pour couper' : 'Notifications navigateur : coupées — cliquer pour activer (alerte quand une session a fini ou attend ta réponse)'}
          aria-label="Basculer les notifications navigateur">
    <span class="theme-ico">{ui.notify ? '🔔' : '🔕'}</span>
    <span class="theme-lbl">Notifs</span>
  </button>
  <button class="theme-btn" onclick={cycleTheme}
          title={`Thème : ${themeUi.label} — cliquer pour changer`}
          aria-label={`Thème : ${themeUi.label}. Cliquer pour changer de thème.`}>
    <span class="theme-ico">{themeUi.icon}</span>
    <span class="theme-lbl">{themeUi.label}</span>
  </button>
</header>

<main>
  {@render children()}
</main>

<!-- pastille flottante visible uniquement en mode focus (cf. CSS body.focus) : ré-ouvrir la
     sidebar (☰) et quitter le focus (✕), accessibles depuis n'importe quelle page. -->
<div class="focus-fab">
  <button class="focus-fab-btn" onclick={toggleSidebarPeek}
          title={ui.sidebarPeek ? 'Replier la sidebar' : 'Ré-ouvrir la sidebar'} aria-label="Basculer la sidebar">☰</button>
  <button class="focus-fab-btn" onclick={toggleFocus} title="Quitter le mode focus" aria-label="Quitter le focus">✕</button>
</div>

<Modal />
