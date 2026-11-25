/*
 * The Flows module's agent tools (cf. modules/index.js). The MCP server (mcp/server.cjs) serves them
 * to Claude and ACP sessions, the module's pi package (./pi) to pi sessions; both only while the
 * module is on. `flow_report` needs the launch key hooked gives the sessions it drives.
 */
'use strict';

const { httpRequest } = require('../../mcp/http.cjs');

const tools = [
  {
    name: 'flow_report',
    description:
      'Reports the result of your stage when hooked runs you as one stage of a flow (a pipeline of sessions). ' +
      'Call it once your part is finished, then end your turn: hooked hands your summary to the next stages. ' +
      'The decider stage must pass a verdict: `done` (closes the flow), `loop` (sends the work back, the summary ' +
      'being the instructions for the next pass) or `escalate` (hands the decision to the user). Other stages ' +
      'pass no verdict, or `escalate` when blocked on a decision that belongs to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'what you did or found, written for the next stages (markdown)' },
        verdict: { type: 'string', enum: ['done', 'loop', 'escalate'] },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    run: (a) => process.env.HOOKED_LAUNCH_KEY
      ? httpRequest('POST', '/api/flows', { op: 'report', launchKey: process.env.HOOKED_LAUNCH_KEY, summary: a.summary, verdict: a.verdict })
      : Promise.resolve({ error: 'this session is not driven by hooked, it cannot be a flow stage' }),
  },
  {
    name: 'list_flows',
    description:
      'Lists the flow templates (pipelines of sessions: pilot, build, review, challenge, decide…) and the flow runs ' +
      'with the state of each stage and its session id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await httpRequest('GET', '/api/flows');
      if (!r.ok) return r;
      const runs = (r.data.runs || []).map((x) => ({
        id: x.id, name: x.name, status: x.status, note: x.note, iteration: x.iteration, cwd: x.cwd,
        link: '/flows?run=' + x.id,
        stages: Object.fromEntries(Object.entries(x.stages).map(([k, s]) => [k, { status: s.status, sessionId: s.sessionId, verdict: s.report?.verdict || null }])),
      }));
      const templates = (r.data.templates || []).map((t) => ({ id: t.id, name: t.name, description: t.description, stages: t.stages.map((s) => s.key) }));
      return { ok: true, data: { templates, runs } };
    },
  },
  {
    name: 'start_flow',
    description:
      'Starts a flow run: hooked launches one session per stage of the template and chains them (each stage gets ' +
      'the reports of the stages before it), looping back when the decider asks for it. The response carries a ' +
      '`link` (relative): emit a markdown link `[label](<link>)` to point the user at the pipeline view.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'flow template id (see list_flows); "feature" is built in' },
        task: { type: 'string', description: 'what the flow should achieve, handed to every stage' },
        cwd: { type: 'string', description: 'project directory' },
        name: { type: 'string', description: 'defaults to the first line of the task' },
        worktree: { type: 'boolean', description: 'run in a new git worktree (defaults to the template setting)' },
        base: { type: 'string', description: 'base branch of the worktree' },
      },
      required: ['templateId', 'task', 'cwd'],
      additionalProperties: false,
    },
    run: async (a) => {
      const r = await httpRequest('POST', '/api/flows', { op: 'start', ...a });
      if (!r.ok) return r;
      return { ok: true, data: { id: r.data.run.id, name: r.data.run.name, cwd: r.data.run.cwd, link: r.data.link } };
    },
  },
];

module.exports = { tools };
