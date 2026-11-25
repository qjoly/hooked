/*
 * The Flows module's lifecycle (cf. server/modules.js). The service adopts every running run at
 * boot; a bare `npm run live` starts the engine lazily, for the runs it starts itself.
 */
import { startFlowEngine, stopFlowEngine } from './flows.js';

export default {
  start({ service }) { if (service) startFlowEngine({ adopt: true }); },
  stop() { stopFlowEngine(); },
};
