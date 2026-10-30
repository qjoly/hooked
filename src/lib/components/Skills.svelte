<script>
  import { untrack } from 'svelte';
  import { getSkills, getSkill } from '$lib/api.js';
  import { data } from '$lib/state.svelte.js';
  import { copyText } from '$lib/clipboard.js';
  import Markdown from './Markdown.svelte';

  const SOURCES = [
    { key: 'user', label: 'User', hint: '~/.claude/skills' },
    { key: 'project', label: 'Project', hint: '<project>/.claude/skills' },
    { key: 'plugin', label: 'Plugin', hint: 'Installed plugins' },
  ];

  let skills = $state(null);
  let error = $state('');
  let query = $state('');
  let source = $state('all');
  let selectedId = $state(null);
  let detail = $state(null);
  let copied = $state(false);

  // Project skills come from the directories of the sessions hooked knows about.
  const cwds = $derived([...new Set(data.sessions.map((s) => s.project).filter(Boolean))].sort());
  const cwdKey = $derived(cwds.join('\n'));

  $effect(() => {
    const list = cwdKey ? cwdKey.split('\n') : [];
    getSkills(list).then((l) => { skills = l; error = ''; }).catch((e) => { error = e.message; });
  });

  // Keyed on the cwd string, not the array: every live tick rebuilds the array, and refetching
  // blanked the pane, which threw the reader back to the top.
  $effect(() => {
    const id = selectedId;
    const list = cwdKey ? cwdKey.split('\n') : [];
    if (untrack(() => detail?.id) !== id) detail = null;
    if (!id) return;
    getSkill(id, list).then((d) => { if (selectedId === id) detail = d; }).catch(() => {});
  });

  const q = $derived(query.trim().toLowerCase());
  const counts = $derived(Object.fromEntries(SOURCES.map((s) => [s.key, (skills || []).filter((k) => k.source === s.key).length])));
  const shown = $derived((skills || [])
    .filter((s) => (source === 'all' || s.source === source)
      && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name)));

  const projectName = (cwd) => (cwd || '').split('/').pop();

  async function copyName() {
    if (!detail) return;
    await copyText('/' + detail.name);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<div class="sk">
  <aside class="sk-list">
    <header class="sk-head">
      <h1>Skills <span class="count">{skills ? skills.length : ''}</span></h1>
      <input class="search" type="search" placeholder="Search skills…" bind:value={query} />
      <div class="chips">
        <button class="chip" class:on={source === 'all'} onclick={() => (source = 'all')}>All</button>
        {#each SOURCES as s (s.key)}
          {#if counts[s.key]}
            <button class="chip" class:on={source === s.key} onclick={() => (source = s.key)} title={s.hint}>
              {s.label} <span class="n">{counts[s.key]}</span>
            </button>
          {/if}
        {/each}
      </div>
    </header>

    {#if error}
      <p class="empty">Could not load skills: {error}</p>
    {:else if !skills}
      <p class="empty">Loading…</p>
    {:else if !shown.length}
      <p class="empty">No skill matches.</p>
    {:else}
      <ul>
        {#each shown as s (s.id)}
          <li>
            <button class="item" class:on={selectedId === s.id} class:off={s.enabled === false} onclick={() => (selectedId = s.id)}>
              <span class="row">
                <span class="name">{s.name}</span>
                <span class="badge src-{s.source}">{s.source === 'project' ? projectName(s.project) : s.source}</span>
              </span>
              {#if s.description}<span class="desc">{s.description}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <section class="sk-detail">
    {#if !selectedId}
      <p class="empty">Pick a skill to read it.</p>
    {:else if !detail}
      <p class="empty">Loading…</p>
    {:else}
      <header class="d-head">
        <div class="d-title">
          <h2>/{detail.name}</h2>
          <button class="btn" onclick={copyName}>{copied ? 'Copied' : 'Copy command'}</button>
        </div>
        {#if detail.enabled === false}<p class="warn">The plugin {detail.plugin} is disabled: this skill is not loaded.</p>{/if}
        {#if detail.description}<p class="d-desc">{detail.description}</p>{/if}
        <p class="d-path"><code>{detail.file}</code></p>
        {#if detail.files.length}
          <details class="files">
            <summary>{detail.files.length} bundled file{detail.files.length > 1 ? 's' : ''}</summary>
            <ul>{#each detail.files as f (f)}<li><code>{f}</code></li>{/each}</ul>
          </details>
        {/if}
      </header>
      <div class="d-body"><Markdown text={detail.body} /></div>
    {/if}
  </section>
</div>

<style>
  .sk { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(280px, 380px) 1fr; }
  .sk-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg2); }
  .sk-head { position: sticky; top: 0; z-index: 1; display: flex; flex-direction: column; gap: 10px; padding: 18px 16px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: var(--t-head); line-height: var(--lh-head); letter-spacing: -.01em; }
  .count { color: var(--muted); font-size: var(--t-body); font-weight: 600; }
  .search { padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font-size: var(--t-body); }
  .search:focus { outline: none; border-color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--muted); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .chip:hover { border-color: var(--border2); }
  .chip.on { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
  .chip .n { opacity: .75; font-variant-numeric: tabular-nums; }

  ul { list-style: none; margin: 0; padding: 6px; }
  .item { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: none; border-radius: 8px; background: none; color: var(--text); text-align: left; cursor: pointer; }
  .item:hover { background: rgba(var(--ink-rgb), .05); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .item.off { opacity: .55; }
  .row { display: flex; align-items: center; gap: 8px; }
  .name { flex: 1; min-width: 0; font-weight: 600; font-size: var(--t-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; background: var(--bg3); color: var(--muted); }
  .src-user { color: var(--info); }
  .src-project { color: var(--success); }
  .src-plugin { color: var(--warn); }
  .desc { color: var(--muted); font-size: var(--t-ui); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  .sk-detail { min-height: 0; overflow-y: auto; padding: 24px 32px 80px; }
  .d-head { max-width: 860px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  .d-title { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
  h2 { margin: 0; font-size: var(--t-title); font-family: var(--mono); overflow-wrap: anywhere; }
  .btn { flex: none; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .d-desc { margin: 10px 0 0; color: var(--text); line-height: 1.55; }
  .d-path { margin: 8px 0 0; font-size: var(--t-meta); color: var(--muted); overflow-wrap: anywhere; }
  .warn { margin: 10px 0 0; color: var(--warn); font-size: var(--t-ui); font-weight: 600; }
  .files { margin-top: 10px; font-size: var(--t-ui); color: var(--muted); }
  .files summary { cursor: pointer; }
  .files ul { padding: 6px 0 0 16px; }
  .files li { padding: 1px 0; }
  .d-body { max-width: 860px; font-size: var(--t-ui); line-height: 1.6; }
  .d-body :global(pre) { max-width: 100%; overflow-x: auto; }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }

  @media (max-width: 760px) {
    .sk { grid-template-columns: 1fr; grid-template-rows: minmax(0, 45%) 1fr; }
    .sk-list { border-right: none; border-bottom: 1px solid var(--border); }
    .sk-detail { padding: 18px 16px 60px; }
  }
</style>
