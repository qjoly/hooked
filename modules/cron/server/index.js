/*
 * The Cron module's lifecycle (cf. server/modules.js). The scheduler only runs in the service, so a
 * bare `npm run live` never fires a task; "Run now" works everywhere.
 */
import { startCronScheduler, stopCronScheduler } from './cron.js';

export default {
  start({ service }) { if (service) startCronScheduler(); },
  stop() { stopCronScheduler(); },
};
