<script>
  // A GitHub Actions run in a floating window that stays open while you move between sessions.
  // Jobs and steps refresh live, a finished job shows its log.
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import FloatingWindow from './FloatingWindow.svelte';
  import { ago, fmtSpan } from '$lib/format.js';
  import { parseRunUrl, CHECK } from '$lib/ghRun.js';

  let { url, onclose } = $props();

  const POLL_MS = 5000;
  // ponytail: only the tail is rendered, a full log of 50k lines would freeze the window; the full one is on GitHub.
  const MAX_LINES = 3000;

  let run = $state(null);
  let err = $state('');
  // The layout remounts the window when the url changes, so reading it once is enough.
  let jobId = $state(untrack(() => parseRunUrl(url)?.job || ''));
  let log = $state(null); // { id, text } | { id, pending } | { id, error }
  let pre = $state();

  async function getJson(path, u) {
    const j = await (await fetch(`/api/github/${path}?url=${encodeURIComponent(u)}`)).json();
    if (j.error) throw new Error(j.error);
    return j;
  }

  async function loadRun() {
    try { run = await getJson('run', url); err = ''; } catch (e) { err = e.message; }
  }

  $effect(() => {
    loadRun();
    const t = setInterval(() => { if (!run || run.status === 'pending') loadRun(); }, POLL_MS);
    return () => clearInterval(t);
  });

  const job = $derived(run?.jobs.find((j) => j.id === jobId)
    || run?.jobs.find((j) => j.status === 'failed') || run?.jobs.find((j) => j.status === 'pending') || run?.jobs[0]);

  // Refetched when the job finishes, since GitHub serves no log before that.
  $effect(() => {
    const j = job;
    if (!j || log?.id === j.id && !log.pending) return;
    if (j.status === 'pending') { log = { id: j.id, pending: true }; return; }
    getJson('run/log', j.url)
      .then((x) => { if (job?.id === j.id) log = x.log == null ? { id: j.id, pending: true } : { id: j.id, text: x.log }; })
      .catch((e) => { if (job?.id === j.id) log = { id: j.id, error: e.message }; });
  });

  const lines = $derived(log?.text ? log.text.split('\n').slice(-MAX_LINES) : []);
  const isError = (l) => l.startsWith('##[error]');

  // Lands on the first error, otherwise on the end of the log.
  $effect(() => {
    if (!pre || !lines.length) return;
    requestAnimationFrame(() => {
      const e = pre.querySelector('.err');
      if (e) e.scrollIntoView({ block: 'center' }); else pre.scrollTop = pre.scrollHeight;
    });
  });

  const span = (a, b) => (a ? fmtSpan((b ? Date.parse(b) : Date.now()) - Date.parse(a)) : '');
</script>

<FloatingWindow {onclose}>
  {#snippet title()}
    {#if run}
      {@const k = CHECK[run.status]}
      <span class="ico {k.cls}"><Icon name={k.icon} size={14} /></span>
      <a class="ttl" href={run.url} target="_blank" rel="noreferrer" data-native title="Open on GitHub">{run.title} <Icon name="external" size={11} /></a>
    {:else}
      <span class="ttl dim">GitHub Actions run</span>
    {/if}
  {/snippet}
    {#if !run}
      <p class="empty" class:ko={err}>{err || 'Loading…'}</p>
    {:else}
      <div class="meta">
        <span>{run.workflow}</span>
        {#if run.branch}<code>{run.branch}</code>{/if}
        <span>{run.event}</span>
        {#if run.attempt > 1}<span>attempt {run.attempt}</span>{/if}
        <span>{ago(run.createdAt)}</span>
        {#if err}<span class="ko" title={err}>refresh failed</span>{/if}
      </div>

      <div class="cols">
        <ul class="jobs">
          {#each run.jobs as j (j.id)}
            {@const jk = CHECK[j.status]}
            <li>
              <button class:on={j.id === job?.id} onclick={() => (jobId = j.id)}>
                <span class="ico {jk.cls}"><Icon name={jk.icon} size={13} /></span>
                <span class="nm">{j.name}</span>
                <span class="dim">{span(j.startedAt, j.completedAt)}</span>
              </button>
            </li>
          {:else}
            <li class="dim">No jobs.</li>
          {/each}
        </ul>

        <div class="job">
          {#if job}
            <ol class="steps">
              {#each job.steps as s, i (i)}
                {@const sk = CHECK[s.status]}
                <li><span class="ico {sk.cls}"><Icon name={sk.icon} size={12} /></span><span class="nm">{s.name}</span><span class="dim">{span(s.startedAt, s.completedAt)}</span></li>
              {/each}
            </ol>
            {#if log?.error}<p class="dim ko">{log.error}</p>
            {:else if log?.pending}<p class="dim">GitHub publishes the log when the job finishes. Steps above refresh every {POLL_MS / 1000} s.</p>
            {:else if log?.text != null}
              <pre bind:this={pre}>{#each lines as l, i (i)}<div class:err={isError(l)}>{l}</div>{/each}</pre>
            {:else}<p class="dim">Loading log…</p>{/if}
          {/if}
        </div>
      </div>
    {/if}
</FloatingWindow>

<style>
  .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); text-decoration: none; }
  a.ttl:hover { color: var(--accent); }
  .empty { text-align: center; padding: 40px 12px; color: var(--muted); }
  .dim { color: var(--muted); }
  .ok { color: var(--success); } .ko { color: var(--danger); } .wait { color: var(--warn); } .muted { color: var(--muted); }
  .ico { display: inline-flex; flex: none; }
  .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: var(--t-meta); }
  code { font-family: var(--mono); font-size: var(--t-micro); background: var(--bg3); padding: 1px 5px; border-radius: 5px; }

  .cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, 220px) 1fr; gap: 12px; }
  .jobs, .steps { list-style: none; margin: 0; padding: 0; }
  .jobs { overflow: auto; }
  .jobs button { width: 100%; display: flex; align-items: center; gap: 7px; padding: 6px 8px; border: none; background: none; color: var(--text); font: inherit; text-align: left; border-radius: 7px; cursor: pointer; }
  .jobs button:hover { background: rgba(var(--ink-rgb), .04); }
  .jobs button.on { background: var(--bg3); }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .job { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
  .steps { flex: none; max-height: 35%; overflow: auto; }
  .steps li { display: flex; align-items: center; gap: 7px; padding: 2px 4px; font-size: var(--t-meta); }
  pre { flex: 1; min-height: 0; margin: 0; overflow: auto; padding: 10px 12px; border-radius: 9px; background: var(--bg3); font-family: var(--mono); font-size: var(--t-micro); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  pre .err { color: var(--danger); background: var(--danger-soft); }
</style>
