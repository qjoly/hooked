<script>
  // The page of a module (modules/index.js), or a notice while that module is switched off.
  import { settings } from '#lib/state.svelte.js';
  import { MODULES, moduleOn } from '#modules/index.js';
  import Icon from './Icon.svelte';

  let { id, children } = $props();
  const mod = $derived(MODULES.find((m) => m.id === id));
  const on = $derived(moduleOn(settings, id));
</script>

{#if on}
  {@render children?.()}
{:else}
  <section class="module-off">
    <Icon name={mod?.icon || 'package'} size={22} />
    <h2>{mod?.label || id} is off</h2>
    <p>{mod?.description}</p>
    <p><a href="/settings#pset-modules">Turn it on in Settings → Modules</a></p>
  </section>
{/if}

<style>
  .module-off { margin: 12vh auto 0; max-width: 460px; text-align: center; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .module-off h2 { margin: 6px 0 0; color: var(--text); font-size: var(--t-title, 18px); }
  .module-off p { margin: 0; line-height: 1.5; }
  .module-off a { color: var(--accent); }
</style>
