<script>
  // Media card for hooked's show_image / show_video MCP tools: the picture or recording Claude made
  // of its work, an optional before/after pair, what changed and the checks it ran. Files are
  // served by /api/user-file (transcript allowlist), like SendUserFile.
  import Lightbox from './Lightbox.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { userFileUrl } from '$lib/api.js';
  let { show, result = '', session = null, agent = null } = $props();

  const isVideo = $derived(show.kind === 'video');
  const src = $derived(userFileUrl(session, agent, show.path));
  const before = $derived(show.compare ? userFileUrl(session, agent, show.compare) : '');
  let zoom = $state(null);
  let failed = $state(false);

  // The "after" video drives the "before" one, so both show the same step at the same time.
  let main = $state(null);
  let other = $state(null);
  let now = $state(0);
  function sync(e) {
    if (!other) return;
    if (e.type === 'play') other.play().catch(() => {});
    else if (e.type === 'pause') other.pause();
    if (Math.abs(other.currentTime - main.currentTime) > 0.3) other.currentTime = main.currentTime;
  }
  function seek(at) {
    if (!main || at == null) return;
    main.currentTime = at;
    if (other) other.currentTime = at;
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // A timed check stays pending until the recording reaches it, like in the plugin this mirrors.
  const reached = (c) => !isVideo || c.at == null || now >= c.at;
</script>

<div class="show">
  <div class="show-head">
    <Icon name="image" size={13} />
    <span class="show-title">{show.title || show.name}</span>
    {#if show.url}<a class="show-link" href={show.url} target="_blank" rel="noopener">Open page <Icon name="external" size={12} /></a>{/if}
  </div>

  {#if failed}
    <div class="show-err">{result || `${show.name} can't be displayed (missing file or unsupported format).`}</div>
  {:else}
    <div class="show-media" class:pair={!!before}>
      {#if before}
        <figure>
          <figcaption>Before</figcaption>
          {#if isVideo}
            <video bind:this={other} src={before} muted playsinline preload="metadata"></video>
          {:else}
            <button class="show-img" onclick={() => (zoom = before)}><img src={before} alt="before" loading="lazy" /></button>
          {/if}
        </figure>
      {/if}
      <figure>
        {#if before}<figcaption>After</figcaption>{/if}
        {#if isVideo}
          <video bind:this={main} {src} controls muted playsinline preload="metadata"
                 onplay={sync} onpause={sync} onseeked={sync}
                 ontimeupdate={(e) => (now = e.currentTarget.currentTime)}
                 onerror={() => (failed = true)}></video>
        {:else}
          <button class="show-img" onclick={() => (zoom = src)}><img {src} alt={show.name} loading="lazy" onerror={() => (failed = true)} /></button>
        {/if}
      </figure>
    </div>
  {/if}

  {#if show.changes.length || show.checks.length || show.summary.length}
    <div class="show-lists">
      {#if show.changes.length}
        <ul class="show-list">
          <li class="show-h">What changed</li>
          {#each show.changes as c}
            <li>
              {#if isVideo && c.at != null}<button class="show-at" onclick={() => seek(c.at)}>{fmt(c.at)}</button>{/if}
              <span>{c.title}{#if c.detail}<span class="show-d">{' · '}{c.detail}</span>{/if}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if show.checks.length || show.summary.length}
        <ul class="show-list">
          <li class="show-h">Checks</li>
          {#each show.summary as s}
            <li class={s.ok ? 'ok' : 'ko'}><Icon name={s.ok ? 'check' : 'close'} size={12} tint={false} /> {s.label}{#if s.total != null}<span class="show-d">{' · '}{s.passed ?? 0}/{s.total}</span>{/if}</li>
          {/each}
          {#each show.checks as c}
            <li class={reached(c) ? (c.ok ? 'ok' : 'ko') : 'pending'}>
              {#if reached(c)}<Icon name={c.ok ? 'check' : 'close'} size={12} tint={false} />{:else}<span class="dot"></span>{/if}
              {#if isVideo && c.at != null}<button class="show-at" onclick={() => seek(c.at)}>{fmt(c.at)}</button>{/if}
              {c.name}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
<Lightbox src={zoom} onclose={() => (zoom = null)} />

<style>
  .show { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); }
  .show-head { display: flex; align-items: center; gap: 6px; font-size: var(--t-ui); color: var(--muted); }
  .show-title { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .show-link { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; }
  .show-media { display: grid; gap: 8px; }
  .show-media.pair { grid-template-columns: 1fr 1fr; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  figcaption { font-size: var(--t-micro); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  video, .show-img img { display: block; width: 100%; max-height: 480px; object-fit: contain; border-radius: 6px; background: #000; }
  .show-img { padding: 0; border: 0; background: none; cursor: zoom-in; line-height: 0; }
  .show-err { font-size: var(--t-ui); color: var(--danger); }
  .show-lists { display: flex; flex-wrap: wrap; gap: 16px; }
  .show-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: var(--t-ui); flex: 1 1 220px; }
  .show-list li { display: flex; align-items: baseline; gap: 6px; }
  .show-h { font-size: var(--t-micro); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .show-d { color: var(--muted); }
  .show-at { font-family: var(--mono); font-size: var(--t-micro); color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
  .ok { color: var(--success-ink, var(--success)); }
  .ko { color: var(--danger); }
  .pending { color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid currentColor; display: inline-block; }
</style>
