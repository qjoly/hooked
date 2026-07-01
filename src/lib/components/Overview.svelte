<script>
  import { data, openModal } from '$lib/state.svelte.js';
  import { fmtTokens, fmtCost } from '$lib/format.js';

  const S = $derived(data.sessions);
  const sum = (f) => S.reduce((a, s) => a + f(s), 0);
  const nb = (states) => S.filter((s) => states.includes(s.state)).length;
</script>

<div class="overview">
  <div class="ov-stats">
    <span><b>{S.length}</b> sessions</span>
    {#if nb(['working'])}<span class="c-working"><b>{nb(['working'])}</b> en cours</span>{/if}
    {#if nb(['waiting', 'attention'])}<span class="c-waiting"><b>{nb(['waiting', 'attention'])}</b> en attente</span>{/if}
    <span><b>{sum((s) => s.userPrompts)}</b> prompts</span>
    <span><b>{fmtTokens(sum((s) => s.usage.output + s.usage.input))}</b> tokens</span>
    <button class="ov-cost" onclick={() => openModal('cost')}><b>{fmtCost(sum((s) => s.cost))}</b> coût API ›</button>
  </div>
  <p class="ov-hint">← Sélectionne une session à gauche pour relire la conversation (lecture seule).</p>
</div>

<style>
  .ov-stats {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 22px;
    font-size: 13.5px; color: var(--muted);
  }
  .ov-stats span, .ov-stats .ov-cost { display: inline-flex; align-items: baseline; gap: 5px; }
  .ov-stats b { font-size: 17px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
  .ov-stats .c-working b { color: var(--working); }
  .ov-stats .c-waiting b { color: var(--waiting); }
  .ov-cost { background: none; border: none; padding: 0; font: inherit; color: var(--accent-d); cursor: pointer; }
  .ov-cost b { color: var(--accent-d); }
  .ov-cost:hover { text-decoration: underline; }
</style>
