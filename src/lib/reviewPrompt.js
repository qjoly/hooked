/*
 * Review-thread instructions of the Review lens (batch review prompt and per-thread follow-ups),
 * and the "Review with Claude" request, where Claude opens the threads itself.
 *
 * Claude REPLIES, and that is all. It used to be told to call `resolve_review_comment` "once the
 * code is fixed", so every answer closed its own thread: the diff emptied itself of comments
 * before the reviewer had read a single reply. Closing — now archiving — is the reviewer's
 * action, and the tool no longer exists (cf. server/reviewThreads.js).
 *
 * The receiving session is NOT guaranteed to have the hooked MCP server: it is only certain for
 * sessions launched by hooked itself (cf. server/agent.js, hookedMcpServer). Hence three
 * precautions, each learned from a session that fixed the code but couldn't answer the threads:
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

const reviewApi = () => `http://localhost:${hookedPort()}/api/review`;

export function threadInstructions(sessionId) {
  const api = reviewApi();
  return (
    `Reply in the thread with the hooked MCP tool mcp__hooked__reply_review_comment ` +
    `(id: "${sessionId}", thread_id above). Do NOT close the thread — closing is the reviewer's ` +
    `call, and there is no tool for it. If that MCP tool is unavailable, POST the same reply to ` +
    `the local hooked API instead: curl -sS -X POST ${api} -H 'content-type: application/json' ` +
    `-d '{"id":"${sessionId}","action":"reply","threadId":"<thread_id>","text":"<your reply>","author":"claude"}'. ` +
    `Keep your chat answer to a one-line summary — the details belong in the thread.`
  );
}

/**
 * The request behind "Review with Claude": review the diff on screen and report each finding as a
 * thread of its own. `scope` reads after "Review" (the lens's description of what it diffs), `rev`
 * is the revision its new side comes from (none: the file on disk), `files` are the absolute paths
 * on screen. `open` and `dismissed` ({ file, anchor, text }) are the threads already there, live
 * and archived: neither is to be raised again — an archived finding is one the reviewer turned down.
 */
export function reviewRequestPrompt(sessionId, { scope, rev = null, files, open, dismissed = [] }) {
  const api = reviewApi();
  const list = files.map((f) => '- ' + f).join('\n');
  const brief = (threads) => threads.map((t) => `- ${t.file} (${t.anchor}): ${t.text.split('\n')[0].slice(0, 160)}`).join('\n');
  const lines = rev
    ? `1-based lines of the file at revision ${rev} (git show ${rev}:<path>), i.e. the new side of the diff`
    : '1-based lines of the file as it is on disk now, i.e. the new side of the diff';
  return (
    `Review ${scope}. Files under review:\n${list}\n\n` +
    `Look for real problems — bugs, wrong behaviour, unhandled cases, risky changes — and for ` +
    `simplifications worth making. Check each finding against the code before reporting it; skip ` +
    `style nits. Do NOT change any code: this is a review, fixes come once I answer in the threads.\n\n` +
    `Report EACH finding as its own inline thread with the hooked MCP tool ` +
    `mcp__hooked__add_review_comment (id: "${sessionId}", file: absolute path, line / end_line: ` +
    `${lines}; text: what is wrong, why it matters and the fix you suggest, in Markdown). If that MCP ` +
    `tool is unavailable, POST each finding to the local hooked API instead: curl -sS -X POST ${api} ` +
    `-H 'content-type: application/json' -d '{"id":"${sessionId}","action":"claude-comment",` +
    `"file":"<path>","start":<line>,"end":<end_line>,"text":"<finding>"}'. ` +
    `Keep your chat answer to a one-line summary (how many threads you opened) — the findings ` +
    `belong in the threads.` +
    (open.length ? '\n\nThese threads are already open, do not raise them again:\n' + brief(open) : '') +
    (dismissed.length ? '\n\nThese were dismissed by the reviewer, do not raise them again:\n' + brief(dismissed) : '')
  );
}
