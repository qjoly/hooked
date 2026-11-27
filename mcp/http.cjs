/*
 * hooked's HTTP API seen from an agent tool: the minimal client the MCP server (mcp/server.cjs) and
 * the extensions' tools (extensions/<id>/tools.cjs) share. Zero dependencies, like the server.
 *
 *   HOOKED_MCP_URL  → base URL of the API (default http://localhost:<HOOKED_PORT|4123>)
 *   HOOKED_PORT     → hooked's port (default 4123), used when HOOKED_MCP_URL is not set
 */
'use strict';

const http = require('node:http');

const PORT = process.env.HOOKED_PORT || '4123';
// Défaut en `localhost` (PAS 127.0.0.1) : hooked peut n'écouter qu'en IPv6 (`::1`, le défaut de
// `vite` sans `--host`). Un littéral IPv4 (127.0.0.1) ne bascule jamais sur IPv6 → ECONNREFUSED.
// `localhost` déclenche une résolution DNS + happy-eyeballs (autoSelectFamily, cf. httpRequest) qui
// joint hooked qu'il soit en IPv4 (127.0.0.1) OU IPv6 (::1).
const BASE = (process.env.HOOKED_MCP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// --- client HTTP minimal ------------------------------------------------------

function httpRequest(method, pathQuery, body) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(BASE + pathQuery);
    } catch (e) {
      return resolve({ ok: false, status: 0, error: 'URL invalide : ' + e.message });
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
      // Essaie IPv4 ET IPv6 (happy-eyeballs) quand hostname=localhost → joint hooked que vite
      // écoute en 127.0.0.1 ou ::1. Défaut à true depuis Node 20 ; explicite par sûreté.
      autoSelectFamily: true,
    };
    if (payload) {
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = payload.length;
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {}
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, status: res.statusCode, data });
      });
    });
    req.on('error', (e) => {
      resolve({
        ok: false,
        status: 0,
        error:
          `impossible de joindre hooked sur ${BASE} (${e.code || e.message}). ` +
          `Le serveur hooked tourne-t-il ? (npm run dev / npm start)`,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Enveloppe un résultat HTTP en contenu MCP. Échec HTTP → isError pour que l'agent le voie.
function resultFrom(r) {
  if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
  const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
  if (!r.ok) {
    const msg = r.data && r.data.error ? r.data.error : text;
    return { content: [{ type: 'text', text: `Erreur ${r.status} : ${msg}` }], isError: true };
  }
  return { content: [{ type: 'text', text }] };
}

module.exports = { BASE, httpRequest, resultFrom };
