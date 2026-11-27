import { jpost } from '#lib/api.js';

export const markGithubNotificationsDone = (ids) => jpost('/api/github/notifications', { ids });
