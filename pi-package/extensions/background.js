/*
 * Background commands for hooked's pi package: Claude Code's `Bash run_in_background`, `BashOutput`
 * and `KillShell`, for pi (whose bash tool waits for the command to end).
 *
 *   BashBackground {command, description?} → starts the command, answers at once with its id
 *   BashOutput {bash_id, filter?}           → the output written since the last read, and the status
 *   KillShell {shell_id}                    → stops the command (its whole process group)
 *
 * When a command ends on its own, the agent gets a `<task-notification>` message, as in Claude
 * Code, and an idle agent wakes up to read it (`followUp` + `triggerTurn`). The commands live in this
 * pi process: they stop with the session (`session_shutdown`, which pi also fires on SIGTERM), and
 * the stop is written to the session file so hooked's dock does not show them running forever.
 *
 * The dock reads the jobs back from the session file (piBackgroundJobs in server/pi.js): the
 * BashBackground calls and results, the KillShell calls, and the `hooked-task` entries below.
 */
import { spawn } from 'node:child_process';

const MAX_BUFFER = 1024 * 1024; // output kept per command; older output is dropped
export const TASK_TYPE = 'hooked-task';

const notice = (j) => {
  const tail = j.out.split('\n').slice(-20).join('\n').trim();
  const what = j.status === 'completed' ? 'completed' : `failed with exit code ${j.exitCode ?? 'unknown'}`;
  return `<task-notification>\n<task-id>${j.id}</task-id>\n<status>${j.status}</status>\n`
    + `<summary>Background command "${j.description || j.command.slice(0, 80)}" ${what}</summary>\n</task-notification>`
    + (tail ? `\nLast output:\n${tail}` : '');
};

// Lines of `text` that match `filter` (a regular expression), or all of it.
export function filterLines(text, filter) {
  if (!filter) return text;
  let re;
  try { re = new RegExp(filter); } catch (_) { return text; }
  return text.split('\n').filter((l) => re.test(l)).join('\n');
}

export function registerBackground(pi) {
  const jobs = new Map();
  let seq = 0;

  const stopAll = (reason) => {
    for (const j of jobs.values()) {
      if (j.status !== 'running') continue;
      try { process.kill(-j.proc.pid, 'SIGTERM'); } catch (_) {}
      j.status = 'killed';
      j.stoppedBy = reason;
      try { pi.appendEntry(TASK_TYPE, { shellId: j.id, status: 'killed', reason }); } catch (_) {}
    }
  };
  pi.on('session_shutdown', () => stopAll('session ended'));
  process.once('exit', () => { for (const j of jobs.values()) if (j.status === 'running') { try { process.kill(-j.proc.pid, 'SIGTERM'); } catch (_) {} } });

  pi.registerTool({
    name: 'BashBackground',
    label: 'Background command',
    description: 'Start a shell command in the background and return at once with its id: for dev servers, watchers, long builds or test runs. Read its output with BashOutput and stop it with KillShell. When it ends on its own you get a <task-notification> message. Do not use it for commands that finish quickly: use bash.',
    promptSnippet: 'Run a long or never-ending command in the background',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, run by bash -lc in the session directory' },
        description: { type: 'string', description: 'What the command does, in a few words' },
      },
      required: ['command'],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const id = `bg-${++seq}`;
      const command = String(params.command || '');
      const proc = spawn('bash', ['-lc', command], {
        cwd: (ctx && ctx.cwd) || process.cwd(),
        env: { ...process.env, HOOKED_DRIVEN: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // its own process group, so KillShell stops what it started too
      });
      const j = { id, command, description: String(params.description || ''), proc, out: '', read: 0, dropped: 0, status: 'running', exitCode: null, startedAt: Date.now() };
      jobs.set(id, j);
      const add = (d) => {
        j.out += d;
        if (j.out.length > MAX_BUFFER) {
          const cut = j.out.length - MAX_BUFFER;
          j.out = j.out.slice(cut);
          j.dropped += cut;
          j.read = Math.max(0, j.read - cut);
        }
      };
      proc.stdout.setEncoding('utf8'); proc.stdout.on('data', add);
      proc.stderr.setEncoding('utf8'); proc.stderr.on('data', add);
      proc.on('error', (e) => add(`\n[failed to start: ${e.message}]\n`));
      proc.on('close', (code, sig) => {
        if (j.status !== 'running') return; // KillShell or shutdown: the agent knows
        j.exitCode = code;
        j.status = code === 0 ? 'completed' : 'failed';
        try {
          pi.sendMessage(
            { customType: TASK_TYPE, content: notice(j), display: true, details: { shellId: id, status: j.status, exitCode: code, signal: sig || null } },
            { deliverAs: 'followUp', triggerTurn: true },
          );
        } catch (_) {}
      });
      return {
        content: [{ type: 'text', text: `Command running in background with ID: ${id}. Read its output with BashOutput and stop it with KillShell; a <task-notification> arrives when it ends.` }],
        details: { shellId: id, command, description: j.description },
      };
    },
  });

  pi.registerTool({
    name: 'BashOutput',
    label: 'Background output',
    description: 'Read the output a background command (BashBackground) wrote since the last read, and its status. `filter` keeps only the lines that match a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        bash_id: { type: 'string', description: 'The id BashBackground returned' },
        filter: { type: 'string', description: 'Optional regular expression: only matching lines' },
      },
      required: ['bash_id'],
    },
    async execute(_id, params) {
      const j = jobs.get(String(params.bash_id));
      if (!j) return { content: [{ type: 'text', text: `No background command with ID ${params.bash_id}.` }], details: undefined, isError: true };
      const fresh = j.out.slice(j.read);
      j.read = j.out.length;
      const status = j.status === 'running' ? 'running' : `${j.status}${j.exitCode != null ? ` (exit code ${j.exitCode})` : ''}`;
      const body = filterLines(fresh, params.filter).trim();
      return {
        content: [{ type: 'text', text: `<status>${status}</status>\n${body ? `<output>\n${body}\n</output>` : '(no new output)'}` }],
        details: { shellId: j.id, status: j.status, exitCode: j.exitCode },
      };
    },
  });

  pi.registerTool({
    name: 'KillShell',
    label: 'Stop a background command',
    description: 'Stop a background command started with BashBackground, and the processes it started.',
    parameters: {
      type: 'object',
      properties: { shell_id: { type: 'string', description: 'The id BashBackground returned' } },
      required: ['shell_id'],
    },
    async execute(_id, params) {
      const j = jobs.get(String(params.shell_id));
      if (!j) return { content: [{ type: 'text', text: `No background command with ID ${params.shell_id}.` }], details: undefined, isError: true };
      if (j.status !== 'running') return { content: [{ type: 'text', text: `${j.id} already ended (${j.status}).` }], details: { shellId: j.id, status: j.status } };
      j.status = 'killed';
      try { process.kill(-j.proc.pid, 'SIGTERM'); } catch (_) {}
      setTimeout(() => { try { process.kill(-j.proc.pid, 'SIGKILL'); } catch (_) {} }, 3000).unref?.();
      return { content: [{ type: 'text', text: `Stopped ${j.id}.` }], details: { shellId: j.id, status: 'killed' } };
    },
  });
}
