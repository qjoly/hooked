import { state, tick } from './state.js';

let timer = null;

export default {
  start() { timer = setInterval(tick, 20); },
  stop() { clearInterval(timer); timer = null; },
  on: {
    'turn:end': () => { state.turns++; },
  },
};
