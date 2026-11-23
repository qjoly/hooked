/*
 * pi-claude-bridge's shadow transcripts (server/bridgeShadows.js): the Claude Code sessions the
 * bridge runs as the model of a pi session stay out of the Claude session list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-shadows-'));
process.env.HOOKED_DATA_DIR = path.join(TMP, 'data');
process.env.PI_CODING_AGENT_DIR = path.join(TMP, 'pi-agent');
const STATE_DIR = path.join(TMP, 'pi-agent', 'claude-bridge', 'sessions');

let mod;
beforeAll(async () => {
  fs.mkdirSync(process.env.HOOKED_DATA_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  mod = await import('../server/bridgeShadows.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const state = (name, ccSessionId) => fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify({ version: 1, ccSessionId, cwd: '/tmp/p', model: 'opus' }));
const session = (id, tools = {}) => ({ id, tools });

describe('bridge shadow sessions', () => {
  it('recognises a transcript that only called the bridge\'s MCP tools', () => {
    expect(mod.usesOnlyBridgeTools({ 'mcp__custom-tools__read': 2, 'mcp__custom-tools__bash': 1 })).toBe(true);
    expect(mod.usesOnlyBridgeTools({ 'mcp__custom-tools__read': 2, Bash: 1 })).toBe(false);
    expect(mod.usesOnlyBridgeTools({})).toBe(false); // undecided: the state file covers it
  });

  it('drops the sessions named by a state file, and still drops them once the state moved on', () => {
    state('s-aa.json', 'cc-1');
    fs.writeFileSync(path.join(STATE_DIR, 's-bb.json'), '{ half-written');
    const list = [session('cc-1'), session('mine', { Bash: 3 }), session('cc-old', { 'mcp__custom-tools__edit': 1 })];
    expect(mod.withoutBridgeShadows(list).map((s) => s.id)).toEqual(['mine']);

    // the bridge minted a fresh transcript: the state now names cc-2 only
    state('s-aa.json', 'cc-2');
    const later = fs.statSync(STATE_DIR).mtimeMs + 1000;
    fs.utimesSync(STATE_DIR, later / 1000, later / 1000);
    const ids = mod.bridgeShadowIds();
    expect(ids.has('cc-1')).toBe(true);
    expect(ids.has('cc-2')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.HOOKED_DATA_DIR, 'bridge-shadows.json'), 'utf8')).ids).toEqual(['cc-1', 'cc-2']);
  });

  it('reads the agent dirs of pi providers too', () => {
    const other = path.join(TMP, 'pi-work');
    fs.mkdirSync(path.join(other, 'claude-bridge', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(other, 'claude-bridge', 'sessions', 's-cc.json'), JSON.stringify({ ccSessionId: 'cc-work' }));
    expect(mod.bridgeShadowIds([other]).has('cc-work')).toBe(true);
  });
});
