/*
 * The `WebSearch` tool of hooked's pi package, with Claude Code's schema (`query`,
 * `allowed_domains`, `blocked_domains`).
 *
 * pi has no search engine, and pi-claude-bridge runs Claude Code without its tools. Public search
 * pages refuse automated queries, so this asks Claude Code itself: one headless `claude -p` on
 * Haiku, on the user's own login, with WebSearch as its only tool. It leaves no trace, the same
 * way hooked's other headless calls do (server/autoTags.js): no session file, no hooks, no MCP
 * servers, a neutral working directory. The answer is a list of results with links and a short
 * summary. Like Claude Code's, the tool asks for permission in the normal mode.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

const TIMEOUT_MS = 120_000;

const domains = (v) => (Array.isArray(v) ? v.map(String).map((d) => d.trim()).filter((d) => /^[A-Za-z0-9.-]+$/.test(d)) : []);

// The prompt of the headless call.
export function searchPrompt({ query, allowed_domains: allowed, blocked_domains: blocked }) {
  const only = domains(allowed);
  const not = domains(blocked);
  return [
    `Use the WebSearch tool to search the web for: ${String(query || '').trim()}`,
    only.length ? `Only keep results from these domains: ${only.join(', ')}.` : '',
    not.length ? `Leave out results from these domains: ${not.join(', ')}.` : '',
    'Answer with the results only, no preamble:',
    '1. A Markdown list of at most 8 results, one line each: the page title as a link to its URL, then one sentence on what the page says about the query.',
    '2. Then a short paragraph that answers the query from these results, citing the links.',
  ].filter(Boolean).join('\n');
}

export function headlessArgs(prompt) {
  return [
    '-p', prompt,
    '--model', 'haiku', '--output-format', 'json',
    '--no-session-persistence', '--tools', 'WebSearch', '--allowedTools', 'WebSearch',
    '--strict-mcp-config', '--disable-slash-commands',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];
}

function runClaude(args, signal) {
  const bin = process.env.HOOKED_CLAUDE_BIN || 'claude';
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(bin, args, { cwd: os.tmpdir(), env: { ...process.env, HOOKED_DRIVEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: null, out, err: e.message }); }
    const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    const timer = setTimeout(kill, TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', kill); resolve({ code, out, err }); });
  });
}

// `claude -p --output-format json` → the answer text, or null.
export function resultText(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    if (j && j.is_error) return null;
    return j && typeof j.result === 'string' && j.result.trim() ? j.result.trim() : null;
  } catch (_) { return null; }
}

export function registerWebSearch(pi) {
  pi.registerTool({
    name: 'WebSearch',
    label: 'Search the web',
    description: 'Search the web and get a list of results (title, link, one sentence each) with a short answer built from them. Use it for recent events, current documentation or anything past your knowledge. Then read a page with WebFetch when you need the details.',
    promptSnippet: 'Search the web',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only keep results from these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Leave out results from these domains' },
      },
      required: ['query'],
    },
    async execute(_id, params, signal) {
      const query = String(params.query || '').trim();
      if (query.length < 2) return { content: [{ type: 'text', text: 'WebSearch needs a query.' }], details: undefined, isError: true };
      const r = await runClaude(headlessArgs(searchPrompt(params)), signal);
      const text = resultText(r.out);
      if (!text) {
        const why = r.code === null ? (r.err || 'claude could not start') : (r.err.trim().split('\n').slice(-2).join(' ') || `claude exited with code ${r.code}`);
        return { content: [{ type: 'text', text: `WebSearch failed: ${why}` }], details: undefined, isError: true };
      }
      return { content: [{ type: 'text', text: `Web search results for "${query}":\n\n${text}` }], details: { query } };
    },
  });
}
