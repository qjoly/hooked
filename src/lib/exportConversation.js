// Render a loaded session (the `/api/session` object) as a Markdown transcript.
// Client-side only: `s.messages` is already in the browser, so no backend round-trip.

// Wrap arbitrary text in a code fence longer than any backtick run inside it,
// so content containing ``` doesn't close the fence early and break rendering.
function codeFence(text) {
  let longest = 0;
  for (const run of String(text).match(/`+/g) || []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

// Inline code: delimiter run must be longer than any inside, and padded with a
// space when the content starts/ends with a backtick (CommonMark rule).
function inlineCode(text) {
  let longest = 0;
  for (const run of String(text).match(/`+/g) || []) longest = Math.max(longest, run.length);
  const d = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) ? ' ' : '';
  return `${d}${pad}${text}${pad}${d}`;
}

function toolBlock(t) {
  const head = `**🔧 ${t.name}**` + (t.detail ? ` — ${inlineCode(t.detail)}` : '');
  const input = t.inputText ? `\n\n${codeFence(t.inputText)}` : '';
  const result = t.result ? `\n\n<details><summary>result</summary>\n\n${codeFence(t.result)}\n</details>` : '';
  return head + input + result;
}

function messageMd(m) {
  const ts = m.ts ? ` · ${m.ts}` : '';
  if (m.role === 'system') return `> ${m.text}${ts}\n`;
  const who = m.role === 'user' ? (m.auto ? '↻ Auto-resumed' : '🧑 You') : '🤖 Claude';
  const parts = (m.parts && m.parts.length)
    ? m.parts
    : [...(m.text ? [{ type: 'text', text: m.text }] : []), ...((m.tools || []).map((t) => ({ type: 'tool', tool: t })))];
  const body = parts
    .map((p) => (p.type === 'text' ? p.text : toolBlock(p.tool)))
    .filter(Boolean)
    .join('\n\n');
  return `### ${who}${ts}\n\n${body}\n`;
}

export function conversationToMarkdown(s) {
  const header = [
    `# ${s.title || s.id}`,
    '',
    `- **Session**: \`${s.id}\``,
    s.project ? `- **Project**: ${s.project}` : null,
    s.model ? `- **Model**: ${s.model}` : null,
    s.startTs ? `- **Started**: ${s.startTs}` : null,
    s.lastTs ? `- **Last**: ${s.lastTs}` : null,
    '',
    '---',
    '',
  ].filter((l) => l !== null).join('\n');
  const body = (s.messages || []).map(messageMd).join('\n---\n\n');
  return header + body;
}
