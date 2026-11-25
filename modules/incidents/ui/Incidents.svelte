<script>
  // incident.io: the lists by scope on the left, one incident on the right. Read only; the writes
  // (merge, pin, roles) stay in the desktop app for now. Data from modules/incidents/server/.
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { ago } from '#lib/format.js';
  import Markdown from '#lib/components/Markdown.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { getIncidentStatus, getIncidents, getIncident } from './api.js';
  import { incidentPrompt, isOpen, leadOf } from '../lib/incidents.js';

  const REFRESH_MS = 60_000;

  let status = $state(null);
  let scope = $state('open');
  let items = $state([]);
  let total = $state(null);
  let cursor = $state(null);
  let loading = $state(false);
  let error = $state('');
  let selectedId = $state(null);
  let detail = $state(null);
  let detailError = $state('');
  let timer;

  async function loadStatus(refresh = false) {
    try { status = await getIncidentStatus(refresh); } catch (e) { status = { available: false, reason: e.message }; }
  }

  async function loadList({ more = false } = {}) {
    if (!status?.available) return;
    loading = true;
    try {
      const r = await getIncidents(scope, more ? cursor : null);
      items = more ? [...items, ...r.incidents] : r.incidents;
      total = r.total;
      cursor = r.cursor;
      error = '';
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function open(id) {
    selectedId = id;
    detailError = '';
    if (detail?.id !== id) detail = null;
    try {
      const r = await getIncident(id);
      if (selectedId === id) detail = r.incident;
    } catch (e) {
      if (selectedId === id) detailError = e.message;
    }
  }

  function pickScope(key) {
    if (key === scope) return;
    scope = key;
    items = [];
    cursor = null;
    loadList();
  }

  async function refresh() {
    await loadList();
    if (selectedId) open(selectedId);
  }

  // A new session that starts on the incident: the prompt is filled in, the project is picked there.
  function investigate(i) {
    goto('/new?prompt=' + encodeURIComponent(incidentPrompt(i)));
  }

  onMount(async () => {
    await loadStatus();
    await loadList();
    timer = setInterval(() => { if (!document.hidden) loadList(); }, REFRESH_MS);
  });
  onDestroy(() => clearInterval(timer));

  const sevClass = (sev) => {
    const n = String(sev?.name || '').toLowerCase();
    if (/crit|major|sev ?1|p1/.test(n)) return 'danger';
    if (/high|sev ?2|p2/.test(n)) return 'warn';
    return '';
  };
  const stamp = (ts) => (ts ? new Date(ts).toLocaleString() : '');
  const text = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v.name || v.label || v.value || JSON.stringify(v));
  const investigationTexts = (inv) => Object.entries(inv || {}).filter(([k, v]) => k !== 'status' && typeof v === 'string' && v.trim()).map(([, v]) => v);
</script>

<div class="inc">
  <aside class="inc-list">
    <header class="inc-head">
      <h1>incident.io {#if total != null}<span class="count">{total}</span>{/if}</h1>
      <button class="icon-btn" title="Refresh" aria-label="Refresh" disabled={loading || !status?.available} onclick={refresh}><Icon name="refresh" size={15} /></button>
    </header>
    {#if status && !status.available}
      <p class="empty">{status.reason || 'incident.io is not reachable.'}</p>
    {:else}
      <div class="scopes">
        {#each status?.scopes || [] as s (s.key)}
          <button class="chip" class:on={scope === s.key} onclick={() => pickScope(s.key)}>{s.label}</button>
        {/each}
      </div>
      {#if error}<p class="hint err">{error}</p>{/if}
      {#if !items.length && !loading && !error}
        <p class="empty">No incident here.</p>
      {/if}
      <ul>
        {#each items as i (i.id)}
          {@const lead = leadOf(i)}
          <li>
            <button class="item" class:on={selectedId === i.id} class:closed={!isOpen(i)} onclick={() => open(i.id)}>
              <span class="row">
                <span class="ref">{i.reference}</span>
                <span class="name">{i.name}</span>
              </span>
              <span class="meta">
                {#if i.severity}<span class="ibadge sev-{sevClass(i.severity)}">{i.severity.name}</span>{/if}
                <span class="ibadge">{i.status?.name}</span>
                {#if lead}<span>{lead.user}</span>{/if}
                {#if i.you?.participant}<span class="you">you</span>{/if}
                <span title={stamp(i.updated_at)}>{ago(i.updated_at)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if cursor}
        <button class="more" disabled={loading} onclick={() => loadList({ more: true })}>Load more</button>
      {/if}
      {#if loading && !items.length}<p class="empty">Loading…</p>{/if}
    {/if}
  </aside>

  <section class="inc-detail">
    {#if !selectedId}
      <p class="empty">Pick an incident.</p>
    {:else if detailError}
      <p class="hint err">{detailError}</p>
    {:else if !detail}
      <p class="empty">Loading…</p>
    {:else}
      {@const d = detail}
      <header class="d-head">
        <div>
          <div class="d-ref">{d.reference}{#if d.incident_type} · {d.incident_type.name}{/if}</div>
          <h2>{d.name}</h2>
          <div class="meta">
            <span class="ibadge">{d.status?.name}</span>
            {#if d.severity}<span class="ibadge sev-{sevClass(d.severity)}">{d.severity.name}</span>{/if}
            {#if d.merged_into}<span>merged into {d.merged_into.reference}</span>{/if}
            <span title={stamp(d.reported_at)}>reported {ago(d.reported_at)}</span>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" onclick={() => investigate(d)}><Icon name="send" size={13} /> Investigate in a session</button>
          {#if d.permalink}<a class="btn" href={d.permalink} target="_blank" rel="noopener">incident.io <Icon name="external" size={12} /></a>{/if}
          {#if d.slack_channel_url || d.chat_channel_url}<a class="btn" href={d.slack_channel_url || d.chat_channel_url} target="_blank" rel="noopener">Channel <Icon name="external" size={12} /></a>{/if}
          {#if d.call_url}<a class="btn" href={d.call_url} target="_blank" rel="noopener">Call <Icon name="external" size={12} /></a>{/if}
        </div>
      </header>

      {#if d.ai_summary || d.summary}
        <h3>Summary</h3>
        <div class="md"><Markdown text={d.ai_summary || d.summary} breaks={false} /></div>
      {/if}

      {#if d.roles?.length}
        <h3>Roles</h3>
        <ul class="facts">
          {#each d.roles as r (r.role_id + r.user_id)}<li><span>{r.role}</span><span>{r.user}</span></li>{/each}
        </ul>
      {/if}

      {#if d.investigation && typeof d.investigation === 'object'}
        {@const texts = investigationTexts(d.investigation)}
        <h3>AI investigation</h3>
        <p class="hint">{(d.investigation.status === 'none' || !d.investigation.status) && !texts.length ? 'No investigation on this incident.' : 'Status: ' + d.investigation.status}</p>
        {#each texts as t, k (k)}<div class="md"><Markdown text={t} breaks={false} /></div>{/each}
      {/if}

      {#if d.updates?.length}
        <h3>Updates {#if d.updates_total_count > d.updates.length}<span class="count">{d.updates.length} of {d.updates_total_count}</span>{/if}</h3>
        <ol class="timeline">
          {#each d.updates as u, k (k)}
            <li>
              <div class="t-head">
                <strong>{text(u.author)}</strong>
                {#if u.status}<span class="ibadge">{text(u.status)}</span>{/if}
                {#if u.severity}<span class="ibadge">{text(u.severity)}</span>{/if}
                <span class="t-at" title={stamp(u.at || u.created_at)}>{ago(u.at || u.created_at)}</span>
              </div>
              {#if u.message}<div class="md"><Markdown text={text(u.message)} breaks={false} /></div>{/if}
            </li>
          {/each}
        </ol>
      {/if}

      {#if d.alerts?.length}
        <h3>Alerts</h3>
        <ul class="facts">
          {#each d.alerts as a, k (a.id || k)}<li><span class="ibadge" class:sev-danger={a.status === 'firing'}>{a.status}</span><span>{a.title}</span></li>{/each}
        </ul>
      {/if}

      {#if d.custom_fields?.length || d.timestamps?.length}
        <h3>Details</h3>
        <ul class="facts">
          {#each d.custom_fields || [] as f, k (f.field_id || k)}<li><span>{f.name}</span><span>{text(f.value)}</span></li>{/each}
          {#each d.timestamps || [] as t, k (t.name || k)}<li><span>{t.name}</span><span>{stamp(t.value)}</span></li>{/each}
        </ul>
      {/if}
    {/if}
  </section>
</div>

<style>
  .inc { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(300px, 420px) 1fr; }
  .inc-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg2); }
  .inc-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 18px 16px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: var(--t-head); line-height: var(--lh-head); letter-spacing: -.01em; }
  .count { color: var(--muted); font-size: var(--t-body); font-weight: 600; }
  .icon-btn { display: inline-flex; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--muted); cursor: pointer; }
  .icon-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border2); }
  .icon-btn:disabled { opacity: .5; cursor: default; }
  .scopes { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px 4px; }
  .chip { padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--muted); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .chip:hover { border-color: var(--border2); }
  .chip.on { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }

  ul { list-style: none; margin: 0; padding: 6px; }
  .item { width: 100%; display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border: none; border-radius: 8px; background: none; color: var(--text); text-align: left; cursor: pointer; }
  .item:hover { background: rgba(var(--ink-rgb), .05); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .item.closed { opacity: .7; }
  .row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .ref { flex: none; font-family: var(--mono); font-size: var(--t-ui); color: var(--muted); }
  .name { flex: 1; min-width: 0; font-weight: 600; font-size: var(--t-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--muted); font-size: var(--t-ui); }
  .ibadge { flex: none; font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; background: var(--bg3); color: var(--muted); }
  .sev-danger { color: var(--danger); }
  .sev-warn { color: var(--warn); }
  .you { color: var(--accent); font-weight: 600; }
  .more { display: block; margin: 4px auto 16px; padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }

  .inc-detail { min-height: 0; overflow-y: auto; padding: 24px 32px 80px; }
  .d-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--border); max-width: 900px; }
  .d-ref { font-family: var(--mono); font-size: var(--t-ui); color: var(--muted); }
  h2 { margin: 2px 0 8px; font-size: var(--t-title); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; text-decoration: none; }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  h3 { margin: 24px 0 8px; font-size: var(--t-meta); font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .md { max-width: 900px; line-height: 1.55; }
  .facts { padding: 0; max-width: 900px; }
  .facts li { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: var(--t-ui); }
  .facts li > span:first-child { min-width: 140px; color: var(--muted); }
  .timeline { list-style: none; margin: 0; padding: 0; max-width: 900px; }
  .timeline li { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .t-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--t-ui); margin-bottom: 4px; }
  .t-at { color: var(--muted); }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: var(--t-ui); line-height: 1.5; }
  .hint.err { color: var(--danger); padding: 0 16px; }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }

  @media (max-width: 760px) {
    .inc { grid-template-columns: 1fr; grid-template-rows: minmax(0, 45%) 1fr; }
    .inc-list { border-right: none; border-bottom: 1px solid var(--border); }
    .inc-detail { padding: 18px 16px 60px; }
  }
</style>
