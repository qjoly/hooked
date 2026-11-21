/*
 * CLI pi en mode headless : `pi -p <prompt> --model mistral/<m>` (équivalent de
 * `claude -p --output-format json`). Le stdout est le texte final de l'assistant.
 * Utilisé comme générateur de secours quand le binaire `claude` n'est pas installé
 * (digests, auto-tags, PR review…).
 */
import cp from 'node:child_process';
import os from 'node:os';
import { loginEnv } from './agent.js';
import { resolvePiBin, piBinaryAvailable } from './piAgent.js';
import { objFromBraces } from './claudeJson.js';

function piBin() {
  return resolvePiBin();
}

// `pi -p <prompt> --model mistral/<m>` → texte brut de la réponse (ou '' si échec).
async function runPiHeadless(prompt, { cwd = null, timeout = 120000, model = null, extraArgs = [] } = {}) {
  if (!piBinaryAvailable()) {
    return { ok: false, error: 'pi binary not found — install @earendil-works/pi-coding-agent (npm i -g) or set HOOKED_PI_BIN', text: '' };
  }
  const env = await loginEnv();
  const args = ['-p', String(prompt || ''), '--no-session', ...extraArgs];
  if (model) args.push('--model', model.startsWith('mistral/') ? model : `mistral/${model}`);
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.execFile(piBin(), args, {
        cwd: cwd || undefined, env: { ...process.env, ...env }, timeout, encoding: 'utf8', maxBuffer: 8 << 20,
      });
    } catch (e) {
      return resolve({ ok: false, error: String(e && e.message || e), text: '' });
    }
    let out = '';
    let err = '';
    // pi -p lit stdin jusqu'à EOF ("piped stdin prepends to the prompt") : fermer tout de suite,
    // sinon le process attend indéfiniment sur le pipe ouvert d'execFile.
    try { child.stdin.end(); } catch (_) {}
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e), text: '' }));
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, error: code === 0 ? '' : err.slice(0, 500), text: piAssistantText(out) });
    });
  });
}

// stdout de `pi -p` : texte final (éventuellement précédé de logs) → on garde la dernière
// ligne non vide (le texte de l'assistant).
function piAssistantText(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return '';
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : stdout.trim();
}

// Le modèle a répondu du JSON (digests/tags) → objet parsé, sinon null.
function piModelJson(stdout) {
  return objFromBraces(piAssistantText(stdout));
}

// ── Session title from the first prompt ─────────────────────────────────────────────────────────
// Claude Code names its sessions itself; pi does not. A small, cheap Mistral model does it once,
// right after launch, and the driver applies it through the `set_session_name` RPC command.
const TITLE_MODEL = process.env.HOOKED_PI_TITLE_MODEL || 'ministral-8b-latest';
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX = 80;
const TITLE_SYSTEM = 'You name coding-assistant sessions for a dashboard. Given the first message of a session, '
  + 'reply with a short title (3 to 7 words) that says what the work is about. Use the language the message is '
  + 'written in. No quotes, no trailing period, no emoji. Reply with the title only.';
// Lean call: no tools, MCP, skills, templates or context files. Extensions stay on: the Mistral
// subscription login is provided by a pi extension, and disabling them drops the credentials.
const TITLE_ARGS = ['--no-tools', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files',
  '--thinking', 'off', '--system-prompt', TITLE_SYSTEM];

// Raw model output → a usable title, or '' when there is nothing sensible to keep.
function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(title|titre)\s*:\s*/i, '')
    .replace(/^[\s"'`«“‘*#]+|[\s"'`»”’*]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function suggestPiTitle(prompt) {
  const text = String(prompt || '').trim().slice(0, 2000);
  if (!text) return '';
  const r = await runPiHeadless(`Message: ${text}`, {
    cwd: os.tmpdir(), timeout: TITLE_TIMEOUT_MS, model: TITLE_MODEL, extraArgs: TITLE_ARGS,
  });
  return r.ok ? cleanTitle(r.text) : '';
}

export { piBin, runPiHeadless, piAssistantText, piModelJson, cleanTitle, suggestPiTitle };
