import { jget, jpost } from '#lib/api.js';

export const getFlows = () => jget('/api/flows');
export const flowOp = (op, extra) => jpost('/api/flows', { op, ...extra });
