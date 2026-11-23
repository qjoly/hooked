// Providers on the client side: labels, badges, colours and capabilities of every provider the
// server knows (built-ins `claude` / `pi` plus custom ones from settings.json — cf.
// server/providers.js, docs/providers.md). The list arrives with /api/sessions (`providerList`)
// and from /api/providers after a settings change; until then the built-ins fall back to the
// defaults below, so nothing renders blank on a cold load.
//
// The list is kept module-level (plain JS, importable from tests and from format.js). Components
// that must re-render when it changes pass `data.providerList` explicitly (the `list` argument),
// which makes their $derived track it.
//
// `p` (the second shape used here) is data.providers = { [id]: enabled } from /api/sessions.

const ALL_CAPS = [
  'permissions', 'questions', 'plan', 'modes', 'autoApprove', 'models', 'effort', 'resume', 'fork',
  'forkAtMessage', 'worktree', 'ephemeral', 'images', 'todos', 'subagents', 'backgroundJobs', 'workflows',
  'screenshots', 'subSessions', 'trace', 'search', 'trash', 'rateLimits', 'promptCache', 'commands',
  'skills', 'mcp', 'mcpLogin', 'memory', 'plugins', 'remoteControl', 'account',
];
const caps = (on) => Object.fromEntries(ALL_CAPS.map((k) => [k, on.includes(k)]));

// Defaults mirroring the server's built-in engines (used before the list arrives).
const FALLBACK = {
  claude: { id: 'claude', engine: 'claude', label: 'Claude', short: 'cc', color: null, mcpKind: 'claude', skillsKind: 'claude', capabilities: caps(ALL_CAPS) },
  pi: {
    id: 'pi', engine: 'pi', label: 'Pi', short: 'pi', color: null, mcpKind: 'pi', skillsKind: 'pi',
    capabilities: caps(['models', 'effort', 'resume', 'fork', 'forkAtMessage', 'worktree', 'trace', 'search', 'trash', 'promptCache', 'commands', 'skills', 'mcp']),
  },
};

let LIST = [];

export function setProviderList(list) {
  if (Array.isArray(list)) LIST = list;
}

export function providerListAll(list = LIST) {
  return list && list.length ? list : Object.values(FALLBACK);
}

// Info of one provider: from the server list, else the built-in fallback, else a neutral entry
// derived from the id (a session of a provider that was since removed from the settings).
export function providerInfo(id, list = LIST) {
  const pid = id || 'claude';
  const hit = (list || []).find((p) => p.id === pid);
  if (hit) return hit;
  if (FALLBACK[pid]) return FALLBACK[pid];
  const label = pid.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return { id: pid, engine: null, label, short: pid.slice(0, 2), color: null, capabilities: caps([]) };
}

export const providerLabel = (id, list = LIST) => providerInfo(id, list).label;
export const providerShort = (id, list = LIST) => providerInfo(id, list).short || String(id || '').slice(0, 2);
export const providerColor = (id, list = LIST) => providerInfo(id, list).color || null;
export const providerEngine = (id, list = LIST) => providerInfo(id, list).engine || (id === 'pi' ? 'pi' : 'claude');

// Inline style of a provider badge: its configured colour, if any (`--prov`, cf. .prov-badge).
export function providerBadgeStyle(id, list = LIST) {
  const c = providerColor(id, list);
  return c ? `--prov:${c}` : '';
}

// Does provider `id` support capability `cap`? (cf. CAPABILITY_KEYS in server/providerConfig.js)
export function can(id, cap, list = LIST) {
  const c = providerInfo(id, list).capabilities;
  return !!(c && c[cap]);
}

// Ids of the enabled providers, in settings order.
export function enabledProviderIds(p, list = LIST) {
  const order = providerListAll(list).map((x) => x.id);
  const ids = Object.keys(p || {}).filter((k) => p[k]);
  return [...order.filter((k) => ids.includes(k)), ...ids.filter((k) => !order.includes(k))];
}

// Per-session badges and the provider picker only make sense with more than one provider enabled:
// with a single one, a pill would teach nothing.
export function multiProvider(p) {
  return Object.values(p || {}).filter(Boolean).length > 1;
}

// Historical helper (claude AND pi enabled), kept for callers that still mean exactly that.
export function providersBoth(p) {
  return !!(p && p.claude && p.pi);
}

// Provider of a NEW session: the user's choice when it is enabled, else the first enabled one
// (claude first), else claude.
export function effectiveProvider(p, wanted) {
  if (wanted && p && p[wanted]) return wanted;
  if (p && p.claude) return 'claude';
  const first = Object.keys(p || {}).find((k) => p[k]);
  return first || 'claude';
}
