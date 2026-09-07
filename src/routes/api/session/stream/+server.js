import { agentSession, subscribeAgent, streamSnapshot } from '$lib/server/core.js';

// Flux SSE PAR SESSION : pousse l'avancement d'un tour au fil de l'eau (texte en cours d'écriture,
// raisonnement, outil courant, état).
//
// Pourquoi un canal séparé de /api/stream : le flux global ne pousse qu'un « tick », sur lequel le
// client refetch tout le détail de session. C'est le bon rythme pour le transcript (une écriture par
// message) mais pas pour des deltas de tokens — on ne va pas relivrer 1000 messages plusieurs fois
// par seconde. Ici on n'envoie qu'un petit instantané (quelques centaines d'octets).
//
// Le tampon envoyé n'est PAS la source de vérité : dès que le message est bufferisé il tombe dans le
// transcript, et c'est le refetch normal qui l'affiche. Ce flux ne sert qu'à combler l'attente.
export function GET({ url }) {
  const id = url.searchParams.get('id');
  if (!id) return new Response('id required', { status: 400 });

  const encoder = new TextEncoder();
  const frame = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  let unsubscribe;
  let heartbeat;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      const st = agentSession(id);
      // Session non pilotée (terminée, ou ouverte hors hooked) : on le dit et on laisse le client
      // fermer plutôt que de tenir une connexion qui ne dira jamais rien.
      if (!st) {
        controller.enqueue(frame({ live: false }));
        controller.close();
        return;
      }
      // État courant d'abord : un client qui s'abonne au milieu d'un tour voit tout de suite ce qui
      // a déjà été écrit, au lieu d'attendre le prochain delta.
      controller.enqueue(frame({ live: true, ...streamSnapshot(st) }));
      unsubscribe = subscribeAgent(id, (snap) => {
        try { controller.enqueue(frame({ live: true, ...snap })); }
        catch (_) { if (unsubscribe) unsubscribe(); }
      });
      // Un proxy peut couper une connexion muette ; un tour peut rester silencieux longtemps
      // (un Bash lent). Commentaire SSE = trafic sans évènement côté client.
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch (_) {}
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
      // Nginx et compagnie tamponnent le SSE par défaut → le direct n'arrive plus en direct.
      'X-Accel-Buffering': 'no',
    },
  });
}
