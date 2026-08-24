// Logique pure des notifications (sans runes → testable en vitest, cf. test/notify.test.mjs).
// Consommée par state.svelte.js. On notifie quand une session « a fini / attend ta réponse » :
// une question en attente (hasQuestion), attention (permission), waiting (fin de tour, hook Stop),
// ou ended (session terminée).
// PAS 'background' : un job/sous-agent de fond tourne encore (cf. server/stats.js withBackgroundState)
// → Claude n'est pas bloqué SUR TOI, on ne nague pas. Le ping tombe quand le job finit : la session
// repasse alors 'background' → 'waiting' (transition captée par checkNotifications → notif). Une
// question en attente (hasQuestion) nague quand même, même en background.

export const NOTIFY_KINDS = {
  q:          { icon: '⌨️', label: 'awaiting your reply' },
  attention:  { icon: '🔴', label: 'action required' },
  waiting:    { icon: '🟡', label: 'finished — waiting for you' },
  ended:      { icon: '🏁', label: 'session ended' },
};

// Clé notifiable d'une session, ou '' si rien à signaler (working/idle/background → jamais de spam).
export function notifyKeyFor(s) {
  if (s.hasQuestion) return 'q';
  if (s.state === 'attention') return 'attention';
  if (s.state === 'waiting') return 'waiting';
  if (s.state === 'ended') return 'ended';
  return '';
}

// Une clé qui compte pour le badge d'onglet (« sessions qui t'attendent »). 'ended' n'en fait pas
// partie (session finie ≠ en attente), cohérent avec applyTitleBadge.
export function countsForBadge(key) {
  return key === 'q' || key === 'attention' || key === 'waiting';
}
