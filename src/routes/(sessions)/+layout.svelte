<script>
  import { page } from '$app/state';
  import Sidebar from '$lib/components/Sidebar.svelte';

  let { children } = $props();
  const path = $derived(page.url.pathname);
  // Vue Sessions = inbox + cockpit (accueil `/` et `/session/<id>`). L'écran « nouvelle session »
  // (`/new`) est plein écran, sans colonne inbox (cf. redesign).
  const showInbox = $derived(path === '/' || path.startsWith('/session/'));
  // détail (session ouverte) → on masque l'inbox en mobile (elle glisse sous le cockpit).
  const hasDetail = $derived(path !== '/');
</script>

<section class="view active">
  <div class="layout" class:has-detail={hasDetail} class:no-inbox={!showInbox}>
    {#if showInbox}<Sidebar />{/if}
    <div class="main-pane">
      {@render children()}
    </div>
  </div>
</section>
