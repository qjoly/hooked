/*
 * CLI pi en mode headless : `pi -p <prompt> --model mistral/<m>` (équivalent de
 * `claude -p --output-format json`). Le stdout est le texte final de l'assistant.
 * Utilisé comme générateur de secours quand le binaire `claude` n'est pas installé
 * (digests, auto-tags, PR review…).
 */
import cp from 'node:child_process';
import { loginEnv } from './agent.js';
import { resolvePiBin, piBinaryAvailable } from './piAgent.js';
import { objFromBraces } from './claudeJson.js';

function piBin() {
  return resolvePiBin();
}

// `pi -p <prompt> --model mistral/<m>` → texte brut de la réponse (ou '' si échec).
async function runPiHeadless(prompt, { cwd = null, timeout = 120000, model = null } = {}) {
  if (!piBinaryAvailable()) {
    return { ok: false, error: 'pi binary not found — install @earendil-works/pi-coding-agent (npm i -g) or set HOOKED_PI_BIN', text: '' };
  }
  const env = await loginEnv();
  const args = ['-p', String(prompt || ''), '--no-session'];
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

export { piBin, runPiHeadless, piAssistantText, piModelJson };
