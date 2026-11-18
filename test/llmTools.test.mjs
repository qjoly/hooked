import { describe, it, expect } from 'vitest';
import { buildToolCatalog, mcpWireName } from '../server/llmTools.js';

describe('buildToolCatalog', () => {
  it('merges context usage and MCP status', () => {
    const ctx = {
      systemTools: [{ name: 'Bash', tokens: 1200 }, { name: 'Read', tokens: 400 }],
      deferredBuiltinTools: [{ name: 'NotebookEdit', tokens: 300, isLoaded: false }],
      mcpTools: [
        { name: 'mcp__hooked__list_sessions', serverName: 'hooked', tokens: 150, isLoaded: true },
        { name: 'mcp__my_srv__ping', serverName: 'my_srv', tokens: 50, isLoaded: false },
        { name: 'mcp__gone__x', serverName: 'gone', tokens: 10 },
      ],
    };
    const servers = [
      { name: 'hooked', status: 'connected', scope: 'dynamic', tools: [{ name: 'list_sessions', description: 'List sessions' }] },
      { name: 'my.srv', status: 'connected', tools: [{ name: 'ping', annotations: { readOnly: true } }] },
      { name: 'broken', status: 'failed' },
    ];
    const c = buildToolCatalog({ ctx, servers });
    expect(c.builtin.map((t) => [t.name, t.deferred])).toEqual([['Bash', false], ['NotebookEdit', true], ['Read', false]]);
    const hooked = c.mcp.find((s) => s.name === 'hooked');
    expect(hooked.tools[0]).toMatchObject({ name: 'list_sessions', description: 'List sessions', tokens: 150, deferred: false });
    expect(c.mcp.find((s) => s.name === 'my.srv').tools[0]).toMatchObject({ wireName: 'mcp__my_srv__ping', deferred: true });
    expect(c.mcp.find((s) => s.name === 'broken').tools).toEqual([]);
    expect(c.mcp.find((s) => s.name === 'gone').tools[0]).toMatchObject({ name: 'x', tokens: 10, deferred: false });
    expect(c.totals).toEqual({ count: 6, inPrompt: 4, deferred: 2, tokens: 1200 + 400 + 150 + 10, deferredTokens: 350 });
  });

  it('falls back to init tool names and category totals', () => {
    const ctx = {
      categories: [{ id: 'system_tools', tokens: 1207 }, { id: 'mcp_tools', tokens: 559 }, { id: 'system_tools_deferred', tokens: 16383 }],
      mcpTools: [{ name: 'mcp__a__b', serverName: 'a', tokens: 9, isLoaded: false }],
    };
    const c = buildToolCatalog({ ctx, initTools: ['Read', 'Bash', 'mcp__a__b'] });
    expect(c.builtin).toEqual([{ name: 'Bash', tokens: null, deferred: null }, { name: 'Read', tokens: null, deferred: null }]);
    expect(c.totals).toMatchObject({ count: 3, inPrompt: 0, deferred: 1, tokens: 1766, deferredTokens: 16383 });
  });

  it('survives missing payloads', () => {
    expect(buildToolCatalog({})).toEqual({ builtin: [], mcp: [], totals: { count: 0, inPrompt: 0, deferred: 0, tokens: 0, deferredTokens: 0 } });
    expect(mcpWireName('claude.ai Slack', 'send')).toBe('mcp__claude_ai_Slack__send');
  });
});
