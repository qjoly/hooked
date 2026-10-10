<script>
  import { copyText } from '$lib/clipboard.js';
  import Icon from '$lib/components/Icon.svelte';
  import { highlight, langLabel } from '$lib/highlight.js';
  import { reply } from '$lib/api.js';
  import { getContext } from 'svelte';

  let { code = '', lang = '' } = $props();

  let copied = $state(false);
  let timer;

  const html = $derived(highlight(code, lang));
  const label = $derived(langLabel(lang));

  // A shell block in a session's conversation runs as a composer `!command`: in the session's
  // folder, its output lands in the thread (and in Claude's context) like any typed one.
  const sessionOf = getContext('hooked.session');
  const session = $derived(sessionOf?.() || null);
  const runnable = $derived(!!session && /^(sh|bash|shell|zsh)$/i.test(lang) && !!code.trim());
  let run = $state(''); // '' | 'busy' | 'done' | error message

  async function runIt() {
    run = 'busy';
    const r = await reply(session, '!' + code.trim());
    run = r.ok ? 'done' : (r.data?.error || `HTTP ${r.status}`);
  }

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
          title={run && run !== 'busy' && run !== 'done' ? run : 'Run in the session folder — output goes to the conversation'}>
          <Icon name={run === 'done' ? 'check' : 'shell'} size={13} /> {run === 'busy' ? 'Running…' : run === 'done' ? 'Ran' : run ? 'Failed' : 'Run'}
        </button>
      {/if}
      <button class="cb-copy" class:done={copied} onclick={copy} title="Copy code">
        {#if copied}<Icon name="check" size={13} /> Copied{:else}<Icon name="copy" size={13} /> Copy{/if}
      </button>
    </div>
  </div>
  <pre><code>{@html html}</code></pre>
</div>
