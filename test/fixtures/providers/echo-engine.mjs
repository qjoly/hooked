// Minimal external engine (cf. docs/providers.md): no subprocess, it answers every prompt by
// echoing it. Built on the journal store hooked hands to engine modules, so the session list,
// the conversation and the trash come for free.
export function createEngine(api) {
  const { journal } = api;
  return {
    id: 'echo',
    label: 'Echo',
    capabilities: { models: false, resume: true, trace: true, search: true, trash: true, todos: true },
    detect: () => true,
    available: () => null,
    storeKey: (provider) => 'journal:' + provider.id,
    scan: (provider) => journal.scanJournal([provider.id]),
    conversation: (s) => journal.journalConversation(s.file),
    trace: (s) => journal.journalTrace(s.file),
    todos: (s) => journal.journalTodos(s.file),
    setArchived: (s, archived) => journal.journalSetArchived(s.file, archived),
    driver: {
      start(st, opts, ctx) {
        const id = opts.resumeId || 'echo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        st.id = id;
        st.echoJournal = journal.openJournal(st.provider, id, { engine: 'echo', cwd: st.cwd });
        st.sawMsg = true;
        ctx.setLive(id, st);
        ctx.done(st);
        if (opts.prompt) this.prompt(st, opts.prompt);
      },
      prompt(st, text) {
        const prefix = (st.providerConfig && st.providerConfig.options && st.providerConfig.options.prefix) || 'echo: ';
        st.echoJournal.user(text);
        st.echoJournal.text(prefix + text);
        st.echoJournal.turnEnd('end_turn');
        st.busy = false;
        st.sdkState = 'idle';
        if (typeof st.onTurnEnd === 'function') st.onTurnEnd();
        return Promise.resolve({ stopReason: 'end_turn' });
      },
      cancel: () => Promise.resolve(),
      kill(st) { st.ended = true; },
    },
  };
}
