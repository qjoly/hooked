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
  if (s < 10) return 'à l\'instant';
  if (s < 60) return `il y a ${Math.floor(s)}s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}
export const shortModel = (m) => (m || '').replace(/^claude-/, '');

// durée courte à partir de minutes : « 2 h 46 min » / « 46 min » / « <1 min ».
export function fmtDuration(min) {
  min = Math.max(0, Math.round(min || 0));
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const STATE_LABEL = {
  working: 'Claude travaille', waiting: 'En attente de toi', attention: 'Action requise',
  idle: 'En pause', ended: 'Terminée', past: 'Passée',
};

// filtres par statut (single-select). `states` = états couverts par le filtre.
export const STATUS_FILTERS = [
  { key: 'all', label: 'Tous', states: null },
  { key: 'attention', label: '🔴 Action', states: ['attention'] },
  { key: 'waiting', label: '🟡 Attente', states: ['waiting'] },
  { key: 'working', label: '🔵 Travaille', states: ['working'] },
  { key: 'idle', label: '🕘 En pause', states: ['idle'] },
  { key: 'done', label: '✓ Terminées', states: ['ended', 'past'] },
];
export function filterMatches(f, state) { return !f.states || f.states.includes(state); }

export const LIVE_STATES = ['working', 'waiting', 'attention', 'idle'];

// Métadonnées d'affichage de TOUS les modes de permission Claude Code (label + icône).
// La source du mode courant est le champ `permission_mode` des hooks (cf. server/events.js) —
// la statusline ne le porte pas. Les valeurs possibles : default / plan / acceptEdits / auto /
// dontAsk / bypassPermissions.
export const MODE_META = {
  default:           { label: 'Normal',       icon: '●',  title: 'Claude demande la permission avant chaque action sensible' },
  plan:              { label: 'Plan',         icon: '⏸',  title: 'Mode plan : Claude réfléchit et propose sans rien modifier' },
  acceptEdits:       { label: 'Auto-edits',   icon: '⏵⏵', title: 'Claude applique les éditions de fichiers sans confirmation' },
  auto:              { label: 'Auto',         icon: '⚡', title: 'Mode auto : Claude approuve automatiquement les actions sans confirmation' },
  dontAsk:           { label: 'Sans demande', icon: '🔕', title: 'Claude refuse automatiquement ce qui n’est pas pré-autorisé' },
  bypassPermissions: { label: 'Bypass',       icon: '⛔', title: 'Claude saute les permissions (sauf règles « ask » explicites)' },
};
export const modeMeta = (k) => MODE_META[k] || { label: k || '—', icon: '·', title: 'Mode de permission' };
export const modeLabel = (k) => modeMeta(k).label;

// Modes proposés dans le sélecteur, dans l'ordre réel du cycle Maj+Tab (Normal → Auto → Plan).
export const PERMISSION_MODES = ['default', 'auto', 'plan'].map((k) => ({ key: k, ...MODE_META[k] }));

// markdown léger : code fences ``` , `code`, **gras**, titres #, sauts de ligne. Échappe le reste.
export function mdLite(t) {
  const parts = String(t).split(/```/);
  let out = '';
  parts.forEach((seg, i) => {
    if (i % 2 === 1) {
      out += `<pre><code>${esc(seg.replace(/^[a-zA-Z0-9]*\n/, ''))}</code></pre>`;
    } else {
      out += esc(seg)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,4} (.+)$/gm, '<b>$1</b>')
        .replace(/\n/g, '<br>');
    }
  });
  return out;
}

// libellé court d'un lien de PR GitHub (repo #num) sinon l'URL brute.
export function prLabel(l) {
  const m = l.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[2]} #${m[3]}` : l;
}
