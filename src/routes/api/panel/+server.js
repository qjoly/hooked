import { json } from '@sveltejs/kit';
import { broadcastEvent } from '$lib/server/live.js';
import { closePanel, listPanels, readSettings, reportPanelError, sendFromPanel, sessionIdForLaunchKey, showPanel } from '$lib/server/core.js';

export function GET() {
  return json({ panels: listPanels() });
}

// show / close come from the hooked MCP server's show_panel tool (keyed by the caller's launch key);
// send and error come from the desktop app: a click on a panel action, a script error it saw.
export async function POST({ request }) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid request' }, { status: 400 });
  if (body.op === 'send') {
    const r = await sendFromPanel(body.session || null, body.id, { label: body.label, value: body.value });
    return r.error ? json({ error: r.error }, { status: r.code }) : json({ ok: true });
  }
  if (body.op === 'error') {
    return reportPanelError(body.session || null, body.id, body.rev, body.message)
      ? json({ ok: true })
      : json({ error: 'unknown panel or empty message' }, { status: 404 });
  }
  const session = sessionIdForLaunchKey(body.launchKey) || null;
  if (body.op === 'close') {
    const id = body.id || 'panel';
    if (!closePanel(session, id)) return json({ error: `no panel "${id}"` }, { status: 404 });
    broadcastEvent('closePanel', { panel: { id, session, closed: true } });
    return json({ ok: true });
  }
  if (!readSettings().featureFlags?.showPanels) return json({ error: 'the showPanels feature flag is off in hooked settings' }, { status: 403 });
  const r = showPanel(session, body.input);
  if (r.error) return json({ error: r.error }, { status: 400 });
  broadcastEvent('showPanel', { panel: r.panel });
  return json({ ok: true, id: r.panel.id, rev: r.panel.rev, session, previousError: r.previousError });
}
