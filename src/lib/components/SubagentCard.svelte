<script>
  import { ago, fmtTokens, fmtCost } from '$lib/format.js';
  import { getAgent } from '$lib/api.js';
  import ChatBubble from './ChatBubble.svelte';
  import Markdown from './Markdown.svelte';

  let { a, session } = $props();
  let open = $state(false);
  let trace = $state(null);     // messages chargés du déroulé interne
  let visible = $state(false);  // déroulé affiché ?
  let loading = $state(false);
  let failed = $state(false);

  const shortM = $derived((a.model || '').replace('claude-', '').replace(/-\d{8}$/, ''));

  async function drill() {
    if (trace) { visible = !visible; return; }
    loading = true; failed = false;
    try {
      const d = await getAgent(session, a.agentId);
      trace = d.messages || [];
      visible = true;
    } catch (_) { failed = true; }
    loading = false;
  }
  const drillLabel = $derived(loading ? 'loading…' : (trace && visible) ? '🔽 Hide trace' : '🔍 View internal trace');
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
      <div class="sa-block"><div class="sa-label">📥 Instructions</div><div class="md"><Markdown text={a.prompt} /></div></div>
    {/if}
    <div class="sa-block">
      <div class="sa-label">📤 Result</div>
      {#if a.result}<div class="md"><Markdown text={a.result} /></div>
      {:else}<div class="pane-empty">No result (subagent interrupted or produced no output).</div>{/if}
    </div>
    {#if a.agentId}
      <div class="sa-block">
        <button class="sa-drill" disabled={loading} onclick={drill}>{drillLabel}</button>
        <div class="sa-trace" class:hidden={!visible}>
          {#if failed}
            <div class="pane-empty">Trace unavailable.</div>
          {:else if trace}
            <div class="chat sa-chat">
              {#if trace.length}
                {#each trace as m, i (m.ts + ':' + i)}<ChatBubble {m} {session} agent={a.agentId} />{/each}
              {:else}
                <div class="pane-empty">No internal steps.</div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
