/*
 * writeMcpLaunchConfig (server/tmux.js) — the MCP config passed to every `claude --mcp-config`
 * at launch, so that sessions started in OTHER repos still get the hooked tools (reply/resolve
 * review comments…). Guards: absolute path to an existing mcp/server.cjs, HOOKED_PORT pinned,
 * file written inside the data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-mcplaunch-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;
process.env.HOOKED_PROJECTS_DIR = path.join(TMP, 'projects');

let tmux;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(process.env.HOOKED_PROJECTS_DIR, { recursive: true });
  tmux = await import('../server/tmux.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('writeMcpLaunchConfig', () => {
  it('writes a config in the data dir pointing at mcp/server.cjs by absolute path', () => {
    const file = tmux.writeMcpLaunchConfig();
    expect(file).toBe(path.join(TMP, 'mcp-launch.json'));
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hooked = cfg.mcpServers.hooked;
    expect(hooked.command).toBe('node');
    expect(hooked.args).toHaveLength(1);
    expect(path.isAbsolute(hooked.args[0])).toBe(true);
    expect(hooked.args[0].endsWith(path.join('mcp', 'server.cjs'))).toBe(true);
    expect(fs.existsSync(hooked.args[0])).toBe(true); // the proxy the session will actually spawn
    expect(hooked.env.HOOKED_PORT).toMatch(/^\d+$/);
  });

  it('is idempotent: a relaunch rewrites the same file', () => {
    const first = tmux.writeMcpLaunchConfig();
    const second = tmux.writeMcpLaunchConfig();
    expect(second).toBe(first);
    expect(() => JSON.parse(fs.readFileSync(second, 'utf8'))).not.toThrow();
  });
});
