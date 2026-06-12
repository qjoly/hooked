<script>
  import { ago, mdLite } from '../lib/format.js';
  import ToolChip from './ToolChip.svelte';
  let { m } = $props();
</script>

<div class="bubble {m.role}">
  <div class="who">{m.role === 'user' ? '🧑 Toi' : '🤖 Claude'}<span class="t">{ago(m.ts)}</span></div>
  {#if m.text}<div class="md">{@html mdLite(m.text)}</div>{/if}
  {#if m.tools && m.tools.length}
    <div class="chips">
      {#each m.tools as t (t.id || t.name + ':' + t.detail)}
        <ToolChip {t} />
      {/each}
    </div>
  {/if}
</div>
