<script>
  // Fenêtre de lignes d'un fichier, rendue avec le vocabulaire visuel de DiffView (mêmes
  // gouttières, même police, même highlighter) sans réutiliser son code : DiffView est bâti
  // autour d'une paire old→new, le plier à un fichier unique le rendrait plus dur à lire.
  //
  // Volontairement muet : il affiche ce qu'on lui donne et signale les intentions. Le
  // chargement, la révision et la pile de navigation appartiennent à DefPeek.
  import { highlight } from '$lib/highlight.js';
  import { langFromName } from '$lib/difflines.js';
  import { symbolUnderPointer, paintSymbol, clearSymbols, highlightsSupported } from '$lib/codeHit.js';
  import { peek as mod, modHeld } from '$lib/peek.svelte.js';
  import Icon from '$lib/components/Icon.svelte';

  let {
    rel = '', lines = [], from = 1, total = 0,
    hitLine = null,            // ligne à surligner (la définition)
    canExpandUp = false, canExpandDown = false,
    onExpand = null,           // ('up' | 'down') => void
    onSymbol = null,           // ({ word, line }) => void — navigation récursive
  } = $props();

  const lang = $derived(langFromName(rel));
  // extension brute pour le filtrage des mots-clés de symbolAt (cf. DiffView : .svelte → 'html'
  // n'a aucun mot-clé, l'extension retombe sur SYMBOL_KW.svelte)
  const symLang = $derived(((rel || '').split('.').pop() || '').toLowerCase());
  let hlCache = new Map();
  $effect(() => { rel; hlCache = new Map(); });
  function hl(text) {
    if (text === '') return '&nbsp;';
    let v = hlCache.get(text);
    if (v === undefined) { v = highlight(text, lang); hlCache.set(text, v); }
    return v;
  }

  // Même geste que dans le diff, mêmes noms de highlights : le survol ⌘ souligne, le clic
  // navigue. Ici tout est « fichier entier », donc une déclaration trouvée dans CE fichier
  // n'a pas de raison d'être distinguée — un seul niveau de soulignement suffit.
  const SYM = 'hooked-symbol-maybe';
  let root;
  let symRaf = 0;
  let symHit = null;

  function clearSym() { symHit = null; clearSymbols([SYM]); }
  function track(e) {
    symRaf = 0;
    if (!onSymbol || !mod.mod) return clearSym();
    const hit = symbolUnderPointer(e, { lineSelector: '.fv-code', lang: symLang });
    if (!hit) return clearSym();
    const row = hit.lineEl.closest('[data-fv-line]');
    symHit = { word: hit.word, line: Number(row?.dataset.fvLine) || null };
    if (highlightsSupported()) paintSymbol(SYM, hit.range);
  }
  function onMove(e) {
    if (!onSymbol) return;
    if (!mod.mod) { if (symHit) clearSym(); return; }
    if (symRaf) return;
    symRaf = requestAnimationFrame(() => track(e));
  }
  $effect(() => { if (!mod.mod) clearSym(); });
  $effect(() => () => { if (symRaf) cancelAnimationFrame(symRaf); clearSymbols([SYM]); });
  function onClick(e) {
    if (!onSymbol || !modHeld(e)) return;
    if (!symHit) track(e);
    if (!symHit) return;
    e.preventDefault();
    e.stopPropagation();
    onSymbol({ ...symHit });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="fv" bind:this={root} class:fv-mod={mod.mod && !!onSymbol}
     onpointermove={onMove} onpointerdown={(e) => { if (onSymbol && modHeld(e) && symHit) e.preventDefault(); }}
     onclick={onClick} onpointerleave={clearSym}>
  {#if canExpandUp}
    <button class="fv-more" onclick={() => onExpand?.('up')}><Icon name="arrow-up" size={11} /> earlier lines</button>
  {/if}
  {#each lines as text, i (from + i)}
    {@const no = from + i}
    <div class="fv-row" class:fv-hit={no === hitLine} data-fv-line={no}>
      <span class="fv-no">{no}</span>
      <code class="fv-code">{@html hl(text)}</code>
    </div>
  {/each}
  {#if canExpandDown}
    <button class="fv-more" onclick={() => onExpand?.('down')}><Icon name="arrow-down" size={11} /> later lines</button>
  {/if}
  {#if total}<div class="fv-foot">{total} lines</div>{/if}
</div>

<style>
  .fv { font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--code-bg); color: #c9cedb; }
  .fv-row { display: grid; grid-template-columns: 52px 1fr; align-items: stretch; }
  .fv-no {
    text-align: right; padding: 0 8px; color: #5a6072; user-select: none;
    font-size: 10.5px; background: rgba(255,255,255,.02); white-space: nowrap;
  }
  /* même traitement que .dv-code : les longues lignes se replient, pas de scroll horizontal */
  .fv-code { padding: 0 10px 0 4px; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; min-width: 0; }
  .fv-hit { background: rgba(var(--accent-rgb), .16); box-shadow: inset 3px 0 0 var(--accent); }
  .fv-hit .fv-no { color: var(--accent-d); font-weight: 700; }
  .fv.fv-mod .fv-code { cursor: pointer; }
  .fv-more {
    display: flex; align-items: center; gap: 5px; width: 100%; padding: 3px 12px;
    background: rgba(var(--accent-rgb), .05); border: none; border-block: 1px solid var(--border);
    color: var(--accent); font-family: inherit; font-size: 10.5px; cursor: pointer;
  }
  .fv-more:hover { background: rgba(var(--accent-rgb), .14); }
  .fv-foot { padding: 2px 12px; font-size: 10px; color: #5a6072; text-align: right; }
</style>
