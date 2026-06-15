<script>
  let { entries, fmt } = $props();
  const sorted = $derived.by(() => {
    const e = entries.slice().sort((a, b) => b[1] - a[1]).slice(0, 8);
    return e;
  });
  const max = $derived(Math.max(1e-6, ...sorted.map((e) => e[1])));
</script>

{#if !sorted.length}
  <div class="empty">Aucune donnée</div>
{:else}
  {#each sorted as [k, v]}
    <div class="bar-row">
      <span class="label" title={k}>{k}</span>
      <span class="track"><span class="fill" style="width:{Math.max(2, (v / max) * 100)}%"></span></span>
      <span class="val">{fmt(v)}</span>
    </div>
  {/each}
{/if}
