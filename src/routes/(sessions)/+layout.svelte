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
  // `has-detail` veut dire « une session est ouverte », pas « la sidebar existe ». La nuance ne se
  // voit qu'en dessous de 900px, où elle décide qui occupe l'écran : sur /sessions, rien n'est
  // sélectionné, donc c'est la liste qui doit tenir l'écran — et pas un volet vide invitant à
  // choisir à gauche, là où il n'y a pas de gauche.
</script>

<section class="view active">
  <div class="layout" class:has-detail={onSession} class:no-inbox={!showSidebar}>
    {#if showSidebar}<SessionSidebar />{/if}
    <div class="main-pane">
      {@render children()}
    </div>
  </div>
</section>
