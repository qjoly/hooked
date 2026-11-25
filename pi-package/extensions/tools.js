/*
 * hooked's agent tools as native pi tools. The definitions are the MCP server's (mcp/server.cjs for
 * the core, modules/<id>/tools.cjs for a module): `{ name, description, inputSchema, run }`, where
 * `run` calls hooked's HTTP API. Each becomes `hooked_<name>`, which the permission gate of the
 * hooked package always allows (extensions/hooked.js).
 */
export function registerHookedTools(pi, tools, resultFrom) {
  for (const t of tools || []) {
    pi.registerTool({
      name: 'hooked_' + t.name,
      label: 'hooked · ' + t.name,
      description: t.description,
      parameters: t.inputSchema || { type: 'object', properties: {} },
      async execute(_id, params) {
        const res = resultFrom(await t.run(params || {}));
        return { content: res.content, details: undefined, ...(res.isError ? { isError: true } : {}) };
      },
    });
  }
}
