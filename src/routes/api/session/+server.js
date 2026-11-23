import { json } from '@sveltejs/kit';
import { sessionDetailWarm, trimDetail, parseDeltaParams } from '#lib/server/core.js';
import { jsonWithEtag } from '#lib/server/respond.js';

export async function GET({ url, request }) {
  const d = await sessionDetailWarm(url.searchParams.get('id'));
  if (!d) return json({}, { status: 404 });
  // Opt-in (`delta=1`): the dashboard sends what it already holds and gets only the difference. The
  // MCP proxy and the small card fetches keep the plain full shape.
  if (url.searchParams.get('delta') === '1') return jsonWithEtag(request, trimDetail(d, parseDeltaParams(url.searchParams)));
  return jsonWithEtag(request, d);
}
