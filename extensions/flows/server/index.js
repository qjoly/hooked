/*
 * The Flows extension's lifecycle (cf. server/extensions.js). The service adopts every running run at
 * boot; a bare `npm run live` starts the engine lazily, for the runs it starts itself.
 */
import { startFlowEngine, stopFlowEngine } from './flows.js';

export default {
  start({ service }) { if (service) startFlowEngine({ adopt: true }); },
  stop() { stopFlowEngine(); },
};
