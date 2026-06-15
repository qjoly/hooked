<script>
  let { o } = $props();
  // edit : lignes alignées par index (avant | après)
  const rows = $derived.by(() => {
    if (o.kind === 'write' || o.kind === 'notebook') return null;
    const oldL = o.old ? o.old.split('\n') : [];
    const newL = o.new ? o.new.split('\n') : [];
    const n = Math.max(oldL.length, newL.length, 1);
    const r = [];
    for (let i = 0; i < n; i++) r.push([i < oldL.length ? oldL[i] : null, i < newL.length ? newL[i] : null]);
    return r;
  });
  const writeSrc = $derived(o.kind === 'write' ? o.content : o.new);
</script>

{#if o.kind === 'write' || o.kind === 'notebook'}
  <div class="diff">
    <div class="diff-tag write">{o.kind === 'write' ? '＋ nouveau contenu' : 'notebook'}</div>
    <div class="diff-body">
      {#each (writeSrc || '').split('\n') as l}<div class="dl add">{l}</div>{/each}
    </div>
  </div>
{:else}
  <div class="diff">
    {#if o.all}<div class="diff-tag">remplace toutes les occurrences</div>{/if}
    <div class="diff-split">
      <div class="ds-head">avant</div><div class="ds-head">après</div>
      {#each rows as [oldLine, newLine]}
        {#if oldLine != null}<div class="dl del">{oldLine}</div>{:else}<div class="dl nil"></div>{/if}
        {#if newLine != null}<div class="dl add">{newLine}</div>{:else}<div class="dl nil"></div>{/if}
      {/each}
    </div>
  </div>
{/if}
