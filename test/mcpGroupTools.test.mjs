import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let server, base;
let respond = () => ({});
const requests = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const r = { method: req.method, url: req.url, body };
      requests.push(r);
      const { status = 200, data } = respond(r, requests.length - 1);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => server.close());

const rpc = (msg, env = {}) => new Promise((resolve, reject) => {
  const child = execFile('node', ['mcp/server.cjs'], {
    env: { ...process.env, HOOKED_MCP_URL: base, HOOKED_LAUNCH_KEY: '', ...env },
    timeout: 10_000,
  }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.split('\n')[0]).result)));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...msg }) + '\n');
});

const call = async (name, args, env) => {
  requests.length = 0;
  const result = await rpc({ method: 'tools/call', params: { name, arguments: args } }, env);
  return { result, data: result.isError ? null : JSON.parse(result.content[0].text) };
};

const metaReply = (meta) => ({ data: { ok: true, meta } });

describe('MCP session group tools', () => {
  it('are listed, and start_session takes a `group` opt-out', async () => {
    const { tools } = await rpc({ method: 'tools/list' });
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['group_sessions', 'ungroup_session', 'set_group_mother', 'rename_group']));
    expect(tools.find((t) => t.name === 'start_session').inputSchema.properties.group).toMatchObject({ type: 'boolean' });
  });

  it('group_sessions posts a join and answers with the resulting group only', async () => {
    respond = () => metaReply({ [B]: { groupOf: A, groupAt: 2 }, [C]: { groupOf: A, groupAt: 1 }, [A]: { groupName: 'Auth' } });
    const { data } = await call('group_sessions', { id: B, target: C });
    expect(requests).toEqual([{ method: 'POST', url: '/api/session-meta', body: { op: 'join', id: B, target: C } }]);
    expect(data).toEqual({ ok: true, group: {
      mother: A, name: 'Auth',
      members: [A, C, B].map((id) => ({ id, link: '/session/' + id })),
    } });
  });

  it('ungroup_session reads the group first, then reports what remains of it', async () => {
    respond = (_, i) => metaReply(i === 0
      ? { [B]: { groupOf: A, groupAt: 1 }, [C]: { groupOf: A, groupAt: 2 } }
      : { [C]: { groupOf: A, groupAt: 2 } });
    const { data } = await call('ungroup_session', { id: B });
    expect(requests.map((r) => r.method + ' ' + r.url)).toEqual(['GET /api/session-meta', 'POST /api/session-meta']);
    expect(requests[1].body).toEqual({ op: 'leave', id: B });
    expect(data.group).toMatchObject({ mother: A, name: null });
    expect(data.group.members.map((m) => m.id)).toEqual([A, C]);
  });

  it('ungroup_session on a mother follows the promoted heir', async () => {
    respond = (_, i) => metaReply(i === 0
      ? { [A]: { groupName: 'Auth' }, [B]: { groupOf: A, groupAt: 1 }, [C]: { groupOf: A, groupAt: 2 } }
      : { [B]: { groupName: 'Auth' }, [C]: { groupOf: B, groupAt: 2 } });
    const { data } = await call('ungroup_session', { id: A });
    expect(data.group).toMatchObject({ mother: B, name: 'Auth' });
    expect(data.group.members.map((m) => m.id)).toEqual([B, C]);
  });

  it('ungroup_session answers null once a single session is left', async () => {
    respond = (_, i) => metaReply(i === 0 ? { [B]: { groupOf: A, groupAt: 1 } } : {});
    expect((await call('ungroup_session', { id: B })).data).toEqual({ ok: true, group: null });
  });

  it('set_group_mother and rename_group post their op', async () => {
    respond = () => metaReply({});
    await call('set_group_mother', { id: B });
    expect(requests[0].body).toEqual({ op: 'mother', id: B });
    await call('rename_group', { id: B, name: 'Auth' });
    expect(requests[0].body).toEqual({ op: 'rename', id: B, name: 'Auth' });
  });

  it('relays an API error as a tool error', async () => {
    respond = () => ({ status: 500, data: { error: 'invalid session id' } });
    const { result } = await call('rename_group', { id: '', name: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid session id');
  });

  it('start_session keeps the caller key and forwards `group: false`', async () => {
    respond = () => ({ data: { sessionId: C, link: '/session/' + C } });
    await call('start_session', { cwd: '/tmp', group: false }, { HOOKED_LAUNCH_KEY: 'launch:k1' });
    expect(requests).toEqual([{ method: 'POST', url: '/api/launch', body: { cwd: '/tmp', group: false, parentKey: 'launch:k1' } }]);
  });
});
