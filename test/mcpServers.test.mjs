/*
 * MCP servers hooked adds to a session (server/mcpServers.js): the common ones from mcp-common.json,
 * the ones dedicated to a profile, how they are validated, resolved and described. Pure, or on a
 * tmpdir: no session is launched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMcpServerMap, loadCommonMcp, mcpServersOf, injectedMcpFor, describeInjectedMcp, MCP_RESERVED_NAMES,
} from '../server/mcpServers.js';
import { parseSecretValue, resolveSecretMap } from '../server/secretValues.js';
import { parseProfiles } from '../server/profiles.js';
import { injectedRows } from '../server/mcp.js';

const STDIO = { command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: { fromEnv: 'SOME_TOKEN' }, MODE: 'fast' } };
const HTTP = { type: 'http', url: 'https://wiki.example.com/mcp?key=SECRET', headers: { Authorization: { fromEnv: 'WIKI_TOKEN' } } };

const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-mcpcommon-'));
  const file = path.join(dir, 'mcp-common.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

describe('parseSecretValue / resolveSecretMap', () => {
  it('accepts a literal (even empty) and the two references, and normalizes them', () => {
    expect(parseSecretValue('x')).toEqual({ value: 'x' });
    expect(parseSecretValue('')).toEqual({ value: '' });
    expect(parseSecretValue({ fromEnv: 'A_B' })).toEqual({ value: { fromEnv: 'A_B' } });
    expect(parseSecretValue({ file: '~/t' })).toEqual({ value: { file: '~/t' } });
  });

  it.each([[1], [null], [['x']], [{}], [{ fromEnv: 'a b' }], [{ file: 'rel' }], [{ fromEnv: 'A', file: '/f' }], [{ cmd: 'x' }]])('rejects %j', (v) => {
    expect(parseSecretValue(v).error).toBeTruthy();
  });

  it('resolves literals, variables and files, naming what fails and never a value', () => {
    const r = resolveSecretMap(
      { A: 'lit', B: { fromEnv: 'SET' }, C: { fromEnv: 'UNSET' }, D: { file: '/ok' }, E: { file: '/missing' } },
      { env: { SET: 'v' }, readFile: (f) => { if (f === '/ok') return 'secret\n'; throw new Error('ENOENT'); } },
    );
    expect(r.values).toEqual({ A: 'lit', B: 'v', D: 'secret' });
    expect(r.errors).toEqual(['C: $UNSET is not set', 'E: /missing is missing or empty']);
  });
});

describe('parseMcpServerMap', () => {
  it('reads a stdio server, with or without its type, and an http one', () => {
    const { servers, errors } = parseMcpServerMap({ a: STDIO, b: { type: 'stdio', command: 'node' }, c: HTTP, d: { type: 'sse', url: 'http://x/sse' } });
    expect(errors).toEqual([]);
    expect(servers.a).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: { fromEnv: 'SOME_TOKEN' }, MODE: 'fast' } });
    expect(servers.b).toEqual({ type: 'stdio', command: 'node' });
    expect(servers.c.type).toBe('http');
    expect(servers.d).toEqual({ type: 'sse', url: 'http://x/sse' });
  });

  it.each([
    ['a non-object', 'nope', /must be an object/],
    ['no command', {}, /"command" is required/],
    ['an empty command', { command: '  ' }, /"command" is required/],
    ['args that are not strings', { command: 'x', args: [1] }, /"args" must be an array of strings/],
    ['a bad env name', { command: 'x', env: { 'A-B': '1' } }, /invalid env name/],
    ['a bad env value', { command: 'x', env: { A: 1 } }, /env A:/],
    ['an unknown key', { command: 'x', cwd: '/tmp' }, /unknown key "cwd"/],
    ['a url on a stdio server', { command: 'x', url: 'http://x' }, /unknown key "url"/],
    ['an unknown type', { type: 'ws', url: 'http://x' }, /"type" must be/],
    ['a url that is not http(s)', { type: 'http', url: 'file:///etc/passwd' }, /http\(s\) URL/],
    ['a command on an http server', { type: 'http', url: 'http://x', command: 'x' }, /unknown key "command"/],
    ['a bad header name', { type: 'http', url: 'http://x', headers: { 'X Y': 'v' } }, /invalid headers name/],
  ])('skips and names %s', (_n, cfg, message) => {
    const { servers, errors } = parseMcpServerMap({ bad: cfg });
    expect(servers).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^server "bad": /);
    expect(errors[0]).toMatch(message);
  });

  it('skips an invalid name and the name reserved for hooked\'s own server, keeping the others', () => {
    expect(MCP_RESERVED_NAMES).toContain('hooked');
    const { servers, errors } = parseMcpServerMap({ 'bad name': STDIO, hooked: STDIO, ok: STDIO });
    expect(Object.keys(servers)).toEqual(['ok']);
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).toMatch(/invalid name/);
    expect(errors.join(' ')).toMatch(/reserved for hooked/);
  });

  it('rejects something that is not an object of servers', () => {
    for (const raw of [null, [], 'x', 3]) expect(parseMcpServerMap(raw).errors).toEqual(['"mcpServers" must be an object']);
  });
});

describe('loadCommonMcp', () => {
  it('is no server and no error when the file does not exist', () => {
    expect(loadCommonMcp(path.join(os.tmpdir(), 'hooked-no-such-dir', 'mcp-common.json'))).toEqual({ servers: {}, errors: [] });
  });

  it('reads the shape of a project\'s .mcp.json', () => {
    const { servers, errors } = loadCommonMcp(tmpFile({ mcpServers: { a: STDIO } }));
    expect(errors).toEqual([]);
    expect(Object.keys(servers)).toEqual(['a']);
  });

  it('reads the file on every call, so an edit shows up at the next launch', () => {
    const file = tmpFile({ mcpServers: { a: STDIO } });
    expect(Object.keys(loadCommonMcp(file).servers)).toEqual(['a']);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { b: STDIO } }));
    expect(Object.keys(loadCommonMcp(file).servers)).toEqual(['b']);
  });

  it('never throws: invalid JSON, another shape, or a directory', () => {
    expect(loadCommonMcp(tmpFile('{ nope')).errors[0]).toMatch(/not valid JSON/);
    expect(loadCommonMcp(tmpFile({ servers: {} })).errors[0]).toMatch(/"mcpServers" key/);
    expect(loadCommonMcp(tmpFile([])).errors[0]).toMatch(/"mcpServers" key/);
    expect(loadCommonMcp(path.dirname(tmpFile({}))).errors[0]).toMatch(/cannot read/);
  });

  it('keeps the valid entries around a bad one, and reports it', () => {
    const { servers, errors } = loadCommonMcp(tmpFile({ mcpServers: { ok: STDIO, broken: { command: '' } } }));
    expect(Object.keys(servers)).toEqual(['ok']);
    expect(errors).toEqual([expect.stringMatching(/server "broken"/)]);
  });
});

describe('mcpServersOf', () => {
  const file = tmpFile({ mcpServers: { shared: { command: 'common-version' }, onlyCommon: { command: 'c' } } });
  const profile = (extra) => ({ id: 'p', kind: 'anthropic', env: {}, ...extra });
  const own = { shared: { type: 'stdio', command: 'profile-version' }, onlyOwn: { type: 'stdio', command: 'o' } };

  it('gives every profile the common servers, the default one included', () => {
    expect(Object.keys(mcpServersOf(null, { file }).servers).sort()).toEqual(['onlyCommon', 'shared']);
    expect(Object.keys(mcpServersOf(profile({}), { file }).servers).sort()).toEqual(['onlyCommon', 'shared']);
  });

  it('adds a profile\'s own servers, which win on a name they share with a common one', () => {
    const r = mcpServersOf(profile({ mcpServers: own }), { file });
    expect(Object.keys(r.servers).sort()).toEqual(['onlyCommon', 'onlyOwn', 'shared']);
    expect(r.servers.shared.command).toBe('profile-version');
    expect(r.sources).toEqual({ onlyCommon: 'common', shared: 'profile', onlyOwn: 'profile' });
  });

  it('leaves the common servers out of a profile that opts out, keeping its own', () => {
    const r = mcpServersOf(profile({ commonMcp: false, mcpServers: own }), { file });
    expect(Object.keys(r.servers).sort()).toEqual(['onlyOwn', 'shared']);
    expect(r.servers.shared.command).toBe('profile-version');
  });

  it('carries the warnings of a common file with skipped entries', () => {
    const f = tmpFile({ mcpServers: { broken: {} } });
    expect(mcpServersOf(null, { file: f }).warnings).toHaveLength(1);
    expect(mcpServersOf(profile({ commonMcp: false }), { file: f }).warnings).toEqual([]);
  });
});

describe('injectedMcpFor', () => {
  const profile = { id: 'p', kind: 'anthropic', env: {}, commonMcp: false, mcpServers: parseMcpServerMap({ a: STDIO, w: HTTP }).servers };

  it('resolves env and headers against the login environment, ready for the SDK', () => {
    const r = injectedMcpFor(profile, { env: { SOME_TOKEN: 'tok-1', WIKI_TOKEN: 'tok-2' } });
    expect(r.errors).toEqual([]);
    expect(r.servers.a).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: 'tok-1', MODE: 'fast' } });
    expect(r.servers.w).toEqual({ type: 'http', url: 'https://wiki.example.com/mcp?key=SECRET', headers: { Authorization: 'tok-2' } });
  });

  it('refuses a server whose reference does not resolve, naming it and the variable, never a value', () => {
    const r = injectedMcpFor(profile, { env: { SOME_TOKEN: 'sk-secret-value' } });
    expect(r.errors).toEqual(['MCP server "w": Authorization: $WIKI_TOKEN is not set']);
    expect(Object.keys(r.servers)).toEqual(['a']);
    expect(JSON.stringify(r.errors)).not.toContain('sk-secret-value');
  });

  it('is empty, with nothing to resolve, when there are no servers at all', () => {
    expect(injectedMcpFor({ id: 'p', env: {}, commonMcp: false }, { env: {} })).toEqual({ servers: {}, errors: [], warnings: [] });
  });
});

describe('describeInjectedMcp and the lens rows', () => {
  const profile = { id: 'p', kind: 'anthropic', env: {}, commonMcp: false, mcpServers: parseMcpServerMap({ a: STDIO, w: HTTP }).servers };

  it('describes each server without resolving anything, and without a secret', () => {
    const { servers } = describeInjectedMcp(profile);
    expect(servers).toEqual([
      { name: 'a', transport: 'stdio', scope: 'profile', summary: 'npx -y some-mcp' },
      { name: 'w', transport: 'http', scope: 'profile', summary: 'https://wiki.example.com/mcp' },
    ]);
    const text = JSON.stringify(servers);
    for (const secret of ['SECRET', 'SOME_TOKEN', 'WIKI_TOKEN', 'Authorization', 'fast']) expect(text).not.toContain(secret);
  });

  it('labels where a server comes from', () => {
    const file = tmpFile({ mcpServers: { c: { command: 'c' } } });
    const { servers } = describeInjectedMcp({ id: 'p', env: {}, mcpServers: { o: { type: 'stdio', command: 'o' } } }, { file });
    expect(servers.map((s) => [s.name, s.scope])).toEqual([['c', 'common'], ['o', 'profile']]);
  });

  it('turns them into rows of the lens, flagged when the account already has the name', () => {
    const { rows } = injectedRows(profile, [{ name: 'a' }, { name: 'other' }]);
    expect(rows.map((r) => [r.name, r.clash])).toEqual([['a', true], ['w', false]]);
    for (const r of rows) {
      expect(r).toMatchObject({ state: 'injected', injected: true, authable: false, scopeLabel: 'Profile' });
    }
    expect(rows[0].target).toBe('npx -y some-mcp');
  });
});

describe('mcpServers and commonMcp in profiles.json', () => {
  const parse = (entry) => parseProfiles([{ id: 'p', kind: 'anthropic', ...entry }], { home: '/h', mainDir: '/h/.claude' });

  it('keeps the dedicated servers, validated, on the profile', () => {
    const r = parse({ mcpServers: { a: STDIO } });
    expect(r.errors).toEqual([]);
    expect(r.profiles[1].mcpServers.a.command).toBe('npx');
  });

  it('works on a compatible profile too', () => {
    const r = parseProfiles([{ id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' }, mcpServers: { a: { command: 'node' } } }]);
    expect(r.errors).toEqual([]);
    expect(r.profiles[1].mcpServers.a.type).toBe('stdio');
  });

  it('skips the profile, naming the server, when one of its servers is invalid', () => {
    const r = parse({ mcpServers: { a: STDIO, bad: { command: '' } } });
    expect(r.profiles).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^profile #1 \(p\): mcpServers: server "bad": "command" is required/);
  });

  it('keeps commonMcp only when it is false, and rejects anything but a boolean', () => {
    expect(parse({ commonMcp: false }).profiles[1].commonMcp).toBe(false);
    expect(parse({ commonMcp: true }).profiles[1]).not.toHaveProperty('commonMcp');
    expect(parse({}).profiles[1]).not.toHaveProperty('commonMcp');
    expect(parse({ commonMcp: 'no' }).errors[0]).toMatch(/"commonMcp" must be true or false/);
  });

  it('has no mcpServers on a profile that declares none, or an empty object', () => {
    expect(parse({}).profiles[1]).not.toHaveProperty('mcpServers');
    expect(parse({ mcpServers: {} }).profiles[1]).not.toHaveProperty('mcpServers');
  });
});
