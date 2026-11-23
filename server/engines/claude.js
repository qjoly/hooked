/*
 * Engine `claude`: Claude Code through the Agent SDK.
 *
 * The driver itself stays in server/agent.js (`driver: null` = the built-in path): it is the
 * reference implementation every other engine mirrors, and the registry state it owns (canUseTool
 * waits, prompt-cache clock, PreModelSwitch hold…) is too intertwined with the SDK to move without
 * risk. What this module exposes is the session STORE (transcripts under ~/.claude/projects) and
 * the capabilities, so the rest of hooked dispatches on the engine instead of testing
 * `provider === 'claude'`.
 */
import { spawnSync } from 'node:child_process';
import { scanSessions } from '../transcript.js';
import { buildConversation, readMessageText } from '../conversation.js';
import { buildSubSessions } from '../subSessions.js';
import { buildSubagents } from '../subagents.js';
import { buildScreenshots } from '../screenshots.js';
import { latestTodos } from '../todos.js';
import { buildBackgroundJobs } from '../background.js';
import { buildWorkflows } from '../workflows.js';
import { buildTrace, readToolDetail } from '../trace.js';
import { memoByFile } from '../transcriptCache.js';
import { withoutBridgeShadows } from '../bridgeShadows.js';

const conversationOf = memoByFile(buildConversation);
const subSessionsOf = memoByFile(buildSubSessions);

function which(bin) {
  try { return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
}

const claudeEngine = {
  id: 'claude',
  label: 'Claude',
  builtin: true,
  // Every capability: Claude Code is the reference the dashboard was built around.
  capabilities: {
    permissions: true, questions: true, plan: true, modes: true, autoApprove: true, models: true, effort: true,
    resume: true, fork: true, forkAtMessage: true, worktree: true, ephemeral: true, images: true,
    todos: true, subagents: true, backgroundJobs: true, workflows: true, screenshots: true, subSessions: true,
    trace: true, search: true, trash: true, rateLimits: true, promptCache: true, commands: true, skills: true,
    mcp: true, mcpLogin: true, memory: true, plugins: true, remoteControl: true, account: true,
  },
  // Which flavour of the shared lenses this engine uses (MCP config, skills folders).
  mcpKind: 'claude',
  skillsKind: 'claude',

  detect(provider) {
    return which((provider && provider.command) || process.env.HOOKED_CLAUDE_BIN || 'claude');
  },
  available() { return null; },

  // ── Store ──────────────────────────────────────────────────────────────────────────────────
  // Without pi-claude-bridge's shadow transcripts: they are the model side of a pi session.
  scan() { return withoutBridgeShadows(scanSessions()); },
  conversation(s) { return conversationOf(s.file); },
  messageText(s, uuid) { return readMessageText(s.file, uuid); },
  trace(s) { return buildTrace(s.file); },
  toolDetail(s, id) { return readToolDetail(s.file, id); },
  todos(s) { return latestTodos(s.file); },
  subagents(s) { return buildSubagents(s.file); },
  subSessions(s) { return subSessionsOf(s.file, s.id); },
  screenshots(s) { return buildScreenshots(s.file, s.id); },
  backgroundJobs(s) { return buildBackgroundJobs(s.file); },
  workflows(s) { return buildWorkflows(s.file); },
  context() { return null; }, // the statusline / agent-status snapshot carries it
  resumeCommand(s) { return `claude --resume=${s.id}`; },

  driver: null,
};

export { claudeEngine };
