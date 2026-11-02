import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-gw-'));
let server, gw, calls = [];

beforeAll(async () => {
  // A fake gateway: bearer + session id required, the tool reply comes back as SSE.
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      calls.push({ method: msg.method, auth: req.headers.authorization, sid: req.headers['mcp-session-id'] });
      if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end(); }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      }
      if (!msg.id) { res.writeHead(202); return res.end(); }
      if (req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(404); return res.end(); }
      const text = JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: { a: '1' }, value: [1, '42'] }] } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.HOOKED_DATA_DIR = dir;
  process.env.HOOKED_GRAFANA_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  fs.writeFileSync(path.join(dir, 'grafana-gateway.json'), JSON.stringify({
    url: process.env.HOOKED_GRAFANA_MCP_URL, tokens: { access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 },
  }));
  gw = await import('../server/grafanaGateway.js');
});
afterAll(() => server?.close());

describe('mcp-gateway client', () => {
  it('opens a session, then runs the query with it', async () => {
    const d = await gw.runQuery({ tool: 'prometheus', datasource: 'mimir-prod', query: 'up', range: '1h' });
    expect(d).toEqual({ kind: 'table', rows: [{ label: '{a="1"}', value: 42 }] });
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(calls[2].sid).toBe('sess-1');
    expect(gw.status().connected).toBe(true);
  });

  it('turns a relative range into start/end ending now', () => {
    const args = gw.toolArgs({ datasource: 'd', query: 'q', range: '6h', step: '5m' }, Date.parse('2026-01-01T06:00:00Z'));
    expect(args).toEqual({ datasource: 'd', query: 'q', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T06:00:00.000Z', step: '5m' });
    expect(gw.durationSec('90s')).toBe(90);
    expect(gw.durationSec('soon')).toBeNull();
  });

  it('asks for a sign-in when there is no token', async () => {
    fs.writeFileSync(path.join(dir, 'grafana-gateway.json'), '{}');
    await expect(gw.runQuery({ tool: 'loki', datasource: 'l', query: '{a="b"}' })).rejects.toMatchObject({ login: true });
  });
});
