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
import { chatText, toolDetail, toolDiffOps, toolInputText, toolResultText } from './util.js';

// includeSidechain : pour un transcript de sous-agent (tout est isSidechain), on garde tout.
function buildConversation(fp, includeSidechain) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const lines = data.split('\n');
  // passe 1 : indexe les résultats d'outils par tool_use_id
  const results = new Map();
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, toolResultText(b.content));
      }
    }
  }
  const msgs = [];
  const seenNotes = new Set(); // dédup des <task-notification> (mêmes notifs sur plusieurs porteurs)
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (!includeSidechain && j.isSidechain) continue;
    // Notification de tâche de fond (Bash run_in_background / Monitor) : <task-notification> livrée via
    // 3 porteurs (queue-operation, user/system, attachment queued_command). Sans ça, une complétion
    // « ré-invoque » l'agent sans cause visible, et la variante user/system s'afficherait comme un faux
    // message « 🧑 You » (XML brut). On la rend en ligne système sobre, DÉDUPLIQUÉE par task-id+résumé
    // (une même notif peut arriver en double sur plusieurs porteurs).
    const note =
      (j.type === 'queue-operation' && typeof j.content === 'string' && j.content.includes('<task-notification>')) ? j.content :
      (j.type === 'attachment' && j.attachment && j.attachment.type === 'queued_command' && typeof j.attachment.prompt === 'string') ? j.attachment.prompt :
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
    // Message tapé dans hooked PENDANT que l'agent travaille : Claude le met en FILE d'attente et
    // le journalise comme queue-operation dont le `content` est le texte brut (SANS
    // <task-notification>, déjà capté ci-dessus). Sans ça il tombe entre user/assistant et n'est
    // jamais rendu → la bulle « ⏳ queued » optimiste ne se résout jamais et le message disparaît
    // au refresh. On le rend comme une vraie bulle user (miroir du push type:"user" ci-dessous).
    if (j.type === 'queue-operation' && typeof j.content === 'string' && j.content.trim()) {
      msgs.push({ role: 'user', ts: j.timestamp, text: j.content.slice(0, 8000), tools: [], forkUuid: j.uuid });
      continue;
    }
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
      const text = chatText(c);
      // Tour ré-invoqué par un ScheduleWakeup : ligne user injectée (promptSource:"sdk" + isMeta).
      // On la marque `auto` pour qu'elle ne se lise pas comme un message tapé par l'utilisateur.
      const auto = j.promptSource === 'sdk' && !!j.isMeta;
      if (text) msgs.push({ role: 'user', ts: j.timestamp, text: text.slice(0, 8000), tools: [], forkUuid: j.uuid, auto });
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
          const tool = { id: b.id || null, name: b.name, detail: toolDetail(b.input), inputText: toolInputText(b.input), result: b.id ? (results.get(b.id) || null) : null };
          tools.push(tool);
          // `diff` carried on the part (not on `tool`, which is shared with `tools[]` frozen
          // by the test baseline) → rendered as a collapsible Pierre diff in the conversation.
          parts.push({ type: 'tool', tool, diff: toolDiffOps(b.name, b.input) });
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

export { buildConversation };
