<script>
  import { highlight, langLabel } from '$lib/highlight.js';

  let { code = '', lang = '' } = $props();

  let copied = $state(false);
  let timer;

  const html = $derived(highlight(code, lang));
  const label = $derived(langLabel(lang));

  async function copy() {
    try {
      // navigator.clipboard est dispo sur localhost (contexte sécurisé) ; sinon fallback.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1500);
    } catch (_) { /* clipboard indisponible : on ignore */ }
  }
</script>

<div class="code-block">
  <div class="cb-head">
    <span class="cb-lang">{label}</span>
    <button class="cb-copy" class:done={copied} onclick={copy} title="Copier le code">
      {copied ? '✓ Copié' : '⧉ Copier'}
    </button>
  </div>
  <pre><code>{@html html}</code></pre>
</div>
