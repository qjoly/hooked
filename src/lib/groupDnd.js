// Drag-and-drop of sessions into groups (sidebar rows, fleet cards, group tabs). Two Svelte
// actions sharing one private MIME type: `use:dragSession={id}` on anything that represents a
// session, `use:dropSession={targetId}` on anything a session can be dropped onto — the dragged
// session then joins the target's group. While hovering, the target gets the `drop-over` class.
import { joinGroup, groupMotherOf } from './state.svelte.js';

const MIME = 'application/x-hooked-session';
let dragging = null; // id being dragged — dataTransfer is unreadable during dragover

export function dragSession(node, id) {
  let cur = id;
  node.draggable = true;
  const start = (e) => {
    dragging = cur;
    e.dataTransfer.setData(MIME, cur);
    e.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  };
  const end = () => { dragging = null; node.classList.remove('dragging'); };
  node.addEventListener('dragstart', start);
  node.addEventListener('dragend', end);
  return {
    update(next) { cur = next; },
    destroy() { node.removeEventListener('dragstart', start); node.removeEventListener('dragend', end); },
  };
}

// A drop is useful only when the dragged session isn't already in the target's group.
const accepts = (target) => !!(dragging && target && groupMotherOf(dragging) !== groupMotherOf(target));

export function dropSession(node, target) {
  let cur = target;
  let depth = 0; // dragenter/leave fire for every child element
  const over = (e) => {
    if (!accepts(cur)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const enter = (e) => { if (!accepts(cur)) return; e.preventDefault(); depth++; node.classList.add('drop-over'); };
  const leave = () => { if (depth && --depth === 0) node.classList.remove('drop-over'); };
  const drop = (e) => {
    depth = 0;
    node.classList.remove('drop-over');
    const id = e.dataTransfer.getData(MIME);
    if (!id || !accepts(cur)) return;
    e.preventDefault();
    e.stopPropagation();
    joinGroup(id, cur);
  };
  node.addEventListener('dragover', over);
  node.addEventListener('dragenter', enter);
  node.addEventListener('dragleave', leave);
  node.addEventListener('drop', drop);
  return {
    update(next) { cur = next; },
    destroy() {
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragenter', enter);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    },
  };
}
