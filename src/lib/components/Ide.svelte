<script>
  /*
   * Onglet « IDE » : un mini-éditeur Monaco pour voir/éditer les fichiers du projet.
   *
   * - Explorateur à deux sources (bascule) : « Changed » = fichiers touchés par Claude (prop
   *   `changes`, forme de changes.js), « All files » = arbre complet du projet (getProjectTree).
   * - Par fichier ouvert : vue « Diff » (baseline `old` à gauche, contenu courant à droite,
   *   éditable — responsive : inline pleine largeur quand étroit) ou « Edit » (éditeur simple).
   *   Un fichier ouvert depuis l'arbre récupère quand même sa baseline s'il est parmi les changes.
   * - Auto-save : chaque frappe est debouncée puis POSTée (saveProjectFile).
   * - Priorité Claude : si le fichier change sur disque et diffère de ce qu'on affiche, on ÉCRASE
   *   le buffer immédiatement (on annule tout save en attente). Claude gagne, toujours.
   */
  import { onDestroy } from 'svelte';
  import MonacoEditor from './MonacoEditor.svelte';
  import { getProjectFile, saveProjectFile, connectProjectFile, getProjectTree } from '$lib/api.js';

  let { id, changes = [], mode = 'split', onmode = null, onclose = null } = $props();

  let source = $state('changed');   // 'changed' | 'tree'
  let active = $state(null);        // { path, name, baseline: string|null }
  let content = $state('');         // contenu courant (éditable)
  let view = $state('diff');        // 'diff' | 'edit'
  let status = $state('idle');      // loading | idle | dirty | saving | saved | error | binary | toolarge
  let errorMsg = $state('');
  let externalFlash = $state(false);
  let pathInput = $state('');

  // Arbre projet (chargé paresseusement au 1er passage sur « All files »).
  let treeFiles = $state([]);       // liste plate de chemins relatifs
  let treeLoading = $state(false);
  let treeLoaded = $state(false);
  let expanded = $state({});        // dossier(path) -> ouvert ?

  let lastMtime = 0;
  let saveTimer = null;
  let flashTimer = null;
  let es = null;

  // Liste « Changed » : les changements (les binaires restent listés mais inertes).
  const changedFiles = $derived(
    (changes || []).map((c) => ({
      path: c.file,
      name: c.name,
      badge: c.badge || (c.count ? c.count + (c.count > 1 ? ' edits' : ' edit') : ''),
      baseline: c.binary ? null : (c.ops && c.ops[0] ? c.ops[0].old ?? '' : ''),
      binary: !!c.binary,
    })),
  );

  // Baseline (diff) d'un chemin s'il fait partie des changements de Claude (match abs ↔ rel).
  function baselineFor(p) {
    const c = (changes || []).find((x) => x.file === p || x.file.endsWith('/' + p));
    return c && !c.binary ? (c.ops && c.ops[0] ? c.ops[0].old ?? '' : '') : null;
  }
  function isActive(p) {
    if (!active) return false;
    return active.path === p || active.path.endsWith('/' + p) || p.endsWith('/' + active.path);
  }

  // ----- arbre : liste plate -> nœuds triés (dossiers puis fichiers), avec chemins de dossier -----
  function buildTree(files) {
    const root = {};
    for (const f of files) {
      const parts = f.split('/');
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        if (i === parts.length - 1) (node.__files ||= []).push({ name: parts[i], path: f });
        else node = (node[parts[i]] ||= {});
      }
    }
    return root;
  }
  function toNodes(obj, prefix) {
    const dirs = [], files = [];
    for (const k in obj) {
      if (k === '__files') continue;
      const p = prefix ? prefix + '/' + k : k;
      dirs.push({ type: 'dir', name: k, path: p, children: toNodes(obj[k], p) });
    }
    for (const f of obj.__files || []) files.push({ type: 'file', name: f.name, path: f.path });
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }
  const treeNodes = $derived(toNodes(buildTree(treeFiles), ''));
  function toggleDir(p) { expanded = { ...expanded, [p]: !expanded[p] }; }

  async function loadTree() {
    if (treeLoaded || treeLoading) return;
    treeLoading = true;
    try {
      const r = await getProjectTree(id);
      treeFiles = r.files || [];
      treeLoaded = true;
    } catch (_) { /* laisse retentable */ }
    treeLoading = false;
  }
  function selectSource(s) { source = s; if (s === 'tree') loadTree(); }

  function closeStream() { if (es) { try { es.close(); } catch (_) {} es = null; } }
  function clearSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } }

  // Ouverture UNIFIÉE (liste Changed, arbre, ou saisie). Baseline auto si le fichier est changé.
  async function openPath(p, name) {
    if (!p) return;
    clearSave();
    closeStream();
    const baseline = baselineFor(p);
    active = { path: p, name: name || p.split('/').pop(), baseline };
    view = baseline != null ? 'diff' : 'edit';
    await load();
  }
  function openInput() {
    const p = pathInput.trim();
    if (!p) return;
    pathInput = '';
    openPath(p);
  }

  async function load() {
    const cur = active;
    status = 'loading';
    content = '';
    const r = await getProjectFile(id, cur.path);
    if (!active || active.path !== cur.path) return; // l'utilisateur a changé de fichier entre-temps
    if (!r.ok) {
      status = r.binary ? 'binary' : r.tooLarge ? 'toolarge' : 'error';
      errorMsg = r.error || 'failed to open';
      return;
    }
    content = r.content;
    lastMtime = r.mtimeMs;
    status = 'idle';
    es = connectProjectFile({ id, path: cur.path, onChange: onExternal, onUnavailable: () => {} });
  }

  // Écriture disque détectée (dont celles de Claude).
  function onExternal(snap) {
    if (!active) return;
    if (snap.content === content) { lastMtime = snap.mtimeMs; return; } // notre propre save / identique
    // Contenu disque différent → priorité Claude : on écrase, on annule le save en attente.
    clearSave();
    content = snap.content;
    lastMtime = snap.mtimeMs;
    if (status === 'dirty' || status === 'saving') status = 'idle';
    externalFlash = true;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (externalFlash = false), 900);
  }

  function onEdit(v) {
    content = v;
    status = 'dirty';
    clearSave();
    saveTimer = setTimeout(doSave, 500);
  }

  async function doSave() {
    const cur = active;
    if (!cur) return;
    status = 'saving';
    const res = await saveProjectFile(id, cur.path, content);
    if (!active || active.path !== cur.path) return;
    if (res.ok) {
      lastMtime = res.data.mtimeMs;
      if (status === 'saving') {
        status = 'saved';
        setTimeout(() => { if (status === 'saved') status = 'idle'; }, 1400);
      }
    } else {
      status = 'error';
      errorMsg = res.data.error || 'save failed';
    }
  }

  const STATUS = {
    loading: { t: 'Loading…', c: 'muted' },
    idle: { t: 'Saved', c: 'muted' },
    dirty: { t: '● Unsaved', c: 'warn' },
    saving: { t: 'Saving…', c: 'warn' },
    saved: { t: '✓ Saved', c: 'ok' },
    error: { t: '✗ Error', c: 'err' },
    binary: { t: 'Binary file', c: 'muted' },
    toolarge: { t: 'File too large', c: 'muted' },
  };
  const st = $derived(STATUS[status] || STATUS.idle);
  const editable = $derived(status !== 'binary' && status !== 'toolarge' && status !== 'loading');

  onDestroy(() => { closeStream(); clearSave(); if (flashTimer) clearTimeout(flashTimer); });
</script>

<!-- Ligne d'arbre récursive (dossier repliable / fichier ouvrable). -->
{#snippet treeItem(node, depth)}
  {#if node.type === 'dir'}
    <button class="tree-row dir" style="padding-left:{depth * 11 + 6}px" onclick={() => toggleDir(node.path)}>
      <span class="tw-arrow">{expanded[node.path] ? '▾' : '▸'}</span><span class="tw-name">{node.name}</span>
    </button>
    {#if expanded[node.path]}
      {#each node.children as c (c.path)}{@render treeItem(c, depth + 1)}{/each}
    {/if}
  {:else}
    <button class="tree-row file" class:active={isActive(node.path)} style="padding-left:{depth * 11 + 16}px"
            onclick={() => openPath(node.path, node.name)} title={node.path}>
      <span class="tw-name">{node.name}</span>
    </button>
  {/if}
{/snippet}

<div class="ide" class:flash={externalFlash}>
  <div class="ide-bar">
    <span class="ide-title">🧩 IDE</span>
    {#if active}
      <span class="ide-path" title={active.path}>{active.name}</span>
      <div class="ide-views">
        <button class="ide-view" class:active={view === 'diff'} disabled={active.baseline == null}
                onclick={() => (view = 'diff')} title={active.baseline == null ? 'No baseline diff for this file' : 'Diff view'}>Diff</button>
        <button class="ide-view" class:active={view === 'edit'} onclick={() => (view = 'edit')} title="Edit view">Edit</button>
      </div>
      <span class="ide-status {st.c}" title={errorMsg}>{externalFlash ? '↺ Updated by Claude' : st.t}</span>
    {/if}
    <div class="ide-spacer"></div>
    <button class="ide-mode" class:on={mode === 'split'} onclick={() => onmode && onmode('split')} title="Side by side with the chat">▐▌ Split</button>
    <button class="ide-mode" class:on={mode === 'full'} onclick={() => onmode && onmode('full')} title="Fullscreen editor">⛶ Full</button>
    <button class="ide-close" onclick={() => onclose && onclose()} title="Close the IDE">✕</button>
  </div>

  <div class="ide-body">
    <aside class="ide-explorer">
      <div class="exp-tabs">
        <button class="exp-tab" class:active={source === 'changed'} onclick={() => selectSource('changed')}>Changed</button>
        <button class="exp-tab" class:active={source === 'tree'} onclick={() => selectSource('tree')}>All files</button>
      </div>
      <div class="exp-open">
        <input class="exp-input" placeholder="Open path…" bind:value={pathInput}
               onkeydown={(e) => { if (e.key === 'Enter') openInput(); }} />
      </div>

      {#if source === 'changed'}
        {#if !changedFiles.length}
          <div class="exp-empty">No changed files.</div>
        {:else}
          {#each changedFiles as f (f.path)}
            <button class="exp-file" class:active={isActive(f.path)} class:binary={f.binary}
                    disabled={f.binary} onclick={() => openPath(f.path, f.name)} title={f.path}>
              <span class="exp-name">{f.name}</span>
              <span class="exp-badge">{f.binary ? 'binary' : f.badge}</span>
            </button>
          {/each}
        {/if}
      {:else}
        {#if treeLoading && !treeLoaded}
          <div class="exp-empty">Loading files…</div>
        {:else if !treeNodes.length}
          <div class="exp-empty">No files.</div>
        {:else}
          <div class="tree">
            {#each treeNodes as n (n.path)}{@render treeItem(n, 0)}{/each}
          </div>
        {/if}
      {/if}
    </aside>

    <div class="ide-editor">
      {#if !active}
        <div class="ide-empty">Pick a file on the left to view its diff and edit it.<br />Edits auto-save. If Claude writes the file, your view is overwritten instantly.</div>
      {:else if status === 'loading'}
        <div class="ide-empty">Loading {active.name}…</div>
      {:else if status === 'binary'}
        <div class="ide-empty">Binary file — no editor.</div>
      {:else if status === 'toolarge'}
        <div class="ide-empty">File is too large to edit here.</div>
      {:else if status === 'error'}
        <div class="ide-empty">Could not open this file: {errorMsg}</div>
      {:else}
        {#key active.path + '|' + view}
          <MonacoEditor
            value={content}
            original={view === 'diff' ? (active.baseline ?? '') : null}
            name={active.name}
            readOnly={!editable}
            onChange={onEdit} />
        {/key}
      {/if}
    </div>
  </div>
</div>

<style>
  /* flex:1 + width:100% : .ide-col est display:flex (row) → sans ça, .ide se réduit à la largeur
     de son contenu (~446px) et laisse la moitié droite VIDE (bug « 1/3 occupé »). */
  .ide { display: flex; flex-direction: column; flex: 1 1 auto; width: 100%; min-width: 0; height: 100%; min-height: 0; background: var(--panel); }
  .ide.flash .ide-body { box-shadow: inset 0 0 0 2px var(--accent); transition: box-shadow .2s; }

  .ide-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-bottom: 1px solid var(--border); background: var(--bg2);
  }
  .ide-title { font-weight: 800; font-size: 13px; }
  .ide-path { font-family: var(--mono); font-size: 12px; color: var(--text); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ide-views { display: inline-flex; gap: 3px; }
  .ide-view {
    background: transparent; border: 1px solid var(--border2); border-radius: 7px; color: var(--muted);
    font-size: 11px; font-weight: 700; padding: 3px 9px; cursor: pointer;
  }
  .ide-view.active { color: var(--accent-d); border-color: var(--accent); background: var(--accent-soft); }
  .ide-view:disabled { opacity: .4; cursor: default; }
  .ide-status { font-size: 11px; font-weight: 700; font-family: var(--mono); white-space: nowrap; }
  .ide-status.muted { color: var(--muted); }
  .ide-status.warn { color: var(--working, #b8860b); }
  .ide-status.ok { color: var(--accent-d); }
  .ide-status.err { color: #d05; }
  .ide-spacer { flex: 1 1 auto; }
  .ide-mode, .ide-close {
    background: transparent; border: 1px solid var(--border2); border-radius: 7px; color: var(--muted);
    font-size: 11px; font-weight: 700; padding: 3px 9px; cursor: pointer;
  }
  .ide-mode.on { color: var(--accent-d); border-color: var(--accent); background: var(--accent-soft); }
  .ide-mode:hover, .ide-close:hover { color: var(--text); border-color: var(--muted); }

  .ide-body { flex: 1 1 auto; min-height: 0; display: flex; }
  .ide-explorer {
    flex: 0 0 178px; min-width: 0; overflow-y: auto; border-right: 1px solid var(--border);
    background: var(--bg2); padding: 8px;
  }
  .exp-tabs { display: flex; gap: 3px; margin-bottom: 8px; }
  .exp-tab {
    flex: 1 1 0; background: transparent; border: 1px solid var(--border2); border-radius: 7px;
    color: var(--muted); font-size: 11px; font-weight: 700; padding: 4px 6px; cursor: pointer;
  }
  .exp-tab.active { color: var(--accent-d); border-color: var(--accent); background: var(--accent-soft); }
  .exp-open { margin-bottom: 8px; }
  .exp-input {
    width: 100%; box-sizing: border-box; background: var(--bg3); border: 1px solid var(--border2);
    border-radius: 7px; color: var(--text); font-family: var(--mono); font-size: 11px; padding: 5px 8px;
  }
  .exp-input:focus { outline: none; border-color: var(--accent); }
  .exp-empty { color: var(--muted); font-size: 12px; padding: 6px 2px; }

  .exp-file {
    display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
    background: transparent; border: none; border-radius: 7px; color: var(--text);
    font-size: 12px; padding: 5px 7px; cursor: pointer;
  }
  .exp-file:hover:not(:disabled) { background: var(--bg3); }
  .exp-file.active { background: var(--accent-soft); color: var(--accent-d); }
  .exp-file.binary { opacity: .5; cursor: default; }
  .exp-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exp-badge { flex: 0 0 auto; font-size: 9.5px; color: var(--muted); font-family: var(--mono); }

  /* --- arbre projet --- */
  .tree { font-size: 12px; }
  .tree-row {
    display: flex; align-items: center; gap: 3px; width: 100%; text-align: left;
    background: transparent; border: none; border-radius: 6px; color: var(--text);
    font-size: 12px; padding: 3px 6px; cursor: pointer; white-space: nowrap; overflow: hidden;
  }
  .tree-row:hover { background: var(--bg3); }
  .tree-row.file.active { background: var(--accent-soft); color: var(--accent-d); }
  .tree-row.dir { color: var(--muted); font-weight: 600; }
  .tw-arrow { flex: 0 0 auto; width: 10px; font-size: 9px; }
  .tw-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

  .ide-editor { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; }
  .ide-empty { padding: 24px; color: var(--muted); font-size: 13px; line-height: 1.6; }
</style>
