<script module>
  // Compteur GLOBAL partagé par toutes les instances → id UNIQUE par rendu. Un id réutilisé
  // entre deux diagrammes casse le rendu du 2e (collision d'ids d'éléments SVG : marqueurs de
  // flèches, <defs>, et l'élément temporaire `d<id>` que Mermaid attache/retire du <body>) →
  // diagramme vide. C'était le bug « mermaid buggé dans un long markdown » (plusieurs diagrammes).
  let mermaidSeq = 0;
</script>

<script>
  // Rendu d'un diagramme Mermaid (bloc de code ```mermaid). Mermait est une grosse lib front :
  // on l'importe DYNAMIQUEMENT (comme xterm / @pierre/diffs) → chunk séparé, chargé à la 1re
  // utilisation, hors du bundle principal. Rendu client uniquement : l'import et `mermaid.render`
  // touchent le DOM, or les $effect ne tournent pas en SSR → aucun garde `browser` nécessaire.
  import { themeType } from '$lib/theme.svelte.js';

  let { code = '' } = $props();

  let svg = $state('');       // SVG rendu (déjà assaini par Mermaid, securityLevel 'strict')
  let error = $state('');     // message d'erreur si la syntaxe est invalide
  let started = $state(false);// un premier rendu a-t-il été tenté (sinon on affiche « Rendering… »)
  let showSource = $state(false);
  let copied = $state(false);
  let copyTimer;

  let mermaid = null;
  let renderSeq = 0; // garde anti-course : seul le dernier rendu lancé peut écrire l'état

  async function ensureMermaid() {
    if (!mermaid) {
      const mod = await import('mermaid');
      mermaid = mod.default ?? mod;
    }
    return mermaid;
  }

  async function render(src, tt) {
    const seq = ++renderSeq;
    const trimmed = String(src || '').trim();
    if (!trimmed) { svg = ''; error = ''; started = true; return; }
    try {
      const m = await ensureMermaid();
      if (seq !== renderSeq) return;
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict', // assainit le SVG (DOMPurify) → {@html} sûr
        theme: tt === 'dark' ? 'dark' : 'default',
        fontFamily: 'var(--mono)',
      });
      // Valider d'abord : parse(..., suppressErrors) renvoie false au lieu de throw ET d'injecter
      // un <div> d'erreur dans <body> (effet de bord de render sur syntaxe invalide).
      const ok = await m.parse(trimmed, { suppressErrors: true });
      if (seq !== renderSeq) return;
      if (!ok) throw new Error('Invalid Mermaid syntax');
      const { svg: out } = await m.render(`mmd-${mermaidSeq++}`, trimmed);
      if (seq !== renderSeq) return;
      svg = out;
      error = '';
    } catch (e) {
      if (seq !== renderSeq) return;
      svg = '';
      error = e?.message || 'Mermaid render error';
    } finally {
      if (seq === renderSeq) started = true;
    }
  }

  // Re-rendre quand le code OU le thème change. Lire les deps AVANT tout garde (piège Svelte 5).
  $effect(() => {
    const src = code;
    const tt = themeType();
    render(src, tt);
  });

  async function copy() {
    try {
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
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch (_) { /* clipboard indisponible : on ignore */ }
  }
</script>

<div class="mermaid-block">
  <div class="cb-head">
    <span class="cb-lang">Mermaid{error ? ' — error' : ''}</span>
    <div class="mmd-actions">
      <button class="cb-copy" onclick={() => (showSource = !showSource)} title="Toggle source">
        {showSource ? '▤ Diagram' : '‹›  Source'}
      </button>
      <button class="cb-copy" class:done={copied} onclick={copy} title="Copy source">
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
    </div>
  </div>

  {#if svg && !showSource && !error}
    <div class="mmd-canvas">{@html svg}</div>
  {:else if !showSource && !error && !started}
    <div class="mmd-loading">Rendering diagram…</div>
  {:else}
    <!-- source brute : demandée (toggle) ou repli quand la syntaxe est invalide -->
    {#if error}<div class="mmd-error">⚠ {error}</div>{/if}
    <pre class="mmd-src"><code>{code}</code></pre>
  {/if}
</div>
