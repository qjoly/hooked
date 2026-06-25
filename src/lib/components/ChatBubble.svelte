<script>
  import { ago } from '$lib/format.js';
  import ToolChip from './ToolChip.svelte';
  import Markdown from './Markdown.svelte';
  let { m } = $props();
</script>

<div class="bubble {m.role}" data-msg-ts={m.ts || ''}>
  <div class="who">{m.role === 'user' ? '🧑 Toi' : '🤖 Claude'}<span class="t">{ago(m.ts)}</span></div>
  {#if m.text}<div class="md"><Markdown text={m.text} /></div>{/if}
  {#if m.tools && m.tools.length}
    <div class="chips">
      {#each m.tools as t (t.id || t.name + ':' + t.detail)}
        <ToolChip {t} />
      {/each}
    </div>
  {/if}
</div>
