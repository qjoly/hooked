// Règles de visibilité liées aux providers installés sur la machine (claude / pi).
// Partagées par la sidebar, le Deck et la modale de nouvelle session — testées dans
// test/providerPicker.test.mjs. `p` = data.providers = { claude: bool, pi: bool } renvoyé
// par GET /api/sessions (détection dans server/providers.js).

// Les badges cc/pi d'une session n'ont de sens que quand les DEUX providers sont installés :
// avec un seul, la pillule n'apprendrait rien → on ne l'affiche pas.
export function providersBoth(p) {
  return !!(p && p.claude && p.pi);
}

// Provider effectif pour une NOUVELLE session : les deux installés → le choix de l'utilisateur
// est respecté ; un seul installé → on le fixe dessus (le sélecteur de provider est caché).
export function effectiveProvider(p, wanted) {
  if (providersBoth(p)) return wanted === 'pi' ? 'pi' : 'claude';
  return p && p.pi ? 'pi' : 'claude';
}
