// A GitHub Actions run or job page, e.g. https://github.com/o/r/actions/runs/1/job/2 (shared by server and UI).
const RUN_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?(?:[/?#]|$)/;

export function parseRunUrl(url) {
  const m = RUN_URL.exec(String(url || ''));
  return m ? { repo: m[1], run: m[2], job: m[3] || '' } : null;
}

// How a check, run, job or step status is shown.
export const CHECK = {
  failed: { icon: 'attention', label: 'Failed', cls: 'ko' },
  cancelled: { icon: 'ban', label: 'Cancelled', cls: 'ko' },
  pending: { icon: 'busy', label: 'Running', cls: 'wait' },
  passed: { icon: 'circle-check', label: 'Passed', cls: 'ok' },
  skipped: { icon: 'circle', label: 'Skipped', cls: 'muted' },
  neutral: { icon: 'circle', label: 'Neutral', cls: 'muted' },
};
