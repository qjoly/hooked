# Cron module

A task launches a new driven session with its prompt on a five-field cron schedule, in local time.
Tasks live in `cron-tasks.json`; the parser (`lib/cron.js`) is pure and shared with the page's
preview (the desktop app's `desktop/src/cron.rs` and Android's `CronSchedule.kt` port it).

- **The scheduler only runs in the service** (`server/index.js`: `start({ service })`), so a bare
  `npm run live` never fires a task. Run now works everywhere. Switching the module off stops it.
- **One live session per task.** A run closes the previous one if it is idle, and is skipped if it
  is still working or waiting on you. Runs missed while hooked is down are not caught up.
- **Agent tools** (`tools.cjs`): `list_cron_tasks`, `save_cron_task`, `delete_cron_task`,
  `run_cron_task`. A save with an `id` only changes the fields it carries. A task without a
  provider runs on the default provider of the settings.
- API: `GET /api/cron`, `POST /api/cron` `{ op: 'save' | 'delete' | 'run' }` (`api.js`).
