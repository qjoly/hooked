import fs from 'node:fs';
import { parseItemUrl } from './ghClient.js';
import { repoSlug, worktreeOf } from './git.js';
import { scanSessions } from './transcript.js';
import { launchSession } from './agent.js';
import { readSettings } from './settings.js';
import { HOME } from './config.js';

// "Review in a session": a new driven session reviews a GitHub pull request and reports in the
// conversation only. Nothing is posted to GitHub; the user decides what to do with the findings.

// Main checkout of `slug` (owner/name) among the projects of known sessions, most recently
// active first. A linked worktree counts as its main checkout, since that one stays put.
export function localCheckoutFor(slug, sessions) {
  const want = String(slug || '').toLowerCase();
  const sorted = [...sessions].sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  const seen = new Set();
  for (const s of sorted) {
    const dir = s.project && (worktreeOf(s.project) || s.project);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (String(repoSlug(dir) || '').toLowerCase() === want && fs.existsSync(dir)) return dir;
  }
  return null;
}

export function prReviewPrompt({ url, repo, number, checkout }) {
  const pr = `${number} -R ${repo}`;
  return [
    `Review the GitHub pull request ${url} (${repo}#${number}).`,
    '',
    'This review stays in this session. Do NOT post anything to GitHub: no `gh pr review`, no `gh pr comment`, no `gh api` call that writes, no approval, no push. Report the findings here only; I decide what to send.',
    '',
    'Stay read-only:',
    `- Read the PR, its description and discussion: \`gh pr view ${pr} --comments\`, and the change: \`gh pr diff ${pr}\`.`,
    checkout
      ? `- For context beyond the diff, fetch the head without touching the working tree: \`git fetch origin pull/${number}/head\`, then \`git show FETCH_HEAD:<path>\`. Do not check out, switch branches, stash or edit files in this checkout.`
      : `- There is no local checkout of ${repo}: read surrounding files through \`gh api repos/${repo}/contents/<path>?ref=<head sha>\` (GET only).`,
    '',
    'Then answer with:',
    '1. What the PR does, in two or three sentences.',
    '2. Findings, most severe first: file:line, the problem, a concrete scenario where it breaks, a suggested fix. Skip style nitpicks unless they hide a bug.',
    '3. A verdict: approve, request changes, or comment.',
  ].join('\n');
}

export function reviewPrInSession(url) {
  const ref = parseItemUrl(url);
  if (!ref || ref.kind !== 'pr') return Promise.reject(Object.assign(new Error('Not a GitHub pull request URL'), { code: 400 }));
  const repo = `${ref.owner}/${ref.name}`;
  const checkout = localCheckoutFor(repo, scanSessions());
  const cwd = checkout || readSettings().quickLaunchProject || HOME;
  const prompt = prReviewPrompt({ url, repo, number: ref.number, checkout });
  return new Promise((resolve, reject) => {
    launchSession({ cwd, prompt }, (err, info) => (err ? reject(err) : resolve({ ...info, checkout })));
  });
}
