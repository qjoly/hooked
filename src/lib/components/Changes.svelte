<script>
  import Diff from './Diff.svelte';
  // `onReview(prompt)` : envoie le prompt de revue généré (branché sur le Composer par le parent).
  // `canReview` : faux si aucun pane tmux → on ne peut rien envoyer, on désactive le bouton.
  let { changes, onReview = null, canReview = true } = $props();
  let openSet = $state({}); // index -> bool

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

{#if !changes.length}
  <div class="pane-empty">No file changes in this session.</div>
{:else}
  {#each changes as c, i}
    <div class="change" class:open={openSet[i]}>
      <div class="change-head" title={c.file} onclick={() => (openSet = { ...openSet, [i]: !openSet[i] })}>
        <span class="ch-arrow">▸</span>
        <span class="ch-name">{c.name}</span>
        <span class="ch-path">{c.file}</span>
        <a class="ch-open" href={'vscode://file' + c.file} title="Open in VS Code"
           onclick={(e) => e.stopPropagation()}>↗ editor</a>
        <span class="ch-count">{c.count} {c.count > 1 ? 'edits' : 'edit'}</span>
      </div>
      <div class="change-ops">
        <div class="op-hint">Hover a line and click <span class="op-hint-plus">＋</span> to comment, like a GitHub PR.</div>
        {#each c.ops as o, j}
          <div class="op-wrap">
            <Diff {o} name={c.name}
                  commentable={true}
                  comments={lineCommentsFor(c.file, j)}
                  onCommit={(p) => addLineComment(c.file, j, c.name, p)}
                  onDelete={removeLineComment} />
          </div>
        {/each}
      </div>
    </div>
  {/each}

  {#if activeCount}
    <div class="review-bar">
      <textarea class="review-note" rows="1" bind:value={note}
                placeholder="Optional general note (e.g. run the tests after fixing)…"></textarea>
      <span class="review-count">{activeCount} {activeCount > 1 ? 'comments' : 'comment'}</span>
      <button class="review-clear" onclick={clearReview} disabled={sending}>Clear</button>
      <button class="review-send" onclick={sendReview} disabled={sending || !canReview}
              title={canReview ? 'Generate a prompt from your comments and send it to the session' : 'No live tmux session to send to'}>
        {sending ? 'Sending…' : 'Send review ↩'}
      </button>
    </div>
  {/if}
{/if}

<style>
  .op-wrap { position: relative; }

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
