<script>
  import { onMount } from 'svelte';
  import { data, sessionTitle } from '$lib/state.svelte.js';
  import { getSession } from '$lib/api.js';
  import { STATE_LABEL } from '$lib/format.js';
  import Icon from '$lib/components/Icon.svelte';

  // Carte de statut vivante pour un lien profond de session (`[label](/session/<id>)`), rendue par
  // <Markdown> à la place de l'anchor brute. La racine reste une anchor `data-session-link` → le
  // handler délégué de +layout.svelte gère le focus + la nav SvelteKit sans code supplémentaire.
  // `block` : variante pleine largeur (liste du sous-onglet Sub-sessions) au lieu de la puce inline.
  let { sessionId, label = '', block = false } = $props();

  // Source vivante : l'entrée du store des sessions (rafraîchie à chaque tick SSE). Repli : un fetch
  // ponctuel de /api/session si la session n'est pas (encore) dans la liste — autre projet, filtrée,
  // ou pas encore chargée. Si les deux échouent, on retombe sur un lien texte simple (jamais pire
  // que le comportement actuel).
  const live = $derived(data.sessions.find((x) => x.id === sessionId));
  let fetched = $state(null);
  const s = $derived(live || fetched);

  onMount(async () => {
    if (live) return; // déjà dans le store → pas de fetch
    try {
      const d = await getSession(sessionId);
      if (d && (d.id || d.state)) fetched = d; // 404 renvoie {} → on garde le repli lien simple
    } catch (_) {}
  });

  const href = $derived('/session/' + encodeURIComponent(sessionId));
  const title = $derived(s ? sessionTitle(s) : (label || sessionId));
  // libellé d'état = verbe d'activité live quand ça mouline, sinon le libellé humain de l'état
  // (miroir de l'en-tête de SessionDetail).
  const statusText = $derived(
    s ? (s.state === 'working' && s.activity ? s.activity + '…' : (STATE_LABEL[s.state] || s.state)) : '',
  );
  const bg = $derived(s && s.bgJobs && s.bgJobs.length ? s.bgJobs.length : 0);
</script>

{#if s}
  <a {href} class="session-card s-{s.state}" class:block data-session-link title="{title} — {statusText}">
    <span class="sc-dot sdot"></span>
    <span class="sc-body">
      <span class="sc-title">{title}</span>
      <span class="sc-sub">
        <span class="sc-status">{statusText}</span>
        {#if s.projectName}<span class="sc-proj">· {s.projectName}</span>{/if}
        {#if bg}<span class="sc-bg">· <Icon name="background" color="var(--background)" size={13} /> {bg} bg job{bg > 1 ? 's' : ''}</span>{/if}
      </span>
    </span>
  </a>
{:else}
  <!-- session inconnue (jamais chargée / supprimée) : lien texte simple, identique au rendu actuel. -->
  <a {href} class="session-link" class:block data-session-link>{label || sessionId}</a>
{/if}

<style>
  /* carte inline : ne casse pas le flux d'un paragraphe si le lien est au milieu d'une phrase. */
  .session-card {
    display: inline-flex; align-items: center; gap: 8px;
    max-width: 100%; vertical-align: middle;
    margin: 1px 2px; padding: 4px 10px 4px 8px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
    text-decoration: none; color: var(--text); line-height: 1.25;
  }
  .session-card:hover { background: var(--bg3); border-color: var(--accent-soft, var(--border)); }
  /* le point reprend EXACTEMENT le dot coloré/animé de la sidebar (app.css : .s-<state> .sdot).
     On force juste l'affichage inline (la règle globale ne pose pas de display). */
  .session-card .sdot { display: inline-block; margin: 0; flex-shrink: 0; }
  .sc-body { display: inline-flex; flex-direction: column; min-width: 0; }
  .sc-title {
    font-weight: 600; font-size: var(--t-ui);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 28ch;
  }
  .sc-sub {
    display: inline-flex; gap: 4px; align-items: baseline;
    font-size: var(--t-micro); color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 34ch;
  }
  /* le libellé d'état prend la couleur de l'état (variables partagées avec la sidebar). */
  .sc-status { font-weight: 600; }
  .s-working .sc-status { color: var(--working); }
  .s-waiting .sc-status { color: var(--waiting); }
  .s-attention .sc-status { color: var(--attention); }
  .s-background .sc-status { color: var(--background); }
  .s-idle .sc-status { color: var(--idle); }
  .s-ended .sc-status { color: var(--ended); }
  .s-past .sc-status { color: var(--past); }

  /* variante pleine largeur : liste verticale (sous-onglet Sub-sessions) au lieu de la puce inline.
     La carte grandit pour remplir la ligne ; titre/sous-titre libérés de la contrainte inline. */
  .session-card.block { display: flex; margin: 0; padding: 8px 12px; vertical-align: initial; }
  .session-card.block .sc-body { display: flex; flex: 1; }
  .session-card.block .sc-title,
  .session-card.block .sc-sub { max-width: none; }
  /* repli pleine largeur (session non résolue) : coquille de carte cohérente avec le reste. */
  .session-link.block {
    display: flex; align-items: center; padding: 8px 12px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
    text-decoration: none; color: var(--text); line-height: 1.25;
  }
  .session-link.block:hover { background: var(--bg3); }
</style>
