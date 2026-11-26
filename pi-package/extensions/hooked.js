/*
 * hooked for pi — the part of hooked that lives inside a pi session (cf. docs/pi-package.md).
 *
 * hooked loads this package into every pi session it drives (`pi --mode rpc -e <this package>`).
 * It brings what Claude Code gives hooked natively and pi does not have:
 *
 *   - hooked's tools (start_session, groups, review comments, PR watch, show_image…) as native pi
 *     tools, from the same definitions as the MCP server (mcp/server.cjs), with no MCP proxy;
 *   - AskUserQuestion, ExitPlanMode and TodoWrite, with Claude Code's schemas;
 *   - Agent: subagents in a separate pi process (extensions/agent.js);
 *   - Workflow: Claude Code's scripted orchestration of subagents (extensions/workflow.js);
 *   - WebFetch / WebSearch: a web page as text, a web search (extensions/webfetch.js, websearch.js);
 *   - BashBackground / BashOutput / KillShell: background commands (extensions/background.js);
 *   - a permission gate following hooked's permission modes and auto-approve switch;
 *   - the account quotas pi-claude-bridge relays (5h / 7d), forwarded to the dashboard.
 *
 * Talking to hooked: in RPC mode, ctx.ui dialogs become `extension_ui_request` records that the
 * driver (server/piAgent.js) answers. A dialog hooked must render as one of its cards is sent as
 * `ctx.ui.input("[hooked:<kind>] <json>")` and answered with a JSON string, so a card keeps its
 * full shape (several questions, multi-select, free text, plan feedback). Outside hooked (a pi
 * opened in a terminal), the same tools fall back to plain select dialogs and the gate is off.
 *
 * Nothing here changes the system prompt between turns: hooked's instructions are one constant
 * section, and mode changes are messages in the history. Changing the prompt costs a cache miss
 * on every provider, and a full re-import of the conversation through pi-claude-bridge.
 */
import { createRequire } from 'node:module';
import { registerAgentTool } from './agent.js';
import { registerWorkflowTool } from './workflow.js';
import { registerWebFetch } from './webfetch.js';
import { registerWebSearch } from './websearch.js';
import { registerBackground } from './background.js';
import { registerHookedTools } from './tools.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = '[hooked:';
const MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];

// Tools that never ask: they read, or they talk to the user / to hooked.
// Agent is safe here because its subagent's tools are bounded by the mode (extensions/agent.js).
const SAFE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'tool_search', 'AskUserQuestion', 'ExitPlanMode', 'TodoWrite', 'Agent', 'BashOutput', 'KillShell']);
const EDIT_TOOLS = new Set(['write', 'edit']);

function loadHookedTools() {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.HOOKED_MCP_SERVER, path.join(here, '..', '..', 'mcp', 'server.cjs')].filter(Boolean);
  for (const file of candidates) {
    try { return require(file); } catch (_) { /* next */ }
  }
  return null;
}

// Pure helpers, exported for the tests.
export function permissionDecision({ toolName, mode, autoApprove, alwaysAllowed }) {
  if (SAFE_TOOLS.has(toolName) || toolName.startsWith('hooked_')) return 'allow';
  if (mode === 'plan' && EDIT_TOOLS.has(toolName)) return 'block-plan';
  if (mode === 'plan') return 'ask'; // planning may read through bash, but every call is shown
  if (mode === 'bypassPermissions' || mode === 'dontAsk' || mode === 'auto') return 'allow';
  if (autoApprove) return 'allow';
  if (alwaysAllowed && alwaysAllowed.has(toolName)) return 'allow';
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return 'allow';
  return 'ask';
}

export function formatAnswers(questions, answers) {
  const parts = (questions || []).map((q) => `"${q.question}"="${(answers || {})[q.question] ?? ''}"`);
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
}

// Account quotas from the unified rate-limit headers (pi-claude-bridge rebuilds them from Claude
// Code's rate_limit_event) → the statusline shape hooked stores ({ used_percentage, resets_at }).
export function quotasFromHeaders(headers) {
  const h = headers || {};
  const win = (k) => {
    const u = h[`anthropic-ratelimit-unified-${k}-utilization`];
    if (u == null || u === '') return null;
    const pct = Number(u) * 100; // a fraction on the wire (as in Anthropic's headers), a percentage in hooked
    if (!Number.isFinite(pct)) return null;
    const r = Number(h[`anthropic-ratelimit-unified-${k}-reset`]);
    return { used_percentage: Math.round(pct * 10) / 10, resets_at: Number.isFinite(r) ? r : null };
  };
  const five = win('5h');
  const seven = win('7d');
  return five || seven ? { five_hour: five, seven_day: seven } : null;
}

// A card on the dashboard: one input dialog carrying the payload, a JSON answer back.
async function hookedCard(ctx, kind, payload) {
  const raw = await ctx.ui.input(`${MARK}${kind}] ${JSON.stringify(payload)}`);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'Questions to ask the user (1-4)',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The complete question, ending with a question mark' },
          header: { type: 'string', description: 'Very short label shown as a chip (max 12 chars)' },
          multiSelect: { type: 'boolean', description: 'Allow several options to be picked' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Display text of the choice (1-5 words)' },
                description: { type: 'string', description: 'What this option means' },
              },
              required: ['label'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

const TODOS_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The updated todo list',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The task, in the imperative form (Run the tests)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string', description: 'The task in the present continuous form (Running the tests)' },
        },
        required: ['content', 'status', 'activeForm'],
      },
    },
  },
  required: ['todos'],
};

export default function hooked(pi) {
  // Read here, not at import: the same module may be loaded by a driven and an undriven pi.
  const DRIVEN = process.env.HOOKED_DRIVEN === '1';
  let mode = MODES.includes(process.env.HOOKED_PERMISSION_MODE) ? process.env.HOOKED_PERMISSION_MODE : 'default';
  let autoApprove = process.env.HOOKED_AUTO_APPROVE !== '0';
  const alwaysAllowed = new Set();
  const mcp = loadHookedTools();

  const notice = (text) => pi.sendMessage(
    { customType: 'hooked-mode', content: text, display: false },
    { deliverAs: 'nextTurn' },
  );
  const setMode = (m) => {
    if (!MODES.includes(m) || m === mode) return;
    const was = mode;
    mode = m;
    if (m === 'plan') {
      notice('Plan mode is on (set from the hooked dashboard). Explore and read as needed, but do not edit files or run commands that change anything. When your plan is ready, present it with the ExitPlanMode tool and wait for the approval.');
    } else if (was === 'plan') {
      notice(`Plan mode is off: the permission mode is now ${m}. You can edit files and run commands.`);
    }
  };

  // ── hooked's tools ─────────────────────────────────────────────────────────────────────────
  // The core ones; each module that is switched on brings its own in its pi package (modules/<id>/pi).
  if (mcp && Array.isArray(mcp.TOOLS)) registerHookedTools(pi, mcp.TOOLS, mcp.resultFrom);

  // hooked's instructions (fenced bash blocks get a Run button…): one constant section.
  if (mcp && mcp.INSTRUCTIONS) {
    pi.on('before_agent_start', (event) => {
      const sections = event.systemPromptOptions && event.systemPromptOptions.sections;
      if (sections && sections.hooked !== mcp.INSTRUCTIONS) sections.hooked = mcp.INSTRUCTIONS;
    });
  }

  // ── AskUserQuestion ────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'AskUserQuestion',
    label: 'Ask the user',
    description: 'Ask the user one to four multiple-choice questions when you need a decision or a preference to go on. The user can also write an answer of their own.',
    promptSnippet: 'Ask the user multiple-choice questions',
    parameters: QUESTIONS_SCHEMA,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      let answers = null;
      if (DRIVEN) {
        const r = await hookedCard(ctx, 'question', { questions });
        answers = r && r.answers;
      } else {
        answers = {};
        for (const q of questions) {
          const pick = await ctx.ui.select(q.question, (q.options || []).map((o) => o.label));
          if (pick == null) { answers = null; break; }
          answers[q.question] = pick;
        }
      }
      if (!answers) {
        return { content: [{ type: 'text', text: 'The user dismissed the questions without answering.' }], details: undefined, isError: true };
      }
      return { content: [{ type: 'text', text: formatAnswers(questions, answers) }], details: { answers } };
    },
  });

  // ── ExitPlanMode ───────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'ExitPlanMode',
    label: 'Present the plan',
    description: 'Present your implementation plan for approval when you are in plan mode. Use it once the plan is complete, not to ask questions.',
    promptSnippet: 'Submit a plan for approval in plan mode',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'The plan, in Markdown' } },
      required: ['plan'],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let r = null;
      if (DRIVEN) r = await hookedCard(ctx, 'plan', { plan: String(params.plan || '') });
      else {
        const pick = await ctx.ui.select('Approve this plan?', ['Approve', 'Keep planning']);
        r = pick === 'Approve' ? { action: 'approve' } : { action: 'keep' };
      }
      const action = r && r.action;
      if (action === 'approve' || action === 'approve-auto') {
        mode = action === 'approve-auto' ? 'auto' : 'acceptEdits';
        return { content: [{ type: 'text', text: `The user approved your plan (permission mode: ${mode}). You can now start implementing it.` }], details: { action } };
      }
      const fb = r && typeof r.feedback === 'string' && r.feedback.trim() ? r.feedback.trim() : '';
      return {
        content: [{ type: 'text', text: fb ? `The user wants you to keep planning: ${fb}` : 'The user did not approve the plan yet. Keep planning.' }],
        details: { action: action || 'keep' },
      };
    },
  });

  // ── TodoWrite ──────────────────────────────────────────────────────────────────────────────
  // The whole list on every call, as in Claude Code: hooked's dock reads the last call from the
  // session file (latestPiTodos in server/pi.js). Nothing is kept here.
  pi.registerTool({
    name: 'TodoWrite',
    label: 'Todo list',
    description: 'Create and update the task list of this session, shown to the user in the hooked dashboard. Use it for work with three steps or more: send the whole list on every call, keep exactly one task in_progress while you work, and mark each task completed as soon as it is done.',
    promptSnippet: 'Track multi-step work in a todo list the user sees',
    parameters: TODOS_SCHEMA,
    async execute(_id, params) {
      const todos = Array.isArray(params.todos) ? params.todos : [];
      const done = todos.filter((t) => t && t.status === 'completed').length;
      return {
        content: [{ type: 'text', text: `Todos have been modified successfully (${done}/${todos.length} completed). Keep using the todo list to track your progress.` }],
        details: { todos },
      };
    },
  });

  // ── Agent (subagents) ─────────────────────────────────────────────────────────────────────
  // Outside hooked nothing asks either, so the subagent gets pi's default tools there.
  const subagentPolicy = () => (DRIVEN ? { mode, autoApprove } : { mode: 'bypassPermissions', autoApprove: true });
  registerAgentTool(pi, subagentPolicy);
  // Workflow asks like bash: it runs a script the model wrote (not sandboxed) and many subagents.
  registerWorkflowTool(pi, subagentPolicy);

  // ── WebFetch, WebSearch (ask in the normal mode, like any tool outside SAFE_TOOLS) ─────────
  registerWebFetch(pi);
  registerWebSearch(pi);

  // ── Background commands (BashBackground asks like bash; reading and stopping do not) ────────
  registerBackground(pi);

  // ── Permission gate (driven sessions only) ─────────────────────────────────────────────────
  pi.on('tool_call', async (event, ctx) => {
    if (!DRIVEN) return undefined;
    const decision = permissionDecision({ toolName: event.toolName, mode, autoApprove, alwaysAllowed });
    if (decision === 'allow') return undefined;
    if (decision === 'block-plan') {
      return { block: true, reason: 'Plan mode is on: do not edit files yet. Present your plan with ExitPlanMode first.' };
    }
    const r = await hookedCard(ctx, 'permission', { toolName: event.toolName, input: event.input });
    const choice = r && r.choice;
    if (choice === 'allow') return undefined;
    if (choice === 'allow-always') { alwaysAllowed.add(event.toolName); return undefined; }
    return { block: true, reason: (r && r.message) || 'Denied from the hooked dashboard.' };
  });

  // ── Controls hooked sends as extension commands (handled at once, even mid-turn) ───────────
  pi.registerCommand('hooked-mode', {
    description: 'hooked: set the permission mode (default, acceptEdits, auto, plan, bypassPermissions)',
    handler: async (args) => setMode(String(args || '').trim()),
  });
  pi.registerCommand('hooked-auto-approve', {
    description: 'hooked: auto-approve tool permission requests (on / off)',
    handler: async (args) => { autoApprove = String(args || '').trim() !== 'off'; },
  });

  // ── Account quotas (pi-claude-bridge) → the dashboard's 5h / 7d gauges ────────────────────
  pi.on('after_provider_response', (event, ctx) => {
    const q = quotasFromHeaders(event && event.headers);
    if (q && ctx && ctx.ui && typeof ctx.ui.setStatus === 'function') ctx.ui.setStatus('hooked-ratelimit', JSON.stringify(q));
  });

  // A plan-mode session started from hooked gets its notice before the first turn.
  pi.on('session_start', () => {
    if (DRIVEN && mode === 'plan') {
      notice('Plan mode is on (set from the hooked dashboard). Explore and read as needed, but do not edit files or run commands that change anything. When your plan is ready, present it with the ExitPlanMode tool and wait for the approval.');
    }
  });
}
