# GitHub module

The GitHub page (notifications, assigned issues, your PRs and the ones waiting on your review, the
open PRs of a repo), PR watches that wake a session, and PR review tags.

**What stays in the core**, because the session dock and other core features use it whatever this
module says: the request policy (`server/ghClient.js`, also used by worktrees), the link summaries
of the dock's PR/issue pills (`server/ghMeta.js`, `/api/gh`, GitLab included), and the viewers the
dock opens with their actions (`server/github.js`: PR/issue detail, diff, Actions runs and logs,
approve, close; `server/prReview.js`: review in a session; `GhDetail.svelte`, `GhRunWindow.svelte`).
Approving or closing a PR drops this module's page caches through globalThis
(`hooked.github.overview`, `hooked.github.repoPrs`), so the core never imports the module.

- **PR watch** (`server/prWatch.js`; `watch_pull_request` tool, or the `autoPrWatch` setting for the
  viewer's open PR a driven session links last) wakes the session with one message about
  failed/passed checks, no check 15 min after a push, a merge conflict, or comments from anyone but
  the viewer. News is held while the session works or waits on a question, so the state only
  advances once it was delivered. A watch ends on merge/close, on `unwatch_pull_request`, or after
  10 comment-only wakes in a row (bot loops). Watches live in `pr-watches.json`; a process only
  polls the sessions it drives, so it runs in every process, `npm run live` included.
- **PR review tags** (`server/prReviewTags.js`, `autoPrReviewTag`): `pr-approved` /
  `pr-changes-requested` on a session when the review of its PR lands. Ticks every minute on top of
  `ghMeta.ghViewMany`'s cache; a lock file keeps two processes from polling at once. Started with
  the service, re-applied in any process when the settings change. The tag names are in
  `lib/reviewTags.js`, which auto-tagging reads to keep them out of its vocabulary.
- **The page** (`server/github.js`, `ui/GitHub.svelte`): one overview cached 90 s (and in
  `github-overview.json`), PR details fetched by ids in parallel chunks (a search with
  statusCheckRollup brushes GitHub's 10 s gateway timeout).
- API: `/api/github` (overview), `/api/github/repo`, `/api/github/notifications`, `/api/pr-watch`.
