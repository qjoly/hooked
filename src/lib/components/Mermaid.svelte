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
  import { copyText } from '$lib/clipboard.js';
  import { themeType } from '$lib/theme.svelte.js';
  import Icon from '$lib/components/Icon.svelte';

  let { code = '' } = $props();

  let svg = $state('');       // SVG rendu (déjà assaini par Mermaid, securityLevel 'strict')
  let error = $state('');     // message d'erreur si la syntaxe est invalide
  let started = $state(false);// un premier rendu a-t-il été tenté (sinon on affiche « Rendering… »)
  let showSource = $state(false);
  let copied = $state(false);
  let copyTimer;

  let mermaid = null;
  let renderSeq = 0; // garde anti-course : seul le dernier rendu lancé peut écrire l'état
  let renderedKey = null; // source+thème du dernier rendu réussi → skip des rendus redondants

  async function ensureMermaid() {
    if (!mermaid) {
      const mod = await import('mermaid');
      mermaid = mod.default ?? mod;
    }
    return mermaid;
  }

  // Conteneur de mesure HORS-FLUX (`position:absolute`, hors écran) passé en 3e argument à
  // `mermaid.render`. Sans lui, Mermaid attache son <div> temporaire de mesure à <body> DANS le
  // flux normal → dans notre shell flex (`main{flex:1}`), ce nœud (~150px) vole de la hauteur à
  // `main` le temps d'une frame → toute la vue session se contracte puis se rétablit (le « flicker »
  // à chaque tick SSE). Absolu + hors écran = aucune incidence sur la mise en page.
  function offscreenHost() {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1200px;height:auto;overflow:hidden;pointer-events:none';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
  }

  async function render(src, tt) {
    const seq = ++renderSeq;
    const trimmed = String(src || '').trim();
    if (!trimmed) { svg = ''; error = ''; started = true; renderedKey = `|${tt}`; return; }
    // Rendu idempotent : une source + un thème identiques redonnent le même SVG. Comme chaque tick
    // SSE réassigne `s` (donc re-propage `code`), re-rendre à l'identique ne sert à rien et fait
    // clignoter le diagramme → on court-circuite si rien n'a changé depuis le dernier rendu réussi.
    const key = `${trimmed}|${tt}`;
    if (key === renderedKey) { started = true; return; }
    let host;
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
      host = offscreenHost();
      const { svg: out } = await m.render(`mmd-${mermaidSeq++}`, trimmed, host);
      if (seq !== renderSeq) return;
      svg = out;
      error = '';
      renderedKey = key;
    } catch (e) {
      if (seq !== renderSeq) return;
      svg = '';
      error = e?.message || 'Mermaid render error';
      renderedKey = null; // échec → autoriser une nouvelle tentative au prochain changement
    } finally {
      host?.remove();
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
    if (!(await copyText(code))) return;
    copied = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = false), 1500);
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
        {#if copied}<Icon name="check" size={13} /> Copied{:else}<Icon name="copy" size={13} /> Copy{/if}
      </button>
    </div>
  </div>

  {#if svg && !showSource && !error}
    <div class="mmd-canvas">{@html svg}</div>
  {:else if !showSource && !error && !started}
    <div class="mmd-loading">Rendering diagram…</div>
  {:else}
    <!-- source brute : demandée (toggle) ou repli quand la syntaxe est invalide -->
    {#if error}<div class="mmd-error"><Icon name="warning" size={13} /> {error}</div>{/if}
    <pre class="mmd-src"><code>{code}</code></pre>
  {/if}
</div>
