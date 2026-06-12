<script>
  import { data, openModal } from '../lib/state.svelte.js';
  import { fmtTokens, fmtCost } from '../lib/format.js';

  const S = $derived(data.sessions);
  const sum = (f) => S.reduce((a, s) => a + f(s), 0);
  const nb = (states) => S.filter((s) => states.includes(s.state)).length;
</script>

<div class="overview">
  <div class="global-bar">
    <div class="gp"><span class="gp-i">📊</span><div><div class="gp-v">{S.length}</div><div class="gp-l">sessions</div></div></div>
    <div class="gp g-working"><span class="gp-i">🔵</span><div><div class="gp-v">{nb(['working'])}</div><div class="gp-l">en cours</div></div></div>
    <div class="gp g-waiting"><span class="gp-i">🟡</span><div><div class="gp-v">{nb(['waiting', 'attention'])}</div><div class="gp-l">en attente</div></div></div>
    <div class="gp"><span class="gp-i">💬</span><div><div class="gp-v">{sum((s) => s.userPrompts)}</div><div class="gp-l">prompts</div></div></div>
    <div class="gp"><span class="gp-i">🎟</span><div><div class="gp-v">{fmtTokens(sum((s) => s.usage.output + s.usage.input))}</div><div class="gp-l">tokens</div></div></div>
    <div class="gp g-cost clickable" onclick={() => openModal('cost')}>
      <span class="gp-i">💲</span><div><div class="gp-v">{fmtCost(sum((s) => s.cost))}</div><div class="gp-l">coût API estimé ›</div></div>
    </div>
  </div>
  <p class="ov-hint">← Sélectionne une session à gauche pour relire la conversation (lecture seule).</p>
</div>
