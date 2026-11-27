<script>
  import { untrack, onMount } from 'svelte';
  import { loadSessions, closeModal, settings, ui } from '#lib/state.svelte.js';
  import { getProfiles, moveSession } from '#lib/api.js';
  import Icon from '#lib/components/Icon.svelte';
  import ModelEffort from './ModelEffort.svelte';

  // r = { id, title, profile: id the session runs on ('default' = the main account), kind: its kind,
  //       busy: a turn is in progress }
  let { r } = $props();

  let profiles = $state([]);
  let loaded = $state(false);
  let target = $state('');
  let model = $state('');
  let effort = $state('high');
  let busy = $state(false);
  let error = $state('');

  onMount(async () => {
    try { profiles = (await getProfiles()).profiles || []; } catch (_) { profiles = []; }
    loaded = true;
  });

  // Where it can go: every profile but the one it is on. The main account is the implicit profile.
  const choices = $derived(profiles.filter((p) => p.id !== r.profile));
  const dest = $derived(choices.find((p) => p.id === target) || null);
  const toServer = $derived(dest?.kind === 'compatible');
  const fromServer = $derived(r.kind === 'compatible');
  // A model has to be picked when either side is a server: its ids mean nothing to the other side.
  // Between two accounts the session keeps its own, and nothing is asked.
  const needsModel = $derived(!!dest && (toServer || fromServer));
  const nameOf = (p) => (p.implicit ? 'Main account' : p.label);
  // What ModelEffort wants as `profile`: '' is the main account.
  const pickerProfile = $derived(!dest || dest.implicit ? '' : dest.id);

  // Pick the first destination once they are known, and a sensible starting model when the target
  // changes: empty on a server (ModelEffort fills in its first model), the usual default otherwise.
  $effect(() => {
    if (!loaded || target || !choices.length) return;
    untrack(() => { target = choices[0].id; });
  });
  $effect(() => {
    const t = dest;
    untrack(() => { model = !t || t.kind === 'compatible' ? '' : (settings.defaultModel || 'opus'); });
  });

  async function go() {
    if (busy || !dest) return;
    if (needsModel && !model) { error = toServer ? 'Pick one of the server\'s models.' : 'Pick a model.'; return; }
    busy = true;
    error = '';
    const res = await moveSession(r.id, dest.id, needsModel ? model : undefined, toServer ? undefined : effort)
      .catch((e) => ({ ok: false, data: { error: e.message } }));
    busy = false;
    if (!res.ok) { error = res.data?.error || 'failed'; return; }
    closeModal();
    setTimeout(() => { loadSessions(); ui.tick++; }, 800);
  }
</script>

<h2 style="margin:0 0 4px"><Icon name="link" size={18} /> Move to another account</h2>
<p class="intro">
  Stops <b>{r.title || 'this session'}</b> and resumes it from its conversation on another account or
  server. Its history, tags and group stay. {#if r.busy}<b>A turn is in progress and will be lost.</b>{:else}A turn in progress would be lost.{/if}
</p>

{#if !loaded}
  <p class="muted">Loading…</p>
{:else if !choices.length}
  <p class="muted">There is nowhere else to move it yet. Add an account or a server from the account menu (the avatar, top right).</p>
{:else}
  <label class="lf-label" for="move-target">Move to</label>
  <select id="move-target" class="lf-input" bind:value={target} disabled={busy}>
    {#each choices as p (p.id)}
      <option value={p.id}>{nameOf(p)}{p.kind === 'compatible' ? ' (server)' : ''}</option>
    {/each}
  </select>

  {#if needsModel}
    <ModelEffort profile={pickerProfile} bind:model bind:effort />
    <p class="hint">
      {#if toServer}The session's model only exists on its current side, so pick one of this server's.
      {:else}The session ran on a server: pick the Claude model it continues with.{/if}
    </p>
  {/if}

  {#if dest}
    <p class="hint">
      {#if toServer}It then runs on your own machine through <b>{nameOf(dest)}</b>: no cost, no prompt cache, no account limits.
      {:else}It then runs on the quota of <b>{nameOf(dest)}</b>, and its prompt cache starts over.{/if}
    </p>
  {/if}

  {#if error}<p class="err" role="alert"><Icon name="warning" size={13} /> {error}</p>{/if}
  <div class="lf-actions">
    <button class="reply-send" disabled={busy || !dest} onclick={go}>{busy ? 'Moving…' : 'Move'} <Icon name="external" size={14} /></button>
    <button class="link" onclick={closeModal}>Cancel</button>
  </div>
{/if}

<style>
  .intro { color: var(--muted); font-size: var(--t-ui); line-height: 1.5; margin: 0 0 14px; }
  .muted { color: var(--muted); font-size: var(--t-ui); }
  .hint { color: var(--muted); font-size: var(--t-meta); line-height: 1.5; margin: 8px 0 0; }
  .err { display: flex; gap: 6px; align-items: flex-start; color: var(--attention); font-size: var(--t-meta); margin: 10px 0 0; }
  .link { background: none; border: none; color: var(--muted); font-size: var(--t-ui); cursor: pointer; text-decoration: underline; padding: 0 0 0 12px; }
</style>
