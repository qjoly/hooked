/* Déduit l'état live d'une session à partir de son dernier évènement de hook. */

function liveStateFor(ev) {
  if (!ev) return null;
  const ageMin = (Date.now() - Date.parse(ev.ts)) / 60000;
  const msg = ev.message || '';
  switch (ev.event) {
    case 'SessionEnd': return { state: 'ended', tool: null };
    case 'Stop':
    case 'SubagentStop':
      return { state: 'waiting', tool: null };
    case 'Notification':
      if (/permission|approve|allow|autoris/i.test(msg)) return { state: 'attention', tool: null };
      return { state: 'waiting', tool: null };
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: ageMin > 5 ? 'idle' : 'working', tool: ev.tool || null };
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'PreCompact':
      return { state: ageMin > 5 ? 'idle' : 'working', tool: null };
    default:
      return { state: ageMin > 30 ? 'idle' : 'working', tool: ev.tool || null };
  }
}

export { liveStateFor };
