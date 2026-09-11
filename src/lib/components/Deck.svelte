<script>
  // The Deck (redesign home): a decision queue you can clear WITHOUT opening sessions
  // (questions answered inline, plans approved inline) + the fleet grouped by repo.
  // Replaces the old empty-cockpit Overview and the /board kanban.
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, sessionTitle, sessionTags, loadSessions, toggleArchive, isArchived, isSessionArchived, snoozeSession, snoozeUntil } from '$lib/state.svelte.js';
  import { getSession, reply } from '$lib/api.js';
  import { ago, tagColor, STATE_LABEL } from '$lib/format.js';
  import Question from './Question.svelte';
  import Plan from './Plan.svelte';
  import Icon from '$lib/components/Icon.svelte';

  const S = $derived(data.sessions);

  // ── snooze ────────────────────────────────────────────────────────────────────────────────
  // Snooze deadlines live in the server-side session-meta store (shared across browsers),
  // mirrored reactively in ui.meta — see snoozeSession/snoozeUntil in state.svelte.js.
  function snoozeOne(id, hours = 1) { snoozeSession(id, hours); }
  function snoozeAll() {
    for (const s of triage) snoozeSession(s.id, 1);
  }
  // minute clock so snoozed cards come back without a reload
  let nowMin = $state(Date.now());
  $effect(() => { const iv = setInterval(() => (nowMin = Date.now()), 30_000); return () => clearInterval(iv); });
  const snoozed = (id) => snoozeUntil(id) > nowMin;

  // ── decision queue ───────────────────────────────────────────────────────────────────────
  const needsDecision = (s) => s.hasQuestion || s.hasPlan || s.state === 'attention' || s.state === 'waiting';
  const kindOf = (s) =>
    s.hasQuestion ? 'question' : s.hasPlan ? 'plan' : s.state === 'attention' ? 'permission' : 'waiting';
  const KIND_META = {
    question:   { label: 'Question',   cls: 'q' },
    plan:       { label: 'Plan',       cls: 'plan' },
    permission: { label: 'Permission', cls: 'perm' },
    waiting:    { label: 'Waiting',    cls: 'wait' },
  };
  const triage = $derived(
    S.filter((s) => needsDecision(s) && !snoozed(s.id) && !isSessionArchived(s))
     .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''))),
  );
  const snoozedCount = $derived(S.filter((s) => needsDecision(s) && snoozed(s.id) && !isSessionArchived(s)).length);
  function archiveOne(id) { toggleArchive(id); }

  // Quick action : envoyer le prompt de follow-up suggéré par le TUI sans ouvrir la session.
  let sendingFollowup = $state(null);
  let sentFollowup = $state(null);
  async function sendFollowup(s) {
    if (sendingFollowup || !s.followup) return;
    sendingFollowup = s.id;
    const res = await reply(s.id, s.followup).catch(() => ({ ok: false }));
    sendingFollowup = null;
    if (res.ok) {
      sentFollowup = s.id;
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
      setTimeout(() => { if (sentFollowup === s.id) sentFollowup = null; }, 2500);
    }
  }

  // Plans: the list payload only carries hasPlan — fetch the session detail lazily (one shot
  // per plan ts) to render the real plan markdown inline with the full <Plan> review UI.
  let planCache = $state({}); // sessionId → { ts, pp } | { loading: true }
  $effect(() => {
    const wanted = triage.filter((s) => kindOf(s) === 'plan');
    untrack(() => {
      for (const s of wanted) {
        const c = planCache[s.id];
        if (c && (c.loading || c.ts === s.lastActivity)) continue;
        planCache = { ...planCache, [s.id]: { loading: true, ts: s.lastActivity } };
        getSession(s.id)
          .then((d) => { planCache = { ...planCache, [s.id]: { ts: s.lastActivity, pp: d.pendingPlan || null } }; })
          .catch(() => { planCache = { ...planCache, [s.id]: { ts: s.lastActivity, pp: null } }; });
      }
    });
  });

  // Decision cards can carry a big payload (a long plan, a wall-of-text question). We cap the
  // body height on the Deck and, when it overflows, fade the bottom and offer "see more" which
  // opens the full session — the Deck stays a scannable queue instead of a few giant cards.
  let clamped = $state({}); // sessionId → true when the card body overflows the cap
  function measureClamp(node, id) {
    const check = () => {
      const over = node.scrollHeight > node.clientHeight + 4;
      if (!!clamped[id] !== over) clamped = { ...clamped, [id]: over };
    };
    const ro = new ResizeObserver(check);
    ro.observe(node);
    check();
    return { destroy() { ro.disconnect(); } };
  }

  // count of running sessions shown in the fleet column header (the day KPIs live in Stats).
  const active = $derived(S.filter((s) => ['working', 'background'].includes(s.state)).length);

  // ── fleet ────────────────────────────────────────────────────────────────────────────────
  let expandedGroups = $state({}); // fleet: repo groups expanded past their cap
  let archivedOpen = $state(false); // fleet: reveal the collapsed "Archived" section
  // shared search predicate for the fleet quick filter.
  function matchesQ(s) {
    const q = fq.toLowerCase().trim();
    if (!q) return true;
    const hay = `${s.repo} ${s.projectName} ${sessionTitle(s)} ${s.lastPrompt} ${s.gitBranch} ${sessionTags(s.id).join(' ')}`.toLowerCase();
    return hay.includes(q);
  }
  // fleet rows shown per group: every live session + up to 8 rows; the rest behind an expander.
  function visibleItems(g) {
    if (expandedGroups[g.proj]) return g.items;
    return g.items.slice(0, Math.max(8, g.items.filter(isLive).length));
  }
  let view = $state((typeof localStorage !== 'undefined' && localStorage.getItem('hooked.deckView')) || 'grid');
  $effect(() => { try { localStorage.setItem('hooked.deckView', view); } catch {} });
  let fq = $state(''); // fleet quick filter

  const projectKey = (s) => s.repo || s.projectName || '—';
  const isLive = (s) => ['working', 'background', 'waiting', 'attention'].includes(s.state);
  const dotClass = (s) =>
    s.hasQuestion || s.hasPlan || s.state === 'attention' ? 'attention'
    : s.state === 'working' ? 'working'
    : s.state === 'background' ? 'bgjob'
    : s.state === 'waiting' ? 'waiting'
    : s.state === 'ended' ? 'ended' : 'idle';
  // live activity only (no lastPrompt fallback) — the cards show the last exchange separately,
  // so the fallback would just duplicate the user message.
  function liveSnippet(s) {
    if (s.state === 'working' && s.activity) return { name: 'activity', text: s.activity + '…' };
    if (s.bgJobs && s.bgJobs.length) return { name: 'background', color: 'var(--background)', text: s.bgJobs.length + ' job' + (s.bgJobs.length > 1 ? 's' : '') + (s.bgJobs[0].label ? ' · ' + s.bgJobs[0].label : '') };
    if (s.todo && s.todo.current) return { name: 'in-progress', text: s.todo.current + ' (' + s.todo.done + '/' + s.todo.total + ')' };
    return null;
  }

  // Archived sessions are NEVER shown in the repo-grouped fleet; they live in their own collapsed
  // section at the bottom (below).
  const archivedList = $derived(S.filter((s) => isSessionArchived(s) && matchesQ(s))
    .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''))));

  const fleetGroups = $derived.by(() => {
    const list = S.filter((s) => !isSessionArchived(s) && matchesQ(s));
    const g = new Map();
    for (const s of list) {
      const k = projectKey(s);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(s);
    }
    const lastOf = (arr) => arr.reduce((m, s) => Math.max(m, Date.parse(s.lastActivity || 0) || 0), 0);
    return [...g.keys()]
      .sort((a, b) => lastOf(g.get(b)) - lastOf(g.get(a)))
      .map((proj) => {
        const items = g.get(proj).slice().sort((a, b) => {
          if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1;
          return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
        });
        return { proj, items, newProject: items[0]?.project || '' };
      });
  });
  const fleetTotal = $derived(fleetGroups.reduce((a, g) => a + g.items.length, 0));

  const open = (s) => goto('/session/' + encodeURIComponent(s.id));
  const openLens = (s, lens) => goto('/session/' + encodeURIComponent(s.id) + '?lens=' + lens);

  // 'deck' = triage + fleet (home) ; 'sessions' = the fleet browser only, full width.
  let { mode = 'deck' } = $props();
</script>

<div class="deck">
  <div class="deck-cols" class:sessions-only={mode === 'sessions'}>
    {#if mode === 'deck'}
    <!-- ── decision queue ── -->
    <section class="triage-col">
      <div class="colhead">
        <h2>Your move</h2>
        <span class="colcount">{triage.length} decision{triage.length === 1 ? '' : 's'}{#if snoozedCount} · {snoozedCount} snoozed{/if}</span>
        {#if triage.length}
          <button class="ghost-btn" onclick={snoozeAll}><Icon name="snooze" size={14} /> Snooze all 1h</button>
        {/if}
      </div>

      {#if !triage.length}
        <div class="triage-empty">
          <div class="te-ico"><Icon name="all-clear" size={28} /></div>
          Inbox zero — nothing needs you right now.
          {#if snoozedCount}<div class="te-sub">{snoozedCount} snoozed decision{snoozedCount > 1 ? 's' : ''} will come back within the hour.</div>{/if}
        </div>
      {/if}

      {#each triage as s (s.id)}
        {@const kind = kindOf(s)}
        {@const meta = KIND_META[kind]}
        <article class="tcard tk-{meta.cls}">
          <header class="tcard-head">
            <span class="tdot t-{meta.cls}"></span>
            <span class="tkind tk-{meta.cls}">{meta.label}</span>
            <button class="ttitle" onclick={() => open(s)} title="Open the session">{sessionTitle(s)}</button>
            <span class="tmeta">{s.repo || s.projectName || ''}{#if s.gitBranch} · <Icon name="git-branch" size={12} /> {s.gitBranch}{/if}</span>
            <span class="tago">{ago(s.lastActivity)}</span>
          </header>

          <div class="tbody-wrap" class:is-clamped={clamped[s.id]}>
            <div class="tbody tbody-clamp" class:is-clamped={clamped[s.id]} use:measureClamp={s.id}>
              {#if kind === 'question' && s.question}
                <Question id={s.id} pq={s.question} />
              {:else if kind === 'plan'}
                {#if planCache[s.id]?.pp}
                  <Plan id={s.id} pp={planCache[s.id].pp} />
                {:else if planCache[s.id]?.loading !== false}
                  <div class="tload">Loading the plan…</div>
                {:else}
                  <div class="tload">Plan unavailable — open the session.</div>
                {/if}
              {:else if kind === 'permission'}
                <div class="tperm">Claude is waiting for a permission in the terminal.</div>
                {@render convo(s)}
              {:else}
                <div class="twait">{STATE_LABEL[s.state] || 'Finished — waiting for you'}</div>
                {#if liveSnippet(s)}{@const snip = liveSnippet(s)}<div class="tsnip"><Icon name={snip.name} color={snip.color} size={13} /> {snip.text}</div>{/if}
                {@render convo(s)}
                {#if s.followup}
                  <!-- suggestion de follow-up (ghost text du TUI) : la carte porte SON propre bouton
                       d'envoi (lien clair texte ↔ action). -->
                  <div class="tfollow">
                    <span class="tfollow-head"><Icon name="lightbulb" size={12} /> Suggested follow-up</span>
                    <span class="tfollow-text">{s.followup}</span>
                    {#if sentFollowup === s.id}
                      <span class="tfollow-sent"><Icon name="check" size={13} /> sent</span>
                    {:else}
                      <button class="tfollow-send" disabled={sendingFollowup === s.id} onclick={() => sendFollowup(s)}>
                        {#if sendingFollowup === s.id}Sending…{:else}<Icon name="send" size={13} /> Send this{/if}
                      </button>
                    {/if}
                  </div>
                {/if}
              {/if}
            </div>
            {#if clamped[s.id]}
              <button class="tsee-more" onclick={() => open(s)} title="Open the session to see and act on the full content">
                <Icon name="maximize" size={13} /> See more in the session
              </button>
            {/if}
          </div>

          <footer class="tfoot">
            {#if kind === 'permission'}
              <button class="tbtn primary" onclick={() => openLens(s, 'terminal')}><Icon name="shell" size={14} tint={false} /> Open the shell</button>
            {:else if kind === 'waiting'}
              <button class="tbtn primary" onclick={() => open(s)}><Icon name="send" size={14} /> Reply</button>
            {/if}
            <button class="tbtn" onclick={() => open(s)}>Open the session</button>
            <button class="tbtn ghost" onclick={() => snoozeOne(s.id)}><Icon name="snooze" size={14} /> 1h</button>
            <button class="tbtn ghost" onclick={() => archiveOne(s.id)} title="Archive this session (hide it from the Deck)"><Icon name="archive" size={14} /> Archive</button>
          </footer>
        </article>
      {/each}
    </section>
    {/if}

    <!-- ── fleet ── -->
    <section class="fleet-col">
      <div class="colhead">
        <h2>The fleet</h2>
        <span class="colcount">{fleetTotal} session{fleetTotal === 1 ? '' : 's'} · {active} active</span>
        <input class="fleet-q" type="search" placeholder="Filter…" bind:value={fq} />
        <div class="viewseg">
          <button class:on={view === 'list'} onclick={() => (view = 'list')} title="List"><Icon name="list" size={15} /></button>
          <button class:on={view === 'grid'} onclick={() => (view = 'grid')} title="Grid"><Icon name="pane" size={15} /></button>
        </div>
      </div>

      {#each fleetGroups as g (g.proj)}
        <div class="repo-group">
          <div class="repo-head">
            <span class="repo-name">{g.proj}</span>
            <span class="repo-n">{g.items.length}</span>
            <a class="repo-plus" href={'/new?project=' + encodeURIComponent(g.newProject)} title="New session in this project"><Icon name="plus" size={15} /></a>
          </div>
          <div class="fleet" class:grid={view === 'grid'}>
            {@render fhead()}
            {#each visibleItems(g) as s (s.id)}
              {@render fcard(s)}
            {/each}
            {#if !expandedGroups[g.proj] && g.items.length > visibleItems(g).length}
              <button class="fmore" onclick={() => (expandedGroups = { ...expandedGroups, [g.proj]: true })}>
                <Icon name="plus" size={13} /> {g.items.length - visibleItems(g).length} older session{g.items.length - visibleItems(g).length > 1 ? 's' : ''}
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="triage-empty">No sessions{fq ? ' matching “' + fq + '”' : ''}.</div>
      {/each}

      {#if archivedList.length}
        <div class="repo-group arch-group">
          <button class="arch-head" onclick={() => (archivedOpen = !archivedOpen)}>
            <span class="arch-chev" class:open={archivedOpen}><Icon name="chevron-right" size={13} /></span>
            <Icon name="archive" size={13} /> Archived <span class="repo-n">{archivedList.length}</span>
          </button>
          {#if archivedOpen}
            <div class="fleet" class:grid={view === 'grid'}>
              {@render fhead()}
              {#each archivedList as s (s.id)}
                {@render fcard(s)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

{#snippet convo(s)}
  {#if s.lastPrompt || s.lastReply}
    <span class="fconv">
      {#if s.lastPrompt}<span class="fmsg me">{s.lastPrompt}</span>{/if}
      {#if s.lastReply}<span class="fmsg ai">{s.lastReply}</span>{/if}
    </span>
  {/if}
{/snippet}

{#snippet fhead()}
  <!-- Column header for the datadog table view. Hidden in every other scheme (see <style>). -->
  <div class="fhead">
    <span class="fh-st"></span><span>Session</span><span>Branch</span><span>Status</span><span class="fh-age">Age</span>
  </div>
{/snippet}

{#snippet fcard(s)}
  {@const ended = s.state === 'ended' || s.state === 'past'}
  <div class="fcard" class:dim={!isLive(s) || isSessionArchived(s)} class:archived={isSessionArchived(s)}
       role="button" tabindex="0" onclick={() => open(s)}
       onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(s); } }}>
    <span class="frow1">
      <span class="fdot f-{dotClass(s)}"></span>
      <span class="ft">{sessionTitle(s)}</span>
      <!-- Table cells for the datadog scheme. Markup cannot be conditioned on a palette, so they
           ship for every scheme and are hidden by default (see .fbranch/.fstate in <style>);
           only :root[data-scheme="datadog"] reveals them, in app.css. -->
      <span class="fbranch">{s.gitBranch || ''}</span>
      <span class="fstate">{STATE_LABEL[s.state] || s.state}</span>
      <span class="fago">{ago(s.lastActivity)}</span>
    </span>
    {#if liveSnippet(s)}
      {@const snip = liveSnippet(s)}
      <span class="fact" class:working={s.state === 'working'}><Icon name={snip.name} color={snip.color} size={13} /> {snip.text}</span>
    {/if}
    {@render convo(s)}
    {#if sessionTags(s.id).length}
      <span class="fpills">
        {#each sessionTags(s.id) as t}<span class="fpill" style="--c:{tagColor(t)}"># {t}</span>{/each}
      </span>
    {/if}
    <!-- ↩ unarchive (explicit archive) · 📥 archive (live session) · nothing for finished ones -->
    {#if isArchived(s.id)}
      <button class="fcard-act" title="Unarchive" onclick={(e) => { e.stopPropagation(); toggleArchive(s.id); }}><Icon name="unarchive" size={14} /></button>
    {:else if !ended}
      <button class="fcard-act" title="Archive" onclick={(e) => { e.stopPropagation(); toggleArchive(s.id); }}><Icon name="archive" size={14} /></button>
    {/if}
  </div>
{/snippet}

<style>
  .deck { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 18px 22px 40px; }

  .deck-cols { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .9fr); gap: 22px; }
  .deck-cols.sessions-only { grid-template-columns: 1fr; }
  @media (max-width: 1080px) { .deck-cols { grid-template-columns: 1fr; } }

  .colhead { display: flex; align-items: center; gap: 10px; margin: 2px 0 12px; }
  .colhead h2 { font-size: 15px; font-weight: 800; letter-spacing: -.01em; margin: 0; }
  .colcount { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .ghost-btn {
    margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer;
    font: inherit; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 7px;
  }
  .ghost-btn:hover { background: var(--hover); color: var(--text); }

  /* triage cards */
  .triage-empty {
    border: 1px dashed var(--border2); border-radius: 14px; padding: 34px 16px;
    text-align: center; color: var(--muted); font-size: 13px;
  }
  .te-ico { font-size: 22px; margin-bottom: 6px; }
  .te-sub { font-size: 11.5px; margin-top: 6px; opacity: .8; }
  .tcard {
    border: 1px solid var(--border); border-radius: 14px; background: var(--bg2);
    box-shadow: var(--shadow-sm); margin-bottom: 14px; overflow: hidden;
  }
  .tcard.tk-q { border-left: 3px solid var(--accent); }
  .tcard.tk-plan { border-left: 3px solid var(--waiting); }
  .tcard.tk-perm { border-left: 3px solid var(--attention); }
  .tcard.tk-wait { border-left: 3px solid var(--waiting); }
  .tcard-head {
    display: flex; align-items: center; gap: 9px; padding: 10px 14px;
    border-bottom: 1px solid var(--border); background: var(--panel); min-width: 0;
  }
  .tdot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; animation: tpulse 1.4s ease-in-out infinite; }
  .t-q { background: var(--accent); }
  .t-plan, .t-wait { background: var(--waiting); }
  .t-perm { background: var(--attention); }
  @keyframes tpulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  .tkind {
    font-family: var(--mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 5px; flex: 0 0 auto; font-weight: 700;
  }
  .tkind.tk-q { background: var(--accent-soft); color: var(--accent-d); }
  .tkind.tk-plan, .tkind.tk-wait { background: color-mix(in srgb, var(--waiting) 14%, transparent); color: var(--waiting); }
  .tkind.tk-perm { background: color-mix(in srgb, var(--attention) 14%, transparent); color: var(--attention); }
  .ttitle {
    background: none; border: none; padding: 0; font: inherit; font-size: 13px; font-weight: 700;
    color: var(--text); cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ttitle:hover { color: var(--accent-d); }
  .tmeta { font-family: var(--mono); font-size: 10px; color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tago { font-family: var(--mono); font-size: 10px; color: var(--muted); flex: 0 0 auto; }
  .tbody { padding: 4px 14px; }
  /* Deck decision cards stay scannable: cap the body height, fade the overflow, and surface a
     "see more" that opens the full session (where the plan/question is fully actionable). */
  .tbody-wrap { position: relative; }
  .tbody-clamp.is-clamped { max-height: 300px; overflow: hidden; }
  .tbody-wrap.is-clamped::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: 34px; height: 60px; pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--bg2));
  }
  .tsee-more {
    display: block; width: 100%; background: none; border: none; border-top: 1px dashed var(--border2);
    color: var(--accent-d); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; padding: 8px;
  }
  .tsee-more:hover { background: var(--hover); }
  /* the embedded Question/Plan cards already carry their own chrome — flatten it inside a tcard */
  .tbody :global(.question), .tbody :global(.plan) { margin: 8px 0; }
  .tload { padding: 12px 2px; font-size: 12.5px; color: var(--muted); }
  .tperm { padding: 10px 2px 2px; font-size: 13px; font-weight: 600; color: var(--attention); }
  .twait { padding: 10px 2px 2px; font-size: 12.5px; font-weight: 600; color: var(--waiting); }
  .tsnip {
    padding: 4px 2px 10px; font-size: 12px; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tfollow {
    display: flex; flex-direction: column; align-items: flex-start; gap: 7px; margin: 2px 0 10px; padding: 9px 11px;
    background: var(--accent-soft); border: 1px solid rgba(var(--accent-rgb), .3); border-radius: 10px;
  }
  .tfollow-head { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--accent-d); }
  .tfollow-text {
    font-size: 12.5px; color: var(--text); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .tfollow-send {
    background: var(--accent); border: none; color: var(--accent-fg); border-radius: 8px;
    padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .tfollow-send:hover:not(:disabled) { background: var(--accent-d); }
  .tfollow-send:disabled { opacity: .6; cursor: default; }
  .tfollow-sent { font-size: 12px; font-weight: 700; color: var(--success); }
  .tfoot { display: flex; gap: 7px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--border); }
  .tbtn {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg3); border: 1px solid var(--border2); color: var(--text);
    border-radius: 8px; padding: 5px 11px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    transition: background .12s;
  }
  .tbtn:hover { background: var(--hover); }
  .tbtn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .tbtn.primary:hover { background: var(--accent-d); }
  .tbtn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .tbtn.ghost:hover { color: var(--text); background: var(--hover); }

  /* fleet */
  .fleet-q {
    margin-left: auto; width: 130px; background: var(--input); border: 1px solid var(--border);
    border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 12px; color: var(--text);
  }
  .fleet-q:focus { outline: none; border-color: var(--accent); }
  .arch-group { margin-top: 4px; }
  .arch-head {
    display: flex; align-items: center; gap: 7px; width: 100%; background: none; border: none;
    color: var(--muted); font: inherit; font-family: var(--mono); font-size: 11px; font-weight: 700;
    letter-spacing: .04em; padding: 6px 4px; cursor: pointer; margin-bottom: 6px;
  }
  .arch-head:hover { color: var(--text); }
  .arch-chev { transition: transform .12s; display: inline-block; }
  .arch-chev.open { transform: rotate(90deg); }
  .viewseg { display: flex; gap: 2px; background: var(--input); border-radius: 8px; padding: 2px; }
  .viewseg button {
    background: transparent; border: none; border-radius: 6px; color: var(--muted);
    font-size: 13px; padding: 3px 9px; cursor: pointer;
  }
  .viewseg button.on { background: var(--accent-soft); color: var(--accent); }
  .repo-group { margin-bottom: 18px; }
  .repo-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .repo-name { font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .repo-n { font-size: 10px; color: var(--muted); background: var(--chip); border-radius: 20px; padding: 1px 7px; }
  .repo-plus {
    margin-left: auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 15px;
    opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .repo-head:hover .repo-plus { opacity: 1; }
  .repo-plus:hover { background: var(--accent-soft); color: var(--accent); }
  .fleet { display: flex; flex-direction: column; gap: 8px; }
  .fleet.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
  .fcard {
    position: relative; display: flex; flex-direction: column; gap: 5px; padding: 10px 13px; text-align: left;
    border-radius: 12px; border: 1px solid var(--border); background: var(--bg2);
    font: inherit; cursor: pointer; min-width: 0; transition: border-color .12s, box-shadow .12s, opacity .12s;
  }
  .fcard:hover { border-color: var(--border2); box-shadow: var(--shadow-sm); }
  .fcard:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .fcard.dim { opacity: .58; }
  .fcard.dim:hover { opacity: .95; }
  .fcard.archived { border-style: dashed; }
  .fcard-act {
    position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); background: var(--bg2); border-radius: 6px; color: var(--muted);
    font-size: 11px; cursor: pointer; padding: 0; opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .fcard:hover .fcard-act { opacity: 1; }
  .fcard-act:hover { background: var(--accent-soft); color: var(--accent-d); }
  .frow1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .fdot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .f-working { background: var(--working); animation: tpulse 1.6s ease-in-out infinite; }
  .f-waiting { background: var(--waiting); animation: tpulse 1.6s ease-in-out infinite; }
  .f-attention { background: var(--attention); animation: tpulse 1s ease-in-out infinite; }
  .f-bgjob { background: var(--background); animation: tpulse 1.6s ease-in-out infinite; }
  .f-ended { background: var(--ended); }
  .f-idle { background: var(--idle); }
  .ft { font-size: 12.5px; font-weight: 600; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fago { margin-left: auto; font-family: var(--mono); font-size: 9.5px; color: var(--muted); flex: 0 0 auto; }
  .fact { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fact.working { color: var(--working); font-style: italic; }
  /* last exchange preview: the user's message aligned right, Claude's reply left, both clamped. */
  .fconv { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tbody .fconv { margin: 6px 0 10px; }
  .fmsg {
    max-width: 88%; font-size: 11px; line-height: 1.4; border-radius: 9px; padding: 4px 8px;
    overflow: hidden; text-overflow: ellipsis; word-break: break-word;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .fmsg.me { align-self: flex-end; background: var(--accent-soft); color: var(--accent-d); border-bottom-right-radius: 3px; }
  .fmsg.ai { align-self: flex-start; background: var(--bg3); color: var(--muted); border-bottom-left-radius: 3px; }
  .fpills { display: flex; flex-wrap: wrap; gap: 4px; }
  .fmore {
    background: none; border: 1px dashed var(--border2); border-radius: 10px; color: var(--muted);
    font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; padding: 8px;
  }
  .fmore:hover { color: var(--text); border-color: var(--accent); }
  .fpill {
    font-family: var(--mono); font-size: 9.5px; font-weight: 600; line-height: 1.6;
    color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent);
    border-radius: 6px; padding: 0 6px;
  }
  /* Cells that only the datadog scheme uses (it lays the fleet out as a table — see app.css).
     Markup is not scopable per palette, so they are emitted for everyone and hidden here;
     `display: none` costs nothing and keeps every other scheme pixel-identical. */
  .fbranch, .fstate, .fhead { display: none; }
</style>
