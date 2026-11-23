/*
 * Engine `pi`: the pi coding agent (earendil-works), driven in RPC mode.
 *
 * pi is multi-provider by nature (Mistral, Anthropic, OpenAI, DeepSeek… whatever it is signed in
 * to), so several hooked providers can sit on this one engine: the built-in `pi` (every model) and
 * custom ones narrowed by `models` patterns ("mistral/*"), each with its own label, defaults and
 * even its own pi profile (`agentDir`). Sessions are attributed to providers by their model
 * (cf. attributeSession in providerConfig.js).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanPiSessions, buildPiConversation, piMessageText, buildPiTrace, piToolDetail, latestPiTodos,
  piSubagents, piSubSessions, piScreenshots, piContext, piToolPaths, piSetArchived,
} from '../pi.js';
import {
  piStart, piPrompt, piCancel, piCompact, piSetMode, piSetAutoApprove, piSetConfig, piKill, piFork, piOptions,
  piBinaryAvailable, piSessionsDirFor,
} from '../piAgent.js';
import { hookedPackageEnabled } from '../piHooked.js';
import { piSlashCommands } from '../piCommands.js';

const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,160}$/;
const EFFORT_RE = /^(off|minimal|low|medium|high|xhigh|max)$/;

const piEngine = {
  id: 'pi',
  label: 'Pi',
  builtin: true,
  capabilities: {
    permissions: false, questions: false, plan: false, modes: false, autoApprove: false,
    models: true, effort: true, resume: true, fork: true, forkAtMessage: true,
    worktree: true, ephemeral: false, images: false,
    todos: false, subagents: false, backgroundJobs: false, workflows: false, screenshots: false, subSessions: false,
    trace: true, search: true, trash: true, rateLimits: false, promptCache: true, commands: true, skills: true,
    mcp: true, mcpLogin: false, memory: false, plugins: false, remoteControl: false, account: false,
  },
  mcpKind: 'pi',
  skillsKind: 'pi',
  // With hooked's pi package (the default), pi sessions get hooked's permission cards, questions,
  // plan mode, mode switches and the todo list; `hookedPackage: false` takes them back off.
  capabilitiesFor(provider) {
    if (!hookedPackageEnabled(provider)) return this.capabilities;
    return { ...this.capabilities, permissions: true, questions: true, plan: true, modes: true, autoApprove: true, todos: true };
  },

  detect(provider) {
    if (piBinaryAvailable(provider)) return true;
    // No binary on PATH but a pi profile on disk (frozen launchd PATH): still worth showing.
    const dir = provider && provider.agentDir
      ? provider.agentDir.replace(/^~(?=\/|$)/, os.homedir())
      : (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
    try { return fs.existsSync(dir); } catch (_) { return false; }
  },
  available(provider) {
    return piBinaryAvailable(provider)
      ? null
      : 'pi is not available on this machine: install @earendil-works/pi-coding-agent (npm i -g), set HOOKED_PI_BIN or the provider\'s `command`, or switch the provider off in the hooked settings';
  },
  validateModel(m) { return MODEL_RE.test(String(m || '')) ? null : 'invalid model: ' + m; },
  validateEffort(e) { return EFFORT_RE.test(String(e || '')) ? null : 'unknown thinking level: ' + e; },

  // ── Store ──────────────────────────────────────────────────────────────────────────────────
  // One scan per distinct profile (sessions folder); the registry attributes each session to a
  // provider. `storeKey` lets it group the providers that read the same folder.
  storeKey(provider) { return piSessionsDirFor(provider); },
  scan(provider) { return scanPiSessions(piSessionsDirFor(provider)); },
  modelRef(s) { return s.modelRef || s.model || null; },
  conversation(s) { return buildPiConversation(s.file); },
  messageText(s, uuid) { return piMessageText(s.file, uuid); },
  trace(s) { return buildPiTrace(s.file); },
  toolDetail(s, id) { return piToolDetail(s.file, id); },
  todos(s) { return latestPiTodos(s.file); },
  subagents(s) { return piSubagents(s.file); },
  subSessions(s) { return piSubSessions(s.file); },
  screenshots(s) { return piScreenshots(s.file); },
  context(s) { return piContext(s); },
  toolPaths(s) { return piToolPaths(s.file); },
  setArchived(s, archived) { return piSetArchived(s.file, archived); },
  resumeCommand(s) { return `pi --session ${s.file || s.id}`; },

  // ── Driver ─────────────────────────────────────────────────────────────────────────────────
  driver: {
    start: piStart,
    prompt: (st, text) => piPrompt(st, text),
    cancel: piCancel,
    compact: piCompact,
    setMode: piSetMode,
    setConfig: (st, { model, effort }) => piSetConfig(st, { model, thinking: effort }),
    kill: piKill,
    fork: piFork,
    // A question card of the hooked package (or another extension's dialog), cf. piHooked.js.
    answerQuestion: (st, ask, { answers }) => ask.resolve({ behavior: 'allow', answers }),
    setAutoApprove: piSetAutoApprove,
    liveCommands: () => null,
  },
  options: (provider) => piOptions(provider),
  slashCommands: (provider, cwd) => piSlashCommands(cwd),
};

export { piEngine };
