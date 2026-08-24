<script>
  import Diff from './Diff.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { getVcsDiff } from '$lib/api.js';
  // `onReview(prompt)` : envoie le prompt de revue généré (branché sur le Composer par le parent).
  // `canReview` : faux si aucun pane tmux → on ne peut rien envoyer, on désactive le bouton.
  // `id` : session id, requis pour charger le diff VCS (git/jj) du working tree à la demande.
  let { changes, id = null, onReview = null, canReview = true } = $props();
  let openSet = $state({}); // clé `${view}:${index}` -> bool

  // ----- sous-onglets : diff « Claude » (reconstruit du transcript) vs diff VCS (git/jj) -----
  let view = $state('claude'); // 'claude' | 'vcs'
  // État du diff VCS, chargé paresseusement au 1er passage sur l'onglet (puis rafraîchissable).
  // `repos` : un item par dépôt détecté (principal en premier + sous-dépôts imbriqués).
  let vcs = $state({ loaded: false, loading: false, error: null, kind: null, repos: [], truncated: false });
  const VCS_META = {
    git: { icon: 'git', label: 'Git' },
    jj:  { icon: 'jujutsu', label: 'Jujutsu' },
  };
  const vcsMeta = $derived(VCS_META[vcs.kind] || { icon: 'git', label: 'VCS' });
  const repoName = (p) => (p || '').split('/').filter(Boolean).pop() || p;

  async function loadVcs(force = false) {
    if (!id || vcs.loading || (vcs.loaded && !force)) return;
    vcs = { ...vcs, loading: true, error: null };
    try {
      const r = await getVcsDiff(id);
      vcs = { loaded: true, loading: false, error: null, kind: r.vcs, repos: r.repos || [], truncated: !!r.truncated };
    } catch (e) {
      vcs = { ...vcs, loading: false, loaded: true, error: 'Failed to load diff.' };
    }
  }
  function selectVcs() { view = 'vcs'; loadVcs(false); }

  // ----- revue de fichiers (commentaires inline façon PR GitHub, envoyés en batch) -----
  // Chaque commentaire porte sur une ligne / un groupe de lignes d'un diff, posé via le gutter
  // « ＋ » de la lib (@pierre/diffs). On stocke la liste à plat ; l'attache au diff se fait par
  // (file, opIndex). `note` = consigne générale optionnelle jointe en tête du prompt.
  let lineComments = $state([]); // [{ id, file, opIndex, name, side, start, end, text, snippet }]
  let note = $state('');
  const activeCount = $derived(lineComments.length);

  function addLineComment(file, opIndex, name, payload) {
    lineComments = [...lineComments, { id: crypto.randomUUID(), file, opIndex, name, ...payload }];
  }
  function removeLineComment(id) {
    lineComments = lineComments.filter((c) => c.id !== id);
  }
  // Ce que <Diff> attend en entrée : les commentaires validés de CE diff, forme légère.
  function lineCommentsFor(file, opIndex) {
    return lineComments
      .filter((c) => c.file === file && c.opIndex === opIndex)
      .map((c) => ({ id: c.id, side: c.side, start: c.start, end: c.end, text: c.text }));
  }
  function clearReview() { lineComments = []; note = ''; }

  const kindLabel = (o) => (o.kind === 'write' ? 'new file' : o.kind === 'notebook' ? 'notebook cell' : 'edit');
  const rangeLabel = (side, start, end) => {
    const w = side === 'deletions' ? 'old' : 'new';
    return start === end ? `${w} L${start}` : `${w} L${start}–${end}`;
  };

  // Construit le prompt de revue : consigne générale (optionnelle) + un item numéroté par
  // commentaire inline, dans l'ordre fichier → diff → ligne, avec chemin, plage, type d'op,
  // commentaire et l'extrait de code concerné (préfixé « | » pour éviter les collisions ```).
  function buildPrompt() {
    const items = [];
    for (const c of changes) {
      c.ops.forEach((o, j) => {
        const forOp = lineComments
          .filter((lc) => lc.file === c.file && lc.opIndex === j)
          .sort((a, b) => a.start - b.start);
        for (const lc of forOp) {
          const snip = (lc.snippet || '').split('\n').map((l) => '   | ' + l).join('\n');
          const body = (lc.text || '').replace(/\n/g, '\n   > ');
          items.push(`${items.length + 1}) ${c.file} (${rangeLabel(lc.side, lc.start, lc.end)}) — ${kindLabel(o)}\n   > ${body}\n   Relevant code:\n${snip}`);
        }
      });
    }
    if (!items.length) return '';
    const head = 'I reviewed your changes and left the following inline comments. Please address each one:';
    const general = note.trim() ? `\n\nGeneral note: ${note.trim()}` : '';
    return head + general + '\n\n' + items.join('\n\n');
  }

  let sending = $state(false);
  async function sendReview() {
    if (!onReview || !activeCount || sending) return;
    const prompt = buildPrompt();
    if (!prompt) return;
    sending = true;
    try {
      await onReview(prompt);
      clearReview();
    } finally {
      sending = false;
    }
  }
</script>

<!-- Une carte fichier, partagée par les deux vues. `commentable` : gutter de revue inline (Claude).
     `prefix` : espace de clés d'ouverture — indispensable côté VCS où chaque dépôt a sa section. -->
{#snippet cards(list, commentable, prefix)}
  {#each list as c, i}
    {@const key = prefix + ':' + i}
    <div class="change" class:open={openSet[key]}>
      <div class="change-head" title={c.file} onclick={() => (openSet = { ...openSet, [key]: !openSet[key] })}>
        <span class="ch-arrow"><Icon name="chevron-right" size={12} /></span>
        <span class="ch-name">{c.name}</span>
        <span class="ch-path">{c.file}</span>
        <a class="ch-open" href={'vscode://file' + c.file} title="Open in VS Code"
           onclick={(e) => e.stopPropagation()}><Icon name="external" size={12} /> editor</a>
        <span class="ch-count">{c.badge ?? (c.count + ' ' + (c.count > 1 ? 'edits' : 'edit'))}</span>
      </div>
      <div class="change-ops">
        {#if c.binary}
          <div class="op-hint">Binary file — no diff.</div>
        {:else}
          {#if commentable}
            <div class="op-hint">Hover a line and click <span class="op-hint-plus"><Icon name="plus" size={12} /></span> to comment, like a GitHub PR.</div>
          {/if}
          {#each c.ops as o, j}
            <div class="op-wrap">
              {#if commentable}
                <Diff {o} name={c.name}
                      commentable={true}
                      comments={lineCommentsFor(c.file, j)}
                      onCommit={(p) => addLineComment(c.file, j, c.name, p)}
                      onDelete={removeLineComment} />
              {:else}
                <Diff {o} name={c.name} />
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/each}
{/snippet}

<div class="subview-bar">
  <button class="subview" class:active={view === 'claude'} onclick={() => (view = 'claude')}><Icon name="diff" size={13} /> Claude</button>
  <button class="subview" class:active={view === 'vcs'} onclick={selectVcs}><Icon name={vcsMeta.icon} size={13} /> {vcsMeta.label}</button>
  {#if view === 'vcs' && vcs.loaded && !vcs.loading}
    <button class="subview-refresh" title="Reload the working-tree diff" onclick={() => loadVcs(true)}><Icon name="rotate-cw" size={13} /></button>
  {/if}
</div>

{#if view === 'claude'}
  {#if !changes.length}
    <div class="pane-empty">No file changes in this session.</div>
  {:else}
    {@render cards(changes, true, 'claude')}
    {#if activeCount}
      <div class="review-bar">
        <textarea class="review-note" rows="1" bind:value={note}
                  placeholder="Optional general note (e.g. run the tests after fixing)…"></textarea>
        <span class="review-count">{activeCount} {activeCount > 1 ? 'comments' : 'comment'}</span>
        <button class="review-clear" onclick={clearReview} disabled={sending}>Clear</button>
        <button class="review-send" onclick={sendReview} disabled={sending || !canReview}
                title={canReview ? 'Generate a prompt from your comments and send it to the session' : 'No live tmux session to send to'}>
          {#if sending}Sending…{:else}Send review <Icon name="send" size={13} />{/if}
        </button>
      </div>
    {/if}
  {/if}
{:else}
  {#if vcs.loading}
    <div class="pane-empty">Loading working-tree diff…</div>
  {:else if vcs.error}
    <div class="pane-empty">{vcs.error}</div>
  {:else if !vcs.repos.length}
    <div class="pane-empty">This project is not in a git or jj repository.</div>
  {:else if vcs.repos.length === 1}
    {#if !vcs.repos[0].changes.length}
      <div class="pane-empty">No uncommitted changes in the working tree.</div>
    {:else}
      {@render cards(vcs.repos[0].changes, false, 'vcs:0')}
    {/if}
  {:else if vcs.repos.every((r) => !r.changes.length)}
    <div class="pane-empty">No uncommitted changes in any repository.</div>
  {:else}
    {#each vcs.repos as repo, ri}
      <div class="repo-head" title={repo.root}>
        <span class="repo-icon"><Icon name={(VCS_META[repo.kind] || vcsMeta).icon} size={13} /></span>
        <span class="repo-label">{repo.label || repoName(repo.root)}</span>
        <span class="repo-count" class:clean={!repo.changes.length}>
          {repo.changes.length ? repo.changes.length + (repo.changes.length > 1 ? ' files' : ' file') : 'clean'}
        </span>
      </div>
      {@render cards(repo.changes, false, 'vcs:' + ri)}
    {/each}
  {/if}
  {#if vcs.truncated}
    <div class="vcs-trunc">File limit reached — some repositories are truncated.</div>
  {/if}
{/if}

<style>
  /* --- barre des sous-onglets (Claude / VCS) --- */
  .subview-bar {
    display: flex; align-items: center; gap: 6px; padding: 8px 14px 4px 14px;
    position: sticky; top: 0; z-index: 4; background: var(--bg);
  }
  .subview {
    background: transparent; border: 1px solid var(--border2); border-radius: 8px;
    color: var(--muted); font-family: var(--mono); font-size: 12px; font-weight: 700;
    padding: 5px 12px; cursor: pointer; transition: color .12s, border-color .12s, background .12s;
  }
  .subview:hover { color: var(--text); border-color: var(--muted); }
  .subview.active { color: var(--accent-d); border-color: var(--accent); background: var(--accent-soft); }
  .subview-refresh {
    margin-left: auto; background: transparent; border: 1px solid var(--border2); border-radius: 8px;
    color: var(--muted); font-size: 13px; padding: 4px 9px; cursor: pointer;
  }
  .subview-refresh:hover { color: var(--text); border-color: var(--muted); }

  .op-wrap { position: relative; }

  /* --- en-tête de section par dépôt (vue VCS multi-dépôts) --- */
  .repo-head {
    display: flex; align-items: center; gap: 8px; padding: 12px 14px 4px 14px;
    font-family: var(--mono); font-size: 12px; color: var(--muted);
  }
  .repo-label { font-weight: 700; color: var(--text); }
  .repo-count {
    color: var(--accent-d); background: var(--accent-soft);
    border-radius: 20px; padding: 1px 9px; font-size: 11px; font-weight: 700;
  }
  .repo-count.clean { color: var(--muted); background: var(--bg3); }
  .vcs-trunc {
    padding: 8px 14px; color: var(--muted); font-size: 11px; font-style: italic;
    font-family: var(--mono);
  }

  /* --- hint de découvrabilité du commentaire inline --- */
  .op-hint {
    padding: 6px 14px 2px 14px; color: var(--muted); font-size: 11px; font-style: italic;
    font-family: var(--mono);
  }
  .op-hint-plus { font-style: normal; font-weight: 700; color: var(--accent-d); }

  /* --- barre de revue collée en bas du scroll --- */
  .review-bar {
    position: sticky; bottom: 0; z-index: 5; margin-top: 2px;
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--surface); border: 1px solid var(--accent);
    border-radius: 14px; box-shadow: 0 -4px 16px rgba(0,0,0,.14);
  }
  .review-note {
    flex: 1 1 auto; min-width: 0; resize: vertical; min-height: 34px;
    background: var(--bg3); border: 1px solid var(--border2); border-radius: 8px;
    color: var(--text); font-family: var(--mono); font-size: 12px; line-height: 1.5; padding: 7px 10px;
  }
  .review-note:focus { outline: none; border-color: var(--accent); }
  .review-count {
    flex: 0 0 auto; color: var(--accent-d); background: var(--accent-soft);
    border-radius: 20px; padding: 3px 11px; font-size: 12px; font-weight: 700; white-space: nowrap;
  }
  .review-clear {
    flex: 0 0 auto; background: transparent; border: 1px solid var(--border2); border-radius: 8px;
    color: var(--muted); font-size: 12px; font-weight: 700; padding: 6px 12px; cursor: pointer;
  }
  .review-clear:hover:not(:disabled) { color: var(--text); border-color: var(--muted); }
  .review-send {
    flex: 0 0 auto; background: var(--accent); border: 1px solid var(--accent); border-radius: 8px;
    color: #fff; font-size: 12px; font-weight: 700; padding: 6px 14px; cursor: pointer;
    transition: background .12s;
  }
  .review-send:hover:not(:disabled) { background: var(--accent-d); }
  .review-send:disabled, .review-clear:disabled { opacity: .5; cursor: default; }
</style>
