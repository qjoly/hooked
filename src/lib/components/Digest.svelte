<script>
  import { onMount } from 'svelte';
  import { getDigests, getDigest, generateDigest } from '$lib/api.js';
  import { ui } from '$lib/state.svelte.js';
  import { fmtCost, prLabel, issueLabel } from '$lib/format.js';
  import Markdown from './Markdown.svelte';

  let index = $state(null);   // { digests:[{date,status,...}], latest, yesterday }
  let date = $state('');
  let digest = $state(null);  // current day's digest object
  let busy = $state(false);

  async function loadIndex() { try { index = await getDigests(); } catch (_) {} }
  async function loadDigest(d) { if (!d) return; try { digest = await getDigest(d); } catch (_) {} }

  onMount(async () => {
    await loadIndex();
    date = index?.latest || index?.yesterday || '';
  });

  // Selecting a date (picker or history) reloads that digest.
  $effect(() => { const d = date; if (d) loadDigest(d); });
  // Keep the history index fresh on the live tick (so the scheduler's morning run shows up).
  $effect(() => { ui.tick; loadIndex(); });
  // Poll while a generation is in flight.
  $effect(() => {
    if (digest?.status === 'running') {
      const t = setTimeout(() => loadDigest(date), 3000);
      return () => clearTimeout(t);
    }
  });

  async function generate(force = false) {
    if (!date || busy) return;
    busy = true;
    try {
      const r = await generateDigest(date, force);
      if (r.ok) { digest = r.data.digest; loadIndex(); }
    } finally { busy = false; }
  }

  const ready = $derived(digest && (digest.status === 'done' || digest.status === 'partial'));
  const sessions = $derived(ready ? (digest.sessions || []) : []);
  const pending = $derived(ready ? (digest.pending || []) : []);
  const blockers = $derived(ready ? (digest.blockers || []) : []);
  const totals = $derived(digest?.totals || null);
  const toolList = (t) => Object.entries(t || {}).sort((a, b) => b[1] - a[1]);
</script>

<div class="digest">
  <aside class="hist">
    <div class="hist-head">History</div>
    {#if index?.digests?.length}
      <ul>
        {#each index.digests as d (d.date)}
          <li>
            <button class="hist-item" class:active={d.date === date} onclick={() => (date = d.date)}>
              <span class="hi-date">{d.date}</span>
              {#if d.status === 'running'}<span class="hi-badge run">…</span>
              {:else if d.status === 'partial'}<span class="hi-badge warn">partial</span>
              {:else if d.status === 'error'}<span class="hi-badge err">error</span>
              {:else if d.totals}<span class="hi-badge">{d.totals.sessions}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="hist-empty">No digests yet.</div>
    {/if}
  </aside>

  <main class="body">
    <header class="bar">
      <h2>Daily Digest</h2>
      <input type="date" bind:value={date} max={index?.yesterday} class="date-in" />
      <div class="spacer"></div>
      {#if ready}
        <button class="btn" onclick={() => generate(true)} disabled={busy}>Regenerate</button>
      {:else}
        <button class="btn primary" onclick={() => generate(false)} disabled={busy || !date}>Generate</button>
      {/if}
    </header>

    {#if !digest}
      <div class="state">Loading…</div>
    {:else if digest.status === 'running' || busy}
      <div class="state"><span class="spin"></span> Generating the digest for {date}… Claude is analyzing the day's sessions.</div>
    {:else if digest.status === 'absent'}
      <div class="state">No digest for <b>{date}</b> yet. Click <b>Generate</b> to have Claude analyze that day.</div>
    {:else if digest.status === 'error'}
      <div class="state err">Generation failed: {digest.error || 'unknown error'}. <button class="link" onclick={() => generate(true)}>Retry</button></div>
    {:else if ready}
      {#if digest.status === 'partial'}
        <div class="notice">The AI summary couldn't be produced ({digest.aiError || 'claude -p error'}), but the day's data is shown below.</div>
      {/if}

      {#if totals}
        <div class="kpis">
          <div class="kpi"><b>{totals.sessions}</b><span>sessions</span></div>
          <div class="kpi"><b>{totals.turns}</b><span>turns</span></div>
          <div class="kpi"><b>{totals.prompts}</b><span>prompts</span></div>
          <div class="kpi"><b>{fmtCost(totals.cost)}</b><span>est. cost</span></div>
        </div>
      {/if}

      {#if digest.summary}
        <section class="card summary"><Markdown text={digest.summary} /></section>
      {/if}

      {#if digest.highlights?.length}
        <section class="card">
          <h3>Highlights</h3>
          <ul class="hl">{#each digest.highlights as h}<li>{h}</li>{/each}</ul>
        </section>
      {/if}

      {#if pending.length || blockers.length}
        <section class="card pending">
          <h3>Still pending</h3>
          {#if blockers.length}
            <ul class="hl">{#each blockers as b}<li class="blocker">{b}</li>{/each}</ul>
          {/if}
          {#if pending.length}
            <ul class="pend">
              {#each pending as p (p.id + p.text)}
                <li><span class="pk">{p.kind}</span> <a href={p.link} data-session-link class="slink">{p.title}</a> — {p.text}</li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      <section class="sessions">
        <h3>{sessions.length} session{sessions.length === 1 ? '' : 's'}</h3>
        {#if digest.truncated}<div class="notice small">Showing the busiest {sessions.length} sessions of the day.</div>{/if}
        {#each sessions as s (s.id)}
          <div class="scard">
            <div class="sc-head">
              <a href={s.link} data-session-link class="sc-title slink">{s.title || '(untitled)'}</a>
              <div class="sc-meta">
                {#if s.projectName}<span class="chip">{s.projectName}</span>{/if}
                {#if s.gitBranch}<span class="chip br">{s.gitBranch}</span>{/if}
                {#each s.tags as t}<span class="chip tag">{t}</span>{/each}
              </div>
            </div>
            {#if s.accomplished}<p class="sc-acc">{s.accomplished}</p>{/if}
            {#if s.pending}<p class="sc-pend"><span class="pk">pending</span> {s.pending}</p>{/if}
            {#if s.pendingQuestion?.length}
              <p class="sc-pend"><span class="pk q">open question</span> {s.pendingQuestion.join(' · ')}</p>
            {/if}
            {#if toolList(s.tools).length}
              <div class="tools">{#each toolList(s.tools) as [n, c]}<span class="tchip">{n}<i>{c}</i></span>{/each}</div>
            {/if}
            {#if s.prLinks?.length || s.issueLinks?.length}
              <div class="links">
                {#each s.prLinks as l}<a href={l} target="_blank" rel="noopener noreferrer" class="ext pr">{prLabel(l)}</a>{/each}
                {#each s.issueLinks as l}<a href={l} target="_blank" rel="noopener noreferrer" class="ext iss">{issueLabel(l)}</a>{/each}
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/if}
  </main>
</div>

<style>
  .digest { display: flex; height: 100%; min-height: 0; }
  .hist {
    width: 200px; flex: 0 0 auto; border-right: 1px solid var(--border);
    overflow-y: auto; padding: 14px 8px; background: var(--bg2);
  }
  .hist-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 0 6px 8px; }
  .hist ul { list-style: none; margin: 0; padding: 0; }
  .hist-item {
    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px;
    padding: 7px 8px; border: none; background: transparent; color: var(--text); cursor: pointer;
    border-radius: 8px; font-size: 13px; text-align: left; font-variant-numeric: tabular-nums;
  }
  .hist-item:hover { background: var(--hover); }
  .hist-item.active { background: var(--accent-soft); color: var(--accent); }
  .hi-badge { font-size: 11px; min-width: 18px; text-align: center; padding: 1px 6px; border-radius: 999px; background: var(--chip); color: var(--muted); }
  .hi-badge.run { background: var(--accent-soft); color: var(--accent); }
  .hi-badge.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .hi-badge.err { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
  .hist-empty { color: var(--muted); font-size: 13px; padding: 6px; }

  .body { flex: 1 1 auto; min-width: 0; overflow-y: auto; padding: 18px 22px 60px; }
  .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .bar h2 { margin: 0; font-size: 20px; }
  .spacer { flex: 1 1 auto; }
  .date-in {
    font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--border2, var(--border));
    border-radius: 8px; background: var(--card); color: var(--text);
  }
  .btn {
    font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--border2, var(--border)); background: var(--card); color: var(--text);
  }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn:disabled { opacity: .5; cursor: default; }

  .state { color: var(--muted); font-size: 14px; padding: 32px 4px; display: flex; align-items: center; gap: 10px; }
  .state.err { color: var(--danger); }
  .link { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; padding: 0; }
  .spin { width: 15px; height: 15px; border: 2px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: sp .7s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }

  .notice { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 14px; }
  .notice.small { font-size: 12px; padding: 5px 10px; }

  .kpis { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; min-width: 84px; }
  .kpi b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .kpi span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }

  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin-bottom: 16px; }
  .card h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
  .summary { font-size: 15px; line-height: 1.6; }
  .hl { margin: 0; padding-left: 20px; }
  .hl li { margin: 3px 0; }
  .hl li.blocker { color: var(--danger); }
  .pending { border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); }
  .pend { list-style: none; margin: 6px 0 0; padding: 0; }
  .pend li { margin: 5px 0; font-size: 14px; }
  .pk { font-size: 11px; font-weight: 700; text-transform: uppercase; background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); border-radius: 5px; padding: 1px 6px; margin-right: 4px; }
  .pk.q { background: var(--accent-soft); color: var(--accent); }

  .sessions h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); margin: 4px 0 12px; }
  .scard { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin-bottom: 12px; }
  .sc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .sc-title { font-size: 15px; font-weight: 600; }
  .slink { color: var(--accent); text-decoration: none; }
  .slink:hover { text-decoration: underline; }
  .sc-meta { display: flex; gap: 5px; flex-wrap: wrap; }
  .chip { font-size: 11px; background: var(--chip); color: var(--muted); border-radius: 6px; padding: 2px 7px; }
  .chip.br { font-family: var(--mono); }
  .chip.tag { background: var(--accent-soft); color: var(--accent); }
  .sc-acc { margin: 8px 0 4px; font-size: 14px; line-height: 1.5; }
  .sc-pend { margin: 4px 0; font-size: 13px; color: var(--muted); }
  .tools { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
  .tchip { font-size: 11px; font-family: var(--mono); background: var(--chip); color: var(--muted); border-radius: 6px; padding: 2px 6px; }
  .tchip i { font-style: normal; opacity: .7; margin-left: 3px; }
  .links { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .ext { font-size: 12px; text-decoration: none; border-radius: 6px; padding: 2px 8px; border: 1px solid var(--border); color: var(--text); }
  .ext:hover { background: var(--hover); }
  .ext.pr { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }

  @media (max-width: 720px) {
    .digest { flex-direction: column; }
    .hist { width: auto; border-right: none; border-bottom: 1px solid var(--border); max-height: 130px; }
  }
</style>
