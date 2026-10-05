<script>
  // series(key) → a colour per row (the project chart paints each bar with its project lot).
  let { entries, fmt, series = null } = $props();
  const sorted = $derived.by(() => {
    const e = entries.slice().sort((a, b) => b[1] - a[1]).slice(0, 8);
    return e;
  });
  const max = $derived(Math.max(1e-6, ...sorted.map((e) => e[1])));
</script>

{#if !sorted.length}
  <div class="empty">No data</div>
{:else}
  {#each sorted as [k, v]}
    <div class="bar-row">
      <span class="label" title={k}>{k}</span>
      <span class="track"><span class="fill" style="width:{Math.max(2, (v / max) * 100)}%{series ? ';--series:' + series(k) : ''}"></span></span>
      <span class="val">{fmt(v)}</span>
    </div>
  {/each}
{/if}
