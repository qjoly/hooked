/*
 * The GitHub module's agent tools (cf. modules/index.js). The MCP server (mcp/server.cjs) serves them
 * to Claude and ACP sessions, the module's pi package (./pi) to pi sessions; both only while the
 * module is on. A watch needs the launch key hooked gives the sessions it drives.
 */
'use strict';

const { httpRequest } = require('../../mcp/http.cjs');

const tools = [
  {
    name: 'watch_pull_request',
    description:
      'Watches a GitHub pull request for you. hooked then messages this session when its checks fail or all ' +
      'pass, a merge conflict appears, no check has reported 15 minutes after a push, or someone else comments. ' +
      'Call it after opening or pushing to a PR when you should follow up on CI or review feedback. Each update ' +
      'arrives as a new user message; watching stops on its own once the PR is merged or closed.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Pull request URL. Defaults to the last PR linked in this session.' },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      if (!process.env.HOOKED_LAUNCH_KEY) return { error: 'this session is not driven by hooked, it cannot watch a pull request' };
      const r = await httpRequest('POST', '/api/pr-watch', { op: 'watch', launchKey: process.env.HOOKED_LAUNCH_KEY, url: a.url });
      if (!r.ok) return r;
      return { ok: true, data: `Watching pull request #${r.data.number} (${r.data.url}). You will get a message here when there is news.` };
    },
  },
  {
    name: 'unwatch_pull_request',
    description: 'Stops watching a pull request started with watch_pull_request (all of this session\'s watches when no url is given).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Pull request URL to stop watching' } },
      additionalProperties: false,
    },
    run: async (a) => {
      if (!process.env.HOOKED_LAUNCH_KEY) return { error: 'this session is not driven by hooked' };
      const r = await httpRequest('POST', '/api/pr-watch', { op: 'unwatch', launchKey: process.env.HOOKED_LAUNCH_KEY, url: a.url });
      if (!r.ok) return r;
      const removed = r.data.removed || [];
      return { ok: true, data: removed.length ? `Stopped watching ${removed.join(', ')}.` : 'Nothing was being watched.' };
    },
  },
];

module.exports = { tools };
