<script>
  import { MODEL_OPTS, EFFORT_OPTS } from '../lib/format.js';
  // `compact` : pilules en ligne (sous une chatbox) plutôt que le formulaire des modales.
  // `onchange` : callback appelé à chaque changement (sert au changement à chaud d'une session).
  let { model = $bindable('opus'), effort = $bindable('high'), compact = false, onchange = null, disabled = false } = $props();
  const fire = () => onchange && onchange();
</script>

{#if compact}
  <div class="me-inline">
    <span class="me-pill" title="Modèle">
      <span class="me-ico">✳</span>
      <select bind:value={model} onchange={fire} {disabled}>
        {#each MODEL_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
    </span>
    <span class="me-pill" title="Effort de raisonnement">
      <span class="me-ico">⚡</span>
      <select bind:value={effort} onchange={fire} {disabled}>
        {#each EFFORT_OPTS as v}<option value={v}>{v}</option>{/each}
      </select>
    </span>
  </div>
{:else}
  <div class="lf-row">
    <div>
      <label class="lf-label">Modèle</label>
      <select class="lf-input" bind:value={model} onchange={fire} {disabled}>
        {#each MODEL_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
    </div>
    <div>
      <label class="lf-label">Effort</label>
      <select class="lf-input" bind:value={effort} onchange={fire} {disabled}>
        {#each EFFORT_OPTS as v}<option value={v}>{v}</option>{/each}
      </select>
    </div>
  </div>
{/if}
