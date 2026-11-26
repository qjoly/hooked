<script>
  import { copyText } from '#lib/clipboard.js';
  import Icon from '#lib/components/Icon.svelte';
  import { highlight, langLabel } from '#lib/highlight.js';
  import { runCommand } from '#lib/api.js';
  import { fenceQuery, agentName, liveLogText } from '#lib/format.js';
  import { floating } from '#lib/floating.svelte.js';
  import { getContext, tick } from 'svelte';

  let { code = '', lang = '', meta = {} } = $props();

  let copied = $state(false);
  let timer;

  const html = $derived(highlight(code, lang));
  const label = $derived(langLabel(lang));

  // A shell block in a session's conversation runs as a composer `!command`, except that Claude
  // proposed it, so its output starts a turn instead of waiting silently in the context.
  // The hooked MCP server's instructions ask Claude to fence the commands it proposes as `bash`.
  const sessionOf = getContext('hooked.session');
  const session = $derived(sessionOf?.() || null);
  const provOf = getContext('hooked.provider');
  const provider = $derived(provOf?.() || 'claude');
  const runnable = $derived(!!session && /^(sh|bash|shell|zsh)$/i.test(lang) && !!code.trim());
  let run = $state(''); // '' | 'busy' | 'done' | error message

  // Output of the last Run, streamed while the command runs and kept once it ends. null hides the
  // pane: nothing ran yet, the request failed before running anything, or the session's own agent
  // ran the command (pi does `!command` itself, its output lands in the thread).
  const LOG_MAX_CHARS = 64000;
  let log = $state(null);
  let logEl = $state();
  let stick = true;   // follow the output until the user scrolls up to read

  async function runIt() {
    run = 'busy';
    log = '';
    stick = true;
    const r = await runCommand(session, code.trim(), (text) => {
      log = (log + text).slice(-LOG_MAX_CHARS);
      followLog();
    }).catch((e) => ({ ok: false, data: { error: e.message } }));
    run = r.ok ? 'done' : (r.data?.error || `HTTP ${r.status}`);
    if (!r.data?.localCommand && !log) log = null;
  }

  async function followLog() {
    await tick();
    if (stick && logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  function onLogScroll() {
    stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
  }

  const isQuery = $derived(/^(promql|logql)$/i.test(lang));
  const query = $derived(fenceQuery(lang, meta, code));
  async function copy() {
    if (!(await copyText(code))) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="code-block">
  <div class="cb-head">
    <span class="cb-lang">{label}</span>
    <div class="mmd-actions">
      {#if runnable}
        <button class="cb-copy" class:done={run === 'done'} class:err={run && run !== 'busy' && run !== 'done'} onclick={runIt} disabled={run === 'busy'}
          title={run && run !== 'busy' && run !== 'done' ? run : `Run in the session folder — ${agentName(provider)} gets the output and continues`}>
          <Icon name={run === 'done' ? 'check' : 'shell'} size={13} /> {run === 'busy' ? 'Running…' : run === 'done' ? 'Ran' : run ? 'Failed' : 'Run'}
        </button>
      {/if}
      {#if isQuery}
        <button class="cb-copy" onclick={() => (floating.query = { spec: query })} disabled={!query}
          title={query ? 'Open a live chart of this query' : 'Add datasource=… after the language to view it'}>
          <Icon name="stats" size={13} /> View
        </button>
      {/if}
      <button class="cb-copy" class:done={copied} onclick={copy} title="Copy code">
        {#if copied}<Icon name="check" size={13} /> Copied{:else}<Icon name="copy" size={13} /> Copy{/if}
      </button>
    </div>
  </div>
  <pre><code>{@html html}</code></pre>
  {#if log !== null}
    {@const text = liveLogText(log)}
    <pre class="cb-log" class:empty={!text} bind:this={logEl} onscroll={onLogScroll}>{text || (run === 'busy' ? 'waiting for output…' : 'no output')}</pre>
  {/if}
</div>
