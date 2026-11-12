import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { normalizePanel, showPanel, closePanel, listPanels, panelMessage, sendFromPanel, reportPanelError, PANEL_LIMITS } from '../server/panels.js';

const SRC = 'return { render = function() return nil end }';

describe('normalizePanel', () => {
  it('takes inline source as init.luau', () => {
    const { panel } = normalizePanel({ id: 'board', source: SRC, state: { n: 1 } });
    expect(panel).toMatchObject({ id: 'board', title: 'board', files: { 'init.luau': SRC }, state: { n: 1 }, rev: 1, sourceRev: 1 });
  });

  it('updates state without resending the source', () => {
    const first = normalizePanel({ id: 'b', source: SRC, state: { n: 1 }, title: 'T' }).panel;
    const { panel } = normalizePanel({ id: 'b', state: { n: 2 } }, first);
    expect(panel).toMatchObject({ files: first.files, state: { n: 2 }, title: 'T', rev: 2, sourceRev: 1 });
    expect(normalizePanel({ id: 'b', source: SRC + ' ' }, panel).panel).toMatchObject({ rev: 3, sourceRev: 2, state: { n: 2 } });
    expect(normalizePanel({ id: 'b', source: SRC }, panel).panel.sourceRev).toBe(1);
  });

  it('refuses what the sandbox should never see', () => {
    expect(normalizePanel({ id: 'x' }).error).toMatch(/source/);
    expect(normalizePanel({ id: '../x', source: SRC }).error).toMatch(/id/);
    expect(normalizePanel({ source: SRC, files: { 'init.luau': SRC } }).error).toMatch(/either/);
    expect(normalizePanel({ files: { 'a.luau': SRC } }).error).toMatch(/init\.luau/);
    expect(normalizePanel({ files: { 'init.luau': SRC, '../etc.luau': SRC } }).error).toMatch(/relative/);
    expect(normalizePanel({ files: { 'init.luau': SRC, '/abs.luau': SRC } }).error).toMatch(/relative/);
    expect(normalizePanel({ source: 'x'.repeat(PANEL_LIMITS.sourceBytes + 1) }).error).toMatch(/limit/);
    expect(normalizePanel({ source: SRC, state: { s: 'x'.repeat(PANEL_LIMITS.stateBytes) } }).error).toMatch(/limit/);
    expect(normalizePanel({ files: { 'init.luau': SRC, 'lib/rows.luau': SRC } }).panel.files).toHaveProperty('lib/rows.luau');
  });
});

describe('panel registry', () => {
  it('keys panels by session and id, and closes them', () => {
    showPanel('s1', { id: 'p', source: SRC });
    showPanel('s2', { id: 'p', source: SRC });
    expect(showPanel('s1', { id: 'p', state: [1] }).panel).toMatchObject({ session: 's1', rev: 2, state: [1] });
    expect(listPanels().filter((p) => p.id === 'p')).toHaveLength(2);
    expect(closePanel('s1', 'p')).toBe(true);
    expect(closePanel('s1', 'p')).toBe(false);
    closePanel('s2', 'p');
  });

  it('sends only for a known panel of a driven session', async () => {
    expect((await sendFromPanel('nope', 'p', { label: 'Go' })).code).toBe(404);
    showPanel(null, { id: 'orphan', source: SRC });
    expect((await sendFromPanel(null, 'orphan', { label: 'Go' })).code).toBe(409);
    closePanel(null, 'orphan');
  });

  it('hands a script error to the next show_panel call, once', () => {
    showPanel('s3', { id: 'e', source: SRC });
    expect(reportPanelError('s3', 'e', 1, '  init.luau:1: syntax error  ')).toBe(true);
    expect(reportPanelError('s3', 'nope', 1, 'x')).toBe(false);
    expect(reportPanelError('s3', 'e', 1, '   ')).toBe(false);
    expect(showPanel('s3', { id: 'e', source: SRC + ' ' }).previousError).toEqual({ rev: 1, message: 'init.luau:1: syntax error' });
    expect(showPanel('s3', { id: 'e', state: 1 }).previousError).toBeNull();
    reportPanelError('s3', 'e', 3, 'x'.repeat(5000));
    expect(showPanel('s3', { id: 'e', state: 2 }).previousError.message).toHaveLength(1000);
    closePanel('s3', 'e');
  });

  it('tells the session it was a click on a button, not typed text', () => {
    expect(panelMessage({ id: 'b' }, 'Looks good', { action: 'approve' })).toBe(
      '[hooked panel] The user clicked the button "Looks good" in panel "b", which you drew with show_panel. It sent: {"action":"approve"}',
    );
    expect(panelMessage({ id: 'b' }, 'Skip', null)).toBe('[hooked panel] The user clicked the button "Skip" in panel "b", which you drew with show_panel.');
  });
});

describe('show_panel MCP tool', () => {
  let server, base;
  let nextError = null;
  const requests = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, id: 'board', rev: 2, session: 'abc', previousError: nextError }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => server.close());

  const rpc = (msg, env = { HOOKED_SHOW_PANELS: '1' }) => new Promise((resolve, reject) => {
    const child = execFile('node', ['mcp/server.cjs'], {
      env: { ...process.env, HOOKED_MCP_URL: base, HOOKED_LAUNCH_KEY: 'k1', ...env },
      timeout: 10_000,
    }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.split('\n')[0]).result)));
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...msg }) + '\n');
  });

  it('is listed only with the interactive panels setting on', async () => {
    expect((await rpc({ method: 'tools/list' }, { HOOKED_SHOW_PANELS: '' })).tools.map((t) => t.name)).not.toContain('show_panel');
  });

  it('posts the panel with the caller launch key', async () => {
    const { tools } = await rpc({ method: 'tools/list' });
    expect(tools.map((t) => t.name)).toContain('show_panel');
    requests.length = 0;
    const r = await rpc({ method: 'tools/call', params: { name: 'show_panel', arguments: { id: 'board', source: SRC, state: { n: 1 } } } });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/Panel "board" shown/);
    expect(requests).toEqual([{ url: '/api/panel', body: { op: 'show', input: { id: 'board', source: SRC, state: { n: 1 } }, launchKey: 'k1' } }]);
  });

  it('reports the previous version\'s error in its result', async () => {
    nextError = { rev: 1, message: 'init.luau:3: attempt to index nil' };
    const r = await rpc({ method: 'tools/call', params: { name: 'show_panel', arguments: { id: 'board', state: { n: 2 } } } });
    nextError = null;
    expect(r.content[0].text).toMatch(/previous version \(rev 1\) failed in the app: init\.luau:3: attempt to index nil/);
  });

  it('describes the colours and carries a full example', async () => {
    const { tools } = await rpc({ method: 'tools/list' });
    const d = tools.find((t) => t.name === 'show_panel').description;
    for (const c of ['text-muted', 'success-bg', 'danger', 'border-weak']) expect(d).toContain(c);
    expect(d).toMatch(/```luau\n[\s\S]*actions = function\(\)[\s\S]*```/);
  });

  it('closes', async () => {
    requests.length = 0;
    await rpc({ method: 'tools/call', params: { name: 'show_panel', arguments: { id: 'board', close: true } } });
    expect(requests[0].body).toEqual({ op: 'close', id: 'board', launchKey: 'k1' });
  });
});
