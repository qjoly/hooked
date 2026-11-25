import { jget, jpost } from '#lib/api.js';

export const getCronTasks = () => jget('/api/cron');
export const cronOp = (op, extra) => jpost('/api/cron', { op, ...extra });
