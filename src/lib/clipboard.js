// Copy text to the clipboard. `navigator.clipboard` needs a secure context — localhost qualifies,
// a plain-HTTP LAN address does not — hence the execCommand fallback. Resolves to whether the copy
// succeeded, so a caller only shows "copied" when it did.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}
