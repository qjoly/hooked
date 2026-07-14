// Logique pure des notifications (sans runes → testable en vitest, cf. test/notify.test.mjs).
// Consommée par state.svelte.js. On notifie quand une session « a fini / attend ta réponse » :
// une question en attente (hasQuestion), attention (permission), waiting (fin de tour, hook Stop),
// background (tour terminé MAIS un job de fond tourne encore, cf. server/stats.js
// withBackgroundState → ça veut toujours dire « attend ta réponse »), ou ended (session terminée).

export const NOTIFY_KINDS = {
  q:          { icon: '⌨️', label: 'awaiting your reply' },
  attention:  { icon: '🔴', label: 'action required' },
  waiting:    { icon: '🟡', label: 'finished — waiting for you' },
  background: { icon: '🌀', label: 'waiting for you — running in background' },
  ended:      { icon: '🏁', label: 'session ended' },
};

// Clé notifiable d'une session, ou '' si rien à signaler (working/idle → jamais de spam).
export function notifyKeyFor(s) {
  if (s.hasQuestion) return 'q';
  if (s.state === 'attention') return 'attention';
  if (s.state === 'waiting') return 'waiting';
  // 'background' = tour terminé mais un job de fond tourne encore : c'est toujours « attend ta
  // réponse » → on notifie (sinon une session waiting re-badgée background passait sous le radar).
  if (s.state === 'background') return 'background';
  if (s.state === 'ended') return 'ended';
  return '';
}

// Une clé qui compte pour le badge d'onglet (« sessions qui t'attendent »). 'ended' n'en fait pas
// partie (session finie ≠ en attente), cohérent avec applyTitleBadge.
export function countsForBadge(key) {
  return key === 'q' || key === 'attention' || key === 'waiting' || key === 'background';
}
