<script>
  // Settings → Providers: enable / disable every provider, customise it (label, badge, colour,
  // command, args, env, model filters, defaults, capabilities…) or declare a new one on an engine
  // — cf. server/providerConfig.js and docs/providers.md. Entries are edited as JSON: every field
  // the server accepts is reachable, and the server sanitises what it stores.
  import { settings, updateSettings, data, loadProviders, loadSessions } from '#lib/state.svelte.js';
  import { getProviders, reloadProviderEngines } from '#lib/api.js';
  import Icon from './Icon.svelte';

  let info = $state(null); // { providers, enabled, engines, external }
  let busy = $state(false);
  let notice = $state('');
  async function refresh() {
    try { info = await getProviders(); } catch (_) { info = null; }
  }
  $effect(() => { refresh(); });

  const entries = $derived(settings.providers || {});
  const list = $derived(info?.providers || data.providerList || []);
  const entryOf = (id) => {
    const e = entries[id];
    return typeof e === 'string' ? { enabled: e } : { ...(e || {}) };
  };

  async function saveProviders(next) {
    busy = true;
    notice = '';
    const res = await updateSettings({ providers: next });
    if (!res.ok) notice = (res.data && res.data.error) || 'save failed';
    await Promise.all([refresh(), loadProviders()]);
    loadSessions();
    busy = false;
    return res.ok;
  }

  function setMode(p, mode) {
    const e = entryOf(p.id);
    const extra = Object.keys(e).filter((k) => k !== 'enabled');
    // A built-in left with nothing but its mode keeps the historical string shape.
    const value = p.builtin && !extra.length ? mode : { ...e, enabled: mode };
    saveProviders({ ...entries, [p.id]: value });
  }

  function remove(p) {
    if (p.builtin) return;
    const next = { ...entries };
    delete next[p.id];
    saveProviders(next);
  }

  // JSON editor of one entry (existing or new).
  let editing = $state(null); // { id, isNew, text, error }
  function edit(p) {
    editing = { id: p.id, isNew: false, text: JSON.stringify(entryOf(p.id), null, 2), error: '' };
  }
  function startNew(tpl = null) {
    const entry = tpl ? tpl.entry : { engine: 'acp', label: '', command: '', args: [] };
    editing = { id: tpl ? tpl.id : '', isNew: true, text: JSON.stringify(entry, null, 2), error: '' };
  }
  async function saveEdit() {
    let obj;
    try { obj = JSON.parse(editing.text); } catch (e) { editing.error = 'Invalid JSON: ' + e.message; return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { editing.error = 'An entry is a JSON object'; return; }
    const id = editing.id.trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) { editing.error = 'id: lowercase letters, digits and dashes, starting with a letter'; return; }
    if (editing.isNew && entries[id] !== undefined) { editing.error = `a provider "${id}" already exists`; return; }
    const ok = await saveProviders({ ...entries, [id]: obj });
    if (!ok) { editing.error = notice; return; }
    if (settings.providers?.[id] === undefined) { editing.error = 'Rejected: a custom provider needs an `engine` (pi, acp, or an external engine id).'; return; }
    editing = null;
  }

  async function reload() {
    busy = true;
    const r = await reloadProviderEngines().catch(() => null);
    if (r && r.data && r.data.providers) info = r.data;
    await loadProviders();
    busy = false;
  }

  // Starting points. Commands of third-party agents change with their versions: check yours.
  const TEMPLATES = [
    { id: 'mistral', name: 'Mistral (through pi)', entry: { engine: 'pi', label: 'Mistral', short: 'mi', color: '#fa520f', models: ['mistral/*'], description: 'Mistral models through pi (pi-mistral-subscription sign-in).' } },
    { id: 'claude-bridge', name: 'Claude through pi-claude-bridge', entry: { engine: 'pi', label: 'Claude (pi)', short: 'cb', models: ['claude-bridge/*'], args: ['-e', 'npm:pi-claude-bridge@0.13.0'], capabilities: { account: true }, description: 'Claude Code as a pi model provider, on your Claude subscription (pi-claude-bridge, loaded for this provider only).' } },
    { id: 'gemini', name: 'Gemini CLI (ACP)', entry: { engine: 'acp', label: 'Gemini', short: 'gm', color: '#4285f4', command: 'gemini', args: ['--experimental-acp'] } },
    { id: 'codex', name: 'Codex (ACP adapter)', entry: { engine: 'acp', label: 'Codex', short: 'cx', command: 'npx', args: ['-y', '@zed-industries/codex-acp'] } },
    { id: 'opencode', name: 'OpenCode (ACP)', entry: { engine: 'acp', label: 'OpenCode', short: 'oc', command: 'opencode', args: ['acp'] } },
    { id: 'goose', name: 'Goose (ACP)', entry: { engine: 'acp', label: 'Goose', short: 'gs', command: 'goose', args: ['acp'] } },
    { id: 'vibe', name: 'Mistral Vibe (ACP)', entry: { engine: 'acp', label: 'Mistral Vibe', short: 'vb', color: '#fa520f', command: 'vibe-acp' } },
  ];
  let tplPick = $state('');
</script>

<div class="pv-default">
  <label class="pv-lbl" for="pv-default">Default provider</label>
  <select id="pv-default" class="lf-input" value={settings.defaultProvider || 'claude'}
          onchange={(e) => updateSettings({ defaultProvider: e.currentTarget.value })}>
    {#each list as p (p.id)}<option value={p.id}>{p.label}{p.enabled ? '' : p.mode === 'off' ? ' (hidden)' : ' (unavailable)'}</option>{/each}
  </select>
  <span class="pv-hint">Used by launches that name no provider (macOS shortcut, PR review, MCP <code>start_session</code>).</span>
</div>

<div class="pv-list">
  {#each list as p (p.id)}
    <div class="pv-row" class:off={!p.enabled}>
      <span class="pv-badge" class:colored={!!p.color} style={p.color ? `--prov:${p.color}` : ''}>{p.short}</span>
      <span class="pv-main">
        <span class="pv-name">{p.label} <code>{p.id}</code></span>
        <span class="pv-meta">
          engine <b>{p.engine}</b>{#if p.engineMissing} — <span class="pv-err">not installed</span>{/if}
          · {p.mode === 'off' ? 'hidden' : p.enabled ? 'shown' : 'unavailable'}{p.mode === 'auto' ? (p.detected ? ' (detected)' : ' (not detected)') : p.mode === 'on' ? ' (forced)' : ''}
          {#if p.models}· models {p.models.join(', ')}{/if}
        </span>
      </span>
      <select class="lf-input pv-mode" value={p.mode} disabled={busy} onchange={(e) => setMode(p, e.currentTarget.value)}
              title="Auto = shown when the agent is found on this machine · On = always shown · Hidden = out of the launch pickers; its sessions stay listed and resume">
        <option value="auto">Auto</option>
        <option value="on">On</option>
        <option value="off">Hidden</option>
      </select>
      <button class="pv-btn" disabled={busy} onclick={() => edit(p)} title="Edit this provider's settings (JSON)"><Icon name="pencil" size={13} /></button>
      {#if !p.builtin}
        <button class="pv-btn danger" disabled={busy} onclick={() => remove(p)} title="Remove this provider (its sessions stay on disk)"><Icon name="trash" size={13} /></button>
      {/if}
    </div>
  {/each}
</div>

{#if editing}
  <div class="pv-editor">
    <div class="pv-ed-head">
      {#if editing.isNew}
        <label class="pv-lbl" for="pv-id">id</label>
        <input id="pv-id" class="lf-input pv-id" bind:value={editing.id} placeholder="e.g. gemini" spellcheck="false" />
      {:else}
        <b>{editing.id}</b>
      {/if}
    </div>
    <textarea class="lf-input pv-json" rows="12" bind:value={editing.text} spellcheck="false"></textarea>
    <p class="pv-hint">
      Fields: <code>enabled</code> (auto|on|off), <code>engine</code> (custom only), <code>label</code>, <code>short</code>
      (badge, ≤ 4 chars), <code>color</code> (#hex), <code>description</code>, <code>command</code>, <code>args</code>,
      <code>env</code> ({'{'}"VAR": "value"{'}'}, "" removes a variable), <code>models</code> (glob patterns, e.g.
      <code>mistral/*</code>), <code>hiddenModels</code>, <code>defaultModel</code>, <code>defaultEffort</code>,
      <code>titleModel</code> (pi; "" = no auto-naming), <code>modelProvider</code> (pi), <code>agentDir</code> (pi profile),
      <code>hookedPackage</code> (pi; false = no cards, tools auto-approved),
      <code>modes</code> (ACP: hooked mode → agent mode id), <code>injectHookedMcp</code> (ACP),
      <code>capabilities</code> ({'{'}"plan": false{'}'}…), <code>options</code> (free-form, external engines).
    </p>
    {#if editing.error}<div class="pv-err">{editing.error}</div>{/if}
    <div class="pv-actions">
      <button class="pv-save" disabled={busy} onclick={saveEdit}><Icon name="check" size={13} /> Save</button>
      <button class="pv-btn" onclick={() => (editing = null)}>Cancel</button>
    </div>
  </div>
{:else}
  <div class="pv-add">
    <button class="pv-save" onclick={() => startNew()}><Icon name="plus" size={13} /> Add a provider</button>
    <select class="lf-input" bind:value={tplPick}
            onchange={() => { const t = TEMPLATES.find((x) => x.id === tplPick); if (t) startNew(t); tplPick = ''; }}>
      <option value="">From a template…</option>
      {#each TEMPLATES as t (t.id)}<option value={t.id} disabled={entries[t.id] !== undefined}>{t.name}</option>{/each}
    </select>
  </div>
{/if}
{#if notice}<div class="pv-err">{notice}</div>{/if}

<div class="pv-ext">
  <div class="pv-lbl">External engines</div>
  <p class="pv-hint">
    JS modules in <code>{info?.external?.dir || '~/.claude/hooked/providers'}</code> (one file, or a folder with an
    <code>index.js</code>), each exporting an engine — see <code>docs/providers.md</code>. Engines:
    {#each info?.engines || [] as e, i (e.id)}{i ? ', ' : ''}<b>{e.id}</b>{e.builtin ? '' : ' (external)'}{/each}.
  </p>
  {#each info?.external?.errors || [] as err (err.file)}
    <div class="pv-err"><code>{err.file}</code>: {err.error}</div>
  {/each}
  <button class="pv-btn wide" disabled={busy} onclick={reload}><Icon name="refresh" size={13} /> Reload engine modules</button>
</div>

<style>
  .pv-default { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
  .pv-default select { max-width: 240px; }
  .pv-lbl { font-size: var(--t-meta, 12px); color: var(--muted); font-weight: 600; }
  .pv-hint { font-size: var(--t-meta, 12px); color: var(--muted); margin: 6px 0; line-height: 1.45; }
  .pv-list { display: flex; flex-direction: column; gap: 6px; }
  .pv-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2, transparent); }
  .pv-row.off { opacity: .65; }
  .pv-badge { font-family: var(--mono); font-size: 10px; line-height: 1; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 3px 4px; min-width: 22px; text-align: center; }
  .pv-badge.colored { color: var(--prov); border-color: var(--prov); }
  .pv-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .pv-name { font-weight: 600; }
  .pv-name code { font-weight: 400; color: var(--muted); margin-left: 4px; }
  .pv-meta { font-size: var(--t-meta, 12px); color: var(--muted); line-height: 1.4; overflow-wrap: anywhere; }
  .pv-mode { width: auto; flex: 0 0 auto; }
  .pv-btn { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; color: var(--fg, inherit); cursor: pointer; }
  .pv-btn.wide { margin-top: 6px; padding: 5px 10px; }
  .pv-btn.danger:hover { color: var(--danger, #d33); border-color: var(--danger, #d33); }
  .pv-save { display: inline-flex; align-items: center; gap: 4px; background: var(--accent); color: var(--accent-fg, #fff); border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  .pv-save:disabled, .pv-btn:disabled { opacity: .5; cursor: default; }
  .pv-editor { margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
  .pv-ed-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .pv-id { max-width: 200px; }
  .pv-json { width: 100%; font-family: var(--mono); font-size: 12px; min-height: 180px; }
  .pv-actions, .pv-add { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .pv-add select { max-width: 260px; }
  .pv-err { color: var(--danger, #d33); font-size: var(--t-meta, 12px); margin-top: 6px; }
  .pv-ext { margin-top: 14px; }
</style>
