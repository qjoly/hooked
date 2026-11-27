// The API of every runtime-loaded extension: /api/<id>/<rest> → the route map of its api.js
// (server/extensions.js applies the on/off gate). Static routes win, so the core's are untouched.
import { dispatchExtensionRoute } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

async function dispatch({ params, request }) {
  return (await dispatchExtensionRoute(params.ext, params.rest, request)) || fail(404, 'not found');
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
