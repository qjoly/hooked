// Helpers de formatage — portés à l'identique depuis l'ancien app.js.

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

// modèles proposés au lancement et au changement à chaud, groupés par famille. La 1ère entrée
// de chaque groupe est l'alias générique (suit le défaut du compte Claude Code) ; les suivantes
// pinent une version précise (`opus-4-7`). Validation backend : voir `isValidModelArg` (regex
// `(opus|sonnet|haiku|fable)(-\d{1,2}(-\d{1,2})?)?`) — toute version nouvellement publiée par
// Claude Code n'a qu'à être ajoutée ici, pas besoin de toucher au serveur.
export const MODEL_GROUPS = [
  { label: 'Opus', opts: [['opus', 'Opus (default)'], ['claude-opus-4-8', '4.8'], ['claude-opus-4-7', '4.7'], ['claude-opus-4-6', '4.6'], ['claude-opus-4-5', '4.5']] },
  { label: 'Sonnet', opts: [['sonnet', 'Sonnet (default)'], ['claude-sonnet-4-6', '4.6'], ['claude-sonnet-4-5', '4.5']] },
  { label: 'Haiku', opts: [['haiku', 'Haiku (default)'], ['claude-haiku-4-5', '4.5']] },
  { label: 'Fable', opts: [['claude-fable-5', 'Fable']] },
];
// Liste plate de toutes les options valides, triée par clé décroissante pour que `modelAlias`
// préfère le match le plus spécifique (`opus-4-7` avant `opus`).
export const MODEL_OPTS = MODEL_GROUPS.flatMap((g) => g.opts);
const MODEL_KEYS_BY_SPECIFICITY = MODEL_OPTS.map(([k]) => k).sort((a, b) => b.length - a.length);
export const EFFORT_OPTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// identifiant de modèle complet (ex. « claude-opus-4-7 ») → clé du sélecteur (« opus-4-7 » si
// connue, sinon alias de famille « opus »). '' si inconnu.
export function modelAlias(m) {
  const s = (m || '').toLowerCase();
  return MODEL_KEYS_BY_SPECIFICITY.find((k) => s.includes(k)) || '';
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
  idle: 'Paused', ended: 'Ended', past: 'Past',
};

export const LIVE_STATES = ['working', 'waiting', 'attention', 'idle'];

// filtres par statut (single-select). `states` = états couverts par le filtre.
// La vue par défaut (« Actives ») n'inclut PAS les sessions terminées (ended/past, p. ex.
// quand on a tué le pane) : elles restent accessibles via le filtre « Terminées ».
export const STATUS_FILTERS = [
  { key: 'all', label: 'Active', states: LIVE_STATES },
  { key: 'attention', label: '🔴 Action', states: ['attention'] },
  { key: 'waiting', label: '🟡 Waiting', states: ['waiting'] },
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

// TLD autorisés pour les domaines « nus » (sans schéma, ex. « google.com »). Liste courte et
// volontairement conservatrice : on veut linkifier un vrai domaine, PAS transformer « format.js »,
// « README.md » ou « server.cjs » en lien — donc aucun TLD qui collisionne avec une extension de
// fichier courante (js, ts, md, sh, rs, json, svelte…).
const LINK_TLDS = 'com|org|net|edu|gov|io|dev|ai|app|co|info|xyz|fr|uk|eu|de';
const LINK_RE = new RegExp(
  '\\[([^\\]]+)\\]\\(([^)\\s]+)\\)' +          // 1,2 = lien markdown [texte](url)
  '|https?:\\/\\/[^\\s<>"\'`]+' +               // URL avec schéma
  // domaine nu : un ou plusieurs labels + TLD connu, port et/ou chemin optionnels.
  '|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:' + LINK_TLDS + ')\\b(?::\\d+)?(?:\\/[^\\s<>"\'`]*)?',
  'gi'
);
const countChar = (s, c) => s.split(c).length - 1;
const A_ATTRS = 'target="_blank" rel="noopener noreferrer"';

// href sûr pour un lien markdown : http(s)/mailto/relatif tels quels, domaine nu préfixé de
// https://, tout autre schéma (javascript:, data:…) refusé → null, on garde alors le texte brut.
function safeHref(url) {
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return url;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]|$)/i.test(url)) return 'https://' + url;
  return null;
}

// Rendu des liens : markdown [texte](url), URLs http(s) et domaines nus → <a> ; le reste est échappé.
// Opère sur le texte BRUT (avant code/gras/barré) : terminaison propre sur «"», espaces et ponctuation,
// et le `&` d'une query string est conservé puis échappé en &amp; (correct en attribut href).
function autolink(raw) {
  let out = '', last = 0;
  for (const mm of raw.matchAll(LINK_RE)) {
    const start = mm.index;
    out += esc(raw.slice(last, start));
    last = start + mm[0].length;
    if (mm[1] !== undefined) { // lien markdown [texte](url)
      const href = safeHref(mm[2]);
      out += href ? `<a href="${esc(href)}" ${A_ATTRS}>${esc(mm[1])}</a>` : esc(mm[0]);
      continue;
    }
    // URL ou domaine nu : collé à « @ » ou à un caractère de mot en amont ⇒ email/identifiant, pas un lien.
    const prev = start > 0 ? raw[start - 1] : '';
    if (prev === '@' || /[a-z0-9]/i.test(prev)) { out += esc(mm[0]); continue; }
    let url = mm[0], trail = '';
    const pm = url.match(/[.,;:!?'"]+$/); // ponctuation de fin de phrase → hors du lien
    if (pm) { trail = pm[0]; url = url.slice(0, -pm[0].length); }
    // parenthèse fermante orpheline (« (voir https://x.com) ») → hors du lien
    while (url.endsWith(')') && countChar(url, '(') < countChar(url, ')')) {
      trail = ')' + trail; url = url.slice(0, -1);
    }
    const href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    out += `<a href="${esc(href)}" ${A_ATTRS}>${esc(url)}</a>` + esc(trail);
  }
  return out + esc(raw.slice(last));
}

// formatage inline d'un fragment (sans gestion des lignes) : liens, `code`, ~~barré~~, **gras**. Échappe le reste.
function mdFrag(t) {
  return autolink(String(t == null ? '' : t))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

// découpe une ligne de tableau GFM en cellules (retire les | de bord, gère \| échappé).
const tableCells = (l) =>
  l.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());

// ligne séparatrice d'un tableau : « |---|:--:|--:| » (au moins une cellule de tirets).
const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);

function renderTable(header, aligns, rows) {
  const al = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const th = header.map((c, i) => `<th${al(i)}>${mdFrag(c)}</th>`).join('');
  const trs = rows
    .map((r) => '<tr>' + header.map((_, i) => `<td${al(i)}>${mdFrag(r[i] || '')}</td>`).join('') + '</tr>')
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// rendu inline (hors blocs de code) : tableaux GFM, `code`, **gras**, titres #, sauts de ligne.
export function mdInline(t) {
  const lines = String(t == null ? '' : t).split('\n');
  const out = [];
  let buf = []; // lignes texte en attente, jointes par <br>
  const flush = () => { if (buf.length) { out.push(buf.join('<br>')); buf = []; } };
  let i = 0;
  while (i < lines.length) {
    // tableau : ligne d'en-tête contenant un | suivie d'une ligne séparatrice |---|.
    if (lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const header = tableCells(lines[i]);
      const aligns = tableCells(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(tableCells(lines[i])); i++; }
      out.push(renderTable(header, aligns, rows));
    } else if (/^\s*>/.test(lines[i])) {
      // blockquote : lignes consécutives préfixées par « > ». On retire le marqueur
      // (et un espace) puis on rend le contenu récursivement → gras, titres, tableaux
      // et citations imbriquées (« >> ») fonctionnent dedans.
      flush();
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdInline(inner.join('\n'))}</blockquote>`);
    } else {
      const h = lines[i].match(/^#{1,4} (.+)$/);
      buf.push(h ? `<b>${mdFrag(h[1])}</b>` : mdFrag(lines[i]));
      i++;
    }
  }
  flush();
  return out.join('');
}

// markdown léger : code fences ``` , `code`, **gras**, titres #, sauts de ligne. Échappe le reste.
export function mdLite(t) {
  const parts = String(t).split(/```/);
  let out = '';
  parts.forEach((seg, i) => {
    if (i % 2 === 1) out += `<pre><code>${esc(seg.replace(/^[a-zA-Z0-9]*\n/, ''))}</code></pre>`;
    else out += mdInline(seg);
  });
  return out;
}

// découpe un texte markdown léger en segments : { type:'text', html } ou
// { type:'code', lang, code }. Le composant <Markdown> rend les blocs de code via
// <CodeBlock> (coloration syntaxique + bouton copier) et le texte via mdInline.
export function mdSegments(t) {
  const parts = String(t).split(/```/);
  const segs = [];
  parts.forEach((seg, i) => {
    if (i % 2 === 1) {
      // 1re ligne = langage éventuel (alphanum + quelques signes), retirée du contenu.
      const nl = seg.indexOf('\n');
      const head = nl === -1 ? '' : seg.slice(0, nl).trim();
      let lang = '', code = seg;
      if (nl !== -1 && /^[a-zA-Z0-9+#._-]*$/.test(head)) {
        lang = head.toLowerCase();
        code = seg.slice(nl + 1);
      }
      segs.push({ type: 'code', lang, code: code.replace(/\n$/, '') });
    } else if (seg) {
      segs.push({ type: 'text', html: mdInline(seg) });
    }
  });
  return segs;
}

// libellé court d'un lien de PR GitHub (repo #num) sinon l'URL brute.
export function prLabel(l) {
  const m = l.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[2]} #${m[3]}` : l;
}
