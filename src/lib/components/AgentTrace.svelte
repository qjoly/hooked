<script>
  // "View internal trace" drill-in shared by the Agents and Workflows cards: loads the agent's own
  // transcript once (GET /api/agent) and renders it as chat bubbles, toggled in place.
  import { getAgent } from '$lib/api.js';
  import ChatBubble from './ChatBubble.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let { session, agentId } = $props();
  let messages = $state(null);
  let visible = $state(false);
  let loading = $state(false);
  let failed = $state(false);

  async function toggle() {
    if (messages) { visible = !visible; return; }
    loading = true; failed = false;
    try {
      messages = (await getAgent(session, agentId)).messages || [];
      visible = true;
    } catch (_) { failed = true; }
    loading = false;
  }
</script>

<div class="at">
  <button class="at-drill" disabled={loading} onclick={toggle}>
    {#if !loading}<Icon name={visible ? 'chevron-down' : 'chevron-right'} size={13} />{/if}
    {loading ? 'loading…' : visible ? 'Hide trace' : 'View internal trace'}
  </button>
  {#if failed}
    <div class="pane-empty">Trace unavailable.</div>
  {:else if visible && messages}
    <div class="chat at-chat">
      {#if messages.length}
        {#each messages as m, i (m.ts + ':' + i)}<ChatBubble {m} {session} agent={agentId} />{/each}
      {:else}
        <div class="pane-empty">No internal steps.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .at-drill {
    display: inline-flex; align-items: center; gap: 5px; background: none; border: 1px solid var(--border2);
    border-radius: 7px; padding: 3px 9px; font: 600 11.5px var(--mono); color: var(--accent-d); cursor: pointer;
  }
  .at-drill:hover:not(:disabled) { border-color: var(--accent); }
  .at-drill:disabled { opacity: .6; cursor: default; }
  .at-chat { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); max-height: 46vh; overflow: auto; }
</style>
