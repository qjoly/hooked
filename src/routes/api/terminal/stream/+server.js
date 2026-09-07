import { subscribeTerminal, getTerminal, terminalScrollback } from '$lib/server/core.js';

// Flux SSE de la sortie d'un terminal.
//
// On envoie les octets BRUTS du PTY, séquences ANSI comprises, encodés en base64 dans le champ
// `data`. Pourquoi base64 : le protocole SSE est délimité par des sauts de ligne, et la sortie d'un
// terminal en est pleine — sans encodage, un simple `ls` casserait le cadrage des évènements. Et
// c'est du binaire, pas du texte : le JSON n'aiderait pas plus.
//
// Le tampon d'écran est rejoué à la connexion : un terminal vit dans le processus hooked et survit
// donc au rechargement de la page. Sans ce rejeu on « rouvrirait » un shell vide alors que la
// commande tourne toujours.
export function GET({ url }) {
  const id = url.searchParams.get('id');
  if (!id) return new Response('id required', { status: 400 });
  if (!getTerminal(id)) return new Response('unknown terminal', { status: 404 });

  const enc = new TextEncoder();
  const frame = (b64) => enc.encode(`data: ${b64}\n\n`);
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  let unsubscribe;
  let heartbeat;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('retry: 2000\n\n'));
      const back = terminalScrollback(id);
      if (back) controller.enqueue(frame(b64(back)));
      unsubscribe = subscribeTerminal(id, (chunk) => {
        try {
          // `null` = le terminal a été fermé : on clôt proprement plutôt que de laisser le client
          // se reconnecter en boucle sur un id qui n'existe plus.
          if (chunk === null) { controller.close(); return; }
          controller.enqueue(frame(b64(chunk)));
        } catch (_) { if (unsubscribe) unsubscribe(); }
      });
      heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(': ping\n\n')); } catch (_) {}
      }, 15000);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',   // sinon un proxy tamponne et le « direct » n'est plus direct
    },
  });
}
