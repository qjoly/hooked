<script>
  // Picks what the Review lens diffs. Session scope: the prompts whose changes are under review.
  // Branch scope: the repository (when several are detected), the branch under review, the base
  // it is compared against, and the commits the review covers. It edits the lens's state LIVE
  // through `r.picker` — getters onto the lens's state plus its own actions — so the diff, and
  // with it the commit list, follows every pick, exactly as the former inline bars did. Done just closes.
  import { closeModal } from '$lib/state.svelte.js';
  import Icon from '$lib/components/Icon.svelte';

  let { r } = $props(); // { picker }
  const p = $derived(r.picker);

  let q = $state('');
  const matches = (name) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());
  const branches = $derived(p.branches.filter((b) => matches(b.name)));
  const shortRev = (rev) => String(rev || '').slice(0, 8);
  const repoLabel = (x) => x.label || x.root.split('/').pop();
  const day = (ts) => String(ts || '').slice(0, 10);
  const commitHint = (c, i) =>
    p.isPicked(c.rev) ? 'Click to take it out of the review'
    : p.inSelection(i) ? 'Pulled in: the reviewed slice runs from the oldest to the newest picked commit'
    : 'Click to add it to the review';
</script>

<div class="rs">
  <div class="rs-head">
    <div class="rs-title"><Icon name="git-branch" size={16} /> Review scope</div>
    <div class="rs-sub">{p.scope === 'session' ? "Which prompts' changes are under review." : 'What the Branch scope diffs.'} Every pick applies at once; the diff behind follows.</div>
  </div>

  {#if p.scope === 'session'}
    <section class="rs-sec">
      <h3>Prompts <span class="rs-note">{p.filtering ? `${p.selected.size} of ${p.turns.length} in the review` : `all ${p.turns.length} in the review`}</span></h3>
      <p class="rs-hint">Click a prompt to restrict the review to the changes it caused, again to take it out — none picked means the whole conversation.</p>
      <div class="rs-chips"><button class="rs-chip" class:on={!p.filtering} onclick={p.clearTurns}>Whole conversation</button></div>
      <ul class="rs-commits">
        {#each p.turns as t (t.turn)}
          <li>
            <button class="rs-commit" class:on={p.selected.has(t.turn)} onclick={() => p.toggleTurn(t.turn)} title={t.prompt}>
              <span class="rs-sha">P{t.turn + 1}</span>
              <span class="rs-subj">{t.prompt || '(prompt)'}</span>
              <span class="rs-meta">{t.files} file{t.files === 1 ? '' : 's'}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
  {#if p.repos.length > 1}
    <section class="rs-sec">
      <h3>Repository</h3>
      <div class="rs-chips">
        {#each p.repos as x (x.root)}
          <button class="rs-chip" class:on={p.repo === x.root} onclick={() => p.selectRepo(x.root)} title={x.root}>
            <Icon name={x.kind === 'jj' ? 'jujutsu' : 'git'} size={11} /> {repoLabel(x)}{#if x.primary}<span class="rs-cur">primary</span>{/if}
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <section class="rs-sec">
    <h3>Branch <span class="rs-note">under review</span></h3>
    {#if p.branches.length > 8}
      <input class="rs-q" type="search" placeholder="Filter branches…" bind:value={q} />
    {/if}
    {#if p.loading && !p.branches.length}
      <p class="rs-hint">Loading branches…</p>
    {:else if !branches.length}
      <p class="rs-hint">No branch{q ? ' matching “' + q + '”' : ''}.</p>
    {:else}
      <div class="rs-chips">
        {#each branches as b (b.name)}
          <button class="rs-chip mono" class:on={p.branch === b.name} onclick={() => p.pick(b.name)} title={b.name}>
            {b.name}{#if b.current}<span class="rs-cur">current</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <section class="rs-sec">
    <h3>Base <span class="rs-note">compared against, from the merge-base</span></h3>
    {#if branches.length}
      <div class="rs-chips">
        {#each branches as b (b.name)}
          <button class="rs-chip mono" class:on={p.base === b.name} onclick={() => p.pickBase(b.name)} title={b.name}>{b.name}</button>
        {/each}
      </div>
    {/if}
  </section>

  <section class="rs-sec">
    <h3>Commits <span class="rs-note">{p.span ? `${p.span.hi - p.span.lo + 1} of ${p.commits.length} in the review` : p.commits.length ? `all ${p.commits.length} in the review` : ''}</span></h3>
    {#if p.loading && !p.commits.length}
      <p class="rs-hint">Loading the branch…</p>
    {:else if !p.commits.length}
      <p class="rs-hint">This branch has no commits of its own against that base.</p>
    {:else}
      <p class="rs-hint">Click a commit to add it to the review, again to take it out — none picked means the whole branch. The reviewed slice is contiguous: the commits between two picks are pulled in.</p>
      <div class="rs-chips"><button class="rs-chip" class:on={!p.span} onclick={p.pickAllCommits}>All {p.commits.length}</button></div>
      <ul class="rs-commits">
        {#each p.commits as c, i (c.rev)}
          <li>
            <button class="rs-commit" class:on={p.isPicked(c.rev)} class:in={!p.isPicked(c.rev) && p.inSelection(i)}
                    onclick={() => p.toggleCommit(c.rev)} title={commitHint(c, i)}>
              <span class="rs-sha">{shortRev(c.rev)}</span>
              <span class="rs-subj">{c.subject || '(no message)'}</span>
              {#if c.author || c.ts}<span class="rs-meta">{c.author || ''}{#if c.author && c.ts} · {/if}{day(c.ts)}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {/if}

  <div class="rs-foot">
    <button class="rs-done" onclick={closeModal}>Done</button>
  </div>
</div>

<style>
  .rs-head { margin-bottom: 14px; padding-right: 24px; }
  .rs-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; }
  .rs-sub { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .rs-sec { padding: 10px 0; border-top: 1px solid var(--border); }
  .rs-sec h3 { margin: 0 0 8px; font: 700 10px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .rs-note { font-weight: 600; letter-spacing: 0; text-transform: none; opacity: .8; margin-left: 6px; }
  .rs-hint { margin: 0 0 8px; font-size: 12px; color: var(--muted); line-height: 1.5; }
  .rs-q {
    width: 100%; box-sizing: border-box; background: var(--input); border: 1px solid var(--border); border-radius: 9px;
    padding: 7px 11px; font: inherit; font-size: 12.5px; color: var(--text); margin-bottom: 8px;
  }
  .rs-q:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .rs-chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 160px; overflow-y: auto; }
  .rs-chip {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
    background: var(--chip); border: 1px solid var(--border); border-radius: 999px;
    color: var(--muted); font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 11px; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rs-chip:hover { color: var(--text); }
  .rs-chip.on { background: var(--accent-soft); border-color: rgba(var(--accent-rgb), .4); color: var(--accent-d); }
  .rs-chip.mono { font-family: var(--mono); }
  .rs-cur { font-size: 9px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; opacity: .7; }
  .rs-commits { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
  .rs-commit {
    display: grid; grid-template-columns: 72px 1fr auto; align-items: center; gap: 10px; width: 100%; text-align: left;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 9px; color: var(--text);
    padding: 6px 10px; cursor: pointer; font: inherit; font-size: 12.5px; min-width: 0;
  }
  .rs-commit:hover { border-color: var(--accent); }
  .rs-commit.on { background: var(--accent-soft); border-color: rgba(var(--accent-rgb), .4); }
  .rs-commit.in { border-style: dashed; border-color: rgba(var(--accent-rgb), .45); }
  .rs-sha { font-family: var(--mono); font-size: 10.5px; font-weight: 800; color: var(--accent-d); }
  .rs-subj { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-meta { font-family: var(--mono); font-size: 10px; color: var(--muted); white-space: nowrap; }
  .rs-foot { display: flex; justify-content: flex-end; margin-top: 14px; }
  .rs-done {
    background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); border-radius: 9px;
    padding: 8px 16px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  }
  .rs-done:hover { background: var(--accent-d); }
</style>
