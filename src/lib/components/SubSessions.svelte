<script>
  import SessionCard from './SessionCard.svelte';
  import Icon from '$lib/components/Icon.svelte';

  // Sessions que cette conversation a créées ou référencées : `[{ id, label, source }]` calculé
  // côté serveur (server/subSessions.js) et transporté dans le détail → reste vivant au tick SSE.
  // Chaque entrée est rendue en <SessionCard block> (pleine largeur, statut live depuis le store).
  let { subSessions = [] } = $props();
</script>

{#if subSessions.length}
  <div class="subsessions">
    {#each subSessions as ss (ss.id)}
      <div class="ss-row">
        <SessionCard sessionId={ss.id} label={ss.label} block />
        <span class="ss-source ss-{ss.source}" title={ss.source === 'created' ? 'Started by this conversation' : 'Linked from this conversation'}>
          {#if ss.source === 'created'}<Icon name="activity" size={12} /> created{:else}<Icon name="external" size={12} /> referenced{/if}
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="pane-empty">No sub-sessions created or referenced by this conversation.</div>
{/if}

<style>
  .subsessions { display: flex; flex-direction: column; gap: 6px; padding: 6px 2px; }
  .ss-row { display: flex; align-items: center; gap: 10px; }
  /* la carte (ou le repli) remplit la ligne, en laissant la place au badge de source à droite. */
  .ss-row :global(.session-card),
  .ss-row :global(.session-link) { flex: 1; min-width: 0; }
  .ss-source { flex-shrink: 0; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .ss-created { color: var(--accent, var(--muted)); }
</style>
