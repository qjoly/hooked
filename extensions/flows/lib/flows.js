/*
 * Flows: a graph of stages, each one a driven hooked session, chained like a CI pipeline.
 * Pure model shared by the server engine (extensions/flows/server/flows.js) and the UI: validation, layout,
 * scheduling decisions and the prompts handed to each stage. No IO here, so it is tested
 * without launching anything (test/flows.test.mjs).
 *
 * A stage runs once all the stages it comes `after` are done. One stage may be the decider: its
 * verdict ends the run (`done`), sends it back to `loopTo` for another iteration (`loop`), or
 * hands it to the user (`escalate`). Looping resets `loopTo` and everything downstream of it.
 */

export const STAGE_STATUSES = ['pending', 'starting', 'running', 'done', 'stalled', 'lost'];
export const VERDICTS = ['done', 'loop', 'escalate'];
export const DEFAULT_MAX_LOOPS = 3;
const MAX_STAGES = 12;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const KEY_RE = /^[a-z][a-z0-9-]{0,23}$/;

export const FEATURE_TEMPLATE = {
  id: 'feature',
  name: 'Feature',
  description: 'Pilot frames the work, a builder implements it, a reviewer and a challenger check it in parallel, a decider settles and loops if needed.',
  maxLoops: DEFAULT_MAX_LOOPS,
  worktree: true,
  stages: [
    {
      key: 'pilot', name: 'Pilot', after: [], writes: false, permissionMode: 'default', model: 'opus', effort: 'high',
      role: 'You frame the work. Read the code involved, then turn the task into a short, concrete spec: goal, '
        + 'scope and non-goals, the files and modules to touch, the design choices you recommend and why, and '
        + 'acceptance criteria. Do not edit code. Ask the user (AskUserQuestion) only when a choice is truly theirs.',
    },
    {
      key: 'build', name: 'Build', after: ['pilot'], writes: true, permissionMode: 'acceptEdits', model: 'sonnet', effort: 'high',
      role: 'You implement the spec in the shared workspace. Keep the change focused, follow the conventions of the '
        + 'codebase, add or update tests, and run them. Commit your work on the current branch with clear messages. '
        + 'On a later iteration, address the decider\'s instructions.',
    },
    {
      key: 'review', name: 'Review', after: ['build'], writes: false, permissionMode: 'default', model: 'sonnet', effort: 'medium',
      role: 'You review the builder\'s change: start from the diff against the base and read around it only as '
        + 'needed, do not survey the whole repository. Look for '
        + 'correctness bugs, missed edge cases, security issues, and code that does not fit the codebase. Do not '
        + 'edit files: list findings, most severe first, each with file, line and a concrete fix.',
    },
    {
      key: 'challenge', name: 'Test & challenge', after: ['build'], writes: false, permissionMode: 'default', model: 'sonnet', effort: 'medium',
      role: 'You run the test suite and exercise the change where it makes sense. Then challenge the design '
        + 'choices: is there a simpler approach, a wrong assumption, a missing requirement? Do not edit tracked '
        + 'files (the reviewer reads the same tree); scratch files go to /tmp. Run the relevant tests first, the '
        + 'whole suite only when the change is cross-cutting.',
    },
    {
      key: 'decide', name: 'Decide', after: ['review', 'challenge'], decider: true, loopTo: 'build', writes: false, permissionMode: 'default', model: 'opus', effort: 'medium',
      role: 'You settle, from the reports: open files only to check a disputed point, do not redo the review. '
        + 'Weigh the review findings and the challenges against the spec, decide which ones must be '
        + 'fixed, and which are rejected (say why). If anything must change, answer `loop` with precise instructions '
        + 'for the builder. If the work meets the spec, answer `done` with a summary for the user. Answer `escalate` '
        + 'only for a decision that belongs to the user.',
    },
  ],
};

function cleanStage(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    key: str(o.key, 24).toLowerCase(),
    name: str(o.name, 60),
    role: typeof o.role === 'string' ? o.role.trim().slice(0, 8000) : '',
    after: Array.isArray(o.after) ? [...new Set(o.after.filter((k) => typeof k === 'string').map((k) => k.trim().toLowerCase()))] : [],
    decider: o.decider === true,
    loopTo: str(o.loopTo, 24).toLowerCase() || null,
    writes: o.writes === true,
    model: str(o.model, 80) || null,
    effort: str(o.effort, 40) || null,
    permissionMode: str(o.permissionMode, 40) || 'default',
  };
}

// Normalizes a template (or the flow snapshot of a run). Never throws: see validateFlow.
export function cleanFlow(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const maxLoops = Number.isInteger(o.maxLoops) ? Math.min(Math.max(o.maxLoops, 0), 20) : DEFAULT_MAX_LOOPS;
  return {
    id: typeof o.id === 'string' && /^[a-z0-9-]{1,32}$/.test(o.id) ? o.id : null,
    name: str(o.name, 80),
    description: str(o.description, 400),
    maxLoops,
    worktree: o.worktree !== false,
    stages: (Array.isArray(o.stages) ? o.stages : []).slice(0, MAX_STAGES).map(cleanStage),
  };
}

// Throws an Error naming the first problem; returns the flow otherwise.
export function validateFlow(flow) {
  const { stages } = flow;
  if (!flow.name) throw new Error('name required');
  if (!stages.length) throw new Error('at least one stage');
  const keys = new Set();
  for (const s of stages) {
    if (!KEY_RE.test(s.key)) throw new Error(`invalid stage key "${s.key}" (lowercase letters, digits, dashes)`);
    if (keys.has(s.key)) throw new Error(`duplicate stage key "${s.key}"`);
    keys.add(s.key);
    if (!s.name) s.name = s.key;
    if (!s.role) throw new Error(`stage "${s.key}" needs a role`);
  }
  for (const s of stages) {
    for (const a of s.after) {
      if (!keys.has(a)) throw new Error(`stage "${s.key}" runs after unknown stage "${a}"`);
      if (a === s.key) throw new Error(`stage "${s.key}" runs after itself`);
    }
  }
  depths(stages); // throws on a cycle
  const deciders = stages.filter((s) => s.decider);
  if (deciders.length > 1) throw new Error('only one decider stage');
  const d = deciders[0];
  if (d) {
    if (!d.loopTo) throw new Error(`decider "${d.key}" needs a stage to loop back to`);
    if (!keys.has(d.loopTo)) throw new Error(`decider loops to unknown stage "${d.loopTo}"`);
    if (d.loopTo === d.key) throw new Error('the decider cannot loop to itself');
    if (!upstreamOf(stages, d.key).has(d.loopTo)) throw new Error(`"${d.loopTo}" must run before the decider to be looped back to`);
    if (downstreamOf(stages, d.key).size) throw new Error('the decider must be the last stage');
  }
  return flow;
}

// Column of each stage: 0 for roots, else 1 + the deepest stage it waits on. Throws on a cycle.
export function depths(stages) {
  const by = new Map(stages.map((s) => [s.key, s]));
  const out = new Map();
  const visiting = new Set();
  const visit = (k) => {
    if (out.has(k)) return out.get(k);
    if (visiting.has(k)) throw new Error(`cycle through stage "${k}"`);
    visiting.add(k);
    const s = by.get(k);
    const d = s && s.after.length ? 1 + Math.max(...s.after.filter((a) => by.has(a)).map(visit), -1) : 0;
    visiting.delete(k);
    out.set(k, d);
    return d;
  };
  for (const s of stages) visit(s.key);
  return out;
}

// Stages grouped by column, in declaration order: what the pipeline view draws.
export function columns(stages) {
  let dep;
  try { dep = depths(stages); } catch (_) { return [stages]; }
  const cols = [];
  for (const s of stages) (cols[dep.get(s.key)] ||= []).push(s);
  return cols.filter(Boolean);
}

export function upstreamOf(stages, key) {
  const by = new Map(stages.map((s) => [s.key, s]));
  const seen = new Set();
  const walk = (k) => { for (const a of by.get(k)?.after || []) if (!seen.has(a)) { seen.add(a); walk(a); } };
  walk(key);
  return seen;
}

export function downstreamOf(stages, key) {
  const seen = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of stages) {
      if (seen.has(s.key)) continue;
      if (s.after.some((a) => a === key || seen.has(a))) { seen.add(s.key); grew = true; }
    }
  }
  return seen;
}

// Pending stages whose dependencies are all done: the ones the engine should start now.
export function readyStages(run) {
  if (run.status !== 'running') return [];
  return run.flow.stages.filter((s) => {
    const st = run.stages[s.key];
    return st && st.status === 'pending' && s.after.every((a) => run.stages[a]?.status === 'done');
  });
}

// What a stage's report does to the run. `verdict` is only meaningful for the decider (and
// `escalate` for anyone). Returns { status, iteration, reset: [keys], note } without mutating.
export function verdictOutcome(run, stageKey, verdict) {
  const stage = run.flow.stages.find((s) => s.key === stageKey);
  if (verdict === 'escalate') return { status: 'needs-you', note: `${stage?.name || stageKey} escalated to you` };
  if (!stage?.decider) return null;
  if (verdict === 'loop') {
    if (run.iteration >= run.flow.maxLoops + 1) {
      return { status: 'needs-you', note: `the decider asked for another pass but the loop cap (${run.flow.maxLoops}) is reached` };
    }
    return { status: 'running', iteration: run.iteration + 1, reset: loopResetKeys(run.flow, stage.loopTo), note: `iteration ${run.iteration + 1}: back to ${stage.loopTo}` };
  }
  return { status: 'done', note: 'the decider closed the run' };
}

export function loopResetKeys(flow, loopTo) {
  return [loopTo, ...downstreamOf(flow.stages, loopTo)];
}

// Whole-run status as a badge: [label, tone].
export function runBadge(run) {
  if (run.status === 'done') return ['done', 'success'];
  if (run.status === 'stopped') return ['stopped', 'muted'];
  if (run.status === 'failed') return ['failed', 'danger'];
  if (run.status === 'needs-you') return ['needs you', 'danger'];
  const stuck = Object.values(run.stages).some((s) => s.status === 'stalled' || s.status === 'lost' || s.waiting);
  return stuck ? ['needs you', 'danger'] : ['running', 'warn'];
}

const REPORT_INSTRUCTIONS = (stage) => stage.decider
  ? 'When you have decided, call the hooked MCP tool `flow_report` with `verdict` (`done`, `loop` or `escalate`) and a '
    + '`summary`: for `loop`, the precise instructions for the next pass; for `done`, a summary for the user. '
    + 'Keep it short: a list of what must change, no restating of the task or the reports. Then end your turn.'
  : 'When your part is finished, call the hooked MCP tool `flow_report` with a `summary` written for the next stages '
    + '(what you did or found, what they need to know). Every later stage reads it, so keep it dense: facts, decisions '
    + 'and file paths, roughly 300 words at most, no restating of the task or of earlier reports. Then end your turn. '
    + 'Use `verdict: "escalate"` only if you '
    + 'are blocked on a decision that belongs to the user.';

// Reports of the stages upstream of `stage`. `only` narrows them to the stages re-run in this pass:
// a looped session already holds the others in its context (and its prompt cache), resending them
// would only pay for the same tokens twice.
function inputsBlock(run, stage, only = null) {
  const keys = [...upstreamOf(run.flow.stages, stage.key)].filter((k) => !only || only.includes(k));
  const order = run.flow.stages.map((s) => s.key).filter((k) => keys.includes(k));
  const parts = order
    .map((k) => {
      const st = run.stages[k];
      const s = run.flow.stages.find((x) => x.key === k);
      return st?.report?.summary ? `### ${s.name} (${k})\n${st.report.summary}` : null;
    })
    .filter(Boolean);
  return parts.length ? 'Reports from the previous stages:\n\n' + parts.join('\n\n') : '';
}

// The first message of a stage session.
export function stagePrompt(run, stage) {
  const others = run.flow.stages.filter((s) => s.key !== stage.key).map((s) => `${s.name} (${s.key})`).join(', ');
  const lines = [
    `You are the **${stage.name}** stage of the hooked flow "${run.name}". Each stage is a separate Claude Code `
      + `session; hooked chains them and hands your report to the next ones. Other stages: ${others || 'none'}.`,
    `Workspace: ${run.cwd}${run.worktree ? ' (a git worktree created for this flow)' : ''}, shared by every stage.`
      + (stage.writes ? '' : ' You are not the writer stage: do not modify tracked files.'),
    `## Your role\n${stage.role}`,
    `## Task\n${run.task}`,
  ];
  const inputs = inputsBlock(run, stage);
  if (inputs) lines.push(inputs);
  lines.push(`## Reporting\n${REPORT_INSTRUCTIONS(stage)}`);
  return lines.join('\n\n');
}

// The message a stage session gets when a loop brings the run back to it.
export function stageLoopPrompt(run, stage) {
  const lines = [
    `Iteration ${run.iteration} of the flow "${run.name}" (at most ${run.flow.maxLoops + 1}). The decider sent the work back.`,
  ];
  if (run.loopNote?.summary) lines.push(`Instructions for this pass (from ${run.loopNote.from}):\n\n${run.loopNote.summary}`);
  const inputs = inputsBlock(run, stage, Array.isArray(run.rerun) ? run.rerun : null);
  if (inputs) lines.push(inputs.replace('Reports from the previous stages', 'New reports from this pass'));
  lines.push(`Do your part again as the **${stage.name}** stage, on the current state of the workspace. You already have `
    + 'the task and the earlier reports in this conversation: focus on what changed since your last pass, do not '
    + 'redo work that still holds.');
  lines.push(REPORT_INSTRUCTIONS(stage));
  return lines.join('\n\n');
}

export const NUDGE_PROMPT = 'Your turn ended without calling the hooked MCP tool `flow_report`, so the flow is waiting on you. '
  + 'If your part is finished, call `flow_report` now. If you need the user, ask with AskUserQuestion.';
