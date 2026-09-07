#!/usr/bin/env node
/*
 * Serveur MCP local (stdio) pour hooked.
 *
 * Client mince : chaque outil MCP appelle l'API HTTP de hooked sur localhost et renvoie
 * la réponse telle quelle. Toute la logique (pilotage Agent SDK, états, reprise…) reste côté serveur
 * hooked — il doit donc tourner (npm run dev / npm start) pour que ces outils marchent.
 *
 * Zéro dépendance (comme hook.cjs) : protocole JSON-RPC MCP implémenté à la main sur
 * stdin/stdout, messages délimités par des sauts de ligne (transport stdio MCP).
 *
 *   HOOKED_MCP_URL  → URL de base de l'API (défaut http://localhost:<HOOKED_PORT|4123>)
 *   HOOKED_PORT     → port de hooked (défaut 4123), utilisé si HOOKED_MCP_URL absent
 */
'use strict';

const http = require('node:http');

const PORT = process.env.HOOKED_PORT || '4123';
// Défaut en `localhost` (PAS 127.0.0.1) : hooked peut n'écouter qu'en IPv6 (`::1`, le défaut de
// `vite` sans `--host`). Un littéral IPv4 (127.0.0.1) ne bascule jamais sur IPv6 → ECONNREFUSED.
// `localhost` déclenche une résolution DNS + happy-eyeballs (autoSelectFamily, cf. httpRequest) qui
// joint hooked qu'il soit en IPv4 (127.0.0.1) OU IPv6 (::1).
const BASE = (process.env.HOOKED_MCP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'hooked', version: '2.0.0' };

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

// --- définition des outils ----------------------------------------------------

// Modèles & efforts ne sont plus énumérés ici (liste figée = obsolète) : `type: string` libre,
// le serveur hooked valide contre les valeurs dérivées du binaire claude (cf. server/capabilities.js)
// et renvoie une erreur si la valeur est inconnue. MODES reste une liste (concept propre à hooked).
const MODES = ['default', 'auto', 'plan'];

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'Liste toutes les sessions Claude Code suivies par hooked (live + passées) avec leur état ' +
      "courant (working / waiting / attention / idle / ended), modèle, projet, coût et outil en cours.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => httpRequest('GET', '/api/sessions'),
  },
  {
    name: 'get_session',
    description:
      "Détail complet d'une session : conversation, todos, fichiers touchés, sous-agents, " +
      'événements récents et question en attente éventuelle. Le champ `link` (ex. `/session/<id>`) ' +
      "est un deep-link vers la session : pour diriger l'utilisateur vers elle dans hooked, émets un " +
      'lien markdown `[label](<link>)` (chemin RELATIF, pas une URL absolue) — le clic focalise la ' +
      'session dans l\'app sans rechargement.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id de la session' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('GET', '/api/session?id=' + encodeURIComponent(a.id)),
  },
  {
    name: 'start_session',
    description:
      'Démarre une nouvelle session Claude Code pilotée par hooked (ou reprend une session ' +
      'existante via resumeId), dans le dossier indiqué. La réponse inclut `sessionId` et `link` ' +
      "(deep-link relatif `/session/<id>`) : pour pointer l'utilisateur vers la nouvelle session " +
      'dans hooked, émets un lien markdown `[label](<link>)`.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'dossier de travail (requis sauf reprise, où il est déduit)' },
        prompt: { type: 'string', description: 'premier message optionnel envoyé à la session' },
        model: { type: 'string', description: 'modèle optionnel : alias de famille (opus/sonnet/haiku/fable) ou version complète (ex. claude-opus-4-8). Valeurs valides = install claude locale ; une valeur inconnue est rejetée par le serveur.' },
        effort: { type: 'string', description: 'niveau d\'effort optionnel (low/medium/high/xhigh/max, + ultracode si claude ≥ 2.1.203). Validé par le serveur.' },
        resumeId: { type: 'string', description: 'id d\'une session existante à reprendre' },
        worktree: { type: 'boolean', description: 'démarrer dans un git worktree dédié (session neuve uniquement)' },
      },
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/launch', a),
  },
  {
    name: 'stop_session',
    description: 'Stoppe une session. Action irréversible : le process Claude Code se termine.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id de la session à stopper' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/kill', { id: a.id }),
  },
  {
    name: 'reply_to_session',
    description:
      'Envoie un message texte à une session live (comme une saisie au clavier). Si une question ' +
      'AskUserQuestion est en attente, le texte est traité comme la réponse à valider.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id de la session' },
        text: { type: 'string', description: 'message à envoyer' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/reply', { id: a.id, text: a.text }),
  },
  {
    name: 'reply_review_comment',
    description:
      'Répond dans un thread de revue de code (commentaire inline d\'une diff hooked). À utiliser ' +
      'quand un prompt de revue liste des commentaires avec leur thread_id : une réponse courte par ' +
      'commentaire — ce qui a été fait, ou pourquoi non. La réponse apparaît dans la diff, sous la ligne commentée.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id de la session' },
        thread_id: { type: 'string', description: 'id du thread (donné dans le prompt de revue)' },
        text: { type: 'string', description: 'réponse à poster dans le thread' },
      },
      required: ['id', 'thread_id', 'text'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/review', { id: a.id, action: 'reply', threadId: a.thread_id, text: a.text, author: 'claude' }),
  },
  {
    name: 'resolve_review_comment',
    description:
      'Marque un thread de revue résolu (ou le rouvre avec resolved=false) une fois le commentaire ' +
      'traité dans le code. À appeler après reply_review_comment quand la correction est faite.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id de la session' },
        thread_id: { type: 'string', description: 'id du thread' },
        resolved: { type: 'boolean', description: 'true (défaut) = résolu, false = rouvert' },
      },
      required: ['id', 'thread_id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/review', { id: a.id, action: 'resolve', threadId: a.thread_id, resolved: a.resolved !== false }),
  },
  {
    name: 'interrupt_session',
    description: 'Envoie Échap à une session live pour interrompre Claude en cours de travail.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id de la session' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/interrupt', { id: a.id }),
  },
  {
    name: 'set_mode',
    description: 'Change le mode de permission d\'une session live (default / auto / plan).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id de la session' },
        mode: { type: 'string', enum: MODES, description: 'mode de permission cible' },
      },
      required: ['id', 'mode'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/mode', { id: a.id, mode: a.mode }),
  },
  {
    name: 'set_model',
    description: 'Change le modèle et/ou l\'effort d\'une session live (au moins l\'un des deux requis).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id de la session' },
        model: { type: 'string', description: 'nouveau modèle : alias de famille (opus/sonnet/haiku/fable) ou version complète (ex. claude-opus-4-8)' },
        effort: { type: 'string', description: 'nouvel effort (low/medium/high/xhigh/max, + ultracode si claude ≥ 2.1.203)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => httpRequest('POST', '/api/model', { id: a.id, model: a.model, effort: a.effort }),
  },
  {
    name: 'search_sessions',
    description: 'Recherche plein-texte dans les conversations des sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'requête de recherche' },
        project: { type: 'string', description: 'filtrer sur un chemin de projet (optionnel)' },
        limit: { type: 'integer', description: 'nombre max de résultats (défaut 50)' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    run: (a) => {
      const p = new URLSearchParams({ q: a.q });
      if (a.project) p.set('project', a.project);
      if (a.limit != null) p.set('limit', String(a.limit));
      return httpRequest('GET', '/api/search?' + p.toString());
    },
  },
  {
    name: 'get_stats',
    description: 'Statistiques d\'usage (coût, tokens) agrégées par jour / modèle / projet / outil.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'fenêtre en jours (ex. "7", "30") ou "all" (défaut 7)' },
      },
      additionalProperties: false,
    },
    run: (a) => httpRequest('GET', '/api/stats' + (a.range ? '?range=' + encodeURIComponent(a.range) : '')),
  },
  {
    name: 'get_digest',
    description: 'Digest quotidien (récap IA de l\'activité des sessions un jour donné). Sans `date` : index des digests + dernier disponible. Avec `date` (YYYY-MM-DD) : le digest de ce jour.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'jour au format YYYY-MM-DD (défaut : liste tous les digests)' },
      },
      additionalProperties: false,
    },
    run: (a) => httpRequest('GET', '/api/digest' + (a.date ? '?date=' + encodeURIComponent(a.date) : '')),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --- boucle JSON-RPC sur stdio ------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (pas d'id) : on ne répond pas.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return replyError(id, -32602, 'outil inconnu : ' + name);
    try {
      const r = await tool.run(args);
      return reply(id, resultFrom(r));
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'Erreur interne : ' + (e.message || e) }], isError: true });
    }
  }

  if (method === 'ping') return reply(id, {});

  // initialized / autres notifications : rien à faire.
  if (isNotification) return;

  return replyError(id, -32601, 'méthode non supportée : ' + method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      continue; // ligne illisible : on ignore (pas d'id → pas de réponse possible)
    }
    handle(msg).catch((e) => {
      if (msg && msg.id != null) replyError(msg.id, -32603, 'erreur interne : ' + (e.message || e));
    });
  }
});

// Pas d'exit explicite sur 'end' : on laisse l'event loop se vider (les appels HTTP en vol
// se terminent et impriment leur réponse), puis Node sort de lui-même quand stdin est fermé.

