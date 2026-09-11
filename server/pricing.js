/*
 * Tarifs estimatifs (USD / million de tokens) + calcul du coût d'un usage.
 * cache write ≈ 1.25x input (5m) / 2x (1h), cache read ≈ 0.1x input.
 */

// Tarifs estimatifs (USD / million de tokens). Éditables.
const PRICING = {
  fable: { in: 10, out: 50 },          // Fable 5 / Mythos 5
  opus: { in: 5, out: 25 },            // Opus 4.5 / 4.6 / 4.7 / 4.8 / 5
  opusLegacy: { in: 15, out: 75 },     // Opus 4 / 4.1 (deprecated)
  sonnet: { in: 3, out: 15 },          // Sonnet 4 / 4.5 / 4.6
  haiku: { in: 1, out: 5 },            // Haiku 4.5
  haikuLegacy: { in: 0.8, out: 4 },    // Haiku 3.5 (retired)
};
function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return PRICING.fable;
  if (m.includes('opus')) {
    // Opus 4.0 (e.g. opus-4-20250514) and 4.1 are the legacy $15/$75 tier; 4.5+ are $5/$25.
    if (/opus-4-1\b/.test(m) || /opus-4-20\d{6}/.test(m)) return PRICING.opusLegacy;
    return PRICING.opus;
  }
  if (m.includes('haiku')) {
    if (m.includes('-3-')) return PRICING.haikuLegacy; // Haiku 3.x (e.g. claude-3-5-haiku)
    return PRICING.haiku;
  }
  if (m.includes('sonnet')) return PRICING.sonnet;
  return PRICING.opus;
}

// calcule le coût d'un objet usage (tokens) pour un modèle donné.
function costForUsage(u, model) {
  const p = priceFor(model);
  const inp = u.input_tokens || 0, out = u.output_tokens || 0;
  const cc = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  const d = u.cache_creation || {};
  const cc1h = d.ephemeral_1h_input_tokens || 0, cc5m = d.ephemeral_5m_input_tokens || 0;
  const cIn = inp * p.in / 1e6, cOut = out * p.out / 1e6;
  const cCc = (cc1h + cc5m) > 0 ? (cc1h * 2 + cc5m * 1.25) * p.in / 1e6 : cc * p.in * 1.25 / 1e6;
  const cCr = cr * p.in * 0.1 / 1e6;
  return { inp, out, cc, cr, cIn, cOut, cCc, cCr, total: cIn + cOut + cCc + cCr };
}

export { PRICING, priceFor, costForUsage };
