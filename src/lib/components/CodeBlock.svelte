<script>
  import { copyText } from '$lib/clipboard.js';
  import Icon from '$lib/components/Icon.svelte';
  import { highlight, langLabel } from '$lib/highlight.js';

  let { code = '', lang = '' } = $props();

  let copied = $state(false);
  let timer;

  const html = $derived(highlight(code, lang));
  const label = $derived(langLabel(lang));

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
    <button class="cb-copy" class:done={copied} onclick={copy} title="Copy code">
      {#if copied}<Icon name="check" size={13} /> Copied{:else}<Icon name="copy" size={13} /> Copy{/if}
    </button>
  </div>
  <pre><code>{@html html}</code></pre>
</div>
