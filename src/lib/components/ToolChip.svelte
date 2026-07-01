<script>
  // Un outil : pastille cliquable + détail (entrée JSON / résultat) repliable.
  // L'état déplié est local au composant ; comme la liste est keyée par id de tool_use,
  // il survit aux re-render live (le composant n'est pas recréé).
  let { t } = $props();
  let open = $state(false);
  const hasDetail = $derived(!!(t.inputText || t.result));
</script>

<div class="tool" class:has-detail={hasDetail} class:open>
  <span class="chip" onclick={() => { if (hasDetail) open = !open; }}>
    🔧 {t.name}{#if t.detail}<span class="chip-d">{t.detail}</span>{/if}{#if hasDetail}<span class="chip-x">▸</span>{/if}
  </span>
  {#if hasDetail}
    <div class="tool-detail">
      {#if t.inputText}<div class="td-sec"><div class="td-h">input</div><pre>{t.inputText}</pre></div>{/if}
      {#if t.result}<div class="td-sec"><div class="td-h">result</div><pre>{t.result}</pre></div>{/if}
    </div>
  {/if}
</div>
