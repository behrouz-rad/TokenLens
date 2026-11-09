import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';

/** Clipboard write for an explicit click, confirmed or reported as failed with a toast that never contains the copied text. */
export async function copyWithFeedback(text: string, successMessage: string): Promise<void> {
  const ok = await copyToClipboard(text);
  if (ok) toast.success(successMessage);
  else toast.error('Clipboard is unavailable in this context. Select the text and copy it manually.');
}
