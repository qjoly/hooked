<script>
  import { onMount } from 'svelte';
  import { ago } from '$lib/format.js';
  import Icon from './Icon.svelte';

  let res = $state(null); // { notifications, issues, mine, review, fetchedAt } | { error }
  let loading = $state(false);
  let query = $state('');
  let repo = $state(''); // '' = all repositories

  async function load(refresh = false) {
    loading = true;
    try {
      const r = await fetch('/api/github' + (refresh ? '?refresh=1' : ''));
      res = await r.json();
    } catch (e) {
      res = { error: e.message };
    } finally {
      loading = false;
    }
  }
  onMount(() => load());

  const DECISION = {
    APPROVED: { label: 'Approved', cls: 'ok' },
    CHANGES_REQUESTED: { label: 'Changes requested', cls: 'ko' },
    REVIEW_REQUIRED: { label: 'Review required', cls: 'wait' },
  };
  const CHECKS = {
    SUCCESS: { icon: 'circle-check', cls: 'ok', title: 'Checks passed' },
    FAILURE: { icon: 'close', cls: 'ko', title: 'Checks failed' },
    ERROR: { icon: 'warning', cls: 'ko', title: 'Checks errored' },
    PENDING: { icon: 'busy', cls: 'wait', title: 'Checks running' },
    EXPECTED: { icon: 'clock', cls: 'wait', title: 'Checks expected' },
  };
  const REVIEW = { APPROVED: 'ok', CHANGES_REQUESTED: 'ko', COMMENTED: 'neutral', DISMISSED: 'muted', PENDING: 'muted' };
  const REVIEW_LABEL = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending' };

  // Reviews others left on my PRs, flattened so they read as their own feed.
  const reviews = $derived(
    (res?.mine || [])
      .flatMap((pr) => pr.reviews.filter((rv) => rv.author !== pr.author)
        .map((rv) => ({ ...rv, repo: pr.repo, title: pr.title, number: pr.number, updatedAt: rv.at })))
      .sort((a, b) => b.at.localeCompare(a.at)),
  );
  const lists = $derived({
    notifications: res?.notifications || [], issues: res?.issues || [],
    mine: res?.mine || [], review: res?.review || [], reviews,
  });

  // Repo rail: every repo with something in any column, most recently active first.
  const repos = $derived.by(() => {
    const m = new Map();
    for (const list of Object.values(lists)) {
      for (const x of list) {
        const r = m.get(x.repo) || { repo: x.repo, n: 0, last: '' };
        r.n++;
        if (x.updatedAt > r.last) r.last = x.updatedAt;
        m.set(x.repo, r);
      }
    }
    return [...m.values()].sort((a, b) => b.last.localeCompare(a.last));
  });

  const q = $derived(query.trim().toLowerCase());
  const keep = (x) => (!repo || x.repo === repo) && (!q || x.title.toLowerCase().includes(q) || x.repo.toLowerCase().includes(q));
  const cols = $derived([
    { key: 'notifications', label: 'Notifications', icon: 'bell', tint: 'var(--warn)', items: lists.notifications.filter(keep) },
    { key: 'issues', label: 'Assigned issues', icon: 'issue', tint: 'var(--success)', items: lists.issues.filter(keep) },
    { key: 'mine', label: 'My pull requests', icon: 'pr', tint: 'var(--accent)', items: lists.mine.filter(keep) },
    { key: 'review', label: 'Review requested', icon: 'eye', tint: 'var(--info)', items: lists.review.filter(keep) },
    { key: 'reviews', label: 'Latest reviews', icon: 'comment', tint: 'var(--danger)', items: lists.reviews.filter(keep) },
  ]);

  const short = (r) => r.split('/')[1] || r;
  const labelStyle = (c) => `--lc:#${c}`;
</script>

{#snippet where(x)}
  {#if !repo}<span class="repo">{short(x.repo)}</span>{/if}<span class="num">#{x.number}</span>
{/snippet}

{#snippet prCard(pr, showAuthor)}
  {@const c = CHECKS[pr.checks]}
  {@const d = DECISION[pr.decision]}
  <div class="top">
    {#if c}<span class="st {c.cls}" title={c.title}><Icon name={c.icon} size={14} /></span>{:else}<span class="st muted" title="No checks"><Icon name="dot" size={14} /></span>{/if}
    {@render where(pr)}
    <span class="when">{ago(pr.updatedAt)}</span>
  </div>
  <a class="title" href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
  <div class="meta">
    {#if pr.draft}<span class="tag muted">Draft</span>{/if}
    {#if d}<span class="tag {d.cls}">{d.label}</span>{/if}
    {#each pr.reviews as rv (rv.author)}
      <a class="rv {REVIEW[rv.state] || 'neutral'}" href={rv.url} target="_blank" rel="noreferrer" title="{rv.author} {REVIEW_LABEL[rv.state] || rv.state} · {ago(rv.at)}">{rv.author}</a>
    {/each}
    {#if pr.requested.length}<span class="dim" title="Review requested">→ {pr.requested.join(', ')}</span>{/if}
    {#if showAuthor}<span class="dim">by {pr.author}</span>{/if}
    <span class="dim"><span class="add">+{pr.additions}</span> <span class="del">−{pr.deletions}</span></span>
    {#if pr.comments}<span class="dim"><Icon name="comment" size={12} /> {pr.comments}</span>{/if}
  </div>
{/snippet}

<div class="gh">
  <header class="bar">
    <h1>GitHub</h1>
    <input class="search" type="search" placeholder="Filter by title or repo…" bind:value={query} />
    {#if res?.fetchedAt}<span class="fetched">fetched {ago(res.fetchedAt)}</span>{/if}
    <button class="refresh" onclick={() => load(true)} disabled={loading}>
      <Icon name="refresh" size={14} /> {loading ? 'Loading…' : 'Refresh'}
    </button>
  </header>

  {#if !res}
    <p class="empty">Loading… (a cold fetch takes ~10 s)</p>
  {:else if res.error}
    <p class="empty err">GitHub unavailable: {res.error}<br /><span class="dim">Check <code>gh auth status</code>.</span></p>
  {:else}
    <div class="body">
      <nav class="rail" aria-label="Repositories">
        <button class="rrow" class:on={!repo} onclick={() => (repo = '')}>
          <span class="rname">All repositories</span><span class="rn">{repos.reduce((n, r) => n + r.n, 0)}</span>
        </button>
        {#each repos as r (r.repo)}
          <button class="rrow" class:on={repo === r.repo} onclick={() => (repo = repo === r.repo ? '' : r.repo)} title={r.repo}>
            <span class="rname"><span class="owner">{r.repo.split('/')[0]}/</span>{short(r.repo)}</span><span class="rn">{r.n}</span>
          </button>
        {/each}
      </nav>

      <div class="cols">
        {#each cols as col (col.key)}
          <section class="col" style="--col-tint:{col.tint}">
            <h2>
              <Icon name={col.icon} size={14} /> {col.label}<span class="cn">{col.items.length}</span>
              {#if repo}<a class="ext" href="https://github.com/{repo}" target="_blank" rel="noreferrer" title="Open {repo} on GitHub"><Icon name="external" size={13} /></a>{/if}
            </h2>
            {#if !col.items.length}
              <p class="none">Nothing here.</p>
            {:else}
              <ul>
                {#each col.items as x (x.url + (x.id || x.author || ''))}
                  <li class="item">
                    {#if col.key === 'notifications'}
                      <div class="top">
                        <span class="st neutral"><Icon name={x.type === 'PullRequest' ? 'pr' : x.type === 'Issue' ? 'issue' : 'bell'} size={14} /></span>
                        {#if !repo}<span class="repo">{short(x.repo)}</span>{/if}
                        <span class="when">{ago(x.updatedAt)}</span>
                      </div>
                      <a class="title" href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                      <div class="meta"><span class="tag neutral">{x.reason.replaceAll('_', ' ')}</span></div>
                    {:else if col.key === 'issues'}
                      <div class="top">
                        <span class="st ok"><Icon name="issue" size={14} /></span>
                        {@render where(x)}
                        <span class="when">{ago(x.updatedAt)}</span>
                      </div>
                      <a class="title" href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                      <div class="meta">
                        {#each x.labels as l (l.name)}<span class="label" style={labelStyle(l.color)}>{l.name}</span>{/each}
                        <span class="dim">by {x.author}</span>
                        {#if x.comments}<span class="dim"><Icon name="comment" size={12} /> {x.comments}</span>{/if}
                      </div>
                    {:else if col.key === 'reviews'}
                      <div class="top">
                        <span class="rv {REVIEW[x.state] || 'neutral'}">{x.author}</span>
                        <span class="dim">{REVIEW_LABEL[x.state] || x.state}</span>
                        <span class="when">{ago(x.at)}</span>
                      </div>
                      <a class="title" href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                      <div class="meta">{#if !repo}<span class="repo">{short(x.repo)}</span>{/if}<span class="num">#{x.number}</span></div>
                    {:else}
                      {@render prCard(x, col.key === 'review')}
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .gh { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 14px 16px 0; gap: 12px; }
  .bar { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: var(--t-title); line-height: var(--lh-title); margin: 0; letter-spacing: -.01em; }
  .search { flex: 0 1 340px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); }
  .search:focus { outline: none; border-color: var(--accent); }
  .fetched { margin-left: auto; color: var(--muted); font-size: var(--t-meta); }
  .refresh { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .refresh:hover:not(:disabled) { border-color: var(--accent); }
  .refresh:disabled { opacity: .6; cursor: progress; }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; line-height: 1.7; }
  .empty.err { color: var(--danger); }
  code { background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-size: var(--t-meta); }

  .body { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; }

  .rail { flex: 0 0 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding-bottom: 14px; }
  .rrow { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border: none; border-radius: 8px; background: none; color: var(--text); font-size: var(--t-ui); text-align: left; cursor: pointer; }
  .rrow:hover { background: rgba(var(--ink-rgb), .05); }
  .rrow.on { background: var(--accent); color: var(--accent-fg); }
  .rname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .owner { opacity: .55; }
  .rn { flex: none; font-size: var(--t-micro); font-weight: 600; opacity: .7; font-variant-numeric: tabular-nums; }

  .cols { flex: 1 1 auto; min-width: 0; display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x proximity; padding-bottom: 14px; }
  .col { flex: 1 1 0; min-width: 270px; max-width: 480px; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; background: var(--bg2); scroll-snap-align: start; }
  .col h2 { flex: none; display: flex; align-items: center; gap: 7px; margin: 0; padding: 10px 12px; font-size: var(--t-ui); font-weight: 700; border-bottom: 1px solid var(--border); }
  .col h2 :global(svg) { color: var(--col-tint); }
  .cn { font-size: var(--t-micro); font-weight: 600; color: var(--col-tint); background: color-mix(in srgb, var(--col-tint) 14%, transparent); border-radius: 999px; padding: 1px 8px; }
  .ext { margin-left: auto; color: var(--muted); display: inline-flex; }
  .ext:hover { color: var(--accent); }
  .none { color: var(--muted); font-size: var(--t-ui); text-align: center; padding: 24px 0; margin: 0; }
  .col ul { flex: 1 1 auto; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: 0; }

  .item { padding: 10px 12px; }
  .item + .item { border-top: 1px solid var(--border); }
  .item:hover { background: rgba(var(--ink-rgb), .03); }
  .top { display: flex; align-items: center; gap: 6px; font-size: var(--t-meta); min-width: 0; }
  .repo { font-weight: 600; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { color: var(--muted); font-variant-numeric: tabular-nums; }
  .when { margin-left: auto; flex: none; color: var(--muted); }
  .title { margin-top: 4px; color: var(--text); text-decoration: none; font-size: var(--t-ui); font-weight: 600; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .title:hover { color: var(--accent); }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 7px; margin-top: 6px; font-size: var(--t-meta); }
  .meta:empty { display: none; }
  .dim { color: var(--muted); display: inline-flex; align-items: center; gap: 3px; }
  .add { color: var(--success); }
  .del { color: var(--danger); }

  .st { display: inline-flex; flex: none; }
  .tag, .rv, .label { font-size: var(--t-micro); font-weight: 700; padding: 1px 7px; border-radius: 6px; text-decoration: none; white-space: nowrap; }
  .tag { text-transform: uppercase; letter-spacing: .03em; }
  .label { color: color-mix(in srgb, var(--lc) 70%, var(--text)); background: color-mix(in srgb, var(--lc) 18%, transparent); }
  .ok { color: var(--success); } .tag.ok, .rv.ok { background: var(--success-soft); }
  .ko { color: var(--danger); } .tag.ko, .rv.ko { background: var(--danger-soft); }
  .wait { color: var(--warn); } .tag.wait, .rv.wait { background: var(--warn-soft); }
  .neutral { color: var(--text); } .tag.neutral, .rv.neutral { background: var(--bg3); }
  .muted { color: var(--muted); } .tag.muted, .rv.muted { background: var(--bg3); }
  .rv.muted { text-decoration: line-through; }

  @media (max-width: 760px) {
    .body { flex-direction: column; }
    .rail { flex: none; flex-direction: row; overflow-x: auto; overflow-y: hidden; padding-bottom: 0; }
    .rrow { flex: none; }
    .col { flex-basis: 85vw; }
  }
</style>
