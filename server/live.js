/* Déduit l'état live d'une session à partir de son dernier évènement de hook. */

function liveStateFor(ev) {
  if (!ev) return null;
  const ageMin = (Date.now() - Date.parse(ev.ts)) / 60000;
  const msg = ev.message || '';
  const busyOrIdle = ageMin > 5 ? 'idle' : 'working';
  switch (ev.event) {
    case 'SessionEnd': return { state: 'ended', tool: null };
    case 'Stop': return { state: 'waiting', tool: null };
    // Un sous-agent qui s'arrête ne veut PAS dire que l'agent principal a fini : il reprend la main
    // et continue de mouliner → surtout pas 'waiting' (bug historique).
    case 'SubagentStop': return { state: busyOrIdle, tool: null };
    case 'Notification':
      if (/permission|approve|allow|autoris/i.test(msg)) return { state: 'attention', tool: null };
      return { state: 'waiting', tool: null };
    case 'PreToolUse':
      // ExitPlanMode / AskUserQuestion : le tool_use est émis mais Claude ATTEND une action de
      // l'utilisateur (approuver le plan, répondre) et AUCUN Stop/Notification ne suit → sinon la
      // session resterait « working » puis basculerait à tort en « idle ». Action requise, sans péremption.
      if (ev.tool === 'ExitPlanMode' || ev.tool === 'AskUserQuestion') return { state: 'attention', tool: ev.tool };
      return { state: busyOrIdle, tool: ev.tool || null };
    case 'PostToolUse':
      return { state: busyOrIdle, tool: ev.tool || null };
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'PreCompact':
      return { state: busyOrIdle, tool: null };
    default:
      return { state: ageMin > 30 ? 'idle' : 'working', tool: ev.tool || null };
  }
}

export { liveStateFor };
