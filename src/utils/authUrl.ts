import { openExternal } from '../ipc';
import { copyTextToClipboard } from './clipboard';

export const AUTH_URL_COPIED_MESSAGE =
  'Could not open your browser automatically. The sign-in link was copied to your clipboard. Paste it into a browser to continue.';

export const AUTH_URL_OPEN_FAILED_MESSAGE =
  'Could not open your browser automatically. Set a default browser and try again.';

export type OpenAuthUrlResult =
  | { status: 'opened' }
  | { status: 'copied'; openError: unknown }
  | { status: 'failed'; openError: unknown; copyError: unknown };

interface OpenAuthUrlDependencies {
  openExternal?: (url: string) => Promise<void>;
  copyTextToClipboard?: typeof copyTextToClipboard;
}

export async function openAuthUrl(
  url: string,
  dependencies: OpenAuthUrlDependencies = {},
): Promise<OpenAuthUrlResult> {
  const openExternalUrl = dependencies.openExternal ?? openExternal;
  const copyUrl = dependencies.copyTextToClipboard ?? copyTextToClipboard;

  try {
    await openExternalUrl(url);
    return { status: 'opened' };
  } catch (openError) {
    let copyError: unknown = null;
    let copied = false;

    try {
      copied = await copyUrl(url, {
        onError: (error) => {
          copyError = error;
        },
      });
    } catch (error) {
      copyError = error;
    }

    if (copied) {
      return { status: 'copied', openError };
    }

    return { status: 'failed', openError, copyError };
  }
}
