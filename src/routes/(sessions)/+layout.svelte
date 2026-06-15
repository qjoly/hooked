<script>
  import { page } from '$app/state';
  import Sidebar from '$lib/components/Sidebar.svelte';

  let { children } = $props();
  // détail (session ouverte) ou écran « nouvelle session » → on masque la sidebar en mobile.
  const hasDetail = $derived(page.url.pathname !== '/');
</script>

<section class="view active">
  <div class="layout" class:has-detail={hasDetail}>
    <Sidebar />
    <div class="main-pane">
      {@render children()}
    </div>
  </div>
</section>
