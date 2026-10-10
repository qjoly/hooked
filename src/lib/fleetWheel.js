// The fleet wheel, read like the coffee taster's flavour wheel: the inner ring is one arc per state
// family, the outer ring one segment per session laid inside its family's arc. Pure (no runes) so
// the geometry is testable; FleetWheel.svelte, the top-bar mark and the favicon all draw from it.
import { sessionDot } from './format.js';

// Clockwise from 12 o'clock: what needs you comes first, so it always sits at the top of the cup.
// Labels reuse the app's existing state vocabulary.
export const FAMILIES = [
  { key: 'attention', label: 'Action required', needsYou: true },
  { key: 'waiting', label: 'Waiting for you', needsYou: true },
  { key: 'working', label: 'Working' },
  { key: 'bgjob', label: 'Background' },
  { key: 'idle', label: 'Paused' },
  { key: 'ended', label: 'Ended' },
];
const ORDER = Object.fromEntries(FAMILIES.map((f, i) => [f.key, i]));

/** Group sessions by family, in wheel order, with fractions of the circle ([0, 1) from 12 o'clock). */
export function wheelModel(sessions, isQuiet = () => false) {
  const list = (sessions || []).map((s) => ({ s, family: sessionDot(s) }))
    .sort((a, b) => ORDER[a.family] - ORDER[b.family]
      || String(b.s.lastActivity || '').localeCompare(String(a.s.lastActivity || '')));
  const total = list.length;
  const segments = list.map(({ s, family }, i) => ({
    id: s.id, family, start: i / total, end: (i + 1) / total, quiet: !!isQuiet(s),
    needsYou: !!FAMILIES[ORDER[family]].needsYou,
  }));
  const families = FAMILIES.map((f) => {
    const members = segments.filter((g) => g.family === f.key);
    return { ...f, count: members.length, start: members[0]?.start ?? 0, end: members.at(-1)?.end ?? 0 };
  });
  return { total, segments, families };
}

// ── favicon ──────────────────────────────────────────────────────────────────────────────────────
// The browser tab is the glance surface when hooked is not the focused window: the same family
// ring, drawn around the hook. Colours are passed in (resolved from the active palette) because an
// SVG favicon is rendered outside the document and cannot read its CSS variables.
const polar = (cx, cy, r, t) => [cx + r * Math.sin(t * 2 * Math.PI), cy - r * Math.cos(t * 2 * Math.PI)];
function arc(cx, cy, r, a, b) {
  const [x0, y0] = polar(cx, cy, r, a), [x1, y1] = polar(cx, cy, r, b);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
export function faviconSvg(families, colors, { bg = '#1e1512', ink = '#f2f3ec' } = {}) {
  // At 16px one waiting session among forty would be a 9° sliver: a family that needs you keeps at
  // least a quarter of the ring, the rest stays proportional.
  const live = families.filter((f) => f.count > 0)
    .map((f) => ({ ...f, count: f.needsYou ? Math.max(f.count, families.reduce((n, g) => n + g.count, 0) / 4) : f.count }));
  const total = live.reduce((n, f) => n + f.count, 0);
  const gap = live.length > 1 ? 0.025 : 0;
  let t = 0;
  const arcs = live.map((f) => {
    const a = t + gap / 2, b = t + f.count / total - gap / 2;
    t += f.count / total;
    return live.length === 1
      ? `<circle cx="32" cy="32" r="27" fill="none" stroke="${colors[f.key]}" stroke-width="8"/>`
      : `<path d="${arc(32, 32, 27, a, b)}" fill="none" stroke="${colors[f.key]}" stroke-width="8"/>`;
  }).join('');
  const hook = `<g fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M32 15v18"/><path d="M32 33a8.5 8.5 0 1 1-8.5 8.5"/><path d="M26.5 15h11"/></g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="22" fill="${bg}"/>${arcs}${hook}</svg>`;
}
