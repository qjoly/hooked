/*
 * pi in headless mode: `pi -p <prompt> [--model <provider/id>]` (the equivalent of
 * `claude -p --output-format json`). stdout is the assistant's final text.
 * Used for session titles and as the fallback generator when no `claude` binary is installed
 * (digests, auto-tags…). Every call takes the PROVIDER config (binary, env, agent dir, model
 * qualification), so a custom pi-based provider runs its headless calls on its own profile.
 */
import cp from 'node:child_process';
import os from 'node:os';
import { loginEnv } from './agent.js';
import { resolvePiBin, piBinaryAvailable, piEnvFor, qualifyModel, piCatalogFor } from './piAgent.js';
import { objFromBraces } from './claudeJson.js';

function piBin(provider = null) {
  return resolvePiBin(provider);
}

// Provider of headless calls that name none (digest / auto-tags fallback when no `claude` binary is
// installed): the first enabled pi-engine provider, built-in `pi` first.
async function defaultPiProvider() {
  const { providerConfigs, isProviderEnabled } = await import('./providers.js');
  const list = providerConfigs().filter((p) => p.engine === 'pi');
  return list.find((p) => p.id === 'pi' && isProviderEnabled(p.id)) || list.find((p) => isProviderEnabled(p.id)) || null;
}

// `pi -p <prompt> [--model …]` → the reply's raw text (or '' on failure).
async function runPiHeadless(prompt, { cwd = null, timeout = 120000, model = null, extraArgs = [], provider } = {}) {
  if (provider === undefined) provider = await defaultPiProvider().catch(() => null);
  if (!piBinaryAvailable(provider)) {
    return { ok: false, error: 'pi binary not found — install @earendil-works/pi-coding-agent (npm i -g) or set HOOKED_PI_BIN', text: '' };
  }
  const env = piEnvFor({ ...process.env, ...(await loginEnv()) }, provider);
  const args = ['-p', String(prompt || ''), '--no-session', ...extraArgs];
  const m = qualifyModel(model, provider);
  if (m) args.push('--model', m);
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.execFile(piBin(provider), args, {
        cwd: cwd || undefined, env, timeout, encoding: 'utf8', maxBuffer: 8 << 20,
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
// Claude Code names its sessions itself; pi does not. A small, cheap model does it once, right
// after launch, and the driver applies it through the `set_session_name` RPC command.
// Which model: the provider's `titleModel` ('' switches naming off), else HOOKED_PI_TITLE_MODEL,
// else the first small model of the provider's catalog (by name), else none.
const SMALL_MODEL_RE = [/ministral-8b/i, /ministral/i, /haiku/i, /flash-lite|nano|mini\b|-mini-/i, /flash|small/i];
async function titleModelFor(provider) {
  if (provider && typeof provider.titleModel === 'string') return provider.titleModel || null;
  if (process.env.HOOKED_PI_TITLE_MODEL) return process.env.HOOKED_PI_TITLE_MODEL;
  const catalog = await piCatalogFor(provider).catch(() => []);
  for (const re of SMALL_MODEL_RE) {
    const hit = catalog.find((m) => re.test(m.id));
    if (hit) return hit.ref;
  }
  return null;
}
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX = 80;
const TITLE_SYSTEM = 'You name coding-assistant sessions for a dashboard. Given the first message of a session, '
  + 'reply with a short title (3 to 7 words) that says what the work is about. Use the language the message is '
  + 'written in. No quotes, no trailing period, no emoji. Reply with the title only.';
// Lean call: no tools, MCP, skills, templates or context files. Extensions stay on: a provider
// login can come from a pi extension (pi-mistral-subscription…), disabling them drops it.
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

async function suggestPiTitle(prompt, provider = null) {
  const text = String(prompt || '').trim().slice(0, 2000);
  if (!text) return '';
  const model = await titleModelFor(provider);
  if (!model) return '';
  const r = await runPiHeadless(`Message: ${text}`, {
    cwd: os.tmpdir(), timeout: TITLE_TIMEOUT_MS, model, extraArgs: TITLE_ARGS, provider,
  });
  return r.ok ? cleanTitle(r.text) : '';
}

export { piBin, runPiHeadless, piAssistantText, piModelJson, cleanTitle, suggestPiTitle, titleModelFor };
