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
