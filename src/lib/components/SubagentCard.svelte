<script>
  import { ago, fmtTokens, fmtCost } from '$lib/format.js';
  import AgentTrace from './AgentTrace.svelte';
  import Markdown from './Markdown.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let { a, session } = $props();
  let open = $state(false);

  const shortM = $derived((a.model || '').replace('claude-', '').replace(/-\d{8}$/, ''));

</script>

<div class="change" class:open>
  <div class="change-head" title={a.description} onclick={() => (open = !open)}>
    <span class="ch-arrow">▸</span>
    <span class="ch-name">{a.type || 'agent'}</span>
    <span class="ch-path">{a.description}</span>
    {#if a.cost != null}
      <span class="ch-count">{shortM} · {fmtTokens(a.totalTokens)} tok · {a.toolUses} tools · {fmtCost(a.cost)}</span>
    {:else}
      <span class="ch-count">{ago(a.ts)}</span>
    {/if}
  </div>
  <div class="change-ops">
    {#if a.prompt}
      <div class="sa-block"><div class="sa-label"><Icon name="file-in" size={13} /> Instructions</div><div class="md"><Markdown text={a.prompt} /></div></div>
    {/if}
    <div class="sa-block">
      <div class="sa-label"><Icon name="file-out" size={13} /> Result</div>
      {#if a.result}<div class="md"><Markdown text={a.result} /></div>
      {:else}<div class="pane-empty">No result (subagent interrupted or produced no output).</div>{/if}
    </div>
    {#if a.agentId}
      <div class="sa-block"><AgentTrace {session} agentId={a.agentId} /></div>
    {/if}
  </div>
</div>
