<script>
  import { onMount } from 'svelte';
  import { data, sessionTitle } from '$lib/state.svelte.js';
  import { STATE_LABEL } from '$lib/format.js';
  import SessionDetail from '$lib/components/SessionDetail.svelte';

  const KEY = 'hooked.split.v2';

  // Grille à deux niveaux : colonnes (largeur %) → volets empilés dans la colonne (hauteur %).
  // Deux niveaux suffisent pour 50/50, 33×3, 2×2, 1+2… sans arbre récursif à maintenir.
  const mk = (counts) =>
    counts.map((n) => ({
      w: 100 / counts.length,
      panes: Array.from({ length: n }, () => ({ id: null, h: 100 / n })),
    }));

  const PRESETS = [
    { label: '▯▯', title: 'Two columns (50/50)', counts: [1, 1] },
    { label: '⊟', title: 'Two rows (stacked)', counts: [2] },
    { label: '▯▯▯', title: 'Three columns (33/33/33)', counts: [1, 1, 1] },
    { label: '⊞', title: 'Grid 2×2', counts: [2, 2] },
    { label: '▯⊟', title: 'One left, two stacked right', counts: [1, 2] },
  ];

  let cols = $state(mk([1, 1]));
  let boxEl;                 // conteneur des colonnes
  let colEls = $state([]);   // conteneurs de volets, un par colonne

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (Array.isArray(saved) && saved.length) cols = saved;
    } catch (_) {}
  });
  $effect(() => { try { localStorage.setItem(KEY, JSON.stringify(cols)); } catch (_) {} });

  // ── layout ────────────────────────────────────────────────────────────────────────────────
  const rescale = (items, key) => {
    const sum = items.reduce((t, x) => t + x[key], 0) || 1;
    items.forEach((x) => (x[key] = (x[key] / sum) * 100));
  };

  function applyPreset(counts) {
    const keep = cols.flatMap((c) => c.panes.map((p) => p.id)).filter(Boolean);
    const next = mk(counts);
    next.flatMap((c) => c.panes).forEach((p, i) => (p.id = keep[i] ?? null));
    cols = next;
  }

  function splitRight(ci) {
    const c = cols[ci];
    c.w /= 2;
    cols.splice(ci + 1, 0, { w: c.w, panes: [{ id: null, h: 100 }] });
  }

  function splitDown(ci, pi) {
    const col = cols[ci];
    const p = col.panes[pi];
    p.h /= 2;
    col.panes.splice(pi + 1, 0, { id: null, h: p.h });
  }

  function closePane(ci, pi) {
    const col = cols[ci];
    col.panes.splice(pi, 1);
    if (col.panes.length) rescale(col.panes, 'h');
    else cols.splice(ci, 1);
    if (!cols.length) cols = mk([1, 1]);
    else rescale(cols, 'w');
  }

  // Drag d'une poignée : le delta se répartit entre les deux voisins (leur somme reste constante).
  function startDrag(e, items, i, axis, el) {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = (axis === 'x' ? rect.width : rect.height) || 1;
    const start = axis === 'x' ? e.clientX : e.clientY;
    const key = axis === 'x' ? 'w' : 'h';
    const a = items[i][key], b = items[i + 1][key];
    const move = (ev) => {
      const raw = ((axis === 'x' ? ev.clientX : ev.clientY) - start) / total * 100;
      const d = Math.max(-a + 10, Math.min(b - 10, raw));
      items[i][key] = a + d;
      items[i + 1][key] = b - d;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ── choix de session ──────────────────────────────────────────────────────────────────────
  let picking = $state(null);   // "ci:pi" du volet en train de choisir sa session
  let query = $state('');
  const openIds = $derived(new Set(cols.flatMap((c) => c.panes.map((p) => p.id)).filter(Boolean)));

  // Sessions vivantes (tmux up) uniquement : un volet split sert à répondre, pas à relire un mort.
  const live = $derived(
    data.sessions
      .filter((s) => s.tmuxAlive)
      .filter((s) => {
        const q = query.trim().toLowerCase();
        return !q || `${s.projectName} ${sessionTitle(s)}`.toLowerCase().includes(q);
      })
      .sort((x, y) => sessionTitle(x).localeCompare(sessionTitle(y))),
  );
  const byId = $derived(new Map(data.sessions.map((s) => [s.id, s])));

  function choose(ci, pi, id) {
    cols[ci].panes[pi].id = id;
    picking = null;
    query = '';
  }
</script>

<div class="split-view">
  <header class="split-bar">
    <span class="sb-label">Split</span>
    <div class="sb-group">
      {#each PRESETS as p}
        <button class="glyph" title={p.title} onclick={() => applyPreset(p.counts)}>{p.label}</button>
      {/each}
    </div>
    <span class="sb-hint">⇥ / ⤓ on a pane to split it · drag the dividers to resize</span>
  </header>

  <div class="split-box" bind:this={boxEl}>
    {#each cols as col, ci}
      {#if ci > 0}
        <div class="handle v" role="separator" tabindex="-1"
             onpointerdown={(e) => startDrag(e, cols, ci - 1, 'x', boxEl)}></div>
      {/if}
      <div class="split-col" style="flex-basis:{col.w}%" bind:this={colEls[ci]}>
        {#each col.panes as p, pi}
          {#if pi > 0}
            <div class="handle h" role="separator" tabindex="-1"
                 onpointerdown={(e) => startDrag(e, col.panes, pi - 1, 'y', colEls[ci])}></div>
          {/if}
          <section class="split-pane" style="flex-basis:{p.h}%">
            <div class="pane-bar">
              <button class="pane-name" onclick={() => { picking = `${ci}:${pi}`; query = ''; }}
                      title="Change session">
                {#if p.id && byId.get(p.id)}
                  <span class="pn-proj">{byId.get(p.id).projectName || '?'}</span>
                  <span class="pn-title">{sessionTitle(byId.get(p.id))}</span>
                {:else}
                  <span class="pn-empty">choose a session…</span>
                {/if}
              </button>
              <button class="pane-act" title="Split right" onclick={() => splitRight(ci)}>⇥</button>
              <button class="pane-act" title="Split down" onclick={() => splitDown(ci, pi)}>⤓</button>
              <button class="pane-act" title="Close pane" onclick={() => closePane(ci, pi)}>✕</button>
            </div>

            {#if picking === `${ci}:${pi}` || !p.id}
              <div class="picker">
                <input class="pk-search" placeholder="Filter live sessions…" bind:value={query} />
                <div class="pk-list">
                  {#each live as s}
                    <button class="pk-row" class:used={openIds.has(s.id)} onclick={() => choose(ci, pi, s.id)}>
                      <span class="pk-dot s-{s.state}"></span>
                      <span class="pk-proj">{s.projectName || '?'}</span>
                      <span class="pk-title">{sessionTitle(s)}</span>
                      <span class="pk-state">{openIds.has(s.id) ? 'open' : (STATE_LABEL[s.state] || s.state)}</span>
                    </button>
                  {:else}
                    <p class="pk-none">No live session.</p>
                  {/each}
                </div>
              </div>
            {:else}
              {#key p.id}
                <SessionDetail id={p.id} />
              {/key}
            {/if}
          </section>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  /* `main` est un bloc, pas un conteneur flex : sans height:100% la vue se dimensionne sur son
     contenu, .pane-body n'est jamais contraint et son overflow-y ne scrolle pas. */
  .split-view { height: 100%; display: flex; flex-direction: column; }

  .split-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
    padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--bg2);
  }
  .sb-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .sb-group { display: flex; gap: 4px; }
  .sb-hint { margin-left: auto; font-size: 11px; color: var(--muted); }
  .glyph {
    min-width: 34px; padding: 3px 8px; font-size: 14px; line-height: 1.2; color: var(--muted);
    background: var(--bg3); border: 1px solid var(--border2); border-radius: 8px; cursor: pointer;
  }
  .glyph:hover { color: var(--accent); border-color: var(--accent); }

  .split-box { flex: 1 1 auto; min-height: 0; display: flex; }
  .split-col { flex: 0 0 auto; min-width: 0; display: flex; flex-direction: column; }
  .split-pane {
    flex: 0 0 auto; min-width: 0; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column; background: var(--bg);
  }

  .handle { flex: 0 0 6px; background: var(--border); transition: background .12s; }
  .handle.v { cursor: col-resize; }
  .handle.h { cursor: row-resize; }
  .handle:hover { background: var(--accent); }

  /* bandeau de volet : identité de la session + actions de découpe, 26px, toujours visible */
  .pane-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 2px;
    height: 26px; padding: 0 4px 0 6px; background: var(--bg2);
    border-bottom: 1px solid var(--border);
  }
  .pane-name {
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px;
    background: transparent; border: none; cursor: pointer; padding: 0; text-align: left;
    font-size: 11.5px; color: var(--text);
  }
  .pane-name:hover .pn-title, .pane-name:hover .pn-empty { color: var(--accent); }
  .pn-proj { flex: 0 0 auto; font-weight: 700; color: var(--muted); font-family: var(--mono); font-size: 10.5px; }
  .pn-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pn-empty { color: var(--muted); font-style: italic; }
  .pane-act {
    flex: 0 0 auto; width: 22px; height: 20px; font-size: 11px; color: var(--muted);
    background: transparent; border: none; border-radius: 5px; cursor: pointer;
  }
  .pane-act:hover { background: var(--hover); color: var(--text); }

  /* picker : recherche + liste des sessions vivantes, occupe le volet vide */
  .picker { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 8px; gap: 6px; }
  .pk-search {
    flex: 0 0 auto; padding: 5px 8px; font-size: 12px; color: var(--text);
    background: var(--bg2); border: 1px solid var(--border2); border-radius: 7px;
  }
  .pk-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .pk-row {
    display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 8px;
    font-size: 12px; color: var(--text); text-align: left;
    background: transparent; border: 1px solid transparent; border-radius: 7px; cursor: pointer;
  }
  .pk-row:hover { background: var(--hover); border-color: var(--border2); }
  .pk-row.used { opacity: .5; }
  .pk-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--idle); }
  .pk-dot.s-working { background: var(--accent); }
  .pk-dot.s-waiting, .pk-dot.s-attention { background: var(--warn); }
  .pk-proj { flex: 0 0 auto; font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--muted); }
  .pk-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pk-state { flex: 0 0 auto; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .pk-none { color: var(--muted); font-size: 12px; padding: 12px 8px; }
</style>
