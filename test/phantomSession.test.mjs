/*
 * Une session enregistrée comme vivante mais dont le CLI ne tourne pas est un TROU NOIR :
 * deliverReply poussait le texte dans la file d'entrée et répondait OK, alors que personne ne la
 * vidait → le message était perdu en silence et l'UI l'affichait « queued » indéfiniment.
 *
 * Vécu : au démarrage, la reprise auto a rappelé une session dont un CLI orphelin d'un hooked
 * précédent tenait encore le verrou. Le nouveau CLI n'a jamais produit un message, readLoop est
 * resté à attendre un flux mort, et l'entrée n'a jamais quitté le registre.
 *
 * Le registre est volontairement épinglé sur globalThis (survie aux ré-exécutions de Vite), ce qui
 * donne une prise pour fabriquer le cas sans lancer de vraie session.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { deliverReply, failStartup, makeInputQueue } from '../server/agent.js';

const live = globalThis[Symbol.for('hooked.agent.registry')];
const ID = 'phantom-test-session';

function phantom(extra = {}) {
  const st = {
    id: ID, launchKey: 'launch:test', cwd: '/tmp', input: makeInputQueue(),
    abort: new AbortController(), sawMsg: false, watchdog: null, ended: false,
    busy: false, activity: null, sdkState: 'idle', pendingAsk: null, ...extra,
  };
  live.set(ID, st);
  return st;
}

beforeEach(() => live.delete(ID));

describe('phantom session', () => {
  it('refuses a reply to a session that has not spoken yet', () => {
    phantom();
    let err = null;
    deliverReply(ID, 'hello', (e) => { err = e; });
    expect(err).toBeTruthy();
    expect(err.code).toBe(400);
    expect(err.message).toMatch(/still starting/);
  });

  it('accepts a reply once the session has produced a message', () => {
    phantom({ sawMsg: true });
    let err = 'unset', info = null;
    deliverReply(ID, 'hello', (e, i) => { err = e; info = i; });
    expect(err).toBe(null);
    expect(info).toEqual({ sessionId: ID, sent: 1 });
  });

  it('failStartup takes the entry out of the registry', () => {
    phantom();
    expect(live.has(ID)).toBe(true);
    failStartup(live.get(ID));
    expect(live.has(ID)).toBe(false);
  });

  it('failStartup marks it ended and releases a pending ask', () => {
    let released = 'unset';
    const st = phantom({ pendingAsk: { resolve: (v) => { released = v; } } });
    failStartup(st);
    expect(st.ended).toBe(true);
    expect(st.busy).toBe(false);
    expect(st.pendingAsk).toBe(null);
    expect(released).toBe(null); // une attente non libérée bloquerait le sous-process à la sortie
  });

  it('a torn-down session no longer accepts replies at all', () => {
    failStartup(phantom({ sawMsg: true }));
    let err = null;
    deliverReply(ID, 'hello', (e) => { err = e; });
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/no live agent session/);
  });
});
