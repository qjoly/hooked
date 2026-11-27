<script>
  // Settings → Modules: one row per runtime-loaded extension, with its switch, its errors and its
  // declarative settings (contributes.settings) rendered from the schema. No extension code runs here.
  import { extensions, setExtensionEnabled, extensionSettings, saveExtensionSettings } from '#lib/extensions.svelte.js';
  import Icon from './Icon.svelte';

  let errors = $state({});

  async function save(id, key, value) {
    const r = await saveExtensionSettings(id, { [key]: value });
    errors[id] = r.ok ? {} : r.data?.errors || { _: r.data?.error || 'HTTP ' + r.status };
  }
</script>

{#each extensions.list as e (e.id)}
  {@const values = extensionSettings(e.id)}
  <div class="ext">
    <label class="check">
      <input type="checkbox" checked={e.enabled} onchange={(ev) => setExtensionEnabled(e.id, ev.currentTarget.checked)} />
      <span><Icon name={e.icon} size={14} /> <strong>{e.label}</strong> · {e.description}
        <em class="src">{e.source}{e.version ? ' · ' + e.version : ''}{e.origin?.commit ? ' · ' + e.origin.commit.slice(0, 7) : ''}</em>
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

<style>
  .ext { display: flex; flex-direction: column; gap: 4px; }
  .src { margin-left: 6px; color: var(--muted); font-size: var(--t-micro); }
  .fields { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 8px 26px; }
  .fld { display: flex; align-items: center; gap: 10px; font-size: var(--t-ui); color: var(--muted); }
  .fld > span { min-width: 140px; }
  .err { margin: 0 0 0 26px; color: var(--danger); font-size: var(--t-ui); }
  .fld .err { margin: 0; }
  .hint { color: var(--muted); }
</style>
