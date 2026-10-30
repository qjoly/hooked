import { json } from '@sveltejs/kit';
import { status } from '../../../../../server/grafanaGateway.js';

export const GET = () => json(status());
