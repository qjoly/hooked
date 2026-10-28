/*
 * Reconstruit la conversation (style chat) : 1 bulle user / 1 bulle assistant par tour,
 * en fusionnant l'activité assistant entre deux prompts. Chaque tool_use porte son input
 * et son résultat (apparié par tool_use_id) pour permettre le détail au clic.
 *
 * `forkUuid` : uuid de la DERNIÈRE ligne brute du transcript composant la bulle (pour une
 * bulle assistant fusionnée, la dernière ligne assistant du tour). Sert de point de coupe
 * stable pour forker une session à partir de ce message (cf. server/fork.js) — les vieux
 * transcripts sans uuid laissent simplement ce champ à undefined (fork indisponible).
 */
import fs from 'node:fs';
import { chatText, toolDetail, toolDiffOps, toolInputText, toolResultText, toolSendFiles, toolShowWork } from './util.js';

// Plafond par message dans la charge utile de la conversation : une session porte des centaines
// de messages et la liste entière repart à chaque rafraîchissement. Au-delà, le texte est coupé
// ET marqué `truncated` — la fin n'est plus perdue, elle est à une requête (readMessageText) :
// le front la charge quand on déplie le message. Le drapeau n'est posé QUE s'il y a coupe (les
// messages courts gardent leur forme d'origine, cf. la baseline de caractérisation).
const TEXT_CAP = 8000;
const FULL_CAP = 400000; // garde-fou sur le texte complet servi à la demande
const capped = (t) => (t.length > TEXT_CAP ? { text: t.slice(0, TEXT_CAP), truncated: true } : { text: t });

// `attachment.queued_command` prompt. It used to be a string and became an array of blocks. The
// string is kept raw: chatText strips tags, which would erase the <task-notification> /
// <agent-message> markers we look for.
function queuedPrompt(j) {
  if (j.type !== 'attachment' || !j.attachment || j.attachment.type !== 'queued_command') return null;
  return typeof j.attachment.prompt === 'string' ? j.attachment.prompt : chatText(j.attachment.prompt);
}

// A subagent's message to this session (its final report, or a SendMessage on the way). The CLI
// writes the same message on up to four carriers: queue-operation enqueue/remove, attachment
// queued_command, and a user line with `origin.kind: "peer"`. The closing tag only counts at
// column 0: the CLI indents every line of a report so that a tag inside it cannot close the frame.
function agentMessage(j) {
  const text = j.type === 'queue-operation' ? j.content
    : j.type === 'user' && j.message ? j.message.content
    : queuedPrompt(j);
  const m = typeof text === 'string' && text.match(/<agent-message from="([^"]+)">\n([\s\S]*?)\n<\/agent-message>/);
  return m ? { from: m[1], body: m[2] } : null;
}

// A final report comes wrapped in a frame written for the model ("[Subagent hand-back] … The
// report follows:") with every line indented by two spaces. Keep what the subagent wrote.
const HANDBACK_REPORT = 'The report follows:\n';
function unframeReport(body) {
  const at = body.indexOf(HANDBACK_REPORT);
  if (!body.startsWith('[Subagent hand-back]') || at < 0) return body;
  return body.slice(at + HANDBACK_REPORT.length).split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
}

// includeSidechain : pour un transcript de sous-agent (tout est isSidechain), on garde tout.
function buildConversation(fp, includeSidechain) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const lines = data.split('\n');
  // passe 1 : indexe les résultats d'outils par tool_use_id
  // + collecte les textes des vrais tours user (pour dédup des queue-operations traitées)
  const results = new Map();
  // Contenu écrasé par un Write, par tool_use_id : le tool_use ne porte que le NOUVEAU contenu,
  // l'ancien est sur la ligne de résultat (`toolUseResult.originalFile`, non vide seulement si le
  // fichier existait déjà). Sans lui, le chip d'un Write affiche tout le fichier en ajout.
  const writeOriginals = new Map();
  const processedUserTexts = new Set();
  // A subagent's report is not in its Agent tool_result (that one only says "launched" or
  // "delivered as a message"): it arrives later as an <agent-message>, matched by agentId.
  const agentOfToolUse = new Map(); // tool_use_id → agentId
  const agentMessages = new Map();  // agentId → bodies, in arrival order, one per message
  // clé de dédup queue-op ↔ tour user : on collapse TOUT le whitespace (pas seulement `[ \t]+`
  // comme chatText) pour qu'un collage multi-espaces (table alignée) ou multi-lignes matche.
  const dedupKey = (t) => chatText(t).replace(/\s+/g, ' ').trim();
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const am = agentMessage(j);
    if (am) {
      const bodies = agentMessages.get(am.from) || [];
      if (!bodies.includes(am.body)) bodies.push(am.body);
      agentMessages.set(am.from, bodies);
    }
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (Array.isArray(c)) {
        const tur = j.toolUseResult && typeof j.toolUseResult === 'object' ? j.toolUseResult : null;
        for (const b of c) {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            results.set(b.tool_use_id, toolResultText(b.content));
            const orig = tur ? tur.originalFile : null;
            if (typeof orig === 'string' && orig) writeOriginals.set(b.tool_use_id, orig);
            if (tur && typeof tur.agentId === 'string') agentOfToolUse.set(b.tool_use_id, tur.agentId);
          }
        }
      }
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      const isTaskNotif = typeof c === 'string' && c.includes('<task-notification>');
      if (!isToolResult && !isTaskNotif) {
        const text = dedupKey(c);
        if (text) processedUserTexts.add(text);
      }
    }
  }
  // Not capped at TEXT_CAP: a tool chip has no way to fetch a tail, and most reports run past it.
  // The payload stays about the same, since each report used to come as two capped user bubbles.
  const agentReport = (toolUseId) => {
    const bodies = agentMessages.get(agentOfToolUse.get(toolUseId));
    return bodies ? bodies.map(unframeReport).join('\n\n---\n\n').slice(0, FULL_CAP) : null;
  };
  const delegatedAgents = new Set(agentOfToolUse.values());
  const msgs = [];
  const seenNotes = new Set(); // dédup des <task-notification> (mêmes notifs sur plusieurs porteurs)
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (!includeSidechain && j.isSidechain) continue;
    // A message from a subagent of this session is shown as the result of its Agent call (see
    // agentReport), not as a bubble: it is model output, not something the user typed.
    const am = agentMessage(j);
    if (am && delegatedAgents.has(am.from)) continue;
    // Notification de tâche de fond (Bash run_in_background / Monitor) : <task-notification> livrée via
    // 3 porteurs (queue-operation, user/system, attachment queued_command). Sans ça, une complétion
    // « ré-invoque » l'agent sans cause visible, et la variante user/system s'afficherait comme un faux
    // message « 🧑 You » (XML brut). On la rend en ligne système sobre, DÉDUPLIQUÉE par task-id+résumé
    // (une même notif peut arriver en double sur plusieurs porteurs).
    // `attachment.queued_command` porte DEUX choses : une notification de tâche de fond, et le
    // message tapé pendant que l'agent travaille.
    const qc = queuedPrompt(j);
    const note =
      (j.type === 'queue-operation' && typeof j.content === 'string' && j.content.includes('<task-notification>')) ? j.content :
      (qc && qc.includes('<task-notification>')) ? qc :
      (j.type === 'user' && j.message && typeof j.message.content === 'string' && j.message.content.includes('<task-notification>')) ? j.message.content :
      null;
    if (note) {
      const m = note.match(/<summary>([\s\S]*?)<\/summary>/i);
      const summary = m ? m[1].trim() : '';
      const tid = (note.match(/<task-id>\s*(\S+?)\s*<\/task-id>/i) || [])[1] || '';
      const key = tid + '|' + summary || note.trim();
      if (!seenNotes.has(key)) {
        seenNotes.add(key);
        msgs.push({ role: 'system', kind: 'bg', ts: j.timestamp, text: (summary || 'Background task update').slice(0, 400) });
      }
      continue;
    }
    // Sortie d'une commande locale (`type:"system", subtype:"local_command"`). C'est là qu'atterrit
    // le rendu d'un skill lancé en commande slash : /code-review écrit sa revue entière ici, et
    // NULLE PART ailleurs dans le transcript principal — aucun tour assistant n'est journalisé. Sans
    // ce cas, la conversation s'arrêtait sur le prompt et la revue n'était visible nulle part.
    // Compaction boundary: from here on the model sees a summary instead of what came before. One
    // system line, with the CLI's own before/after sizes (`postTokens` leaves out system + tools).
    if (j.type === 'system' && j.subtype === 'compact_boundary') {
      const meta = j.compactMetadata || {};
      msgs.push({
        role: 'system', kind: 'compact', ts: j.timestamp, text: 'Conversation compacted',
        preTokens: meta.preTokens || null, postTokens: meta.postTokens || null,
      });
      continue;
    }
    if (j.type === 'system' && j.subtype === 'local_command' && typeof j.content === 'string') {
      const out = (j.content.match(/<local-command-stdout>([\s\S]*)<\/local-command-stdout>/) || [])[1];
      const raw = (out || '').trim();
      if (raw) {
        const c = capped(raw);
        msgs.push({
          role: 'assistant', ts: j.timestamp, ...c,
          parts: [{ type: 'text', text: c.text }], tools: [], localCommand: true, forkUuid: j.uuid,
        });
      }
      continue;
    }
    // Message tapé pendant que l'agent travaille, absorbé dans le tour en cours
    // (`reason:"absorbed_mid_turn"`) : il n'ouvre PAS de tour user et n'existe QUE dans cet
    // attachment. Non rendu, il disparaissait du fil — et la bulle « ⏳ queued » du front, qui
    // s'efface en matchant une bulle user de même texte, ne se résolvait jamais.
    if (qc && qc.trim()) {
      if (processedUserTexts.has(dedupKey(qc))) continue; // aussi journalisé en tour user → une seule bulle
      msgs.push({ role: 'user', ts: j.timestamp, ...capped(qc), tools: [], forkUuid: j.uuid });
      continue;
    }
    // Même cas, ANCIENNE forme : le texte était porté par la queue-operation elle-même, avant de
    // migrer vers l'attachment ci-dessus. Gardé pour les transcripts déjà écrits.
    // `operation:"remove"` = la MÊME entrée sortant de la file : la rendre en plus de son `enqueue`
    // affichait chaque message en file DEUX fois.
    if (j.type === 'queue-operation' && j.operation !== 'remove' && typeof j.content === 'string' && j.content.trim()) {
      // Skip if already processed into a real user turn (dedup: queue-op + matching user turn → show only user turn)
      if (processedUserTexts.has(dedupKey(j.content))) continue;
      msgs.push({ role: 'user', ts: j.timestamp, ...capped(j.content), tools: [], forkUuid: j.uuid });
      continue;
    }
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
      const text = chatText(c);
      // Compaction: the summary turn and the echo of a bare `/compact` would read as messages the
      // user typed — the `compact_boundary` line above stands for the whole operation.
      if (j.isCompactSummary || text === '/compact') continue;
      // Invocation d'un skill (outil Skill / slash command) : Claude Code injecte tout le SKILL.md
      // comme un tour user isMeta commençant par « Base directory for this skill: … ». Sans ça il
      // s'afficherait comme une énorme fausse bulle « 🧑 You ». On le drop ; le chip 🔧 Skill suffit
      // à marquer qu'un skill a tourné.
      if (/^Base directory for this skill:/.test(text)) continue;
      // Tour ré-invoqué par un ScheduleWakeup : ligne user injectée (promptSource:"sdk" + isMeta).
      // On la marque `auto` pour qu'elle ne se lise pas comme un message tapé par l'utilisateur.
      const auto = j.promptSource === 'sdk' && !!j.isMeta;
      if (text) msgs.push({ role: 'user', ts: j.timestamp, ...capped(text), tools: [], forkUuid: j.uuid, auto });
    } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      // parts : blocs (text / tool) dans l'ordre d'arrivée pour rendu inline (style claude-cli)
      let text = '';
      const tools = [];
      const parts = [];
      for (const b of j.message.content) {
        if (b.type === 'text' && b.text) {
          text += (text ? '\n' : '') + b.text;
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          const tool = { id: b.id || null, name: b.name, detail: toolDetail(b.input), inputText: toolInputText(b.input), result: b.id ? (agentReport(b.id) || results.get(b.id) || null) : null };
          tools.push(tool);
          // `diff` carried on the part (not on `tool`, which is shared with `tools[]` frozen
          // by the test baseline) → rendered as a collapsible Pierre diff in the conversation.
          // `ask` carries the raw AskUserQuestion payload on the part (like `diff`, invisible to
          // the characterization baseline which strips parts) so the chip renders the question +
          // options read-only instead of dumping raw JSON.
          const ask = b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions) ? b.input.questions : null;
          // `send` carries the files delivered by SendUserFile (like `diff`/`ask`, on the part) so
          // the chip renders image thumbnails / open-file links instead of raw JSON.
          parts.push({ type: 'tool', tool, diff: toolDiffOps(b.name, b.input, b.id ? writeOriginals.get(b.id) : null), ask, send: toolSendFiles(b.name, b.input, j.cwd), show: toolShowWork(b.name, b.input, j.cwd) });
        }
      }
      text = text.trim();
      if (!text && !tools.length) continue;
      const prev = msgs[msgs.length - 1];
      if (prev && prev.role === 'assistant') { // fusion du même tour
        if (text && prev.text !== text && !prev.text.endsWith(text)) prev.text += (prev.text ? '\n' : '') + text;
        for (const t of tools) if (!prev.tools.some((x) => (t.id && x.id === t.id) || (x.name === t.name && x.detail === t.detail))) prev.tools.push(t);
        // dedup des parts : texte si déjà présent à l'identique, tool si même id
        for (const p of parts) {
          if (p.type === 'text') {
            if (!prev.parts.some((x) => x.type === 'text' && x.text === p.text)) prev.parts.push(p);
          } else {
            const id = p.tool.id;
            if (!prev.parts.some((x) => x.type === 'tool' && ((id && x.tool.id === id) || (x.tool.name === p.tool.name && x.tool.detail === p.tool.detail)))) prev.parts.push(p);
          }
        }
        if (j.timestamp) prev.ts = j.timestamp;
        prev.forkUuid = j.uuid; // le point de coupe avance jusqu'à la dernière ligne du tour
      } else {
        msgs.push({ role: 'assistant', ts: j.timestamp, text: text.slice(0, 8000), tools, parts, forkUuid: j.uuid });
      }
    }
  }
  return msgs;
}

// Texte COMPLET d'un message user, à la demande, retrouvé par l'uuid de sa ligne de transcript
// (le même `forkUuid` que porte la bulle). Sert la fin d'un message coupé par TEXT_CAP.
// Limité aux tours user : une bulle assistant fusionne plusieurs lignes du transcript, son uuid
// ne désigne donc pas tout son texte.
function readMessageText(fp, uuid) {
  if (!fp || !uuid) return null;
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  for (const line of data.split('\n')) {
    if (!line || !line.includes(uuid)) continue; // pré-filtre : évite de parser tout le fichier
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.uuid !== uuid) continue;
    if (j.type === 'queue-operation' && typeof j.content === 'string') return j.content.slice(0, FULL_CAP);
    if (j.type === 'user' && j.message) {
      const t = chatText(j.message.content);
      return t ? t.slice(0, FULL_CAP) : null;
    }
    return null;
  }
  return null;
}

export { buildConversation, readMessageText };
