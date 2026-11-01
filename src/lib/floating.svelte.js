// Floating windows open above every page, so they survive moving between sessions.
export const floating = $state({
  run: null,   // GitHub Actions run URL
  query: null, // { session, agent, id } of a Grafana query tool call
});
