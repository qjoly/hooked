<script>
  import { MODE_OPTS, shortModel } from '#lib/format.js';
  import { getCapabilities } from '#lib/api.js';
  import { settings } from '#lib/state.svelte.js';
  import { filterModelGroups, filterModelOpts } from '#lib/models.js';
  import Icon from '#lib/components/Icon.svelte';
  // `compact` : pilules en ligne (sous une chatbox) plutôt que le formulaire des modales.
  // `onchange` : callback appelé à chaque changement (sert au changement à chaud d'une session).
  // `showMode` : ajoute le sélecteur de mode de permission (→ claude --permission-mode) au
  // lancement d'une session. Absent du changement à chaud (qui a son propre sélecteur live).
  // `allowInherit` : ajoute une option « hériter » (valeur '') en tête de chaque sélecteur — sert
  // aux défauts de session (Réglages), où '' signifie « retomber sur la config Claude Code ».
  // `modelOpts`/`effortList` : listes externes (provider pi → /api/pi-options) qui remplacent
  // les capacités Claude quand elles sont fournies.
  let { model = $bindable('opus'), effort = $bindable('high'), mode = $bindable('default'), compact = false, showMode = false, allowInherit = false, onchange = null, disabled = false, modelOpts = null, effortList = null, modelOptsLabel = null, hiddenExtra = null } = $props();
  const fire = () => onchange && onchange();

  // Modèles & efforts dérivés LIVE du binaire claude (cf. server/capabilities.js), chargés une fois
  // (getCapabilities est mémoïsé). Pas de liste figée : sans claude, les listes sont vides.
  let modelGroups = $state([]);
  let efforts = $state([]);
  $effect(() => {
    if (modelOpts) return; // listes externes fournies (pi) : pas besoin des capacités Claude
    let alive = true;
    getCapabilities().then((c) => { if (alive) { modelGroups = c.models || []; efforts = c.efforts || []; } }).catch(() => {});
    return () => { alive = false; };
  });

  // On garde toujours la valeur COURANTE affichable même si les listes ne sont pas (encore) chargées
  // ou ne la contiennent pas (ex. session sur une version épinglée hors bundle, ou 'ultracode' sur un
  // claude trop ancien) — sinon le <select> lié perdrait sa valeur.
  const effortBase = $derived(effortList || efforts);
  const effortOpts = $derived(effort && !effortBase.includes(effort) ? [effort, ...effortBase] : effortBase);
  // Filtre d'affichage des Réglages (liste noire, cf. src/lib/models.js) appliqué ICI et pas côté
  // serveur : /api/capabilities est mémoïsé pour tout le chargement de page, alors que `settings`
  // est réactif → (dé)cocher une version se répercute immédiatement sur les sélecteurs ouverts.
  // `model` est passé en `keep` : le modèle courant d'une session survit toujours au filtre.
  const visibleGroups = $derived(filterModelGroups(modelGroups, settings.hiddenModels, model));
  // Même réglage pour le provider pi : sa liste vient de /api/pi-options (`pi --list-models`), donc
  // elle ne traverse pas server/capabilities.js et le filtre s'applique ici, sur la liste plate.
  const visiblePiOpts = $derived(modelOpts ? filterModelOpts(modelOpts, [...(settings.hiddenPiModels || []), ...(hiddenExtra || [])], model) : null);
  const modelView = $derived.by(() => {
    if (modelOpts) {
      const opts = visiblePiOpts || modelOpts;
      const has = opts.some(([v]) => v === model);
      return [{ label: modelOptsLabel || 'Models', opts: model && !has ? [[model, shortModel(model)], ...opts] : opts }];
    }
    const has = visibleGroups.some((g) => g.opts.some(([v]) => v === model));
    if (model && !has) return [{ label: '', opts: [[model, shortModel(model)]] }, ...visibleGroups];
    return visibleGroups;
  });
</script>

{#if compact}
  <div class="me-inline">
    <span class="me-pill" title="Model">
      <span class="me-ico"><Icon name="model" size={14} /></span>
      <select bind:value={model} onchange={fire} {disabled}>
        {#if allowInherit}<option value="">Inherit</option>{/if}
        {#each modelView as g}
          <optgroup label={g.label}>
            {#each g.opts as [v, l]}<option value={v}>{l}</option>{/each}
          </optgroup>
        {/each}
      </select>
    </span>
    <span class="me-pill" title="Reasoning effort">
      <span class="me-ico"><Icon name="effort" size={14} /></span>
      <select bind:value={effort} onchange={fire} {disabled}>
        {#if allowInherit}<option value="">Inherit</option>{/if}
        {#each effortOpts as v}<option value={v}>{v}</option>{/each}
      </select>
    </span>
    {#if showMode}
      <span class="me-pill" title="Permission mode at launch (claude --permission-mode)">
        <span class="me-ico"><Icon name="mode" size={14} /></span>
        <select bind:value={mode} onchange={fire} {disabled}>
          {#if allowInherit}<option value="">Inherit</option>{/if}
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
        {#if allowInherit}<option value="">Inherit (Claude Code default)</option>{/if}
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
        {#if allowInherit}<option value="">Inherit</option>{/if}
        {#each effortOpts as v}<option value={v}>{v}</option>{/each}
      </select>
    </div>
  </div>
  {#if showMode}
    <div class="lf-mode">
      <label class="lf-label">Permission mode</label>
      <select class="lf-input" bind:value={mode} onchange={fire} {disabled}>
        {#if allowInherit}<option value="">Inherit (Claude Code default)</option>{/if}
        {#each MODE_OPTS as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
    </div>
  {/if}
{/if}
