import { json } from '@sveltejs/kit';
import { githubDetail } from '../../../../../server/github.js';
import { gitlabDetail, parseGitlabUrl } from '../../../../../server/gitlab.js';

export async function GET({ url }) {
  try {
    const u = url.searchParams.get('url');
    return json(await (parseGitlabUrl(u) ? gitlabDetail(u) : githubDetail(u)));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
