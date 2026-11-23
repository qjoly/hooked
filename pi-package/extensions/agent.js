/*
 * The `Agent` tool of hooked's pi package: Claude Code's subagents, for pi.
 *
 * A call runs a separate pi process (`pi --mode json -p`) on the current model, with
 * its own context window, and returns the subagent's final answer. The child loads the same `-e`
 * extensions as this pi, so a model that an extension provides (pi-claude-bridge's claude-bridge/*)
 * works there too, but not hooked's package: no hooked tools and no nested Agent in a subagent.
 * Its session goes to a temporary folder, removed after the run: out of hooked's session list, but
 * a real session, so pi-claude-bridge records the Claude Code transcript it runs as a shadow (its
 * state file), and hooked hides that transcript too (server/bridgeShadows.js).
 *
 * A subagent cannot show a permission card (print mode has no UI), so its tools follow the
 * parent's permission mode instead of asking:
 *   plan mode, an Explore / Plan subagent, or the normal mode → read-only (read, grep, find, ls)
 *   acceptEdits                                              → read-only + edit, write
 *   bypassPermissions / auto / dontAsk, or auto-approve on   → pi's default tools
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READ_TOOLS = ['read', 'grep', 'find', 'ls'];

// Tool allowlist of a subagent (null = pi's defaults).
export function subagentTools({ mode, autoApprove, subagentType }) {
  if (mode === 'plan' || subagentType === 'Explore' || subagentType === 'Plan') return READ_TOOLS;
  if (mode === 'bypassPermissions' || mode === 'auto' || mode === 'dontAsk' || autoApprove) return null;
  if (mode === 'acceptEdits') return [...READ_TOOLS, 'edit', 'write'];
  return READ_TOOLS;
}

// The `-e` extensions of this pi process, without hooked's package.
export function inheritedExtensions(argv, packageDir = PACKAGE_DIR) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-e' || argv[i] === '--extension') && argv[i + 1]) {
      const v = argv[++i];
      const abs = path.resolve(v);
      if (abs === packageDir || abs.startsWith(packageDir + path.sep)) continue;
      out.push('-e', v);
    }
  }
  return out;
}

// The final answer: the text of the last assistant message.
export function finalText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m && m.role === 'assistant');
  if (!last || !Array.isArray(last.content)) return '';
  return last.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Usage summed over the subagent's assistant messages, in pi's shape.
export function totalUsage(messages) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant' || !m.usage) continue;
    u.turns++;
    u.input += m.usage.input || 0;
    u.output += m.usage.output || 0;
    u.cacheRead += m.usage.cacheRead || 0;
    u.cacheWrite += m.usage.cacheWrite || 0;
    u.cost += (m.usage.cost && m.usage.cost.total) || 0;
  }
  return u;
}

// How to start pi again: the same runtime and entry script as this process.
function piInvocation(args) {
  const script = process.argv[1];
  if (script && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  return { command: 'pi', args };
}

function runSubagent({ prompt, cwd, model, thinking, tools, extensions, signal, onTool }) {
  let sessionDir = null;
  try { sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-subagent-')); } catch (_) {}
  const args = ['--mode', 'json', '-p', ...(sessionDir ? ['--session-dir', sessionDir] : ['--no-session']), ...extensions];
  if (model) args.push('--model', model);
  if (thinking) args.push('--thinking', thinking);
  if (tools) args.push('--tools', tools.join(','));
  args.push(prompt);
  const inv = piInvocation(args);
  return new Promise((resolve) => {
    let messages = null;
    let buf = '';
    let stderr = '';
    const toolCalls = [];
    const child = spawn(inv.command, inv.args, {
      cwd,
      env: { ...process.env, HOOKED_DRIVEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const line = (l) => {
      let ev;
      try { ev = JSON.parse(l); } catch (_) { return; }
      if (ev.type === 'tool_execution_start' && ev.toolName) { toolCalls.push(ev.toolName); if (onTool) onTool(ev.toolName, toolCalls.length); }
      if (ev.type === 'agent_end' && Array.isArray(ev.messages)) messages = ev.messages;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 8000) stderr += d; });
    const done = (code, err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (sessionDir) { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {} }
      if (buf.trim()) line(buf);
      resolve({ messages: messages || [], toolCalls, code, error: err || null, stderr: stderr.trim(), aborted: !!(signal && signal.aborted) });
    };
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code, null));
  });
}

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'A short (3-5 words) description of the task' },
    prompt: { type: 'string', description: 'The task for the subagent: everything it needs to know, since it does not see this conversation' },
    subagent_type: { type: 'string', description: 'Optional. "Explore" or "Plan" keep the subagent read-only' },
  },
  required: ['description', 'prompt'],
};

// Registers the tool. `policy()` returns the parent's { mode, autoApprove } at call time.
export function registerAgentTool(pi, policy) {
  pi.registerTool({
    name: 'Agent',
    label: 'Subagent',
    description: 'Launch a subagent: a separate pi process on the current model, with its own context window, that works on one task and returns its final answer. Use it for broad searches or independent work that would fill this conversation, and run several at once for independent tasks. The subagent does not see this conversation: give it every detail it needs. It cannot ask the user anything. Its tools follow the permission mode: read-only in the normal and plan modes, plus file edits with acceptEdits, every tool when tool calls are auto-approved.',
    promptSnippet: 'Delegate a task to a subagent with its own context',
    parameters: AGENT_SCHEMA,
    async execute(_id, params, signal, onUpdate, ctx) {
      const { mode, autoApprove } = policy();
      const tools = subagentTools({ mode, autoApprove, subagentType: params.subagent_type });
      const model = ctx && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
      const label = String(params.description || 'subagent');
      const r = await runSubagent({
        prompt: String(params.prompt || ''),
        cwd: (ctx && ctx.cwd) || process.cwd(),
        model,
        thinking: ctx && ctx.thinkingLevel && ctx.thinkingLevel !== 'off' ? ctx.thinkingLevel : null,
        tools,
        extensions: inheritedExtensions(process.argv),
        signal,
        onTool: (name, n) => {
          if (typeof onUpdate === 'function') onUpdate({ content: [{ type: 'text', text: `${label}: ${n} tool call${n > 1 ? 's' : ''}, last ${name}` }], details: undefined });
        },
      });
      const usage = totalUsage(r.messages);
      const details = { description: label, model, tools: tools || 'default', toolCalls: r.toolCalls.length, usage };
      const text = finalText(r.messages);
      if (r.aborted) return { content: [{ type: 'text', text: 'The subagent was interrupted.' }], details, isError: true };
      if (!text) {
        const why = r.error || r.stderr.split('\n').slice(-3).join('\n') || `pi exited with code ${r.code}`;
        return { content: [{ type: 'text', text: `The subagent returned no answer: ${why}` }], details, isError: true };
      }
      return { content: [{ type: 'text', text }], details };
    },
  });
}
