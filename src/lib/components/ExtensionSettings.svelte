<script>
  // Settings → Extensions: one row per extension, with its switch, its errors and its declarative
  // settings (contributes.settings) rendered from the schema, then the folders that did not load.
  // No extension code runs here.
  import { extensions, setExtensionEnabled, extensionSettings, extensionSettingsIfLoaded, saveExtensionSettings } from '#lib/extensions.svelte.js';
  import Icon from './Icon.svelte';

  let errors = $state({});

  $effect(() => {
    for (const e of extensions.list) if (e.settings.length) extensionSettings(e.id);
  });

  async function save(id, key, value) {
    const r = await saveExtensionSettings(id, { [key]: value });
    errors[id] = r.ok ? {} : r.data?.errors || { _: r.data?.error || 'HTTP ' + r.status };
  }
</script>

{#each extensions.list as e (e.id)}
  {@const values = extensionSettingsIfLoaded(e.id)}
  <div class="ext">
    <label class="check">
      <input type="checkbox" checked={e.enabled} onchange={(ev) => setExtensionEnabled(e.id, ev.currentTarget.checked)} />
      <span><Icon name={e.icon} size={14} /> <strong>{e.label}</strong> · {e.description}
        <em class="src">{e.origin ? `${e.origin.repo}@${(e.origin.commit || e.origin.ref || '').slice(0, 7)}` : e.source}{e.version ? ' · ' + e.version : ''}</em>
        {#if e.available === false}<em class="unavail">Not available on this machine.</em>{/if}</span>
    </label>
    {#each e.errors as err (err)}<p class="err">{err}</p>{/each}
    {#if e.enabled && e.settings.length}
      <div class="fields">
        {#each e.settings as s (s.key)}
          <label class="fld">
            <span>{s.label}</span>
            {#if s.type === 'bool'}
              <input type="checkbox" checked={values[s.key] ?? s.default} onchange={(ev) => save(e.id, s.key, ev.currentTarget.checked)} />
            {:else if s.type === 'number'}
              <input type="number" min={s.min} max={s.max} value={values[s.key] ?? s.default} onchange={(ev) => save(e.id, s.key, Number(ev.currentTarget.value))} />
            {:else if s.type === 'select'}
              <select value={values[s.key] ?? s.default} onchange={(ev) => save(e.id, s.key, ev.currentTarget.value)}>
                {#each s.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
              </select>
            {:else if s.type === 'list'}
              <input value={(values[s.key] ?? s.default ?? []).join(', ')} placeholder={s.placeholder || ''}
                     onchange={(ev) => save(e.id, s.key, ev.currentTarget.value.split(',').map((x) => x.trim()).filter(Boolean))} />
            {:else}
              <input value={values[s.key] ?? s.default ?? ''} placeholder={s.placeholder || ''} onchange={(ev) => save(e.id, s.key, ev.currentTarget.value)} />
            {/if}
            {#if errors[e.id]?.[s.key]}<em class="err">{errors[e.id][s.key]}</em>{:else if s.hint}<em class="hint">{s.hint}</em>{/if}
          </label>
        {/each}
      </div>
    {/if}
  </div>
{/each}
{#each extensions.rejected as r (r.dir)}
  <p class="err off">{r.id} ({r.source}) not loaded: {r.error}</p>
{/each}
{#each extensions.pending as p (p.dir)}
  <p class="pending">{p.id}: {p.state}</p>
{/each}

<style>
  .ext { display: flex; flex-direction: column; gap: 4px; }
  .src { margin-left: 6px; color: var(--muted); font-size: var(--t-micro); }
  .fields { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 8px 26px; }
  .fld { display: flex; align-items: center; gap: 10px; font-size: var(--t-ui); color: var(--muted); }
  .fld > span { min-width: 140px; }
  .fld input:not([type='checkbox']), .fld select { flex: 1; min-width: 0; }
  .err { margin: 0 0 0 26px; color: var(--danger); font-size: var(--t-ui); }
  .fld .err { margin: 0; }
  .hint { color: var(--muted); }
  .unavail { margin-left: 6px; color: var(--warn); }
  .off, .pending { margin: 0; }
  .pending { color: var(--muted); font-size: var(--t-ui); }
</style>
