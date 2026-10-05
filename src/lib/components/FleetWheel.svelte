<script>
  // The fleet wheel (signature of the coffee world): every non-archived session is a segment of the
  // outer ring, laid inside its state family's arc on the inner ring, like a cup on the coffee
  // taster's flavour wheel. Segments that need you are pulled out of the ring; hovering one names
  // the session in the centre; a state change sweeps the segment to its new family.
  import { goto } from '$app/navigation';
  import { sessionTitle } from '$lib/state.svelte.js';
  import { STATE_LABEL } from '$lib/format.js';
  import { wheelModel } from '$lib/fleetWheel.js';

  let {
    sessions = [],
    quiet = () => false,
    decisions = 0,
    filter = $bindable(null),
    mini = false,
    size = mini ? 26 : 172,
  } = $props();

  const model = $derived(wheelModel(sessions, quiet));
  const byId = $derived(new Map(sessions.map((s) => [s.id, s])));
  const HUE = { attention: 'var(--attention)', waiting: 'var(--waiting)', working: 'var(--working)', bgjob: 'var(--background)', idle: 'var(--idle)', ended: 'var(--ended)' };

  // pathLength = 1000: dash lengths are fractions of the circle, whatever the radius.
  const gap = $derived(model.total > 1 ? Math.min(7, 250 / model.total) : 0);
  const dash = (a, b) => `${Math.max(0.5, (b - a) * 1000 - gap)} 1000`;
  const off = (a) => -(a * 1000 + gap / 2);

  let hover = $state(null);
  const hovered = $derived(hover ? byId.get(hover) : null);
  const summary = $derived(model.families.filter((f) => f.count).map((f) => `${f.count} ${f.label.toLowerCase()}`).join(', '));
</script>

{#if mini}
  <svg class="fw-mini" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="22" class="fw-mini-core" />
    {#if model.total}
      {#each model.families.filter((f) => f.count) as f (f.key)}
        <circle class="fw-arc" cx="32" cy="32" r="27" pathLength="1000" transform="rotate(-90 32 32)"
                stroke={HUE[f.key]} stroke-width="7" stroke-dasharray={dash(f.start, f.end)} stroke-dashoffset={off(f.start)} />
      {/each}
    {:else}
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--shell-line)" stroke-width="7" />
    {/if}
    <g class="fw-hook" fill="none" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M32 15v18" /><path d="M32 33a8.5 8.5 0 1 1-8.5 8.5" /><path d="M26.5 15h11" />
    </g>
  </svg>
{:else}
  <div class="fw">
    <div class="fw-dial" style="--size:{size}px">
      <svg viewBox="0 0 200 200" role="img" aria-label={model.total ? `Fleet: ${summary}` : 'Fleet: no sessions'}>
        <!-- inner ring: one arc per family -->
        {#each model.families.filter((f) => f.count) as f (f.key)}
          <circle class="fw-arc fw-fam" cx="100" cy="100" r="60" pathLength="1000" transform="rotate(-90 100 100)"
                  stroke={HUE[f.key]} stroke-dasharray={dash(f.start, f.end)} stroke-dashoffset={off(f.start)}
                  class:dim={filter && filter !== f.key} />
        {/each}
        {#if !model.total}<circle cx="100" cy="100" r="80" class="fw-empty" />{/if}
        <!-- outer ring: one segment per session, needs-you pulled out -->
        {#each model.segments as g (g.id)}
          <a href={'/session/' + encodeURIComponent(g.id)} tabindex="-1" aria-hidden="true"
             onclick={(e) => { e.preventDefault(); goto('/session/' + encodeURIComponent(g.id)); }}
             onpointerenter={() => (hover = g.id)} onpointerleave={() => (hover === g.id) && (hover = null)}>
            <circle class="fw-arc fw-seg" cx="100" cy="100" r={g.needsYou && !g.quiet ? 85 : 79} pathLength="1000"
                    transform="rotate(-90 100 100)" stroke={HUE[g.family]}
                    stroke-dasharray={dash(g.start, g.end)} stroke-dashoffset={off(g.start)}
                    class:quiet={g.quiet} class:hot={hover === g.id} class:dim={filter && filter !== g.family} />
          </a>
        {/each}
      </svg>
      <div class="fw-centre" aria-live="polite">
        {#if hovered}
          <span class="fw-c-title">{sessionTitle(hovered)}</span>
          <span class="fw-c-state">{STATE_LABEL[hovered.state] || hovered.state}</span>
        {:else}
          <span class="fw-c-n">{decisions}</span>
          <span class="fw-c-l">{decisions === 1 ? 'decision' : 'decisions'}</span>
        {/if}
      </div>
    </div>
    <ul class="fw-legend" aria-label="Filter the fleet by state">
      {#each model.families as f (f.key)}
        <li>
          <button class="fw-key" class:on={filter === f.key} class:zero={!f.count} aria-pressed={filter === f.key}
                  onclick={() => (filter = filter === f.key ? null : f.key)}>
            <span class="state-dot d-{f.key}"></span>
            <span class="fw-k-l">{f.label}</span>
            <span class="fw-k-n">{f.count}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .fw { display: flex; align-items: center; gap: 22px; }
  .fw-dial { position: relative; width: var(--size); height: var(--size); flex: 0 0 auto; }
  .fw-dial svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .fw-arc {
    fill: none;
    /* The one authored motion of the world: a session changing state sweeps to its new family. */
    transition: stroke-dasharray .7s cubic-bezier(.16, 1, .3, 1), stroke-dashoffset .7s cubic-bezier(.16, 1, .3, 1),
      r .45s cubic-bezier(.16, 1, .3, 1), stroke-width .2s ease-out, opacity .2s ease-out;
  }
  .fw-fam { stroke-width: 9; opacity: .55; }
  .fw-seg { stroke-width: 14; cursor: pointer; }
  .fw-seg.hot { stroke-width: 19; }
  .fw-seg.quiet { opacity: .4; }
  .dim { opacity: .14; }
  .fw-empty { fill: none; stroke: var(--border); stroke-width: 14; stroke-dasharray: 4 6; }
  .fw-centre {
    position: absolute; inset: 27%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; pointer-events: none; gap: 2px; min-width: 0;
  }
  .fw-c-n {
    font-family: var(--font-display); font-size: 40px; line-height: 1; font-weight: 750; letter-spacing: -.03em;
    font-variant-numeric: tabular-nums; color: var(--text);
  }
  .fw-c-l, .fw-c-state { font-size: var(--t-micro); font-weight: 600; color: var(--muted); }
  .fw-c-title {
    font-size: var(--t-meta); font-weight: 700; line-height: 1.25; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }

  .fw-legend { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 10px; flex: 1 1 auto; min-width: 0; }
  .fw-key {
    display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 6px 8px;
    border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer;
    font: inherit; font-size: var(--t-ui); color: var(--text); text-align: left;
    transition: background .12s, border-color .12s;
  }
  .fw-key:hover { background: var(--hover); }
  .fw-key.on { background: var(--accent-soft); border-color: rgba(var(--accent-rgb), .2); }
  .fw-key.zero { color: var(--muted); }
  /* The legend names the states; only the decision column is allowed to pulse. */
  .fw-key .state-dot { width: 9px; height: 9px; animation: none; }
  .fw-k-l { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fw-k-n { font-variant-numeric: tabular-nums; font-weight: 700; }
  .fw-key.zero .fw-k-n { font-weight: 500; }

  .fw-mini { display: block; flex: 0 0 auto; }
  .fw-mini-core { fill: var(--shell-accent); }
  .fw-mini .fw-arc { transition: stroke-dasharray .7s cubic-bezier(.16, 1, .3, 1), stroke-dashoffset .7s cubic-bezier(.16, 1, .3, 1); }
  .fw-hook { stroke: var(--shell-accent-fg); }

  @media (max-width: 640px) {
    .fw { gap: 14px; }
    .fw-dial { width: 132px; height: 132px; }
    .fw-c-n { font-size: 32px; }
    .fw-legend { grid-template-columns: 1fr; }
    .fw-key { padding: 7px 8px; min-height: 36px; }
  }
</style>
