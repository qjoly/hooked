<script>
  import { page } from '$app/state';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';

  let { children } = $props();
  const path = $derived(page.url.pathname);
  // Refonte : l'accueil `/` est le Deck (pleine largeur). Les pages « session ouverte » ET la page
  // Sessions (`/sessions`, rien de sélectionné) affichent le side menu gauche + le contenu à droite.
  const onSession = $derived(path.startsWith('/session/'));
  // La sidebar reste TOUJOURS visible en split (c'est la liste nommée des sessions — la cacher
  // fait « perdre les labels ») ; seul le dock droit se replie quand les panes sont étroits
  // (ui.splitCompact, géré dans SessionDetail). L'utilisateur peut la replier lui-même (⌘B).
  const showSidebar = $derived(onSession || path === '/sessions');
</script>

<section class="view active">
  <div class="layout" class:has-detail={showSidebar} class:no-inbox={!showSidebar}>
    {#if showSidebar}<SessionSidebar />{/if}
    <div class="main-pane">
      {@render children()}
    </div>
  </div>
</section>
