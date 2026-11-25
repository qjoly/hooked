/*
 * The GitHub module's lifecycle (cf. server/modules.js).
 *  - PR watch runs in every process: it only wakes the sessions this process drives, and reads
 *    `autoPrWatch` on every tick.
 *  - PR review tags follow `autoPrReviewTag`: started with the service, re-applied in any process
 *    when the settings change (a lock file keeps two processes from polling at once).
 */
import { startPrWatch, stopPrWatch } from './prWatch.js';
import { applyPrReviewTagSetting, stopPrReviewTags } from './prReviewTags.js';

export default {
  start({ service, settings }) {
    startPrWatch();
    if (service) applyPrReviewTagSetting(settings);
  },
  stop() {
    stopPrWatch();
    stopPrReviewTags();
  },
  applySettings(settings) { applyPrReviewTagSetting(settings); },
};
