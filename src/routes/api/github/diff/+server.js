import { json } from '@sveltejs/kit';
import { githubDiff } from '../../../../../server/github.js';
import { gitlabDiff, parseGitlabUrl } from '../../../../../server/gitlab.js';

export async function GET({ url }) {
  try {
    const u = url.searchParams.get('url');
    return json({ files: await (parseGitlabUrl(u) ? gitlabDiff(u) : githubDiff(u)) });
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
}
