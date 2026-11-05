<script>
  import { settings, updateSettings } from '$lib/state.svelte.js';
  import Icon from './Icon.svelte';

  // Prompts have no id: they are addressed by their index in the list ('new' = unsaved draft).
  let selected = $state(null);
  let form = $state({ name: '', text: '' });
  let busy = $state(false);
  let notice = $state('');

  const prompts = $derived(settings.promptLibrary || []);

  function edit(i) {
    selected = i;
    form = i === 'new' ? { name: '', text: '' } : { ...prompts[i] };
    notice = '';
  }

  async function persist(list, done) {
    busy = true;
    notice = '';
    const r = await updateSettings({ promptLibrary: list });
    busy = false;
    if (!r.ok) { notice = r.data?.error || 'HTTP ' + r.status; return; }
    done?.();
  }

  const save = () => {
    const list = selected === 'new' ? [...prompts, form] : prompts.map((p, i) => (i === selected ? form : p));
    persist(list, () => { if (selected === 'new') selected = list.length - 1; notice = 'Saved.'; });
  };
  const remove = () =>
    confirm(`Delete "${prompts[selected].name}"?`) && persist(prompts.filter((_, i) => i !== selected), () => (selected = null));
</script>

<div class="pr">
  <aside class="pr-list">
    <header class="pr-head">
      <h1>Prompts <span class="count">{prompts.length}</span></h1>
      <button class="btn primary" onclick={() => edit('new')}><Icon name="plus" size={14} /> New prompt</button>
    </header>

    {#if !prompts.length}
      <p class="empty">No prompt yet. Saved prompts show up on the New session page, ready to drop into the draft.</p>
    {:else}
      <ul>
        {#each prompts as p, i (i)}
          <li>
            <button class="item" class:on={selected === i} onclick={() => edit(i)}>
              <span class="name">{p.name}</span>
              <span class="meta">{p.text.split('\n')[0]}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <section class="pr-detail">
    {#if selected === null}
      <p class="empty">Pick a prompt, or create one.</p>
    {:else}
      <div class="form">
        <header class="d-head">
          <h2>{selected === 'new' ? 'New prompt' : prompts[selected]?.name}</h2>
          {#if selected !== 'new'}
            <button class="btn danger" disabled={busy} onclick={remove}>Delete</button>
          {/if}
        </header>

        <label class="lf-label" for="pr-name">Name</label>
        <input id="pr-name" class="lf-input" placeholder="Shown on the New session page" bind:value={form.name} />

        <label class="lf-label" for="pr-text">Prompt</label>
        <textarea id="pr-text" class="lf-input" rows="14" placeholder="Text appended to the draft when you pick this prompt" bind:value={form.text}></textarea>

        <div class="save">
          <button class="btn primary" disabled={busy || !form.name.trim() || !form.text.trim()} onclick={save}>{selected === 'new' ? 'Create prompt' : 'Save'}</button>
          {#if notice}<span class="notice">{notice}</span>{/if}
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  .pr { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(280px, 380px) 1fr; }
  .pr-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg2); }
  .pr-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 18px 16px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: var(--t-head); line-height: var(--lh-head); letter-spacing: -.01em; }
  .count { color: var(--muted); font-size: var(--t-body); font-weight: 600; }

  ul { list-style: none; margin: 0; padding: 6px; }
  .item { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: none; border-radius: 8px; background: none; color: var(--text); text-align: left; cursor: pointer; }
  .item:hover { background: rgba(var(--ink-rgb), .05); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .name, .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { font-weight: 600; font-size: var(--t-body); }
  .meta { color: var(--muted); font-size: var(--t-ui); }

  .pr-detail { min-height: 0; overflow-y: auto; padding: 24px 32px 80px; }
  .form { max-width: 760px; }
  .d-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: var(--t-title); overflow-wrap: anywhere; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .btn:hover:not(:disabled) { border-color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
  .save { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
  .notice { color: var(--muted); font-size: var(--t-ui); }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }

  @media (max-width: 760px) {
    .pr { grid-template-columns: 1fr; grid-template-rows: minmax(0, 40%) 1fr; }
    .pr-list { border-right: none; border-bottom: 1px solid var(--border); }
    .pr-detail { padding: 18px 16px 60px; }
  }
</style>
