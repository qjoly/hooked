<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, settings, loadSettings, startLive, toggleFocus, cycleTheme, splitWithMostRecent, isSessionArchived, openModal } from '$lib/state.svelte.js';
  import { wheelModel, faviconSvg } from '$lib/fleetWheel.js';
  import { themeType } from '$lib/theme.svelte.js';
  import { page } from '$app/state';
  import { pageHref } from '$lib/nav.js';
  import { matchShortcut } from '$lib/shortcuts.js';
  import { trackModifier } from '$lib/peek.svelte.js';
  import { parseRunUrl } from '$lib/ghRun.js';
  import Modal from '$lib/components/Modal.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import Companion from '$lib/components/Companion.svelte';
  import TopBar from '$lib/components/TopBar.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import '../app.css';

  let { children } = $props();
  let palette;
  onMount(startLive);
  // Suivi global de la touche « go to definition » (⌘ sur Mac, ⌃ ailleurs) : un seul écouteur
  // pour toute l'application, et il rend la touche à `blur`/`visibilitychange` — un ⌘-Tab ne
  // livre jamais le keyup, et le mode resterait collé au retour dans la fenêtre.
  onMount(trackModifier);

  // Page d'accueil par défaut (réglable) : à froid (une fois par onglet), si on atterrit sur le
  // Deck `/` et que la préférence pointe ailleurs, on redirige. sessionStorage → ne se déclenche
  // qu'au premier chargement, pas quand l'utilisateur reclique « Deck » ensuite.
  onMount(async () => {
    try {
      if (sessionStorage.getItem('hooked.defaultApplied')) return;
      await loadSettings();
      sessionStorage.setItem('hooked.defaultApplied', '1');
      const dp = settings.defaultPage;
      if (dp && dp !== 'deck' && location.pathname === '/') {
        goto(pageHref(dp));
      }
    } catch (_) {}
  });

  // Deep-links de session (`[label](/session/<id>)` rendus par autolink) : le routeur client
  // SvelteKit intercepte déjà le clic (nav interne, sans reload). On ajoute juste window.focus()
  // pour remonter la fenêtre au premier plan en multi-fenêtres — sans preventDefault, pour laisser
  // SvelteKit faire la navigation. Miroir du handler de clic des notifications (state.svelte.js).
  onMount(() => {
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest && e.target.closest('a[data-session-link]');
      if (a) { try { window.focus(); } catch (_) {} }
      // A GitHub Actions run link opens the live log modal; a modifier click still opens GitHub.
      const run = e.target?.closest?.('a[href]:not([data-native])');
      if (run && parseRunUrl(run.href)) { e.preventDefault(); openModal('ghRun', { url: run.href }); }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  });

  $effect(() => {
    document.body.classList.toggle('focus', ui.focus);
  });

  // The tab icon is the fleet wheel too: with hooked in a background tab, red or caramel in the
  // favicon is the glance. Colours are read from the active palette (an SVG favicon is rendered
  // outside the document, so it cannot resolve the CSS variables itself).
  let faviconLink = null;
  let lastFavicon = '';
  $effect(() => {
    const families = wheelModel(data.sessions.filter((s) => !isSessionArchived(s))).families;
    themeType(); ui.scheme;
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const svg = faviconSvg(families, {
      attention: v('--attention'), waiting: v('--waiting'), working: v('--working'),
      bgjob: v('--background'), idle: v('--idle'), ended: v('--ended'),
    }, { bg: v('--shell-accent') || '#e4cdb1', ink: v('--shell-accent-fg') || '#1e1512' });
    if (svg === lastFavicon) return;
    lastFavicon = svg;
    if (!faviconLink) {
      faviconLink = document.createElement('link');
      faviconLink.rel = 'icon';
      faviconLink.type = 'image/svg+xml';
      document.head.appendChild(faviconLink);
    }
    faviconLink.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  });

  function onGlobalKeydown(e) {
    const id = matchShortcut(e);
    if (!id) return;
    // Session-scoped shortcuts, handled by SessionDetail's own window listener — and the
    // lens-scoped review key, handled by Ship / Branch themselves. Bailing out here (instead of
    // falling through) is what keeps the browser default intact outside a session view.
    if (id === 'open-terminal' || id === 'new-terminal' || id === 'toggle-dock' || id === 'review-file') return;

    const tag = e.target?.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
    const alwaysActive = ['command-palette', 'commands-only', 'new-session', 'settings',
      'go-sessions', 'go-board', 'go-stats', 'go-digest', 'go-memory', 'go-github',
      'toggle-sidebar', 'split-session', 'focus-mode', 'theme-cycle'];
    if (isInput && !alwaysActive.includes(id)) return;

    e.preventDefault();
    switch (id) {
      case 'command-palette': palette?.toggle(); break;
      case 'commands-only': palette?.openCommands(); break;
      case 'new-session': goto('/new'); break;
      case 'settings': goto('/settings'); break;
      case 'go-sessions': goto('/'); break;
      case 'go-board': goto('/sessions'); break;
      case 'go-stats': goto('/stats'); break;
      case 'go-digest': goto('/digest'); break;
      case 'go-memory': goto('/memory'); break;
      case 'go-github': goto('/github'); break;
      case 'toggle-sidebar': ui.sideMenuOpen = !ui.sideMenuOpen; break;
      case 'split-session': {
        const m = page.url.pathname.match(/^\/session\/(.+)/);
        if (m) splitWithMostRecent(decodeURIComponent(m[1]));
        break;
      }
      case 'focus-mode': toggleFocus(); break;
      case 'theme-cycle': cycleTheme(); break;
    }
  }
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<a href="#main-content" class="skip-link">Skip to main content</a>

<div class="shell">
  <TopBar onOmnibar={() => palette?.toggle()} />

  <main id="main-content">
    {@render children()}
  </main>

  <!-- Floating focus-mode control: leave focus (✕). -->
  <div class="focus-ctl">
    <button class="focus-fab-btn" onclick={toggleFocus} title="Exit focus mode" aria-label="Exit focus"><Icon name="close" /></button>
  </div>
</div>

<Modal />
<CommandPalette bind:this={palette} />
{#if ui.companion}<Companion />{/if}

<style>
  .skip-link {
    position: fixed; top: -100px; left: 16px; z-index: 9999;
    background: var(--accent); color: var(--accent-fg); padding: 8px 16px;
    border-radius: 0 0 8px 8px; font-weight: 700; font-size: var(--t-ui);
    text-decoration: none; transition: top .15s;
  }
  .skip-link:focus { top: 0; }

  /* Coquille de la refonte : top bar au-dessus, contenu en dessous (l'ancien rail vertical
     de 14 icônes est remplacé par la TopBar — espaces Deck/Archive + omnibar + jauges). */
  .shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  main { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }

  /* Contrôles focus : flottants en haut à droite, seulement en mode focus. */
  .focus-ctl { display: none; position: fixed; top: 12px; right: 14px; gap: 6px; z-index: 20; }
  :global(body.focus) .focus-ctl { display: flex; }
  .focus-fab-btn {
    width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: var(--t-body);
    border: 1px solid var(--border2); background: var(--bg2); color: var(--text); border-radius: 9px; cursor: pointer;
    box-shadow: var(--shadow-sm); opacity: .85; transition: opacity .12s, background .12s;
  }
  .focus-fab-btn:hover { opacity: 1; background: var(--hover); }
</style>
