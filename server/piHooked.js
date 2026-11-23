/*
 * hooked's side of its pi package (pi-package/, cf. docs/pi-package.md).
 *
 * The package runs inside each pi session hooked drives and talks back through pi's RPC extension
 * UI protocol: its dialogs arrive here as `extension_ui_request` records, and the answer goes back
 * as an `extension_ui_response`. This module turns them into the dashboard's cards — the same
 * pendingAsk shapes as the Claude path (permission / question / plan), so Question.svelte,
 * Plan.svelte and the desktop app render them with no change — and writes the account quotas the
 * package relays (pi-claude-bridge) where the header gauges read them.
 *
 *   [hooked:permission] {toolName, input}   → permission card, answered {choice, message?}
 *   [hooked:question]   {questions}         → question card,   answered {answers}
 *   [hooked:plan]       {plan}              → plan card,       answered {action, feedback?}
 *   select / confirm of any other extension → a one-question card (best effort)
 *   setStatus "hooked-ratelimit"            → STATUS_DIR snapshot (5h / 7d gauges)
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeSnapshot } from './agent-status.js';

const PACKAGE_CANDIDATES = [
  path.join(process.cwd(), 'pi-package'),
  path.join(import.meta.dirname, '..', 'pi-package'),
  path.join(import.meta.dirname, '..', '..', 'pi-package'),
  path.join(import.meta.dirname, '..', '..', '..', 'pi-package'),
];

// Absolute path of the package (resolved on every launch: the checkout may move), or null.
function hookedPiPackage() {
  if (process.env.HOOKED_PI_PACKAGE) return process.env.HOOKED_PI_PACKAGE;
  return PACKAGE_CANDIDATES.find((p) => {
    try { return fs.statSync(path.join(p, 'extensions', 'hooked.js')).isFile(); } catch (_) { return false; }
  }) || null;
}

// The package is loaded unless the provider opts out (`hookedPackage: false`).
function hookedPackageEnabled(provider) {
  return !(provider && provider.hookedPackage === false) && !!hookedPiPackage();
}

// Environment of a driven pi session for the package: hooked's MCP context (port, launch key,
// show-work flags), the path of the tool definitions, and the session controls at launch.
function hookedPackageEnv(st, mcp) {
  const env = { HOOKED_DRIVEN: '1' };
  if (mcp && mcp.env) Object.assign(env, mcp.env);
  if (mcp && Array.isArray(mcp.args) && mcp.args[0]) env.HOOKED_MCP_SERVER = mcp.args[0];
  env.HOOKED_PERMISSION_MODE = st.permissionMode || 'default';
  env.HOOKED_AUTO_APPROVE = st.autoApprove === false ? '0' : '1';
  return env;
}

// "[hooked:<kind>] <json>" → { kind, payload }, or null for any other title.
function parseHookedTitle(title) {
  const m = /^\[hooked:([a-z]+)\]\s+([\s\S]*)$/.exec(String(title || ''));
  if (!m) return null;
  try { return { kind: m[1], payload: JSON.parse(m[2]) || {} }; } catch (_) { return null; }
}

// Puts `ask` on the registry entry, the way the Claude path's canUseTool does.
function setPending(st, ask) {
  const raw = ask.resolve;
  ask.resolve = (resp) => {
    if (st.pendingAsk === ask) {
      st.pendingAsk = null;
      st.sdkState = 'running';
      st.busy = true;
    }
    try { raw(resp); } finally { if (st._emit) st._emit(true); }
  };
  st.pendingAsk = ask;
  st.sdkState = 'requires_action';
  st.busy = false;
  if (st._emit) st._emit(true);
}

// One `extension_ui_request` record. `send` writes a record to pi's stdin. Returns true when the
// record became a card.
function handleUiRequest(st, rec, send) {
  const respond = (extra) => send({ type: 'extension_ui_response', id: rec.id, ...extra });
  const id = 'pi:' + rec.id;
  switch (rec.method) {
    case 'input':
    case 'editor': {
      const h = parseHookedTitle(rec.title);
      if (!h) {
        // A free-text dialog of another extension: no card for it yet.
        respond({ cancelled: true });
        return false;
      }
      const p = h.payload;
      if (h.kind === 'permission') {
        setPending(st, {
          kind: 'permission', id, toolName: p.toolName || 'tool', input: p.input || null,
          resolve: (resp) => respond({
            value: JSON.stringify(!resp || resp.behavior === 'deny'
              ? { choice: 'deny', ...(resp && resp.message ? { message: resp.message } : {}) }
              : { choice: resp.allowAlways ? 'allow-always' : 'allow' }),
          }),
        });
        return true;
      }
      if (h.kind === 'question') {
        const questions = Array.isArray(p.questions) ? p.questions : [];
        setPending(st, {
          kind: 'question', id, questions,
          resolve: (resp) => {
            let answers = resp && resp.answers;
            if (!answers && resp && resp.freeTextAnswer && questions[0]) answers = { [questions[0].question]: resp.freeTextAnswer };
            respond(answers && Object.keys(answers).length ? { value: JSON.stringify({ answers }) } : { cancelled: true });
          },
        });
        return true;
      }
      if (h.kind === 'plan') {
        setPending(st, {
          kind: 'plan', id, plan: String(p.plan || ''),
          resolve: (resp) => respond(resp && resp.action
            ? { value: JSON.stringify({ action: resp.action, feedback: resp.feedback || '' }) }
            : { cancelled: true }),
        });
        return true;
      }
      respond({ cancelled: true });
      return false;
    }
    case 'select':
    case 'confirm': {
      // Any other extension's choice (permission-gate style extensions…): one question.
      const labels = rec.method === 'confirm' ? ['Yes', 'No'] : (Array.isArray(rec.options) ? rec.options.map(String) : []);
      if (!labels.length) { respond({ cancelled: true }); return false; }
      const question = [rec.title, rec.message].filter(Boolean).join(' — ') || 'Choose';
      setPending(st, {
        kind: 'question', id, questions: [{ question, header: 'Extension', multiSelect: false, options: labels.map((label) => ({ label })) }],
        resolve: (resp) => {
          const pick = (resp && resp.answers && resp.answers[question]) || (resp && resp.freeTextAnswer) || null;
          if (!pick || (resp && resp.behavior === 'deny')) return respond({ cancelled: true });
          respond(rec.method === 'confirm' ? { confirmed: pick === 'Yes' } : { value: pick });
        },
      });
      return true;
    }
    case 'setStatus': {
      if (rec.statusKey === 'hooked-ratelimit' && rec.statusText && st.id) {
        try {
          const rl = JSON.parse(rec.statusText);
          writeSnapshot({ session_id: st.id, source: 'pi', ts: Math.round(Date.now() / 1000), rate_limits: rl });
        } catch (_) { /* malformed: ignored */ }
      }
      return false;
    }
    default:
      return false; // notify / setWidget / setTitle / set_editor_text: nothing to show yet
  }
}

export { hookedPiPackage, hookedPackageEnabled, hookedPackageEnv, parseHookedTitle, handleUiRequest };
