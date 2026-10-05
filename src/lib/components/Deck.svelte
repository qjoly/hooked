<script>
  // The Deck (redesign home): a decision queue you can clear WITHOUT opening sessions
  // (questions answered inline, plans approved inline) + the fleet grouped by repo.
  // Replaces the old empty-cockpit Overview and the /board kanban.
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { ui, data, sessionTitle, sessionTags, loadSessions, toggleArchive, isArchived, isSessionArchived, snoozeSession, snoozeUntil, groupUnits, isGroupArchived, isGrouped, groupName } from '$lib/state.svelte.js';
  import { dragSession, dropSession, dropDetach } from '$lib/groupDnd.js';
  import { getSession, reply } from '$lib/api.js';
  import { ago, tagColor, lotColor, STATE_LABEL, needsDecision, isActiveSession as isLive, sessionDot as dotClass } from '$lib/format.js';
  import Question from './Question.svelte';
  import Plan from './Plan.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import FleetWheel from '$lib/components/FleetWheel.svelte';

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
  // The queue folds into session groups too: a child's decision sits under its mother (whose own
  // card only shows if she needs a decision herself). Children that merely finished are usually
  // waiting for the orchestrating mother, not for you — they shrink to tree rows, as in the fleet.
  const triageUnits = $derived.by(() => {
    const pending = new Set(triage.map((s) => s.id));
    return groupUnits(triage).map((u) => ({
      ...u,
      motherPending: pending.has(u.mother.id),
      kidDecisions: u.children.filter((c) => kindOf(c) !== 'waiting'),
      kidsWaiting: u.children.filter((c) => kindOf(c) === 'waiting'),
    }));
  });
  let kidOpen = $state({}); // child session id → decision card unfolded
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
    if (fstate && dotClass(s) !== fstate) return false;
    const q = fq.toLowerCase().trim();
    if (!q) return true;
    const hay = `${s.repo} ${s.projectName} ${sessionTitle(s)} ${s.lastPrompt} ${s.gitBranch} ${sessionTags(s.id).join(' ')}`.toLowerCase();
    return hay.includes(q);
  }
  // fleet rows shown per repo: every live session group + up to 8; the rest behind an expander.
  function visibleItems(g) {
    if (expandedGroups[g.proj]) return g.items;
    return g.items.slice(0, Math.max(8, g.items.filter(unitLive).length));
  }
  let view = $state((typeof localStorage !== 'undefined' && localStorage.getItem('hooked.deckView')) || 'grid');
  $effect(() => { try { localStorage.setItem('hooked.deckView', view); } catch {} });
  let fq = $state(''); // fleet quick filter
  let fstate = $state(null); // fleet state filter, set from the wheel legend (a sessionDot family)
  const wheelSessions = $derived(S.filter((s) => !isSessionArchived(s)));

  const projectKey = (s) => s.repo || s.projectName || '—';
  const unitLive = (u) => u.all.some(isLive);
  // A group card lists at most KIDS_CAP children (live ones first) so a big orchestration doesn't
  // turn its card into a column; the rest fold into one « +N » row. Folding a single child would
  // save nothing, hence the +1.
  const KIDS_CAP = 3;
  let kidsExpanded = $state({}); // unit key → true once its « +N » row was clicked
  function fleetKids(u) {
    const kids = u.children.filter(isLive).concat(u.children.filter((c) => !isLive(c)));
    if (kidsExpanded[u.key] || kids.length <= KIDS_CAP + 1) return { shown: kids, hidden: [] };
    return { shown: kids.slice(0, KIDS_CAP), hidden: kids.slice(KIDS_CAP) };
  }
  // live activity only (no lastPrompt fallback) — the cards show the last exchange separately,
  // so the fallback would just duplicate the user message.
  function liveSnippet(s) {
    if (s.state === 'working' && s.activity) return { name: 'activity', text: s.activity + '…' };
    if (s.bgJobs && s.bgJobs.length) return { name: 'background', color: 'var(--background)', text: s.bgJobs.length + ' job' + (s.bgJobs.length > 1 ? 's' : '') + (s.bgJobs[0].label ? ' · ' + s.bgJobs[0].label : '') };
    if (s.todo && s.todo.current) return { name: 'in-progress', text: s.todo.current + ' (' + s.todo.done + '/' + s.todo.total + ')' };
    return null;
  }

  const byRecent = (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  // The fleet shows session GROUPS (cf. groupUnits): one card per group, headed by its mother,
  // children listed inside the card. Archived groups (every member archived) are NEVER shown in
  // the repo-grouped fleet; they live in their own collapsed section at the bottom (below).
  const archivedList = $derived(groupUnits(S.filter((s) => isSessionArchived(s) && matchesQ(s)).sort(byRecent))
    .filter((u) => isGroupArchived(u.key)));

  const fleetGroups = $derived.by(() => {
    const units = groupUnits(S.filter((s) => !isSessionArchived(s) && matchesQ(s)).sort(byRecent));
    const g = new Map();
    for (const u of units) {
      const k = projectKey(u.mother); // a group sits under its mother's repo
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(u);
    }
    const lastOfUnit = (u) => u.all.reduce((m, s) => Math.max(m, Date.parse(s.lastActivity || 0) || 0), 0);
    const lastOf = (arr) => arr.reduce((m, u) => Math.max(m, lastOfUnit(u)), 0);
    return [...g.keys()]
      .sort((a, b) => lastOf(g.get(b)) - lastOf(g.get(a)))
      .map((proj) => {
        const items = g.get(proj).slice().sort((a, b) => {
          if (unitLive(a) !== unitLive(b)) return unitLive(a) ? -1 : 1;
          return lastOfUnit(b) - lastOfUnit(a);
        });
        return { proj, items, newProject: items[0]?.mother.project || '' };
      });
  });
  const fleetTotal = $derived(fleetGroups.reduce((a, g) => a + g.items.length, 0));

  const open = (s) => goto('/session/' + encodeURIComponent(s.id));

</script>

<div class="deck">
  <div class="deck-cols">
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
          <div class="te-ico te-cup" aria-hidden="true">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path class="steam" d="M7 2.5v2" /><path class="steam" d="M10.5 2.5v2" /><path class="steam" d="M14 2.5v2" />
              <path d="M17 8.5a1 1 0 0 1 1 1v6.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9.5a1 1 0 0 1 1-1z" /><path d="M18 10.5h1a3 3 0 0 1 0 6h-1" />
            </svg>
          </div>
          Inbox zero — nothing needs you right now.
          {#if snoozedCount}<div class="te-sub">{snoozedCount} snoozed decision{snoozedCount > 1 ? 's' : ''} will come back within the hour.</div>{/if}
        </div>
      {/if}

      {#each triageUnits as u (u.key)}
        {@const waitingTree = { key: u.key, children: u.kidsWaiting }}
        <div class="tunit" class:has-kids={u.kidDecisions.length}>
          {#if u.motherPending}
            {@render tcard(u.mother, false, waitingTree)}
          {:else}
            <div class="tunit-head">
              <button class="tunit-open" onclick={() => open(u.mother)} title="Open the mother session">
                <span class="state-dot fdot d-{dotClass(u.mother)}"></span>
                <Icon name="sessions" size={12} /> <span class="tunit-name">{groupName(u.key)}</span>
                <span class="tmeta">{u.mother.repo || u.mother.projectName || ''}</span>
                <span class="tago">{ago(u.mother.lastActivity)}</span>
              </button>
              {#if u.kidsWaiting.length}{@render kidTree(waitingTree)}{/if}
            </div>
          {/if}
          {#if u.kidDecisions.length}
            <div class="tkids">
              {#each u.kidDecisions as c (c.id)}{@render tcard(c, true)}{/each}
            </div>
          {/if}
        </div>
      {/each}
    </section>

    <!-- ── fleet ── -->
    <section class="fleet-col">
      <div class="colhead">
        <h2>The fleet</h2>
        <span class="colcount">{fleetTotal} group{fleetTotal === 1 ? '' : 's'} · {active} active</span>
        <input class="fleet-q" type="search" placeholder="Filter…" bind:value={fq} />
        <div class="viewseg">
          <button class:on={view === 'list'} onclick={() => (view = 'list')} title="List"><Icon name="list" size={15} /></button>
          <button class:on={view === 'grid'} onclick={() => (view = 'grid')} title="Grid"><Icon name="pane" size={15} /></button>
        </div>
      </div>

      <div class="wheel-card">
        <FleetWheel sessions={wheelSessions} quiet={(s) => snoozed(s.id)} decisions={triage.length} bind:filter={fstate} />
      </div>

      {#each fleetGroups as g (g.proj)}
        <div class="repo-group">
          <!-- drop a grouped session on a repo header to take it out of its group -->
          <div class="repo-head" use:dropDetach>
            <span class="lot" style="--lot:{lotColor(g.proj)}"></span>
            <span class="repo-name">{g.proj}</span>
            <span class="repo-n">{g.items.length}</span>
            <a class="repo-plus" href={'/new?project=' + encodeURIComponent(g.newProject)} title="New session in this project"><Icon name="plus" size={15} /></a>
          </div>
          <div class="fleet" class:grid={view === 'grid'}>
            {@render fhead()}
            {#each visibleItems(g) as u (u.key)}
              {@render fcard(u)}
            {/each}
            {#if !expandedGroups[g.proj] && g.items.length > visibleItems(g).length}
              <button class="fmore" onclick={() => (expandedGroups = { ...expandedGroups, [g.proj]: true })}>
                <Icon name="plus" size={13} /> {g.items.length - visibleItems(g).length} older group{g.items.length - visibleItems(g).length > 1 ? 's' : ''}
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="triage-empty">
          {#if fq || fstate}
            <div class="te-ico"><Icon name="sessions" size={28} /></div>
            {fq ? `Nothing matches “${fq}”.` : 'No session in this state.'}
            <div class="te-sub"><button class="te-link" onclick={() => { fq = ''; fstate = null; }}>Clear the filter</button></div>
          {:else}
            <div class="te-ico"><Icon name="sessions" size={28} /></div>
            No sessions yet — this is where they'll land.
            <div class="te-sub"><a class="te-link" href="/new">Start your first one</a></div>
          {/if}
        </div>
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
              {#each archivedList as u (u.key)}
                {@render fcard(u)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

{#snippet tcard(s, child, waitingTree = null)}
  {@const kind = kindOf(s)}
  {@const meta = KIND_META[kind]}
  {@const folded = child && !kidOpen[s.id]}
  <article class="tcard tk-{meta.cls}" class:child>
    <header class="tcard-head">
      <span class="tkind tk-{meta.cls}">{meta.label}</span>
      <button class="ttitle" onclick={() => open(s)} title="Open the session">{sessionTitle(s)}</button>
      {#if child}
        <!-- repo and group are the mother's, already shown right above -->
        <span class="tmeta"></span>
        <span class="tago">{ago(s.lastActivity)}</span>
        <button class="tfold" onclick={() => (kidOpen = { ...kidOpen, [s.id]: !kidOpen[s.id] })} title={folded ? 'Show the decision' : 'Fold'}>
          <span class="arch-chev" class:open={!folded}><Icon name="chevron-right" size={13} /></span>
        </button>
      {:else}
        {#if isGrouped(s.id)}<span class="tgroup" title="Session group"><Icon name="sessions" size={11} /> {groupName(s.id)}</span>{/if}
        <span class="tmeta">{#if projectKey(s) !== '—'}<span class="lot" style="--lot:{lotColor(projectKey(s))}"></span>{/if}{s.repo || s.projectName || ''}{#if s.gitBranch} · <Icon name="git-branch" size={12} /> {s.gitBranch}{/if}</span>
        <span class="tago">{ago(s.lastActivity)}</span>
      {/if}
    </header>

    {#if !folded}
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

      {#if waitingTree?.children.length}
        <!-- the group's finished children, inside the mother's card -->
        <div class="ttree">{@render kidTree(waitingTree)}</div>
      {/if}

      <footer class="tfoot">
        {#if kind === 'waiting'}
          <button class="tbtn primary" onclick={() => open(s)}><Icon name="send" size={14} /> Reply</button>
        {/if}
        <button class="tbtn" onclick={() => open(s)}>Open the session</button>
        <button class="tbtn ghost" onclick={() => snoozeOne(s.id)}><Icon name="snooze" size={14} /> 1h</button>
        <button class="tbtn ghost" onclick={() => archiveOne(s.id)} title="Archive this session: stops it and hides it from the Deck"><Icon name="archive" size={14} /> Archive</button>
      </footer>
    {/if}
  </article>
{/snippet}

{#snippet convo(s)}
  {#if s.lastPrompt || s.lastReply}
    <span class="fconv">
      {#if s.lastPrompt}<span class="fmsg me"><span class="fmsg-t">{s.lastPrompt}</span></span>{/if}
      {#if s.lastReply}<span class="fmsg ai"><span class="fmsg-t">{s.lastReply}</span></span>{/if}
    </span>
  {/if}
{/snippet}

{#snippet fhead()}
  <!-- Column header for the datadog table view. Hidden in every other scheme (see <style>). -->
  <div class="fhead">
    <span class="fh-st"></span><span>Session</span><span>Branch</span><span>Status</span><span class="fh-age">Age</span>
  </div>
{/snippet}

{#snippet kidTree(u)}
  {@const kids = fleetKids(u)}
  <!-- the group's other sessions, each openable (and draggable) from the card -->
  <span class="fkids">
    {#each kids.shown as c (c.id)}
      <span class="fkid" role="button" tabindex="0" use:dragSession={c.id}
            onclick={(e) => { e.stopPropagation(); open(c); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(c); } }}>
        <span class="state-dot fdot d-{dotClass(c)}"></span>
        <span class="fkid-t">{sessionTitle(c)}</span>
        {#if liveSnippet(c)}<span class="fkid-a">{liveSnippet(c).text}</span>{/if}
        <span class="fkid-ago">{ago(c.lastActivity)}</span>
      </span>
    {/each}
    {#if kids.hidden.length}
      <button class="fkid fkid-more" title="Show the {kids.hidden.length} other sessions of this group"
              onclick={(e) => { e.stopPropagation(); kidsExpanded = { ...kidsExpanded, [u.key]: true }; }}>
        <span class="fkid-t">+{kids.hidden.length}</span>
        <span class="fkid-dots">{#each kids.hidden as c (c.id)}<span class="state-dot fdot d-{dotClass(c)}"></span>{/each}</span>
      </button>
    {/if}
  </span>
{/snippet}

{#snippet fcard(u)}
  {@const s = u.mother}
  {@const ended = s.state === 'ended' || s.state === 'past'}
  <div class="fcard" class:dim={!unitLive(u) || isGroupArchived(s.id)} class:archived={isGroupArchived(s.id)}
       role="button" tabindex="0" onclick={() => open(s)}
       use:dragSession={s.id} use:dropSession={s.id}
       onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(s); } }}>
    <span class="frow1">
      <span class="state-dot fdot d-{dotClass(s)}"></span>
      <span class="ft" title={u.children.length ? 'Group · mother session: ' + sessionTitle(s) : undefined}>{u.children.length ? groupName(s.id) : sessionTitle(s)}</span>
      {#if u.children.length}<span class="fgn" title="{u.all.length} sessions in this group"><Icon name="sessions" size={11} /> {u.all.length}</span>{/if}
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
    {#if u.children.length}{@render kidTree(u)}{/if}
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
  /* minmax(0, …): a bare 1fr track grows to its widest unbreakable line (a path in a reply), which
     pushed every card past the right edge of a phone. */
  @media (max-width: 1080px) { .deck-cols { grid-template-columns: minmax(0, 1fr); } }

  .colhead { display: flex; align-items: baseline; gap: 10px; margin: 4px 0 14px; }
  .colhead h2 {
    font-family: var(--font-display); font-size: 25px; line-height: var(--lh-head); font-weight: 750;
    letter-spacing: -.025em; margin: 0; font-variation-settings: "opsz" 36;
  }
  .colcount { font-size: var(--t-meta); font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
  .colhead .ghost-btn, .colhead .fleet-q, .colhead .viewseg { align-self: center; }
  .ghost-btn {
    margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer;
    font: inherit; font-size: var(--t-meta); font-weight: 600; padding: 4px 8px; border-radius: 7px;
  }
  .ghost-btn:hover { background: var(--hover); color: var(--text); }

  /* triage cards */
  .triage-empty {
    border: 1px solid var(--border); border-radius: 16px; padding: 34px 16px;
    background: color-mix(in srgb, var(--bg2) 55%, transparent);
    text-align: center; color: var(--muted); font-size: var(--t-ui);
  }
  .te-ico { margin-bottom: 6px; }
  /* Inbox zero is the one empty state that is good news: the cup, steam rising. */
  .te-cup { color: var(--ended); }
  .te-cup .steam { animation: steam 2.4s ease-in-out infinite; }
  .te-cup .steam:nth-child(2) { animation-delay: .4s; }
  .te-cup .steam:nth-child(3) { animation-delay: .8s; }
  @keyframes steam { 0%, 100% { opacity: .2; transform: translateY(1px); } 50% { opacity: 1; transform: translateY(-1px); } }
  .te-sub { font-size: var(--t-meta); margin-top: 8px; color: var(--muted); }
  /* Un état vide qui ne propose rien est une impasse. La sortie est un lien, pas un bouton :
     elle accompagne une phrase, elle ne réclame pas le regard. */
  .te-link {
    background: none; border: none; padding: 0; font: inherit; font-size: var(--t-meta); font-weight: 700;
    color: var(--accent-d); cursor: pointer; text-decoration: underline; text-underline-offset: 3px;
  }
  .te-link:hover { color: var(--accent); }
  .tcard {
    border: 1px solid var(--border); border-radius: 16px; background: var(--bg2);
    box-shadow: var(--shadow); margin-bottom: 14px; overflow: hidden;
  }
  /* L'état se lit à deux distances : de près par la pastille pleine de l'en-tête, de loin par
     l'anneau teinté de la carte. Rien entre les deux — pas de tranche gauche, pas de bandeau
     lavé, qui ternissait la carte sans se voir de plus loin qu'un contour. */
  /* Same families as the dots and the wheel: anything that blocks Claude (question, plan,
     permission) is attention; a finished turn waiting for your reply is waiting. */
  .tcard.tk-q, .tcard.tk-plan, .tcard.tk-perm { --tk: var(--attention); --tk-ink: var(--attention-ink); }
  .tcard.tk-wait { --tk: var(--waiting); --tk-ink: var(--waiting-ink); }
  .tcard.tk-q, .tcard.tk-plan, .tcard.tk-perm, .tcard.tk-wait {
    border-color: color-mix(in srgb, var(--tk) 55%, var(--border));
  }
  .tcard-head {
    display: flex; align-items: center; gap: 10px; padding: 12px 16px;
    border-bottom: 1px solid var(--border); background: transparent; min-width: 0;
  }
  /* Un point qui clignote n'attire l'œil que s'il est le seul à bouger. Sur quarante sessions,
     la flotte en faisait battre quarante à un troisième tempo : le mouvement cessait d'être un
     signal pour devenir une texture. La pulsation reste ici, dans la colonne des décisions, et
     adopte le tempo du système (1,6 s) au lieu d'en inventer un. */
  /* La flotte est un inventaire, pas une alarme : ses pastilles gardent couleur et libellé, elles
     ne battent plus. Rien ne bat plus sur le Deck — la pastille pleine de l'en-tête dit la nature
     de la décision assez fort pour que le mouvement n'ait plus rien à ajouter. */
  .fleet :global(.state-dot) { animation: none; }
  /* Fond plein plutôt que lavis : c'est le seul objet coloré de la carte, il peut se permettre
     d'être franc — et du blanc sur l'encre est plus net qu'une encre sur un lavis de sa teinte. */
  /* The kind pill: label + the family's shape (diamond = blocks Claude, disc = your turn) + its hue. */
  .tkind {
    display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
    font-size: var(--t-micro); font-weight: 750; letter-spacing: .07em; text-transform: uppercase;
    padding: 3px 9px 3px 8px; border-radius: 999px;
    color: var(--tk-ink); background: color-mix(in srgb, var(--tk) 14%, transparent);
  }
  .tkind::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tk); flex: 0 0 auto; }
  .tkind.tk-q::before, .tkind.tk-plan::before, .tkind.tk-perm::before { border-radius: 1px; transform: rotate(45deg) scale(.9); }
  .ttitle {
    background: none; border: none; padding: 0; font: inherit; font-size: var(--t-body); font-weight: 700; text-align: left;
    color: var(--text); cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ttitle:hover { color: var(--accent-d); }
  .tmeta { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tago { font-size: var(--t-meta); color: var(--muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .tbody { padding: 6px 16px; }
  /* Project lot: one square per repo, identical wherever the repo shows up. */
  .lot { display: var(--lot-display, inline-block); width: 14px; height: 7px; border-radius: 2px; background: var(--lot); margin-right: 6px; vertical-align: 1px; flex: 0 0 auto; }
  .wheel-card {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 16px;
    padding: 16px 18px; margin-bottom: 20px; box-shadow: var(--shadow-sm);
  }
  /* Deck decision cards stay scannable: cap the body height, fade the overflow, and surface a
     "see more" that opens the full session (where the plan/question is fully actionable). */
  .tbody-wrap { position: relative; }
  .tbody-clamp { position: relative; }
  .tbody-clamp.is-clamped { max-height: 300px; overflow: hidden; }
  /* Le fondu appartient à la zone tronquée, pas au conteneur : ancré en bas de `.tbody-clamp`,
     il n'a plus à connaître la hauteur du bouton qui le suit — hauteur que le bloc mobile et le
     scheme datadog changent tous les deux, et que l'ancienne valeur en dur désalignait. */
  .tbody-clamp.is-clamped::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 60px; pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--bg2));
  }
  .tsee-more {
    display: block; width: 100%; background: none; border: none; border-top: 1px dashed var(--border2);
    color: var(--accent-d); font: inherit; font-size: var(--t-meta); font-weight: 700; cursor: pointer; padding: 8px;
  }
  .tsee-more:hover { background: var(--hover); }
  /* the embedded Question/Plan cards already carry their own chrome — flatten it inside a tcard */
  .tbody :global(.question), .tbody :global(.plan) { margin: 8px 0; }
  .tload { padding: 12px 2px; font-size: var(--t-ui); color: var(--muted); }
  .tperm { padding: 10px 2px 2px; font-size: var(--t-ui); font-weight: 600; color: var(--attention-ink); }
  .twait { padding: 10px 2px 2px; font-size: var(--t-ui); font-weight: 600; color: var(--waiting-ink); }
  .tsnip {
    padding: 4px 2px 10px; font-size: var(--t-meta); color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tfollow {
    display: flex; flex-direction: column; align-items: flex-start; gap: 7px; margin: 2px 0 10px; padding: 9px 11px;
    background: var(--accent-soft); border: 1px solid rgba(var(--accent-rgb), .3); border-radius: 10px;
  }
  .tfollow-head { font-family: var(--mono); font-size: var(--t-micro); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--accent-d); }
  .tfollow-text {
    font-size: var(--t-ui); color: var(--text); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .tfollow-send {
    background: var(--accent); border: none; color: var(--accent-fg); border-radius: 8px;
    padding: 5px 12px; font: inherit; font-size: var(--t-meta); font-weight: 700; cursor: pointer;
  }
  .tfollow-send:hover:not(:disabled) { background: var(--accent-d); }
  .tfollow-send:disabled { opacity: .6; cursor: default; }
  .tfollow-sent { font-size: var(--t-meta); font-weight: 700; color: var(--success-ink); }
  .tfoot { display: flex; gap: 8px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--border); }
  .tbtn {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--bg2); border: 1px solid var(--border2); color: var(--text);
    border-radius: 999px; padding: 6px 14px; font: inherit; font-size: var(--t-ui); font-weight: 650; cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  .tbtn:hover { background: var(--hover); }
  .tbtn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .tbtn.primary:hover { background: var(--accent-d); }
  /* Le bouton le plus discret de la carte était le seul irréversible : il arrête la session et,
     sur une mère, tout son groupe. Il garde son rang tertiaire — ce n'est pas l'action attendue —
     mais cesse d'être invisible, et s'annonce en rouge dès qu'on le vise. */
  .tbtn.ghost { background: transparent; border-color: var(--border); color: var(--muted); }
  .tbtn.ghost:hover, .tbtn.ghost:focus-visible {
    color: var(--attention-ink); border-color: color-mix(in srgb, var(--attention) 45%, var(--border));
    background: var(--danger-soft);
  }

  /* triage folded by session group: finished children sit inside the mother card as tree rows,
     children with a decision hang under it through a left rail */
  .tunit { margin-bottom: 14px; }
  .tunit > .tcard { margin-bottom: 0; }
  .tunit.has-kids > .tcard { margin-bottom: 6px; }
  .tunit-head { display: flex; flex-direction: column; gap: 2px; padding: 4px 6px 6px; border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--bg2) 55%, transparent); }
  .tunit.has-kids > .tunit-head { margin-bottom: 6px; }
  .tunit-open {
    display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; padding: 4px 6px;
    border: none; border-radius: 7px; background: none; cursor: pointer;
    font: inherit; font-size: var(--t-ui); font-weight: 700; color: var(--text); text-align: left;
  }
  .tunit-open:hover { background: var(--hover); }
  .ttree { padding: 0 14px 10px; }
  .tunit-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tkids { display: flex; flex-direction: column; gap: 6px; margin-left: 12px; padding-left: 10px; border-left: 1px solid var(--border2); }
  .tcard.child { margin-bottom: 0; border-radius: 10px; box-shadow: none; }
  .tcard.child .tcard-head { padding: 6px 10px; border-bottom: 0; }
  .tcard.child .ttitle { font-size: var(--t-meta); }
  .tfold {
    display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: 0 0 auto;
    background: none; border: none; border-radius: 6px; color: var(--muted); cursor: pointer; padding: 0;
  }
  .tfold:hover { background: var(--hover); color: var(--text); }

  /* fleet */
  .fleet-q {
    margin-left: auto; width: 130px; background: var(--input); border: 1px solid var(--border);
    border-radius: 8px; padding: 5px 10px; font: inherit; font-size: var(--t-meta); color: var(--text);
  }
  .fleet-q:focus { outline: none; border-color: var(--accent); }
  .arch-group { margin-top: 4px; }
  .arch-head {
    display: flex; align-items: center; gap: 7px; width: 100%; background: none; border: none;
    color: var(--muted); font: inherit; font-family: var(--mono); font-size: var(--t-micro); font-weight: 700;
    letter-spacing: .04em; padding: 6px 4px; cursor: pointer; margin-bottom: 6px;
  }
  .arch-head:hover { color: var(--text); }
  .arch-chev { transition: transform .12s; display: inline-block; }
  .arch-chev.open { transform: rotate(90deg); }
  .viewseg { display: flex; gap: 2px; background: var(--input); border-radius: 8px; padding: 2px; }
  .viewseg button {
    background: transparent; border: none; border-radius: 6px; color: var(--muted);
    font-size: var(--t-ui); padding: 3px 9px; cursor: pointer;
  }
  .viewseg button.on { background: var(--accent-soft); color: var(--accent); }
  .repo-group { margin-bottom: 18px; }
  .repo-head { display: flex; align-items: center; gap: 2px; margin-bottom: 8px; }
  .repo-head .repo-n { margin-left: 6px; }
  .repo-name { font-size: var(--t-ui); font-weight: 700; color: var(--text); letter-spacing: -.005em; }
  .repo-n { font-size: var(--t-micro); color: var(--muted); background: var(--chip); border-radius: 20px; padding: 1px 7px; }
  .repo-plus {
    margin-left: auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; color: var(--muted); text-decoration: none;
    opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .repo-head:hover .repo-plus { opacity: 1; }
  .repo-plus:hover { background: var(--accent-soft); color: var(--accent); }
  .fleet { display: flex; flex-direction: column; gap: 8px; }
  /* align-items: start — a tall group card must not stretch its whole grid row */
  .fleet.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); align-items: start; }
  .fcard {
    position: relative; display: flex; flex-direction: column; gap: 6px; padding: 11px 14px; text-align: left;
    border-radius: 14px; border: 1px solid var(--border); background: var(--bg2);
    font: inherit; cursor: pointer; min-width: 0; transition: border-color .12s, box-shadow .12s, opacity .12s;
  }
  .fcard:hover { border-color: var(--border2); box-shadow: var(--shadow-sm); }
  .fcard:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* L'atténuation est le bon geste — elle recule vraiment — mais .58 emportait le texte avec le
     chrome et faisait tomber le titre sous le seuil. .75 garde le recul et repasse au-dessus. */
  .fcard.dim { opacity: .75; }
  .fcard.dim:hover { opacity: 1; }
  .fcard.archived { border-style: dashed; }
  .fcard-act {
    position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); background: var(--bg2); border-radius: 6px; color: var(--muted);
    font-size: var(--t-micro); cursor: pointer; padding: 0; opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .fcard:hover .fcard-act { opacity: 1; }
  .fcard-act:hover { background: var(--accent-soft); color: var(--accent-d); }
  .frow1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ft { font-size: var(--t-ui); font-weight: 600; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fago { margin-left: auto; font-size: var(--t-micro); color: var(--muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  /* session groups: member count on the head, the other members listed inside the card */
  .fgn { display: inline-flex; align-items: center; gap: 3px; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); flex: 0 0 auto; }
  .fkids { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding-left: 3px; }
  .fkid {
    position: relative; display: flex; align-items: center; gap: 6px; min-width: 0; margin-left: 11px;
    padding: 2px 6px; border-radius: 7px; font-size: var(--t-meta); color: var(--text); cursor: pointer;
  }
  .fkid:hover { background: var(--hover); }
  /* tree connectors (├ / └) tying each child to the mother above */
  .fkid::before, .fkid::after { content: ''; position: absolute; left: -9px; border-color: var(--border2); pointer-events: none; }
  .fkid::before { top: -2px; bottom: -2px; border-left: 1px solid; }
  .fkid:last-child::before { bottom: 50%; }
  .fkid::after { top: 50%; width: 8px; border-top: 1px solid; }
  button.fkid { background: none; border: none; font: inherit; text-align: left; }
  .fkid-more { color: var(--muted); }
  .fkid-more .fkid-t { font-family: var(--mono); font-size: var(--t-micro); }
  .fkid-dots { display: flex; flex-wrap: wrap; gap: 3px; min-width: 0; }
  .fkid .fdot, .fkid-dots .fdot { width: 6px; height: 6px; }
  .fkid-t { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .fkid-a { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--t-micro); }
  .fkid-ago { margin-left: auto; font-size: var(--t-micro); color: var(--muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .fcard:global(.drop-over) { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .repo-head:global(.drop-over) { box-shadow: inset 0 0 0 2px var(--accent); border-radius: 8px; }
  .fcard:global(.dragging), .fkid:global(.dragging) { opacity: .4; }
  .tgroup {
    display: inline-flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0; max-width: 30%;
    font-size: var(--t-micro); font-weight: 600; color: var(--muted); padding: 1px 6px; border-radius: 6px;
    background: var(--chip); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fact { font-size: var(--t-micro); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fact.working { color: var(--working-ink); font-style: italic; }
  /* last exchange preview: the user's message aligned right, Claude's reply left, both clamped. */
  .fconv { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tbody .fconv { margin: 6px 0 10px; }
  /* The bubble pads, the inner text clamps: clamping the padded box let the third line's
     ascenders show through the bottom padding. */
  .fmsg { display: block; max-width: 88%; font-size: var(--t-micro); line-height: 1.4; border-radius: 9px; padding: 4px 8px; word-break: break-word; }
  .fmsg-t { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .fmsg.me { align-self: flex-end; background: var(--accent-soft); color: var(--accent-d); border-bottom-right-radius: 3px; }
  .fmsg.ai { align-self: flex-start; background: var(--bg3); color: var(--muted); border-bottom-left-radius: 3px; }
  .fpills { display: flex; flex-wrap: wrap; gap: 4px; }
  .fmore {
    background: none; border: 1px dashed var(--border2); border-radius: 10px; color: var(--muted);
    font: inherit; font-size: var(--t-micro); font-weight: 600; cursor: pointer; padding: 8px;
  }
  .fmore:hover { color: var(--text); border-color: var(--accent); }
  .fpill {
    font-family: var(--mono); font-size: var(--t-micro); font-weight: 600; line-height: 1.6;
    color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent);
    border-radius: 6px; padding: 0 6px;
  }
  /* Cells that only the datadog scheme uses (it lays the fleet out as a table — see app.css).
     Markup is not scopable per palette, so they are emitted for everyone and hidden here;
     `display: none` costs nothing and keeps every other scheme pixel-identical. */
  .fbranch, .fstate, .fhead { display: none; }

  /* Phone: the Deck is the home screen, so it has to survive a 360px viewport.
     Everything here is layout only — one column, headers allowed to wrap, hover-only
     affordances made permanent (there is no hover on a touch screen). */
  @media (max-width: 640px) {
    .deck { padding: 12px 12px 28px; }
    .deck-cols { gap: 16px; }

    .colhead { flex-wrap: wrap; row-gap: 6px; gap: 8px; }
    .colhead h2 { font-size: var(--t-body); }
    .ghost-btn { margin-left: auto; }
    .fleet-q { order: 3; flex: 1 1 100%; width: auto; margin-left: 0; }
    .viewseg { margin-left: auto; }

    /* decision cards */
    .tcard-head { flex-wrap: wrap; row-gap: 3px; padding: 9px 11px; }
    .ttitle { flex: 1 1 auto; }
    .tago { margin-left: auto; }
    .tmeta { order: 5; flex: 1 1 100%; }
    .tgroup { max-width: 100%; }
    .tbody { padding: 4px 11px; }
    .tbody-clamp.is-clamped { max-height: 260px; }
    /* Thumb band: the expected action spans the card, the others share the row under it, all
       above the 44px floor. */
    .tfoot { flex-wrap: wrap; gap: 8px; padding: 10px 11px 12px; }
    .tfoot > .tbtn { flex: 1 1 auto; justify-content: center; min-height: 44px; padding: 8px 12px; white-space: nowrap; }
    .tfoot > .tbtn:first-child { flex-basis: 100%; }
    .wheel-card { padding: 12px; }

    /* fleet: single column, and the archive / new-session buttons stay reachable */
    .fleet.grid { grid-template-columns: 1fr; }
    .fcard { padding: 11px 12px; }
    /* Sans survol, ces deux-là doivent être visibles en permanence — mais à demi-opacité le
       glyphe tombait à 2,0:1, sous le plancher de contraste non-textuel. Ils s'affichent en
       entier et c'est le ton, pas la transparence, qui les tient au second plan. */
    .fcard-act, .repo-plus { opacity: 1; color: var(--muted); }
    /* The archive action stays visible on touch: give it a real target and keep the age clear of it. */
    .fcard-act { width: 32px; height: 32px; top: 5px; right: 5px; }
    .fcard:has(.fcard-act) .frow1 { padding-right: 34px; }
    .fmsg { max-width: 100%; }
    .triage-empty { padding: 26px 12px; }
  }
</style>
