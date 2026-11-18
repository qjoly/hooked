/*
 * The tool catalog a driven session sends to the model.
 *
 * The CLI never hands out the raw tool definitions, but two control requests on the `Query` cover
 * what the model actually receives:
 *   - `getContextUsage()` lists every tool the request carries, with its token cost and whether it
 *     is loaded in the prompt or deferred behind tool search (only the name is sent then);
 *   - `mcpServerStatus()` adds, per MCP server, the description and annotations of each tool.
 *
 * Not every CLI fills every field: some report no per-tool breakdown for built-ins and no MCP
 * descriptions. The `tools` list of `system/init` (names only) then supplies the built-ins, and the
 * category rows (`system_tools`, `mcp_tools`, their `_deferred` twins) supply the totals.
 *
 * `buildToolCatalog` merges all of it. It is PURE (tested without launching a session).
 */

// The CLI's wire name for an MCP tool: `mcp__<server>__<tool>`, with every character outside
// [A-Za-z0-9_-] replaced by `_` (the same normalization `getContextUsage().mcpTools` applies).
const normalizeMcpName = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
const mcpWireName = (server, tool) => `mcp__${normalizeMcpName(server)}__${normalizeMcpName(tool)}`;

const num = (n) => (Number.isFinite(n) ? n : 0);

/**
 * @param {object} p
 * @param {object} [p.ctx]        getContextUsage() response
 * @param {object[]} [p.servers]  mcpServerStatus() response
 * @param {string[]} [p.initTools] `tools` of the session's system/init message
 * @returns {{ builtin: object[], mcp: object[], totals: object }}
 */
function buildToolCatalog({ ctx, servers, initTools } = {}) {
  const builtin = [];
  const seen = new Set();
  for (const t of (ctx && ctx.systemTools) || []) {
    if (!t || !t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    builtin.push({ name: t.name, tokens: num(t.tokens), deferred: false });
  }
  for (const t of (ctx && ctx.deferredBuiltinTools) || []) {
    if (!t || !t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    builtin.push({ name: t.name, tokens: num(t.tokens), deferred: !t.isLoaded });
  }
  // Names only: cost and loaded state unknown (null), the CLI did not break them down.
  for (const name of initTools || []) {
    if (typeof name !== 'string' || name.startsWith('mcp__') || seen.has(name)) continue;
    seen.add(name);
    builtin.push({ name, tokens: null, deferred: null });
  }
  builtin.sort((a, b) => a.name.localeCompare(b.name));

  // Context-usage rows, keyed by wire name, carry the cost and the loaded/deferred state.
  const usageByWire = new Map();
  for (const t of (ctx && ctx.mcpTools) || []) if (t && t.name) usageByWire.set(t.name, t);

  const mcp = [];
  const claimed = new Set();
  for (const s of servers || []) {
    if (!s || !s.name) continue;
    const tools = (s.tools || []).filter((t) => t && t.name).map((t) => {
      const wire = mcpWireName(s.name, t.name);
      const u = usageByWire.get(wire);
      if (u) claimed.add(wire);
      return {
        name: t.name,
        wireName: wire,
        description: t.description || '',
        annotations: t.annotations || null,
        tokens: u ? num(u.tokens) : null,
        deferred: u ? u.isLoaded === false : null,
      };
    });
    mcp.push({ name: s.name, status: s.status || null, scope: s.scope || s.source || null, tools });
  }

  // Tools the context report lists but no server status explains (a server that went away
  // between the two requests, or a name normalized differently): keep them, they are still sent.
  const orphans = new Map();
  for (const [wire, u] of usageByWire) {
    if (claimed.has(wire)) continue;
    const server = u.serverName || wire.split('__')[1] || '?';
    if (!orphans.has(server)) orphans.set(server, []);
    const prefix = `mcp__${server}__`;
    orphans.get(server).push({
      name: wire.startsWith(prefix) ? wire.slice(prefix.length) : wire,
      wireName: wire, description: '', annotations: null,
      tokens: num(u.tokens), deferred: u.isLoaded === false,
    });
  }
  for (const [name, tools] of orphans) {
    const existing = mcp.find((s) => normalizeMcpName(s.name) === name);
    if (existing) existing.tools.push(...tools);
    else mcp.push({ name, status: null, scope: null, tools });
  }

  for (const s of mcp) s.tools.sort((a, b) => a.name.localeCompare(b.name));
  mcp.sort((a, b) => a.name.localeCompare(b.name));

  const all = [...builtin, ...mcp.flatMap((s) => s.tools)];
  // Token totals: the category rows when the CLI reports them (they count every tool, broken
  // down or not), else the sum of the per-tool rows.
  const cat = (id) => {
    const row = ((ctx && ctx.categories) || []).find((c) => c && c.id === id);
    return row ? num(row.tokens) : null;
  };
  const sumTools = (deferred) => all.reduce((n, t) => n + (t.deferred === deferred ? num(t.tokens) : 0), 0);
  const both = (a, b) => (a == null && b == null ? null : num(a) + num(b));
  const totals = {
    count: all.length,
    inPrompt: all.filter((t) => t.deferred === false).length,
    deferred: all.filter((t) => t.deferred === true).length,
    tokens: both(cat('system_tools'), cat('mcp_tools')) ?? sumTools(false),
    deferredTokens: both(cat('system_tools_deferred'), cat('mcp_tools_deferred')) ?? sumTools(true),
  };
  return { builtin, mcp, totals };
}

export { buildToolCatalog, mcpWireName };
