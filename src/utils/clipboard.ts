import { writeClipboardText } from '../ipc';

export async function copyTextToClipboard(
  text: string,
  options?: {
    writeText?: (text: string) => Promise<void>;
    onError?: (error: unknown) => void;
  },
): Promise<boolean> {
  const writeText = options?.writeText ?? writeClipboardText;

  try {
    await writeText(text);
    return true;
  } catch (error) {
    if (options?.onError) {
      options.onError(error);
    } else {
      console.error('[Clipboard] Failed to copy text:', error);
    }
    return false;
  }
}
