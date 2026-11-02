/**
 * Clipboard writes happen only from explicit user actions. The async Clipboard API can be
 * unavailable or rejected inside extension frames, so a textarea + execCommand fallback is
 * attempted before reporting failure. Returns true only when a write succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  let succeeded: boolean;
  try {
    succeeded = document.execCommand('copy');
  } catch {
    succeeded = false;
  } finally {
    textarea.remove();
  }
  return succeeded;
}
