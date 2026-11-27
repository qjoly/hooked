// Shared by the lifecycle and the API of one loaded version of the extension.
export const VERSION = 1;
export const state = { turns: 0, ticks: 0 };

// Visible to the tests: how many times each loaded version's timer fired.
export const probe = (globalThis[Symbol.for('hooked.test.hello')] ??= {});
export function tick() {
  state.ticks++;
  probe[VERSION] = (probe[VERSION] || 0) + 1;
}
