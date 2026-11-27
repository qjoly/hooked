// A short message at the bottom of the dashboard (session menu actions of extensions, their pages).
export const flashMessage = $state({ text: '', error: false, at: 0 });

let timer = null;
export function flash(text, error = false) {
  Object.assign(flashMessage, { text: String(text || ''), error: !!error, at: Date.now() });
  clearTimeout(timer);
  timer = setTimeout(() => { flashMessage.text = ''; }, 3500);
}
