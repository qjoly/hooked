// Repérage du symbole sous le pointeur, dans une ligne de code rendue en HTML.
//
// Pourquoi ce module existe : `highlight.js` n'enveloppe PAS les identifiants ordinaires dans
// un élément (seuls les mots-clés, littéraux et appels en reçoivent un — cf. highlight.js).
// Un nom de type est donc un nœud texte nu, fusionné avec ses voisins : `event.target` ne dit
// rien de ce qu'on a cliqué. Il faut passer par la position du CARET.
//
// Trois étapes : point → caret (nœud + offset), caret → offset absolu dans la ligne aplatie,
// offset → symbole (symbolAt, pur et testé). Le chemin retour (offset → Range) sert à
// souligner le mot avec la CSS Custom Highlight API, sans toucher au DOM.

import { symbolAt } from './highlight.js';

// Aplatit les nœuds texte d'un élément de ligne : offset absolu ⇄ (nœud, offset local).
// Repris du walker de l'écho d'occurrences de DiffView — les deux le partagent désormais,
// pour que « ce que je souligne » et « ce que je lis » ne puissent pas diverger.
export function flattenLine(el) {
  const nodes = [], starts = [];
  let text = '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push(n); starts.push(text.length); text += n.nodeValue; }
  const at = (idx) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > idx) i--;
    return [nodes[i], idx - starts[i]];
  };
  return { text, nodes, starts, at };
}

// Position du caret sous (x, y). Les deux API coexistent et aucune n'est universelle :
// caretPositionFromPoint (Firefox, Chrome ≥ 128) et caretRangeFromPoint (Safari, Chrome
// anciens). hooked se vérifie explicitement sous Gecko, donc les deux sont obligatoires.
export function caretAt(x, y) {
  if (typeof document === 'undefined') return null;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

// Le symbole sous l'événement pointeur, ou null.
// → { word, kind, lineEl, range } — `range` couvre exactement le mot, pour le soulignement.
//
// La position est recalculée à CHAQUE appel, jamais mémorisée entre le survol et le clic :
// quand le blame arrive (asynchrone), `.dv-code` passe en `flex: 0 1 auto` et la boîte
// rétrécit sous le curseur (cf. le CSS de DiffView).
export function symbolUnderPointer(ev, { lineSelector = '.dv-code', lang = '' } = {}) {
  const caret = caretAt(ev.clientX, ev.clientY);
  if (!caret || !caret.node) return null;
  const host = caret.node.nodeType === 3 ? caret.node.parentElement : caret.node;
  const lineEl = host && host.closest ? host.closest(lineSelector) : null;
  if (!lineEl) return null;

  const flat = flattenLine(lineEl);
  if (!flat.text) return null;
  const idx = flat.nodes.indexOf(caret.node);
  if (idx < 0) return null;   // caret sur l'élément lui-même (marge, padding) : pas de mot
  const abs = flat.starts[idx] + caret.offset;

  const hit = symbolAt(flat.text, lang, abs);
  if (!hit) return null;

  const [sn, so] = flat.at(hit.start);
  const [en, eo] = flat.at(hit.end - 1);
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo + 1);
  // start/end sont les offsets dans le TEXTE de la ligne, pas dans le DOM : ils survivent à un
  // re-rendu, là où une Range devient caduque. C'est ce qui permet de garder le symbole cliqué
  // marqué tant que sa carte est ouverte.
  return { word: hit.word, kind: hit.kind, start: hit.start, end: hit.end, lineEl, range };
}

// Peinture d'un mot via la CSS Custom Highlight API : aucun nœud ajouté ni scindé, donc aucune
// invalidation du cache de rendu et aucune interférence avec la sélection.
// Absente avant Firefox 140 → l'appelant retombe sur un simple `cursor: pointer`.
export const highlightsSupported = () => typeof CSS !== 'undefined' && !!CSS.highlights;

export function paintSymbol(name, range) {
  if (!highlightsSupported()) return;
  if (range) CSS.highlights.set(name, new Highlight(range));
  else CSS.highlights.delete(name);
}
// Repeint un mot d'une ligne déjà rendue, à partir de ses offsets TEXTE. Sert au marquage
// persistant : après chaque re-rendu du diff, la Range est reconstruite depuis les offsets.
export function paintRangeIn(name, lineEl, start, end) {
  if (!highlightsSupported() || !lineEl) return false;
  const flat = flattenLine(lineEl);
  if (end > flat.text.length || start >= end) return false;
  const [sn, so] = flat.at(start), [en, eo] = flat.at(end - 1);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo + 1);
  CSS.highlights.set(name, new Highlight(r));
  return true;
}

export function clearSymbols(names) {
  if (!highlightsSupported()) return;
  for (const n of names) CSS.highlights.delete(n);
}
