/*
 * The Cron module's agent tools (cf. modules/index.js). The MCP server (mcp/server.cjs) serves them
 * to Claude and ACP sessions, the module's pi package (./pi) to pi sessions; both only while the
 * module is on.
 */
'use strict';

const { httpRequest } = require('../../mcp/http.cjs');

const tools = [
  {
    name: 'list_cron_tasks',
    description: 'Lists the cron tasks: prompts hooked launches as a new session on a schedule, with their next run and recent runs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => httpRequest('GET', '/api/cron'),
  },
  {
    name: 'save_cron_task',
    description:
      'Creates a cron task, or updates one when `id` is given. An update only changes the fields you pass. ' +
      'Each run starts a new session tagged `cron` and closes the previous run if it is idle.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id of the task to update (omit to create one)' },
        name: { type: 'string', description: 'defaults to the first line of the prompt' },
        schedule: { type: 'string', description: 'five-field cron expression in local time (minute hour day-of-month month day-of-week), or @hourly / @daily / @weekly / @monthly' },
        cwd: { type: 'string', description: 'project directory the session runs in' },
        prompt: { type: 'string', description: 'first message sent to each run' },
        model: { type: 'string', description: 'optional model; empty for the Claude Code default' },
        effort: { type: 'string', description: 'optional effort; empty for the Claude Code default' },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'] },
        ephemeral: { type: 'boolean', description: 'each run archives itself once it is sure nothing is left for the user' },
        enabled: { type: 'boolean', description: 'false pauses the scheduled runs' },
        provider: { type: 'string', description: 'provider id the runs launch on (see list_providers); defaults to the default provider of the settings' },
      },
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/cron', { op: 'save', task: a }),
  },
  {
    name: 'delete_cron_task',
    description: 'Deletes a cron task. The sessions it already started are kept.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id of the task' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/cron', { op: 'delete', id: a.id }),
  },
  {
    name: 'run_cron_task',
    description:
      'Runs a cron task now, outside its schedule. Fails if its previous run is still working or waiting on the user. ' +
      'The response carries `sessionId` and `link` (relative `/session/<id>`): emit a markdown link `[label](<link>)` to point the user at it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id of the task' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/cron', { op: 'run', id: a.id }),
  },
];

module.exports = { tools };
