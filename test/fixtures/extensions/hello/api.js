import { state, probe, VERSION } from './server/state.js';

export default (ctx) => ({
  count: {
    GET: () => ctx.json({ turns: state.turns, version: VERSION, ticks: { ...probe } }),
  },
  'say-hello': {
    POST: () => {
      const { loud, name } = ctx.settings();
      const text = `Hello, ${name}!`;
      return ctx.json({ flash: loud ? text.toUpperCase() : text });
    },
  },
});
