/*
 * The `Workflow` tool of hooked's pi package: Claude Code's scripted orchestration of subagents,
 * for pi. The script has the same shape as Claude Code's:
 *
 *   export const meta = { name: 'review', description: '…', phases: [{ title: 'Find' }] }
 *   phase('Find')
 *   const found = await parallel(FILES.map((f) => () => agent(`Review ${f}`, { schema: S })))
 *   return found.filter(Boolean)
 *
 * Supported: agent(prompt, { label, phase, schema, model, effort, agentType }), parallel(thunks),
 * pipeline(items, ...stages), phase(title), log(message), args, budget (no token target: total is
 * null). Not supported: resume, `isolation: 'worktree'` (the agent runs in the session directory,
 * and a log line says so), workflow() nesting, saved workflows by name.
 *
 * Each agent() is a subagent of extensions/agent.js: a separate pi process on the session's model
 * (or `model`), whose tools follow the parent's permission mode. With `schema`, the subagent is told
 * to answer with one JSON object, which is parsed and checked (one retry with the error), and
 * agent() returns the object. A failed agent returns null, as in Claude Code; parallel() and
 * pipeline() never reject.
 *
 * The script runs in a separate V8 context with no require, process or file access handed to it.
 * That is not a security boundary (the model already has bash): the tool asks for permission in
 * the normal mode, like bash.
 */
import os from 'node:os';
import vm from 'node:vm';
import { subagentFor } from './agent.js';

const MAX_AGENTS = 100;
const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 2));
const MAX_RESULT_CHARS = 60_000;

// The script as an async function body: `export` dropped, and `meta` also kept on the context's
// global so the tool can read the workflow's name once it has run.
export function prepareScript(script) {
  const src = String(script || '');
  if (!/^\s*export\s+const\s+meta\s*=/m.test(src)) throw new Error('the script must begin with `export const meta = {...}`');
  return src
    .replace(/^(\s*)export\s+const\s+meta\s*=/m, '$1const meta = globalThis.__meta =')
    .replace(/^(\s*)export\s+(const|let|function|async\s+function)\b/gm, '$1$2');
}

// The JSON object in a subagent's answer (a bare object, or one inside a code fence).
export function parseObject(text) {
  const t = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in the answer');
  const v = JSON.parse(body.slice(a, b + 1));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the answer is not a JSON object');
  return v;
}

// A light check of a value against a JSON Schema: types, required keys, enums, nested objects and
// arrays. Returns the first problem, or null.
export function schemaProblem(schema, value, at = '$') {
  if (!schema || typeof schema !== 'object') return null;
  const t = schema.type;
  const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v);
  const ok = (want, v) => want === typeOf(v) || (want === 'number' && typeof v === 'number') || (want === 'integer' && Number.isInteger(v));
  if (t && !(Array.isArray(t) ? t.some((x) => ok(x, value)) : ok(t, value))) return `${at} should be ${Array.isArray(t) ? t.join(' or ') : t}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `${at} should be one of ${JSON.stringify(schema.enum)}`;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) return `${at}.${k} is missing`;
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) { const p = schemaProblem(sub, value[k], `${at}.${k}`); if (p) return p; }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) { const p = schemaProblem(schema.items, value[i], `${at}[${i}]`); if (p) return p; }
  }
  return null;
}

const schemaInstruction = (schema) => `\n\nYour final answer must be only one JSON object that matches this JSON Schema, with no prose and no code fence:\n${JSON.stringify(schema)}`;

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => { if (active < n && queue.length) { active++; queue.shift()(); } };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

const sumUsage = (a, b) => ({
  input: a.input + (b.input || 0), output: a.output + (b.output || 0),
  cacheRead: a.cacheRead + (b.cacheRead || 0), cacheWrite: a.cacheWrite + (b.cacheWrite || 0),
  cost: a.cost + (b.cost || 0), turns: a.turns + (b.turns || 0),
});

// Runs a script. `run(opts)` starts one subagent ({ text, usage, error }), injected for the tests.
export async function runWorkflow({ script, args, run, signal, onProgress }) {
  const body = prepareScript(script);
  const limit = limiter(CONCURRENCY);
  const state = { phase: null, agents: [], logs: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, model: null };
  const progress = () => { if (onProgress) onProgress(state); };

  const agent = async (prompt, opts = {}) => {
    if (signal && signal.aborted) return null;
    if (state.agents.length >= MAX_AGENTS) throw new Error(`a workflow runs at most ${MAX_AGENTS} agents`);
    const rec = { label: String(opts.label || String(prompt).split('\n')[0].slice(0, 60)), phase: opts.phase || state.phase, status: 'queued' };
    state.agents.push(rec);
    if (opts.isolation === 'worktree') state.logs.push(`${rec.label}: worktree isolation is not supported here, the agent runs in the session directory`);
    progress();
    return limit(async () => {
      rec.status = 'running'; progress();
      let attempt = String(prompt) + (opts.schema ? schemaInstruction(opts.schema) : '');
      for (let tries = 0; tries < (opts.schema ? 2 : 1); tries++) {
        const r = await run({ prompt: attempt, model: opts.model || null, effort: opts.effort || null, subagentType: opts.agentType || null, signal });
        state.usage = sumUsage(state.usage, r.usage || {});
        if (r.model) state.model = r.model;
        if (r.error) { rec.status = 'failed'; rec.error = r.error; progress(); return null; }
        if (!opts.schema) { rec.status = 'done'; progress(); return r.text; }
        let problem;
        try {
          const obj = parseObject(r.text);
          problem = schemaProblem(opts.schema, obj);
          if (!problem) { rec.status = 'done'; progress(); return obj; }
        } catch (e) { problem = e.message; }
        attempt = `${prompt}${schemaInstruction(opts.schema)}\n\nYour previous answer was rejected: ${problem}. Answer again with the JSON object only.`;
      }
      rec.status = 'failed'; rec.error = 'the answer did not match the schema'; progress();
      return null;
    });
  };
  const parallel = (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = (items, ...stages) => Promise.all((items || []).map(async (item, i) => {
    let prev = item;
    for (const stage of stages) {
      try { prev = await stage(prev, item, i); } catch (_) { return null; }
    }
    return prev;
  }));
  const phase = (title) => { state.phase = String(title); progress(); };
  const log = (m) => { state.logs.push(String(m)); progress(); };
  const workflow = () => { throw new Error('workflow() is not supported in pi workflows'); };
  const budget = Object.freeze({ total: null, spent: () => state.usage.output, remaining: () => Infinity });

  const context = vm.createContext({ agent, parallel, pipeline, phase, log, workflow, budget, args, console: { log } });
  const fn = vm.runInContext(`(async () => {\n${body}\n;return undefined;\n})`, context, { filename: 'workflow.js' });
  const result = await fn();
  return { result, state, meta: context.__meta || null };
}

export function registerWorkflowTool(pi, policy, { run } = {}) {
  pi.registerTool({
    name: 'Workflow',
    label: 'Workflow',
    description: 'Run a JavaScript workflow that orchestrates subagents deterministically: fan out over a list, verify findings with independent agents, then synthesize. The script begins with `export const meta = { name, description, phases }` and uses agent(prompt, { label, phase, schema, model, effort, agentType }) (a subagent; with a JSON Schema it returns the parsed object; null on failure), parallel(thunks) (a barrier, never rejects), pipeline(items, ...stages) (each item through every stage, no barrier), phase(title), log(message) and args. It returns what the script returns. Subagents do not see this conversation and cannot ask the user; their tools follow the permission mode. Use it only for work that needs many agents.',
    promptSnippet: 'Orchestrate many subagents with a script',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The workflow script (plain JavaScript)' },
        args: { description: 'Value exposed to the script as `args`' },
      },
      required: ['script'],
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const runOne = run || ((o) => subagentFor(ctx, policy(), o));
      const report = (st) => {
        if (typeof onUpdate !== 'function') return;
        const done = st.agents.filter((a) => a.status === 'done' || a.status === 'failed').length;
        const running = st.agents.filter((a) => a.status === 'running').length;
        onUpdate({ content: [{ type: 'text', text: `${st.phase ? `${st.phase}: ` : ''}${done}/${st.agents.length} agents done, ${running} running${st.logs.length ? `\n${st.logs[st.logs.length - 1]}` : ''}` }], details: undefined });
      };
      let out;
      try {
        out = await runWorkflow({ script: params.script, args: params.args, run: runOne, signal, onProgress: report });
      } catch (e) {
        return { content: [{ type: 'text', text: `The workflow failed: ${(e && e.message) || e}` }], details: undefined, isError: true };
      }
      const { result, state, meta } = out;
      const failed = state.agents.filter((a) => a.status === 'failed');
      let text = result === undefined ? '(the workflow returned nothing)' : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters]`;
      const head = `Workflow ${meta && meta.name ? `"${meta.name}" ` : ''}finished: ${state.agents.length} agent(s)${failed.length ? `, ${failed.length} failed` : ''}.`;
      const logs = state.logs.length ? `\nLog:\n${state.logs.map((l) => `- ${l}`).join('\n')}` : '';
      return {
        content: [{ type: 'text', text: `${head}${logs}\n\nResult:\n${text}` }],
        details: { name: meta && meta.name, agents: state.agents.length, agentCount: state.agents.length, failed: failed.length, model: state.model, usage: state.usage },
      };
    },
  });
}
