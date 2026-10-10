<script>
  import { data, closeModal, sessionTitle, sessionTags, setSessionTags, allTags } from '$lib/state.svelte.js';
  import { tagColor } from '$lib/format.js';

  let { r } = $props(); // { sessionId }
  const session = $derived(data.sessions.find((s) => s.id === r.sessionId) || { id: r.sessionId, title: '(session)' });

  let newTag = $state('');

  // liste de tous les tags connus (en usage) UNION ceux de la session — triée.
  const known = $derived.by(() => {
    const set = new Set([...allTags(), ...sessionTags(r.sessionId)]);
    return [...set].sort((a, b) => a.localeCompare(b));
  });
  const applied = $derived(new Set(sessionTags(r.sessionId)));

  // normalise : minuscule, « # » de tête retiré, rogné.
  function norm(t) { return (t || '').trim().replace(/^#+/, '').trim().toLowerCase(); }

  function addTag() {
    const t = norm(newTag);
    newTag = '';
    if (!t) return;
    const cur = sessionTags(r.sessionId);
    if (!cur.includes(t)) setSessionTags(r.sessionId, [...cur, t]);
  }
  function toggle(t) {
    const cur = sessionTags(r.sessionId);
    setSessionTags(r.sessionId, cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  }
</script>

<div class="et">
  <div class="et-head">
    <div class="et-title">Edit tags</div>
    <div class="et-sess">{sessionTitle(session)}</div>
  </div>

  <label class="et-label" for="et-add">Add a tag</label>
  <div class="et-add">
    <input id="et-add" type="text" placeholder="Type a tag name…" bind:value={newTag}
           onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
    <button class="et-addbtn" onclick={addTag}>Add</button>
  </div>

  <div class="et-label">Tags</div>
  <div class="et-list">
    {#if !known.length}
      <div class="et-empty">No tags yet — add one above.</div>
    {:else}
      {#each known as t (t)}
        {@const on = applied.has(t)}
        <button class="et-row" class:on onclick={() => toggle(t)}>
          <span class="et-sw" style="background:{tagColor(t)}"></span>
          <span class="et-name">{t}</span>
          {#if on}
            <svg class="et-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          {/if}
        </button>
      {/each}
    {/if}
  </div>

  <div class="et-foot">
    <button class="et-done" onclick={closeModal}>Done</button>
  </div>
</div>

<style>
  .et-head { margin-bottom: 16px; padding-right: 24px; }
  .et-title { font-size: var(--t-title); line-height: var(--lh-title); font-weight: 800; }
  .et-sess { font-size: var(--t-ui); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .et-label { display: block; font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 14px 0 7px; }
  .et-add { display: flex; gap: 8px; }
  .et-add input {
    flex: 1; background: var(--input); border: 1px solid var(--border); border-radius: 9px;
    padding: 9px 12px; font: inherit; font-size: var(--t-ui); color: var(--text);
  }
  .et-add input::placeholder { color: var(--muted); }
  .et-add input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .et-addbtn {
    background: var(--accent); color: var(--accent-fg); border: none; border-radius: 9px;
    padding: 0 16px; font: inherit; font-size: var(--t-ui); font-weight: 700; cursor: pointer;
  }
  .et-addbtn:hover { background: var(--accent-d); }
  .et-list { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .et-empty { color: var(--muted); font-size: var(--t-ui); padding: 10px 2px; }
  .et-row {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
    padding: 9px 11px; cursor: pointer; font: inherit; color: var(--text); transition: background .12s, border-color .12s;
  }
  .et-row:hover { border-color: var(--border2); }
  .et-row.on { background: var(--accent-soft); border-color: var(--accent); }
  .et-sw { width: 11px; height: 11px; border-radius: 4px; flex: 0 0 auto; }
  .et-name { flex: 1; font-size: var(--t-ui); }
  .et-check { color: var(--accent); flex: 0 0 auto; }
  .et-foot { display: flex; justify-content: flex-end; margin-top: 18px; }
  .et-done {
    background: var(--chip); color: var(--text); border: 1px solid var(--border); border-radius: 9px;
    padding: 8px 18px; font: inherit; font-size: var(--t-ui); font-weight: 600; cursor: pointer;
  }
  .et-done:hover { background: var(--hover); }
</style>
