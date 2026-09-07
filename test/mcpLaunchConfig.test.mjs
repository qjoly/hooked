/*
 * hookedMcpServer (server/agent.js) — the `hooked` MCP server entry injected into every SDK
 * launch (options.mcpServers), so that sessions started in OTHER repos still get the hooked tools
 * (reply/resolve review comments…). Guards: absolute path to an existing mcp/server.cjs,
 * HOOKED_PORT pinned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-mcplaunch-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;
process.env.HOOKED_PROJECTS_DIR = path.join(TMP, 'projects');

let agent;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(process.env.HOOKED_PROJECTS_DIR, { recursive: true });
  agent = await import('../server/agent.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('hookedMcpServer', () => {
  it('points at mcp/server.cjs by absolute path with HOOKED_PORT pinned', () => {
    const hooked = agent.hookedMcpServer();
    expect(hooked).not.toBeNull();
    expect(hooked.command).toBe('node');
    expect(hooked.args).toHaveLength(1);
    expect(path.isAbsolute(hooked.args[0])).toBe(true);
    expect(hooked.args[0].endsWith(path.join('mcp', 'server.cjs'))).toBe(true);
    expect(fs.existsSync(hooked.args[0])).toBe(true); // the proxy the session will actually spawn
    expect(hooked.env.HOOKED_PORT).toMatch(/^\d+$/);
  });

  it('is stable: a relaunch resolves the same server', () => {
    const first = agent.hookedMcpServer();
    const second = agent.hookedMcpServer();
    expect(second).toEqual(first);
  });
});
