<script>
  import { MODE_OPTS, shortModel } from '$lib/format.js';
  import { getCapabilities } from '$lib/api.js';
  // `compact` : pilules en ligne (sous une chatbox) plutôt que le formulaire des modales.
  // `onchange` : callback appelé à chaque changement (sert au changement à chaud d'une session).
  // `showMode` : ajoute le sélecteur de mode de permission (→ claude --permission-mode) au
  // lancement d'une session. Absent du changement à chaud (qui a son propre sélecteur live).
  let { model = $bindable('opus'), effort = $bindable('high'), mode = $bindable('default'), compact = false, showMode = false, onchange = null, disabled = false } = $props();
  const fire = () => onchange && onchange();

  // Modèles & efforts dérivés LIVE du binaire claude (cf. server/capabilities.js), chargés une fois
  // (getCapabilities est mémoïsé). Pas de liste figée : sans claude, les listes sont vides.
  let modelGroups = $state([]);
  let efforts = $state([]);
  $effect(() => {
    let alive = true;
    getCapabilities().then((c) => { if (alive) { modelGroups = c.models || []; efforts = c.efforts || []; } }).catch(() => {});
    return () => { alive = false; };
  });

  // On garde toujours la valeur COURANTE affichable même si les listes ne sont pas (encore) chargées
  // ou ne la contiennent pas (ex. session sur une version épinglée hors bundle, ou 'ultracode' sur un
  // claude trop ancien) — sinon le <select> lié perdrait sa valeur.
  const effortOpts = $derived(effort && !efforts.includes(effort) ? [effort, ...efforts] : efforts);
  const modelView = $derived.by(() => {
    const has = modelGroups.some((g) => g.opts.some(([v]) => v === model));
    if (model && !has) return [{ label: '', opts: [[model, shortModel(model)]] }, ...modelGroups];
    return modelGroups;
  });
</script>

{#if compact}
  <div class="me-inline">
    <span class="me-pill" title="Model">
      <span class="me-ico">✳</span>
      <select bind:value={model} onchange={fire} {disabled}>
        {#each modelView as g}
          <optgroup label={g.label}>
            {#each g.opts as [v, l]}<option value={v}>{l}</option>{/each}
          </optgroup>
        {/each}
      </select>
    </span>
    <span class="me-pill" title="Reasoning effort">
      <span class="me-ico">⚡</span>
      <select bind:value={effort} onchange={fire} {disabled}>
        {#each effortOpts as v}<option value={v}>{v}</option>{/each}
      </select>
    </span>
    {#if showMode}
      <span class="me-pill" title="Permission mode at launch (claude --permission-mode)">
        <span class="me-ico">🛡</span>
        <select bind:value={mode} onchange={fire} {disabled}>
          {#each MODE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
        </select>
      </span>
    {/if}
  </div>
{:else}
  <div class="lf-row">
    <div>
      <label class="lf-label">Model</label>
      <select class="lf-input" bind:value={model} onchange={fire} {disabled}>
        {#each modelView as g}
          <optgroup label={g.label}>
            {#each g.opts as [v, l]}<option value={v}>{l}</option>{/each}
          </optgroup>
        {/each}
      </select>
    </div>
    <div>
      <label class="lf-label">Effort</label>
      <select class="lf-input" bind:value={effort} onchange={fire} {disabled}>
        {#each effortOpts as v}<option value={v}>{v}</option>{/each}
      </select>
    </div>
  </div>
  {#if showMode}
    <div class="lf-mode">
      <label class="lf-label">Permission mode</label>
      <select class="lf-input" bind:value={mode} onchange={fire} {disabled}>
        {#each MODE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
    </div>
  {/if}
{/if}
