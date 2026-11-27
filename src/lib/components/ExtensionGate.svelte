<script>
  // The page of an extension (src/lib/extensions.svelte.js), or a notice while it is switched off,
  // not available on this machine, or failing to start.
  import Icon from './Icon.svelte';

  let { ext, children } = $props();
</script>

{#if ext?.active}
  {@render children?.()}
{:else}
  <section class="ext-off">
    <Icon name={ext?.icon || 'package'} size={22} />
    {#if ext && !ext.enabled}
      <h2>{ext.label} is off</h2>
      <p>{ext.description}</p>
      <p><a href="/settings#pset-modules">Turn it on in Settings → Modules</a></p>
    {:else if ext && ext.available === false}
      <h2>{ext.label} is not available on this machine</h2>
    {:else}
      <h2>{ext?.label} failed to start</h2>
      {#each ext?.errors || [] as e (e)}<p class="err">{e}</p>{/each}
    {/if}
  </section>
{/if}

<style>
  .ext-off { margin: 12vh auto 0; max-width: 460px; text-align: center; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .ext-off h2 { margin: 6px 0 0; color: var(--text); font-size: var(--t-title, 18px); }
  .ext-off p { margin: 0; line-height: 1.5; }
  .ext-off a { color: var(--accent); }
  .ext-off .err { color: var(--danger); font-family: var(--mono); font-size: var(--t-ui); }
</style>
