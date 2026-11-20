/*
 * CLI Mistral Vibe en mode headless : `vibe --output json -p <prompt>` (équivalent de
 * `claude -p --output-format json`). Le stdout est un ARRAY d'events (entries projetées du
 * journal) ; le texte du modèle est dans le dernier message assistant
 * (content: [{type:'text', text}]). Utilisé comme générateur de secours quand le binaire
 * `claude` n'est pas installé (digests, auto-tags, PR review…).
 */
import cp from 'node:child_process';
import { loginEnv } from './agent.js';
import { objFromBraces } from './claudeJson.js';

function vibeBin() {
  return process.env.HOOKED_VIBE_BIN || 'vibe';
}

// `vibe --output json -p <prompt>` → texte brut du dernier message assistant (ou '' si échec).
async function runVibeHeadless(prompt, { cwd = null, timeout = 120000, model = null } = {}) {
  const env = await loginEnv();
  const args = ['--output', 'json', '-p', String(prompt || '')];
  if (model) args.push('--model', model);
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.execFile(vibeBin(), args, {
        cwd: cwd || undefined, env: { ...process.env, ...env }, timeout, encoding: 'utf8', maxBuffer: 8 << 20,
      });
    } catch (e) {
      return resolve({ ok: false, error: String(e && e.message || e), text: '' });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e), text: '' }));
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, error: code === 0 ? '' : err.slice(0, 500), text: vibeAssistantText(out) });
    });
  });
}

// Dernier message assistant de l'array d'events → texte concaténé.
function vibeAssistantText(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return '';
  let arr;
  try { arr = JSON.parse(stdout); } catch (_) { return stdout.trim(); }
  if (!Array.isArray(arr)) return stdout.trim();
  const parts = [];
  for (const e of arr) {
    if (e && e.type === 'message' && e.role === 'assistant' && Array.isArray(e.content)) {
      for (const b of e.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
  }
  return parts.join('\n');
}

// Le modèle a répondu du JSON (digests/tags) → objet parsé, sinon null.
function vibeModelJson(stdout) {
  return objFromBraces(vibeAssistantText(stdout));
}

export { vibeBin, runVibeHeadless, vibeAssistantText, vibeModelJson };
