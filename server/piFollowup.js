/*
 * Follow-up suggestions for pi sessions (Claude through pi, Mistral…).
 *
 * After each turn, Claude Code works out the message the user is likely to send next (the SDK's
 * `prompt_suggestion`), and the dashboard offers it as `st.followup`: ghost text in the composer,
 * a Send button on the Deck card. pi has no such thing, and pi-claude-bridge does not pass Claude
 * Code's on. So when a pi turn ends, one small headless call predicts it from the last exchange:
 * `claude -p` on Haiku, with no trace (no session file, no hooks, no tools, no MCP), as hooked's
 * other headless calls do (server/autoTags.js). Without a claude binary, pi's headless mode with
 * the provider's small model does it.
 *
 * The suggestion is dropped when a new prompt went out in the meantime, when the session is busy
 * again, or when a card waits for the user: the same moments the Claude path shows none.
 */
import os from 'node:os';

const MAX_PART = 3000;
const MAX_SUGGESTION = 200;
const TIMEOUT_MS = 60_000;

const INSTRUCTIONS = [
  'You predict the next message a developer will send to their coding assistant.',
  'Below are their last request and the assistant\'s last reply.',
  'Write the message the developer is most likely to send next: short (under 15 words), concrete,',
  'in the language of their request, written as the developer (an instruction or a question).',
  'If the work looks finished and nothing obvious follows, answer exactly NONE.',
  'Reply with the message only: no quotes, no preamble.',
].join(' ');

const clip = (s) => {
  const t = String(s || '').trim();
  return t.length > MAX_PART ? '…' + t.slice(-MAX_PART) : t;
};

export function followupPrompt(user, reply) {
  return `${INSTRUCTIONS}\n\n<request>\n${clip(user)}\n</request>\n\n<reply>\n${clip(reply)}\n</reply>`;
}

// The model's answer → a suggestion, or null (NONE, empty, too long, or not a user message).
export function cleanSuggestion(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(next message|suggestion|user)\s*:\s*/i, '').replace(/^["'`«“]+|["'`»”]+$/g, '').trim();
  if (!t || /^none\.?$/i.test(t) || t.length > MAX_SUGGESTION) return null;
  return t;
}

const LEAN_PI_ARGS = ['--no-tools', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--thinking', 'off'];

// One headless call → the raw answer ('' on failure). Imports are lazy: piAgent.js loads this
// module, and mcp.js reaches agent.js, which loads piAgent.js.
async function defaultRun(prompt, provider) {
  const { resolveClaudeBin } = await import('./commands.js');
  if (resolveClaudeBin()) {
    const { runClaude } = await import('./mcp.js');
    const { resultEnvelope } = await import('./claudeJson.js');
    const r = await runClaude([
      '-p', prompt, '--model', 'haiku', '--output-format', 'json',
      '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
      '--settings', JSON.stringify({ disableAllHooks: true }),
    ], os.tmpdir(), TIMEOUT_MS);
    const env = resultEnvelope(r.stdout);
    return env && !env.is_error && typeof env.result === 'string' ? env.result : '';
  }
  const { runPiHeadless, titleModelFor } = await import('./piCli.js');
  const model = await titleModelFor(provider);
  if (!model) return '';
  const r = await runPiHeadless(prompt, { cwd: os.tmpdir(), timeout: TIMEOUT_MS, model, provider, extraArgs: LEAN_PI_ARGS });
  return r.ok ? r.text : '';
}

// Called at the end of a pi turn. `st` is the registry entry; `run` is injected for the tests.
export async function suggestFollowup(st, { run = defaultRun } = {}) {
  const user = st._followupUser;
  const reply = st._followupReply;
  if (!user || !reply) return null;
  const seq = st._followupSeq || 0;
  let suggestion = null;
  try { suggestion = cleanSuggestion(await run(followupPrompt(user, reply), st.providerConfig || null)); } catch (_) { suggestion = null; }
  // Stale: a new prompt went out, the session works again, or a card waits for the user.
  if ((st._followupSeq || 0) !== seq || st.busy || st.pendingAsk || st.ended) return null;
  st.followup = suggestion;
  if (suggestion && st._emit) st._emit();
  return suggestion;
}
