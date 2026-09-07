/*
 * Review-thread instructions shared by Ship.svelte and Branch.svelte (batch review prompt and
 * per-thread follow-ups). The receiving session is NOT guaranteed to have the hooked MCP server:
 * it is only certain for sessions launched by hooked itself (cf. server/agent.js, hookedMcpServer).
 * Hence three precautions, each learned from a session that fixed the code but couldn't answer
 * the threads:
 *   - tools are named by their FULL MCP name (mcp__hooked__…) so ToolSearch `select:` finds them;
 *   - the LITERAL session id is embedded — a session does not know its own hooked id;
 *   - an HTTP fallback on the local hooked API is spelled out (the MCP server is a thin proxy of
 *     that same endpoint, cf. src/routes/api/review/+server.js), usable with plain curl.
 */

// Port the session should dial: hooked runs on the same machine as the sessions it pilots, so
// localhost + the port serving this page. `location` is guarded for non-browser contexts (tests).
function hookedPort() {
  return (typeof location !== 'undefined' && location.port) || '4123';
}

export function threadInstructions(sessionId) {
  const api = `http://localhost:${hookedPort()}/api/review`;
  return (
    `Reply in the thread with the hooked MCP tool mcp__hooked__reply_review_comment ` +
    `(id: "${sessionId}", thread_id above), and call mcp__hooked__resolve_review_comment once the ` +
    `code is fixed. If these MCP tools are unavailable, POST the same actions to the local hooked ` +
    `API instead: curl -sS -X POST ${api} -H 'content-type: application/json' ` +
    `-d '{"id":"${sessionId}","action":"reply","threadId":"<thread_id>","text":"<your reply>","author":"claude"}' ` +
    `then -d '{"id":"${sessionId}","action":"resolve","threadId":"<thread_id>","resolved":true}'. ` +
    `Keep your chat answer to a one-line summary — the details belong in the thread.`
  );
}
