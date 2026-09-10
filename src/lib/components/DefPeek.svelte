<script>
  // « Peek definition » : la définition s'ouvre EN LIGNE, juste sous la ligne cliquée, comme
  // dans un IDE. On ne quitte pas la review, on ne perd pas sa place, Échap referme.
  //
  // La carte est autonome : elle charge sa fenêtre de lignes, tient sa PILE de navigation
  // (définition → définition) et résout elle-même un ⌘-clic en son sein — le fichier de
  // contexte devient alors celui qu'elle affiche, ce qui est bien ce qu'il faut pour le
  // classement par imports.
  import { getSource, getSymbolDefs } from '$lib/api.js';
  import { editorFor } from '$lib/editors.js';
  import { settings } from '$lib/state.svelte.js';
  import FileView from '$lib/components/FileView.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let {
    id,                      // session
    target,                  // { file, rel, line, rev, symbol, kind } — l'entrée de la pile
    onClose = null,
  } = $props();

  const PAD = 12;            // lignes de contexte autour de la définition à l'ouverture
  const STEP = 20;           // lignes révélées par clic sur « earlier / later »
  const MAX_DEPTH = 8;

  let stack = $state([]);    // [{ file, rel, line, rev, symbol, kind }]
  let win = $state(null);    // { from, to } demandé
  let data = $state(null);   // réponse de /api/session/source
  let loading = $state(false);
  let error = $state(null);

  const top = $derived(stack[stack.length - 1] || null);

  // `target` change → on repart d'une pile neuve. Le composant est monté/démonté par le diff,
  // mais un second ⌘-clic sur une autre ligne réutilise l'instance.
  $effect(() => {
    const t = target;
    if (!t) return;
    stack = [t];
    win = { from: Math.max(1, t.line - PAD), to: t.line + PAD };
  });

  $effect(() => {
    const t = top, w = win;
    if (!t || !w) return;
    let cancelled = false;
    loading = true;
    error = null;
    getSource(id, t.file, t.rev || '', w.from, w.to)
      .then((r) => {
        if (cancelled) return;
        if (!r || !r.supported) { error = 'This file is not readable from here.'; data = null; }
        else data = r;
      })
      .catch(() => { if (!cancelled) error = 'Could not load the file.'; })
      .finally(() => { if (!cancelled) loading = false; });
    return () => { cancelled = true; };
  });

  function expand(dir) {
    if (!win || !data) return;
    win = dir === 'up'
      ? { from: Math.max(1, win.from - STEP), to: win.to }
      : { from: win.from, to: Math.min(data.total, win.to + STEP) };
  }

  // ⌘-clic DANS la carte : on résout depuis le fichier affiché, et on empile.
  async function dive({ word }) {
    const t = top;
    if (!t || stack.length >= MAX_DEPTH) return;
    loading = true;
    let r;
    try { r = await getSymbolDefs(id, word, t.file, t.rev || ''); } catch (_) { r = null; }
    loading = false;
    if (!r || !r.supported) return (error = 'No repository to search.');
    if (r.origin) return (error = word + ' comes from ' + r.origin.specifier + ' — not in this repo.');
    const next = r.jump || (r.declarations.length === 1 ? r.declarations[0] : null);
    if (!next) return (error = r.referenceCount ? 'No declaration for ' + word + ' (' + r.referenceCount + ' references).' : 'No declaration for ' + word + '.');
    error = null;
    stack = [...stack, { file: next.file, rel: next.rel, line: next.line, rev: t.rev, symbol: word, kind: next.kind }];
    win = { from: Math.max(1, next.line - PAD), to: next.line + PAD };
  }

  function back() {
    if (stack.length <= 1) return onClose?.();
    const prev = stack[stack.length - 2];
    stack = stack.slice(0, -1);
    win = { from: Math.max(1, prev.line - PAD), to: prev.line + PAD };
  }

  const editorHref = $derived(top ? editorFor(settings.editor).fileUrl(top.file, top.line) : null);

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="dp" role="region" aria-label="Definition" tabindex="-1" onkeydown={onKey}>
  <div class="dp-head">
    <button class="dp-btn" title={stack.length > 1 ? 'Back' : 'Close'} onclick={back}>
      <Icon name={stack.length > 1 ? 'arrow-up' : 'close'} size={12} />
    </button>
    <span class="dp-where">
      {#each stack as s, i (i)}{#if i}<span class="dp-sep">›</span>{/if}<span class="dp-crumb" class:on={i === stack.length - 1}>{s.symbol}</span>{/each}
    </span>
    {#if top}
      <span class="dp-path" title={top.file}>{top.rel}:{top.line}</span>
      {#if top.kind}<span class="dp-kind">{top.kind}</span>{/if}
    {/if}
    {#if loading}<span class="dp-load">…</span>{/if}
    {#if editorHref}
      <a class="dp-btn" href={editorHref} title={'Open at this line in ' + editorFor(settings.editor).label}><Icon name="external" size={12} /></a>
    {/if}
    <button class="dp-btn" title="Close (Esc)" onclick={() => onClose?.()}><Icon name="close" size={12} /></button>
  </div>
  {#if error}
    <div class="dp-msg">{error}</div>
  {:else if data}
    <div class="dp-body">
      <FileView rel={data.rel} lines={data.lines} from={data.from} total={data.total}
                hitLine={top?.line}
                canExpandUp={data.from > 1} canExpandDown={data.to < data.total}
                onExpand={expand} onSymbol={dive} />
    </div>
  {:else if !loading}
    <div class="dp-msg">Nothing to show.</div>
  {/if}
</div>

<style>
  /* La carte vit dans le flux du diff, sous la ligne cliquée — même famille visuelle que les
     fils de commentaires (.dv-thread), pour qu'un bloc inséré sous une ligne se lise toujours
     de la même façon. */
  .dp {
    margin: 4px 0; border: 1px solid var(--border2); border-left: 3px solid var(--accent);
    border-radius: 10px; overflow: hidden; background: var(--surface);
  }
  .dp-head {
    display: flex; align-items: center; gap: 8px; padding: 5px 8px;
    background: var(--surface); border-bottom: 1px solid var(--border2);
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
  }
  .dp-where { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .dp-crumb { color: var(--muted); }
  .dp-crumb.on { color: var(--accent-d); font-weight: 700; }
  .dp-sep { opacity: .5; }
  .dp-path { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dp-kind {
    flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 700;
    text-transform: uppercase; background: rgba(var(--accent-rgb), .14); color: var(--accent-d);
  }
  .dp-load { flex: 0 0 auto; opacity: .7; }
  .dp-btn {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    background: none; border: none; padding: 2px; border-radius: 5px; cursor: pointer; color: var(--muted);
  }
  .dp-btn:hover { color: var(--text); background: rgba(255,255,255,.06); }
  /* Plafonné : une définition de 400 lignes ne doit pas repousser le diff hors de l'écran. */
  .dp-body { max-height: min(46vh, 420px); overflow-y: auto; }
  .dp-msg { padding: 8px 12px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
</style>
