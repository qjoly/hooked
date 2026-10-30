<script module>
  // Fetched details survive the panel switching between links; the refresh button bypasses them.
  const details = new Map(); // url → detail
  const diffs = new Map();   // url → { path → patch }
</script>

<script>
  // Detail panel of a GitHub / GitLab pull request or issue: header, then Summary · Timeline · Code.
  // `onfix(check, detail)` is optional: when given, a failed check offers to fix it in the session.
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';
  import CodeBlock from './CodeBlock.svelte';
  import { ago } from '$lib/format.js';
  import { CHECK } from '$lib/ghRun.js';

  let { url, onfix = null } = $props();

  let d = $state(null);
  let err = $state('');
  let loading = $state(false);
  let tab = $state('summary');
  let patches = $state(null);
  let patchErr = $state('');
  let openFiles = $state({});
  let fixed = $state({});

  async function getJson(path, u) {
    const r = await fetch(`/api/github/${path}?url=${encodeURIComponent(u)}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  }

  async function load(u, refresh = false) {
    if (refresh) { details.delete(u); diffs.delete(u); patches = null; }
    if (details.has(u)) { d = details.get(u); return; }
    loading = true;
    try {
      const j = await getJson('detail', u);
      details.set(u, j);
      if (u === url) d = j;
    } catch (e) {
      if (u === url) err = e.message;
    } finally {
      if (u === url) loading = false;
    }
  }

  async function loadDiff(u) {
    if (diffs.has(u)) { patches = diffs.get(u); return; }
    try {
      const j = await getJson('diff', u);
      diffs.set(u, j.files);
      if (u === url) patches = j.files;
    } catch (e) {
      if (u === url) patchErr = e.message;
    }
  }

  $effect(() => {
    const u = url;
    d = null; err = ''; patches = null; patchErr = ''; openFiles = {}; fixed = {};
    tab = 'summary';
    load(u);
  });
  $effect(() => { if (tab === 'code' && d?.kind === 'pr' && !patches) loadDiff(url); });

  const STATE = {
    OPEN: ['Open', 'open'], DRAFT: ['Draft', 'muted'], MERGED: ['Merged', 'merged'],
    CLOSED: ['Closed', 'closed'], NOT_PLANNED: ['Not planned', 'muted'],
  };
  // A closed issue was resolved, a closed PR was dropped — same hues as GitHub.
  const stateOf = (x) => (x.kind === 'issue' && x.state === 'CLOSED' ? ['Closed', 'merged'] : STATE[x.state] || [x.state, 'muted']);
  const DECISION = { APPROVED: ['Approved', 'ok'], CHANGES_REQUESTED: ['Changes requested', 'ko'], REVIEW_REQUIRED: ['Review required', 'wait'] };
  const RANK = { failed: 0, cancelled: 1, pending: 2 };
  const REVIEW = { APPROVED: ['approved', 'ok'], CHANGES_REQUESTED: ['requested changes', 'ko'], COMMENTED: ['reviewed', 'muted'], DISMISSED: ['dismissed', 'muted'] };
  const CHANGE = { ADDED: 'A', DELETED: 'D', RENAMED: 'R', MODIFIED: 'M' };

  const checks = $derived([...(d?.checks || [])].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)));
  const failing = $derived(checks.filter((c) => c.status === 'failed' || c.status === 'cancelled').length);
  const running = $derived(checks.filter((c) => c.status === 'pending').length);
  const people = $derived((d?.comments || []).filter((c) => !c.bot).slice().reverse());
  const bots = $derived((d?.comments || []).filter((c) => c.bot).slice().reverse());

  // GitLab hands out avatar URLs; GitHub's are derived from the login.
  const avatar = (login, url) => url || `https://github.com/${String(login).replace(/^app\//, '')}.png?size=40`;
  const repoOf = (u) => u.replace(/^https?:\/\/[^/]+\//, '').replace(/\/(-\/)?(issues|work_items)\/\d+.*$/, '');
  const gitlab = $derived(!!d?.url?.includes('/-/'));

  async function fix(c) {
    fixed = { ...fixed, [c.name]: 'sending' };
    const ok = await onfix(c, d);
    fixed = { ...fixed, [c.name]: ok === false ? 'failed' : 'sent' };
  }
</script>

{#snippet comment(c)}
  <details class="cmt">
    <summary>
      <img class="av" src={avatar(c.author, c.avatar)} alt="" loading="lazy" />
      <b>{c.author}</b><span class="dim">{ago(c.at)}</span>
      <span class="excerpt">{c.body.replace(/[#*`>_\[\]]/g, '').slice(0, 120)}</span>
    </summary>
    <div class="md"><Markdown text={c.body} /></div>
  </details>
{/snippet}

<div class="ghd">
  {#if err && !d}
    <p class="empty err">{err}</p>
  {:else if !d}
    <p class="empty">Loading…</p>
  {:else}
    {@const st = stateOf(d)}
    {@const dec = DECISION[d.decision]}
    <header class="hd">
      <div class="row">
        <a class="ttl" href={d.url} target="_blank" rel="noreferrer" title="Open on {gitlab ? 'GitLab' : 'GitHub'}">
          <span class="num">{gitlab && d.kind === 'pr' ? '!' : '#'}{d.number}</span> {d.title} <Icon name="external" size={12} />
        </a>
        <span class="badge {st[1]}">{st[0]}</span>
      </div>
      <div class="row meta">
        <img class="av" src={avatar(d.author, d.authorAvatar)} alt="" />
        <span>{d.author}</span>
        <span class="dim">{ago(d.createdAt)}</span>
        {#if d.kind === 'pr'}
          <span class="br" title="{d.head} → {d.base}"><code>{d.base}</code> ← <code>{d.head}</code></span>
          <span class="stat">
            <Icon name="file" size={12} /> {d.changedFiles}
            <span class="add">+{d.additions.toLocaleString()}</span> <span class="del">−{d.deletions.toLocaleString()}</span>
          </span>
        {:else}
          <span class="dim">{repoOf(d.url)}</span>
        {/if}
      </div>
      <div class="row tabs">
        <div class="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'summary'} class:on={tab === 'summary'} onclick={() => (tab = 'summary')}>Summary</button>
          <button role="tab" aria-selected={tab === 'timeline'} class:on={tab === 'timeline'} onclick={() => (tab = 'timeline')}>Timeline</button>
          {#if d.kind === 'pr'}<button role="tab" aria-selected={tab === 'code'} class:on={tab === 'code'} onclick={() => (tab = 'code')}>Code</button>{/if}
        </div>
        {#if dec}<span class="badge {dec[1]}">{dec[0]}</span>{/if}
        {#if checks.length}
          <span class="ck {failing ? 'ko' : running ? 'wait' : 'ok'}">
            <Icon name={failing ? 'attention' : running ? 'busy' : 'circle-check'} size={13} />
            {failing ? `${failing} of ${checks.length} failing` : running ? `${running} of ${checks.length} running` : 'All checks passed'}
          </span>
        {/if}
        <button class="icon-btn" onclick={() => load(url, true)} disabled={loading} title="Refresh"><Icon name="refresh" size={13} /></button>
      </div>
    </header>

    <div class="bd">
      {#if tab === 'summary'}
        {#if d.kind === 'issue' && (d.labels.length || d.assignees.length)}
          <div class="chips">
            {#each d.labels as l (l.name)}<span class="label" style="--lc:#{l.color}">{l.name}</span>{/each}
            {#if d.assignees.length}<span class="dim">→ {d.assignees.join(', ')}</span>{/if}
          </div>
        {/if}

        <details class="sec" open>
          <summary>Description</summary>
          {#if d.body.trim()}<div class="md"><Markdown text={d.body} /></div>{:else}<p class="dim">No description.</p>{/if}
        </details>

        {#if checks.length}
          <details class="sec" open>
            <summary>Checks</summary>
            <ul class="checks">
              {#each checks as c, i (c.name + i)}
                {@const k = CHECK[c.status]}
                <li class:bad={k.cls === 'ko'}>
                  <span class="ico {k.cls}"><Icon name={k.icon} size={14} /></span>
                  {#if c.url}<a href={c.url} target="_blank" rel="noreferrer" title={c.workflow || c.name}>{c.name}</a>{:else}<span>{c.name}</span>{/if}
                  <span class="dim st">{k.label}</span>
                  {#if onfix && c.status === 'failed'}
                    <button class="fix" onclick={() => fix(c)} disabled={!!fixed[c.name] && fixed[c.name] !== 'failed'}>
                      <Icon name="tool" size={12} /> {fixed[c.name] === 'sent' ? 'Sent' : fixed[c.name] === 'failed' ? 'Retry' : 'Fix in this thread'}
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}

        <details class="sec" open>
          <summary>Comments ({d.comments.length})</summary>
          {#if !d.comments.length}<p class="dim">No comments.</p>{/if}
          {#each people as c (c.at + c.author)}{@render comment(c)}{/each}
          {#if bots.length}
            <details class="cmt">
              <summary><Icon name="bot" size={14} /> <b>{bots.length} bot comment{bots.length > 1 ? 's' : ''}</b><span class="dim">latest {ago(bots[0].at)}</span></summary>
              {#each bots as c (c.at + c.author)}{@render comment(c)}{/each}
            </details>
          {/if}
        </details>

      {:else if tab === 'timeline'}
        {#if !d.timeline.length}<p class="dim">Nothing yet.</p>{/if}
        <ol class="tl">
          {#each d.timeline as e, i (i)}
            <li>
              <span class="ico {e.kind === 'review' ? (REVIEW[e.state] || REVIEW.COMMENTED)[1] : 'muted'}">
                <Icon name={e.kind === 'commit' ? 'git' : e.kind === 'review' ? 'eye' : 'comment'} size={14} />
              </span>
              <div class="ev">
                <div class="evh">
                  <b>{e.author}</b>
                  {#if e.kind === 'commit'}<span class="dim">committed</span> <code>{e.sha}</code>
                  {:else if e.kind === 'review'}<span class="dim">{(REVIEW[e.state] || [e.state.toLowerCase()])[0]}</span>
                  {:else}<span class="dim">commented</span>{/if}
                  <span class="dim when">{ago(e.at)}</span>
                </div>
                {#if e.kind === 'commit'}<div class="commit">{e.text}</div>
                {:else if e.text}<div class="md"><Markdown text={e.text} /></div>{/if}
              </div>
            </li>
          {/each}
        </ol>

      {:else}
        <ul class="files">
          {#each d.files as f (f.path)}
            <li>
              <button class="frow" onclick={() => (openFiles = { ...openFiles, [f.path]: !openFiles[f.path] })}>
                <span class="chev" class:open={openFiles[f.path]}><Icon name="chevron-right" size={12} /></span>
                <span class="chg">{CHANGE[f.change] || '·'}</span>
                <span class="path">{f.path}</span>
                <span class="add">+{f.additions}</span><span class="del">−{f.deletions}</span>
              </button>
              {#if openFiles[f.path]}
                {#if patches?.[f.path]}<CodeBlock code={patches[f.path]} lang="diff" />
                {:else if patchErr}<p class="dim err">{patchErr}</p>
                {:else if patches}<p class="dim">No textual diff (binary or too large).</p>
                {:else}<p class="dim">Loading diff…</p>{/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ghd { display: flex; flex-direction: column; min-height: 0; font-size: var(--t-ui); }
  .empty { color: var(--muted); text-align: center; padding: 40px 12px; }
  .err { color: var(--danger); }
  .dim { color: var(--muted); }
  .add { color: var(--success); font-variant-numeric: tabular-nums; }
  .del { color: var(--danger); font-variant-numeric: tabular-nums; }
  code { font-family: var(--mono); font-size: var(--t-micro); background: var(--bg3); padding: 1px 5px; border-radius: 5px; }

  .hd { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid var(--border); }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ttl { flex: 1; min-width: 0; color: var(--text); text-decoration: none; font-weight: 600; line-height: 1.35; }
  .ttl:hover { color: var(--accent); }
  .num { color: var(--muted); font-weight: 500; }
  .meta { font-size: var(--t-meta); flex-wrap: wrap; }
  .av { width: 18px; height: 18px; border-radius: 50%; flex: none; background: var(--bg3); }
  .br { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--muted); }
  .br code { overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
  .stat { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }

  .badge { flex: none; font-size: var(--t-micro); font-weight: 700; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
  .badge.open, .badge.ok { color: var(--success); background: var(--success-soft); }
  .badge.merged { color: #8250df; background: color-mix(in srgb, #8250df 15%, transparent); }
  .badge.closed, .badge.ko { color: var(--danger); background: var(--danger-soft); }
  .badge.wait { color: var(--warn); background: var(--warn-soft); }
  .badge.muted { color: var(--muted); background: var(--bg3); }

  .tabs { gap: 10px; }
  .seg { margin-right: auto; display: inline-flex; padding: 2px; border-radius: 9px; background: var(--bg3); }
  .seg button { border: none; background: none; color: var(--muted); font: inherit; font-weight: 600; padding: 4px 11px; border-radius: 7px; cursor: pointer; }
  .seg button.on { background: var(--bg2); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }
  .ck { display: inline-flex; align-items: center; gap: 5px; font-size: var(--t-meta); }
  .icon-btn { flex: none; display: inline-flex; padding: 4px; border: none; background: none; color: var(--muted); border-radius: 6px; cursor: pointer; }
  .icon-btn:hover:not(:disabled) { color: var(--text); background: var(--bg3); }
  .icon-btn:disabled { opacity: .5; cursor: progress; }

  .bd { padding: 10px 14px 18px; display: flex; flex-direction: column; gap: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: var(--t-meta); }
  .label { font-size: var(--t-micro); font-weight: 700; padding: 1px 7px; border-radius: 6px; color: color-mix(in srgb, var(--lc) 70%, var(--text)); background: color-mix(in srgb, var(--lc) 18%, transparent); }

  .sec > summary { cursor: pointer; color: var(--muted); font-size: var(--t-meta); font-weight: 600; padding: 8px 0 6px; list-style: none; }
  .sec > summary::after { content: ' ▾'; }
  .sec:not([open]) > summary::after { content: ' ▸'; }
  .md { line-height: 1.6; word-break: break-word; overflow-x: auto; }

  .checks, .files, .tl { list-style: none; margin: 0; padding: 0; }
  .checks li { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; }
  .checks li:hover { background: rgba(var(--ink-rgb), .04); }
  .checks li.bad { background: var(--danger-soft); }
  .checks a, .checks span:not(.ico):not(.st) { flex: 1; min-width: 0; color: var(--text); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .checks a:hover { color: var(--accent); }
  .st { flex: none; font-size: var(--t-meta); }
  .ico { display: inline-flex; flex: none; }
  .ok { color: var(--success); } .ko { color: var(--danger); } .wait { color: var(--warn); } .muted { color: var(--muted); }
  .fix { flex: none; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border2); background: var(--bg2); color: var(--text); font: inherit; font-size: var(--t-meta); padding: 2px 8px; border-radius: 6px; cursor: pointer; }
  .fix:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .fix:disabled { opacity: .7; cursor: default; }

  .cmt { border: 1px solid var(--border); border-radius: 9px; margin-bottom: 6px; background: var(--bg2); }
  .cmt > summary { display: flex; align-items: center; gap: 7px; padding: 7px 10px; cursor: pointer; list-style: none; min-width: 0; font-size: var(--t-meta); }
  .cmt .excerpt { flex: 1; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmt[open] .excerpt { display: none; }
  .cmt > .md, .cmt > .cmt { margin: 0 10px 10px; }

  .tl li { display: flex; gap: 10px; padding: 8px 0; }
  .tl li + li { border-top: 1px solid var(--border); }
  .ev { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .evh { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--t-meta); }
  .when { margin-left: auto; }
  .commit { font-family: var(--mono); font-size: var(--t-meta); }

  .frow { width: 100%; display: flex; align-items: center; gap: 7px; padding: 5px 6px; border: none; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; border-radius: 7px; }
  .frow:hover { background: rgba(var(--ink-rgb), .04); }
  .chev { display: inline-flex; transition: transform .12s; }
  .chev.open { transform: rotate(90deg); }
  .chg { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); width: 10px; }
  .path { flex: 1; min-width: 0; font-family: var(--mono); font-size: var(--t-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
</style>
