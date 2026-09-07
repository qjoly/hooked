// Helpers de formatage — portés à l'identique depuis l'ancien app.js.

import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
export function fmtCost(n) { return '$' + (n || 0).toFixed(n >= 100 ? 0 : 2); }
export function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const shortModel = (m) => (m || '').replace(/^claude-/, '');

// Identifiant de modèle complet (ex. « claude-opus-4-8 », voire daté « …-4-8-20251101 ») → clé du
// sélecteur : l'id complet NON daté (« claude-opus-4-8 ») si une version est présente, sinon l'alias
// de famille (« opus »), sinon '' si famille inconnue. Basé sur une regex — la LISTE des options est
// désormais dérivée LIVE du binaire claude (GET /api/capabilities, cf. ModelEffort.svelte /
// server/capabilities.js) ; ce helper d'affichage ne doit donc PAS dépendre d'une liste figée. Les
// VALEURS d'option correspondent : alias de famille et ids complets « claude-<famille>-<version> ».
export function modelAlias(m) {
  const s = (m || '').toLowerCase();
  const fam = s.match(/(opus|sonnet|haiku|fable)/);
  if (!fam) return '';
  const full = s.match(/claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?/);
  return full ? full[0] : fam[1];
}

// durée courte à partir de minutes : « 2 h 46 min » / « 46 min » / « <1 min ».
export function fmtDuration(min) {
  min = Math.max(0, Math.round(min || 0));
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Images jointes par le composer : leur chemin absolu (dossier .../images/…) est préfixé au texte
// du message (Claude Code lit l'image par chemin). Pour l'affichage, on sépare ces chemins du texte
// afin de rendre des miniatures et de ne pas laisser un chemin brut dans la bulle. Renvoie
// { images: [chemins], text: reste }. On ne matche que les chemins d'un dossier « images/ »
// (signature du composer) → pas de faux positifs sur du texte quelconque.
const MSG_IMAGE_RE = /(^|\s)(\/[^\s]*\/images\/[^\s]+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;
export function splitMessageImages(text) {
  const s = String(text == null ? '' : text);
  const images = [];
  const stripped = s.replace(MSG_IMAGE_RE, (_, pre, p) => { images.push(p); return pre; }).trim();
  return { images, text: stripped };
}

export const STATE_LABEL = {
  working: 'Claude is working', waiting: 'Waiting for you', attention: 'Action required',
  background: 'Running in background', idle: 'Paused', ended: 'Ended', past: 'Past',
};

// Le composer a-t-il envoyé une COMMANDE plutôt qu'un message ? Sert à l'affichage (libellé, couleur
// de la bulle) et au rattachement de l'écho à son bloc. Le parsing qui décide vraiment reste côté
// serveur (parseBangCommand) ; même forme de retour exprès, pour qu'un test puisse comparer les deux
// champ par champ sur une même table — ce doublon ne peut donc pas dériver en silence.
export function parseBang(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^(!!?)\s*(\S[\s\S]*)$/);
  if (!m) return null;
  const command = m[2].trim();
  if (!command || command.startsWith('!')) return null;
  return { command, kind: m[1] === '!!' ? 'interactive' : 'shell' };
}

// Ce message du transcript est-il le bloc produit par `command` ? Le serveur écrit le fence avec
// `$ <commande>` en première ligne du corps (formatLocalCommand / formatInteractiveCommand), c'est
// donc l'ancre de correspondance. Sert à remonter l'écho de la commande JUSTE AVANT son terminal, au
// lieu de le laisser tomber tout en bas du fil.
const BLOCK_CMD_RE = /^```(?:console|pty)\b[^\n]*\n\$ ([^\n]*)/m;
export function isBlockForCommand(text, command) {
  if (!text || !command) return false;
  const m = String(text).match(BLOCK_CMD_RE);
  return !!m && m[1].trim() === String(command).trim();
}

// Commande à coller dans un terminal pour reprendre une session À LA MAIN. L'Agent SDK spawne
// exactement ça (`claude --resume=<id>`, vérifiable dans un `ps`), donc c'est bien la MÊME session
// qui repart, pas une copie. Corollaire à garder en tête : ne pas la lancer pendant que hooked pilote
// déjà cette session — deux process sur un même transcript se disputent le verrou, et le perdant
// devient un fantôme qui avale les messages.
export function resumeCommand(s) {
  if (!s || !s.id) return '';
  const dir = s.project || s.cwd || '';
  const cmd = `claude --resume=${s.id}`;
  return dir ? `cd ${shellQuote(dir)} && ${cmd}` : cmd;
}
// Quoting POSIX : un chemin de projet peut contenir une espace, et rien n'interdit une apostrophe.
function shellQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

// Une session terminée ET froide, c'est-à-dire sans activité depuis 24 h. C'est le seul cas où
// « terminée » vaut « rangée » : une session qui vient de finir a le plus souvent été tuée par un
// redémarrage de hooked, et la sortir de la liste active sur le champ obligeait à aller la
// rechercher dans l'onglet Archived. Partie PURE de isSessionArchived (state.svelte.js), sortie ici
// pour être testable — state.svelte.js utilise des runes, que Vitest ne compile pas.
export const COLD_MS = 86400000;
export function isFinishedAndCold(s, now = Date.now()) {
  if (!s || (s.state !== 'ended' && s.state !== 'past')) return false;
  const t = s.lastActivity ? Date.parse(s.lastActivity) : 0;
  return !t || Number.isNaN(t) || now - t > COLD_MS;
}

// Couleur stable d'un tag (palette du redesign). Noms connus → couleur fixe ; sinon hash du nom →
// index dans la palette. Le fond de pilule = couleur + '22' (13% alpha). Partagé entre l'inbox et
// la modale d'édition des tags.
const TAG_BASE = { azure: '#c62a9e', constant: '#0f8a7e', chart: '#c27a12', infra: '#3b6fd4', urgent: '#d1493a' };
const TAG_PALETTE = ['#c62a9e', '#0f8a7e', '#c27a12', '#3b6fd4', '#d1493a', '#7c4bd0', '#2a9d63'];
export function tagColor(name) {
  const n = (name || '').toLowerCase();
  if (TAG_BASE[n]) return TAG_BASE[n];
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

export const LIVE_STATES = ['working', 'background', 'waiting', 'attention', 'idle'];

// filtres par statut (single-select). `states` = états couverts par le filtre.
// La vue par défaut (« Actives ») n'inclut PAS les sessions terminées (ended/past, p. ex.
// quand on a tué le pane) : elles restent accessibles via le filtre « Terminées ».
export const STATUS_FILTERS = [
  { key: 'all', label: 'Active', states: LIVE_STATES },
  { key: 'attention', label: '🔴 Action', states: ['attention'] },
  { key: 'waiting', label: '🟡 Waiting', states: ['waiting'] },
  { key: 'background', label: '🌀 Background', states: ['background'] },
  { key: 'working', label: '🔵 Working', states: ['working'] },
  { key: 'idle', label: '🕘 Paused', states: ['idle'] },
  { key: 'done', label: '✓ Ended', states: ['ended', 'past'] },
];
export function filterMatches(f, state) { return !f.states || f.states.includes(state); }
// Multi-sélection : un état matche si AU MOINS un des filtres sélectionnés le couvre (union).
// Aucune sélection → tout passe (garde-fou).
export function filterMatchesAny(keys, state) {
  if (!keys || !keys.length) return true;
  return keys.some((k) => {
    const f = STATUS_FILTERS.find((x) => x.key === k);
    return f && filterMatches(f, state);
  });
}

// Métadonnées d'affichage de TOUS les modes de permission Claude Code (label + icône).
// La source du mode courant est le champ `permission_mode` des hooks (cf. server/events.js) —
// la statusline ne le porte pas. Les valeurs possibles : default / plan / acceptEdits / auto /
// dontAsk / bypassPermissions.
export const MODE_META = {
  default: { label: 'Normal', icon: '●', title: 'Claude asks for permission before each sensitive action' },
  plan: { label: 'Plan', icon: '⏸', title: 'Plan mode: Claude thinks and proposes without changing anything' },
  acceptEdits: { label: 'Auto-edits', icon: '⏵⏵', title: 'Claude applies file edits without confirmation' },
  auto: { label: 'Auto', icon: '⚡', title: 'Auto mode: Claude automatically approves actions without confirmation' },
  dontAsk: { label: 'Don\'t ask', icon: '🔕', title: 'Claude automatically denies anything not pre-authorized' },
  bypassPermissions: { label: 'Bypass', icon: '⛔', title: 'Claude skips permissions (except explicit "ask" rules)' },
};
export const modeMeta = (k) => MODE_META[k] || { label: k || '—', icon: '·', title: 'Permission mode' };
export const modeLabel = (k) => modeMeta(k).label;

// Modes proposés dans le sélecteur, dans l'ordre réel du cycle Maj+Tab (Normal → Auto → Plan).
export const PERMISSION_MODES = ['default', 'auto', 'plan'].map((k) => ({ key: k, ...MODE_META[k] }));

// Modes proposés au LANCEMENT d'une session (→ `claude --permission-mode`). `[key, label]`,
// label préfixé de l'icône du mode. 'default' = comportement natif (aucun flag passé).
export const MODE_OPTS = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']
  .map((k) => [k, `${MODE_META[k].icon} ${MODE_META[k].label}`]);

// Lien profond RELATIF vers une autre session hooked (émis par un agent : `[label](/session/<id>)`).
// Rendu comme un <a> interne SANS target="_blank" → le routeur client SvelteKit intercepte le clic
// (même origine, pas de nouvel onglet) et focalise la session sans rechargement complet.
const SESSION_LINK_RE = /^\/session\/[^/?#\s]+$/;

// Alertes GitHub (« callouts ») : un blockquote dont la 1re ligne est `[!NOTE]` / `[!TIP]` /
// `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`. Rendu en <div class="md-alert md-alert-<type>">
// coiffé d'un titre iconisé (cf. app.css). Marqueur seul sur sa ligne (comportement GitHub).
const ALERT_TYPES = {
  note: { label: 'Note', icon: 'ℹ️' },
  tip: { label: 'Tip', icon: '💡' },
  important: { label: 'Important', icon: '❗' },
  warning: { label: 'Warning', icon: '⚠️' },
  caution: { label: 'Caution', icon: '🛑' },
};
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

// Plugin : règle core (après parsing inline → les `children` existent) qui transforme les
// blockquotes-alertes en <div> et injecte le titre.
function githubAlerts(mdit) {
  mdit.core.ruler.push('github_alerts', (state) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'blockquote_open') continue;
      const pOpen = toks[i + 1], inl = toks[i + 2];
      if (!pOpen || pOpen.type !== 'paragraph_open' || !inl || inl.type !== 'inline') continue;
      const m = ALERT_RE.exec(inl.content);
      if (!m) continue;
      const type = m[1].toLowerCase();
      const meta = ALERT_TYPES[type];

      // blockquote_open → <div class="md-alert md-alert-<type>"> et son close → </div>
      toks[i].tag = 'div';
      toks[i].attrSet('class', `md-alert md-alert-${type}`);
      for (let j = i + 1, depth = 1; j < toks.length; j++) {
        if (toks[j].type === 'blockquote_open') depth++;
        else if (toks[j].type === 'blockquote_close' && --depth === 0) { toks[j].tag = 'div'; break; }
      }

      // retirer le marqueur [!TYPE] du contenu ET des enfants inline (1er texte + saut de ligne)
      inl.content = inl.content.slice(m[0].length);
      const ch = inl.children || [];
      if (ch[0] && ch[0].type === 'text') {
        ch[0].content = ch[0].content.replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i, '');
      }
      let k = ch[0] && ch[0].type === 'text' && ch[0].content === '' ? 1 : 0;
      if (ch[k] && (ch[k].type === 'softbreak' || ch[k].type === 'hardbreak')) k++;
      if (k) inl.children = ch.slice(k);

      // injecter le titre (html_block) juste après l'ouverture du <div>
      const title = new state.Token('html_block', '', 0);
      title.block = true;
      title.content = `<p class="md-alert-title"><span class="md-alert-icon">${meta.icon}</span>${meta.label}</p>`;
      toks.splice(i + 1, 0, title);
      i += 1; // sauter le titre injecté
    }
  });
}

// Moteur markdown : GitHub Flavored Markdown complet via markdown-it.
// - html:true → le HTML brut d'un message passe LIBREMENT (choix assumé : dashboard local
//   mono-utilisateur ; conséquence : un message peut injecter du HTML/handlers arbitraires).
// - linkify → URLs nues autolinkées ; breaks → un simple \n devient <br> (UX chat, comme GitHub
//   dans les commentaires) ; typographer désactivé (pas de substitution de guillemets/tirets).
// - task-lists → cases à cocher `- [ ]` / `- [x]` (désactivées) ; github-alerts → callouts.
const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false })
  .use(taskLists)
  .use(githubAlerts);

// Liens : les liens internes `/session/<id>` reçoivent la signature reconnue par splitSessionLinks
// (→ <SessionCard> vivant, nav client). Les liens http(s) externes s'ouvrent dans un nouvel onglet.
const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  if (SESSION_LINK_RE.test(href)) {
    tokens[idx].attrSet('class', 'session-link');
    tokens[idx].attrSet('data-session-link', '');
  } else if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Images : chargement paresseux + classe pour contraindre la largeur (cf. app.css .md-img).
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('loading', 'lazy');
  const cls = tokens[idx].attrGet('class');
  tokens[idx].attrSet('class', cls ? `${cls} md-img` : 'md-img');
  return defaultImage(tokens, idx, options, env, self);
};

// Un message d'un seul paragraphe ne doit pas hériter des marges d'un <p> ni être coupé par un
// lien de session (le split entre deux {@html} briserait la balise <p>). Quand le HTML rendu EST
// un unique paragraphe (aucun autre bloc dedans), on retire l'enveloppe <p> → rendu inline, comme
// l'ancien moteur. Le multi-bloc garde ses <p> (stylés dans app.css).
function stripSoleParagraph(html) {
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return m && !/<(?:p|ul|ol|h[1-6]|blockquote|table|pre|hr|div)\b/i.test(m[1]) ? m[1] : html;
}

// rendu markdown complet → chaîne HTML. Utilisé pour du markdown « plat » (sans découpage en
// segments / cartes de session) et par mdSegments pour chaque bloc de texte.
export function mdInline(t) {
  return stripSoleParagraph(md.render(String(t == null ? '' : t)).trim());
}

// Anchor émise par le rendu markdown pour un lien profond de session (`[label](/session/<id>)`).
// On la re-repère dans le HTML pour la remplacer par un <SessionCard> vivant. Regex tolérante à
// l'ordre des attributs : on repère `class="session-link"` puis on extrait href et le libellé.
const SESSION_ANCHOR_RE = /<a\b([^>]*\bclass="session-link"[^>]*)>([\s\S]*?)<\/a>/g;
const unesc = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
// id de session extrait d'un href `/session/<id>` (déjà dé-échappé). null si non conforme.
function sessionIdFromHref(href) {
  const m = /^\/session\/([^/?#\s]+)$/.exec(href);
  return m ? decodeURIComponent(m[1]) : null;
}

// découpe un fragment HTML (issu de mdInline) en sous-parties : { type:'html', html } et
// { type:'session', id, label } pour chaque lien de session. Permet à <Markdown> de rendre les
// liens de session comme des cartes vivantes (<SessionCard>) tout en gardant le reste en {@html}.
// Aucun lien de session → une seule sous-partie 'html' (chemin inchangé).
function splitSessionLinks(html) {
  const out = [];
  let last = 0, m;
  SESSION_ANCHOR_RE.lastIndex = 0;
  while ((m = SESSION_ANCHOR_RE.exec(html)) !== null) {
    const hrefMatch = /href="([^"]*)"/.exec(m[1]);
    const id = hrefMatch ? sessionIdFromHref(unesc(hrefMatch[1])) : null;
    if (!id) continue; // href inattendu : on laisse l'anchor tel quel dans le html environnant
    if (m.index > last) out.push({ type: 'html', html: html.slice(last, m.index) });
    out.push({ type: 'session', id, label: unesc(m[2]) });
    last = m.index + m[0].length;
  }
  if (!out.length) return [{ type: 'html', html }];
  if (last < html.length) out.push({ type: 'html', html: html.slice(last) });
  return out;
}

// langage d'un bloc de code fence : premier mot de l'info-string, en minuscule ('' si absent).
const fenceLang = (info) => (info || '').trim().split(/\s+/)[0].toLowerCase();

// Métadonnées d'une info-string, après le langage : `console exit=0 cwd=/tmp` → { exit:'0', cwd:'/tmp' }.
// Sert aux blocs qui portent un contexte structuré plutôt qu'un simple langage — un compte rendu de
// commande locale, par exemple, a besoin de son code de sortie pour être rendu correctement.
export function fenceMeta(info) {
  const out = {};
  for (const part of String(info || '').trim().split(/\s+/).slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

// découpe un texte markdown en segments : { type:'text', parts } ou { type:'code', lang, code }.
// Les blocs de code de PREMIER NIVEAU (fence ``` ou indenté) sont extraits pour être rendus par
// <CodeBlock> (coloration + copie) ou <Mermaid> (lang === 'mermaid') ; tout le reste est rendu en
// HTML par markdown-it puis découpé en sous-parties (html en {@html}, session en <SessionCard>).
// Un bloc de code IMBRIQUÉ (dans une liste/citation) reste rendu inline par markdown-it (<pre>).
export function mdSegments(t) {
  const src = String(t == null ? '' : t);
  const tokens = md.parse(src, {});
  const segs = [];
  let run = []; // tokens de bloc accumulés (non-code, premier niveau) à rendre ensemble
  const flushRun = () => {
    if (!run.length) return;
    const html = stripSoleParagraph(md.renderer.render(run, md.options, {}).trim());
    run = [];
    if (html) segs.push({ type: 'text', parts: splitSessionLinks(html) });
  };
  for (const tok of tokens) {
    if (tok.level === 0 && (tok.type === 'fence' || tok.type === 'code_block')) {
      flushRun();
      const lang = tok.type === 'fence' ? fenceLang(tok.info) : '';
      const meta = tok.type === 'fence' ? fenceMeta(tok.info) : {};
      segs.push({ type: 'code', lang, meta, code: tok.content.replace(/\n$/, '') });
    } else {
      run.push(tok);
    }
  }
  flushRun();
  return segs;
}

// libellé court d'un lien de PR GitHub (repo #num) sinon l'URL brute.
export function prLabel(l) {
  const m = l.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[2]} #${m[3]}` : l;
}

// libellé court d'un lien d'issue GitHub (repo #num) sinon l'URL brute.
export function issueLabel(l) {
  const m = l.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  return m ? `${m[2]} #${m[3]}` : l;
}
