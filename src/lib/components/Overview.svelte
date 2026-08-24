<script>
  import { ui, data, openModal } from '$lib/state.svelte.js';
  import { fmtTokens, fmtCost, ago } from '$lib/format.js';
  import { getBackground } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';

  const S = $derived(data.sessions);
  const sum = (f) => S.reduce((a, s) => a + f(s), 0);
  const nb = (states) => S.filter((s) => states.includes(s.state)).length;

  // Jobs de fond actifs, toutes sessions (via /api/background) — rafraîchi à chaque tick live.
  let bg = $state({ jobs: [], count: 0 });
  const KIND_ICON = { bash: 'bash', monitor: 'eye', wakeup: 'wakeup', subagent: 'subagent' };
  $effect(() => {
    ui.tick; // dépendance : re-fetch à chaque tick SSE / poll
    getBackground().then((r) => { bg = r; }).catch(() => {});
  });
</script>

<div class="overview">
  <div class="ov-stats">
    <span><b>{S.length}</b> sessions</span>
    {#if nb(['working'])}<span class="c-working"><b>{nb(['working'])}</b> running</span>{/if}
    {#if nb(['waiting', 'attention'])}<span class="c-waiting"><b>{nb(['waiting', 'attention'])}</b> waiting</span>{/if}
    <span><b>{sum((s) => s.userPrompts)}</b> prompts</span>
    <span><b>{fmtTokens(sum((s) => s.usage.output + s.usage.input))}</b> tokens</span>
    <button class="ov-cost" onclick={() => openModal('cost')}><b>{fmtCost(sum((s) => s.cost))}</b> API cost ›</button>
  </div>
  <p class="ov-hint">← Select a session on the left to replay the conversation (read-only).</p>

  {#if bg.count}
    <div class="ov-bg">
      <div class="ov-bg-head"><Icon name="background" size={14} color="var(--background)" /> Active background jobs <span class="ov-bg-n">{bg.count}</span></div>
      <ul class="ov-bg-list">
        {#each bg.jobs as j (j.sessionId + ':' + (j.taskId || j.command))}
          <li>
            <a class="ov-bg-item" href="/session/{encodeURIComponent(j.sessionId)}">
              <span class="ov-bg-kind"><Icon name={KIND_ICON[j.kind] || 'background'} size={16} color={KIND_ICON[j.kind] ? undefined : 'var(--background)'} /></span>
              <span class="ov-bg-main">
                <span class="ov-bg-desc">{j.description || j.command || j.kind}</span>
                <span class="ov-bg-sub">{j.repo || j.projectName || ''} · {j.title || j.sessionId}</span>
              </span>
              <span class="ov-bg-ago">{ago(j.startedAt)}</span>
            </a>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .ov-stats {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 22px;
    font-size: 13.5px; color: var(--muted);
  }
  .ov-stats span, .ov-stats .ov-cost { display: inline-flex; align-items: baseline; gap: 5px; }
  .ov-stats b { font-size: 17px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
  .ov-stats .c-working b { color: var(--working); }
  .ov-stats .c-waiting b { color: var(--waiting); }
  .ov-cost { background: none; border: none; padding: 0; font: inherit; color: var(--accent-d); cursor: pointer; }
  .ov-cost b { color: var(--accent-d); }
  .ov-cost:hover { text-decoration: underline; }

  .ov-bg { margin-top: 18px; max-width: 720px; }
  .ov-bg-head { font-size: 14px; font-weight: 700; color: var(--background); display: flex; align-items: center; gap: 8px; }
  .ov-bg-n { font-size: 11px; font-weight: 700; color: #fff; background: var(--background); border-radius: 999px; padding: 0 7px; }
  .ov-bg-list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .ov-bg-item {
    display: flex; align-items: center; gap: 10px; text-decoration: none;
    border: 1px solid var(--border); border-left: 3px solid var(--background);
    border-radius: 10px; background: var(--panel); padding: 8px 12px; color: var(--text);
  }
  .ov-bg-item:hover { background: var(--bg3); }
  .ov-bg-kind { font-size: 16px; flex: none; }
  .ov-bg-main { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .ov-bg-desc { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov-bg-sub { font-size: 11px; color: var(--muted); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov-bg-ago { font-size: 11px; color: var(--muted); flex: none; }
</style>
