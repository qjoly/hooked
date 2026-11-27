/*
 * The Cron extension's lifecycle. The scheduler only runs in the service, so a bare `npm run live`
 * never fires a task; "Run now" works everywhere.
 */
import { useCronContext, startCronScheduler, stopCronScheduler } from './cron.js';

export default {
  start(ctx) {
    useCronContext(ctx);
    if (ctx.service) startCronScheduler();
  },
  stop() { stopCronScheduler(); },
};
