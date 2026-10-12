#!/usr/bin/env node
'use strict';
// Builds a fictional, English-only dataset for the README screenshots (see scripts/screenshots.mjs).
// Timestamps are relative to now, so regenerate right before capturing.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = process.env.HOOKED_DEMO_DIR || path.join(os.tmpdir(), 'hooked-demo');
const PROJECTS = path.join(ROOT, 'projects');
const DATA = path.join(ROOT, 'data');
const CODE = path.join(ROOT, 'code');
fs.rmSync(ROOT, { recursive: true, force: true });
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const writeJsonl = (fp, rows) => { mkdirp(path.dirname(fp)); fs.writeFileSync(fp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
const writeFile = (fp, c) => { mkdirp(path.dirname(fp)); fs.writeFileSync(fp, c); };

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60e3, H = 60 * MIN, D = 24 * H;
const projDir = (cwd) => path.join(PROJECTS, cwd.replace(/[/.]/g, '-'));

// Real git repos so the Review lens and the branch chips have something to show.
const repos = {
  'acme-api': {
    'package.json': '{\n  "name": "acme-api",\n  "version": "1.4.0",\n  "type": "module"\n}\n',
    'src/server.js': "import http from 'node:http';\nimport { router } from './router.js';\n\nhttp.createServer(router).listen(process.env.PORT || 3000);\n",
    'src/router.js': "export function router(req, res) {\n  if (req.url === '/health') return res.end('ok');\n  res.statusCode = 404;\n  res.end();\n}\n",
    'src/auth/session.js': "export function verifySession(token) {\n  return token && token.length > 10;\n}\n",
    'README.md': '# acme-api\n\nPublic REST API for Acme.\n',
  },
  storefront: {
    'package.json': '{\n  "name": "storefront",\n  "private": true\n}\n',
    'src/routes/+page.svelte': '<h1>Storefront</h1>\n',
    'src/lib/cart.js': 'export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n',
  },
  'infra-k8s': {
    'charts/api/values.yaml': 'replicaCount: 2\nresources:\n  requests:\n    cpu: 100m\n    memory: 128Mi\n',
    'charts/api/Chart.yaml': 'apiVersion: v2\nname: api\nversion: 0.3.1\n',
  },
  'docs-site': {
    'docs/index.md': '# Acme docs\n',
    'astro.config.mjs': 'export default {};\n',
  },
};
for (const [name, files] of Object.entries(repos)) {
  const dir = path.join(CODE, name);
  for (const [f, c] of Object.entries(files)) writeFile(path.join(dir, f), c);
  const g = (cmd) => execSync(cmd, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });
  g('git init -q -b main && git add -A && git commit -q -m "Initial commit"');
}
// Uncommitted work in acme-api, as Claude would leave it mid-task.
writeFile(path.join(CODE, 'acme-api/src/auth/session.js'), [
  "import { createHmac, timingSafeEqual } from 'node:crypto';",
  '',
  'const SECRET = process.env.SESSION_SECRET;',
  '',
  '// Tokens are `<payload>.<signature>`; compare in constant time to avoid timing leaks.',
  'export function verifySession(token) {',
  "  if (typeof token !== 'string') return false;",
  "  const [payload, sig] = token.split('.');",
  '  if (!payload || !sig) return false;',
  "  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');",
  '  const a = Buffer.from(sig);',
  '  const b = Buffer.from(expected);',
  '  return a.length === b.length && timingSafeEqual(a, b);',
  '}',
  '',
].join('\n'));
writeFile(path.join(CODE, 'acme-api/src/router.js'), "import { verifySession } from './auth/session.js';\n\nexport function router(req, res) {\n  if (req.url === '/health') return res.end('ok');\n  if (!verifySession(req.headers.authorization?.replace('Bearer ', ''))) {\n    res.statusCode = 401;\n    return res.end('unauthorized');\n  }\n  res.statusCode = 404;\n  res.end();\n}\n");
writeFile(path.join(CODE, 'acme-api/test/session.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { verifySession } from '../src/auth/session.js';\n\ntest('rejects a missing token', () => assert.equal(verifySession(undefined), false));\n");

// --- session builder ---
let msgSeq = 0;
function session({ id, project, branch = 'main', title, model = 'claude-opus-4-8', startAgo, turns, events }) {
  const cwd = path.join(CODE, project);
  const rows = [{ type: 'mode', mode: 'normal', sessionId: id }];
  let t = startAgo;
  for (const turn of turns) {
    rows.push({ type: 'user', isSidechain: false, sessionId: id, cwd, gitBranch: branch, timestamp: iso(t), message: { role: 'user', content: turn.prompt } });
    for (const step of turn.steps) {
      t -= step.dt || 20e3;
      const id_ = `m${++msgSeq}`;
      const usage = step.usage || { input_tokens: 400 + (msgSeq % 7) * 90, output_tokens: 300 + (msgSeq % 5) * 250, cache_read_input_tokens: 18000 + msgSeq * 900, cache_creation_input_tokens: 2500 };
      rows.push({ type: 'assistant', sessionId: id, cwd, timestamp: iso(t), message: { id: id_, model, usage, content: step.content } });
      for (const c of step.content) {
        if (c.type === 'tool_use' && step.results && step.results[c.id] !== undefined) {
          t -= 3e3;
          rows.push({ type: 'user', sessionId: id, cwd, timestamp: iso(t), ...(step.toolUseResult ? { toolUseResult: step.toolUseResult } : {}),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: step.results[c.id] }] } });
        }
      }
    }
    t -= turn.gap || 2 * MIN;
  }
  if (title) rows.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  writeJsonl(path.join(projDir(cwd), `${id}.jsonl`), rows);
  for (const e of events || []) allEvents.push({ session_id: id, cwd, ...e, ts: iso(e.ago) });
  return { id, cwd };
}
const allEvents = [];
const text = (s) => ({ type: 'text', text: s });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const api = path.join(CODE, 'acme-api');

// 1. Needs action: pending tool permission.
session({
  id: '7f3a1c2e-0001-4a10-9c1e-aa0000000001', project: 'acme-api', branch: 'feat/signed-sessions', title: 'Harden session token verification',
  startAgo: 38 * MIN,
  turns: [{
    prompt: 'Session tokens are compared with ===, which leaks timing. Switch verifySession to HMAC + timingSafeEqual and add a test.',
    steps: [
      { content: [text('Let me look at how tokens are verified today.'), tool('t1', 'Read', { file_path: `${api}/src/auth/session.js` })], results: { t1: "export function verifySession(token) {\n  return token && token.length > 10;\n}" } },
      { content: [text('That only checks the length. I will sign tokens as `<payload>.<signature>` and compare signatures in constant time.'),
        tool('t2', 'Edit', { file_path: `${api}/src/auth/session.js`, old_string: 'export function verifySession(token) {\n  return token && token.length > 10;\n}', new_string: "export function verifySession(token) {\n  if (typeof token !== 'string') return false;\n  const [payload, sig] = token.split('.');\n  if (!payload || !sig) return false;\n  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');\n  const a = Buffer.from(sig);\n  const b = Buffer.from(expected);\n  return a.length === b.length && timingSafeEqual(a, b);\n}" })], results: { t2: 'The file has been updated.' } },
      { content: [tool('t3', 'TodoWrite', { todos: [
        { content: 'Sign tokens with HMAC-SHA256', status: 'completed', activeForm: 'Signing tokens' },
        { content: 'Reject requests with an invalid token in the router', status: 'completed', activeForm: 'Wiring the router' },
        { content: 'Add a regression test', status: 'in_progress', activeForm: 'Adding a regression test' },
        { content: 'Run the full test suite', status: 'pending', activeForm: 'Running tests' },
      ] })], results: { t3: 'Todos updated' } },
      { content: [tool('t4', 'Write', { file_path: `${api}/test/session.test.js`, content: "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { verifySession } from '../src/auth/session.js';\n\ntest('rejects a missing token', () => assert.equal(verifySession(undefined), false));\n" })], results: { t4: 'File created successfully' } },
      { content: [text('Now running the test suite.'), tool('t5', 'Bash', { command: 'npm test', description: 'Run the test suite' })] },
    ],
  }],
  events: [
    { ago: 31 * MIN, event: 'UserPromptSubmit' },
    { ago: 1 * MIN, event: 'Notification', message: 'Claude needs your permission to use Bash' },
  ],
});

// 2. Waiting for you: a question.
session({
  id: '7f3a1c2e-0002-4a10-9c1e-aa0000000002', project: 'storefront', branch: 'feat/checkout', title: 'Checkout flow: pick a payment provider',
  startAgo: 55 * MIN,
  turns: [{
    prompt: 'Add a checkout page to the storefront. Card payments only for now.',
    steps: [
      { content: [text('I mapped the cart and the routes. Before wiring payments I need one decision from you.'),
        tool('q1', 'AskUserQuestion', { questions: [{ question: 'Which payment provider should the checkout use?', header: 'Payments', multiSelect: false, options: [
          { label: 'Stripe', description: 'Hosted checkout, fastest to ship' },
          { label: 'Adyen', description: 'Already used by the finance team' },
          { label: 'Mollie', description: 'Cheapest fees in the EU' },
        ] }] })] },
    ],
  }],
  events: [{ ago: 3 * MIN, event: 'PreToolUse', tool: 'AskUserQuestion', ask: [{ question: 'Which payment provider should the checkout use?', header: 'Payments', multiSelect: false, options: [{ label: 'Stripe', description: 'Hosted checkout, fastest to ship' }, { label: 'Adyen', description: 'Already used by the finance team' }, { label: 'Mollie', description: 'Cheapest fees in the EU' }] }] }],
});

// 3. Working.
session({
  id: '7f3a1c2e-0003-4a10-9c1e-aa0000000003', project: 'infra-k8s', title: 'Right-size the api chart', model: 'claude-sonnet-4-6',
  startAgo: 12 * MIN,
  turns: [{
    prompt: 'The api pods get OOMKilled at peak. Look at the chart and propose new requests/limits.',
    steps: [
      { content: [tool('k1', 'Read', { file_path: path.join(CODE, 'infra-k8s/charts/api/values.yaml') })], results: { k1: 'replicaCount: 2\nresources:\n  requests:\n    cpu: 100m\n    memory: 128Mi' } },
      { content: [text('Memory requests are set but there is no limit and 128Mi is far below the observed peak. Let me check the last 7 days of usage.'),
        tool('k2', 'Bash', { command: 'kubectl top pods -n api --containers', description: 'Show current pod usage' })] },
    ],
  }],
  events: [{ ago: 20e3, event: 'PreToolUse', tool: 'Bash' }],
});

// 4. Waiting (turn finished), with a PR link and a subagent.
session({
  id: '7f3a1c2e-0004-4a10-9c1e-aa0000000004', project: 'docs-site', branch: 'docs/api-reference', title: 'Generate the API reference pages',
  startAgo: 3 * H,
  turns: [{
    prompt: 'Generate an API reference page per endpoint from the OpenAPI spec and open a PR.',
    steps: [
      { content: [tool('a1', 'Agent', { subagent_type: 'Explore', description: 'Map the OpenAPI spec', prompt: 'List every endpoint in openapi.yaml with its method and summary.' })],
        results: { a1: [{ type: 'text', text: 'Found 14 endpoints across 4 tags.' }] },
        toolUseResult: { agentType: 'Explore', agentId: 'demo1', resolvedModel: 'claude-sonnet-4-6', totalTokens: 31000, totalToolUseCount: 9, totalDurationMs: 48000, usage: { input_tokens: 900, output_tokens: 1400, cache_read_input_tokens: 26000 } } },
      { content: [tool('a2', 'Bash', { command: 'gh pr create --fill', description: 'Open the pull request' })], results: { a2: 'https://github.com/acme/docs-site/pull/128' } },
      { content: [text('Done. 14 reference pages generated, one per endpoint, grouped by tag.\n\nPR: https://github.com/acme/docs-site/pull/128')] },
    ],
  }],
  events: [{ ago: 2 * H + 40 * MIN, event: 'Stop' }],
});
writeJsonl(path.join(projDir(path.join(CODE, 'docs-site')), '7f3a1c2e-0004-4a10-9c1e-aa0000000004', 'subagents', 'agent-demo1.jsonl'), [
  { type: 'user', isSidechain: true, agentId: 'demo1', sessionId: '7f3a1c2e-0004-4a10-9c1e-aa0000000004', timestamp: iso(3 * H - MIN), message: { role: 'user', content: 'List every endpoint in openapi.yaml with its method and summary.' } },
  { type: 'assistant', isSidechain: true, timestamp: iso(3 * H - 2 * MIN), message: { id: 'sa1', model: 'claude-sonnet-4-6', usage: { input_tokens: 300, output_tokens: 500 }, content: [tool('sa-t1', 'Grep', { pattern: 'operationId', path: path.join(CODE, 'docs-site') })] } },
]);

// History: ~35 past sessions over 30 days, for the stats and the session list.
const pastTitles = [
  ['acme-api', 'Add rate limiting to the public endpoints'], ['acme-api', 'Fix flaky integration test on CI'], ['acme-api', 'Migrate config loading to env schema'],
  ['acme-api', 'Paginate the /orders endpoint'], ['storefront', 'Lazy-load product images'], ['storefront', 'Dark mode for the cart drawer'],
  ['storefront', 'Fix currency rounding in totals'], ['storefront', 'Upgrade to Svelte 5 runes'], ['infra-k8s', 'Add a PodDisruptionBudget to the api chart'],
  ['infra-k8s', 'Rotate the registry pull secret'], ['infra-k8s', 'Alert on 5xx ratio above 2%'], ['docs-site', 'Write the getting-started guide'],
  ['docs-site', 'Fix broken links after the rename'], ['acme-api', 'Profile slow /search queries'], ['storefront', 'Add e2e test for checkout'],
  ['infra-k8s', 'Bump ingress controller to 1.12'], ['acme-api', 'Review PR #311: webhook retries'], ['docs-site', 'Translate the FAQ'],
];
const models = ['claude-opus-4-8', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-1', 'claude-haiku-4-5'];
let n = 10;
for (let day = 29; day >= 1; day--) {
  const count = 1 + ((day * 7) % 3);
  for (let k = 0; k < count; k++) {
    const [project, title] = pastTitles[(day * 3 + k) % pastTitles.length];
    const id = `5e2b9d40-${String(n).padStart(4, '0')}-4b20-8d2f-bb${String(n).padStart(10, '0')}`; n++;
    const big = 1 + ((day + k) % 4);
    session({
      id, project, title, model: models[(day + k) % models.length], startAgo: day * D + (9 + k * 3) * H,
      turns: Array.from({ length: 2 + big }, (_, i) => ({ prompt: i === 0 ? title : 'Looks good, go on.',
        steps: [{ content: [text('Working on it.'), tool(`h${n}-${i}`, 'Read', { file_path: path.join(CODE, project, 'README.md') })], results: { [`h${n}-${i}`]: '...' },
          usage: { input_tokens: 800 * big, output_tokens: 1500 * big, cache_read_input_tokens: 60000 * big, cache_creation_input_tokens: 9000 * big } }] })),
      events: [{ ago: day * D + (8 + k * 3) * H, event: 'SessionEnd' }],
    });
  }
}

mkdirp(DATA);
allEvents.sort((a, b) => a.ts.localeCompare(b.ts));
writeJsonl(path.join(DATA, 'events.jsonl'), allEvents);
writeFile(path.join(ROOT, 'claude.json'), '{}\n');
console.log('demo data in', ROOT, '-', n - 10 + 4, 'sessions');
