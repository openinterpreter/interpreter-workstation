import { describe, expect, test } from 'bun:test';
import { AUTH_URL_COPIED_MESSAGE, AUTH_URL_OPEN_FAILED_MESSAGE, openAuthUrl } from './authUrl';

describe('openAuthUrl', () => {
  const authUrl = 'https://auth.example.com/oauth';

  test('returns opened when the OS opens the auth URL', async () => {
    const opened: string[] = [];

    const result = await openAuthUrl(authUrl, {
      openExternal: async (url) => {
        opened.push(url);
      },
      copyTextToClipboard: async () => {
        throw new Error('should not copy after opening');
      },
    });

    expect(result).toEqual({ status: 'opened' });
    expect(opened).toEqual([authUrl]);
  });

  test('copies the auth URL when the OS has no browser association', async () => {
    const copied: string[] = [];

    const result = await openAuthUrl(authUrl, {
      openExternal: async () => {
        throw new Error('Failed to open: no app association');
      },
      copyTextToClipboard: async (url) => {
        copied.push(url);
        return true;
      },
    });

    expect(result.status).toBe('copied');
    expect(copied).toEqual([authUrl]);
  });

  test('returns failed when neither opening nor copying is available', async () => {
    const result = await openAuthUrl(authUrl, {
      openExternal: async () => {
        throw new Error('Failed to open: no app association');
      },
      copyTextToClipboard: async (_url, options) => {
        options?.onError?.(new Error('clipboard unavailable'));
        return false;
      },
    });

    expect(result.status).toBe('failed');
  });

  test('keeps the user-facing messages specific to browser launch failure', () => {
    expect(AUTH_URL_COPIED_MESSAGE).toContain('copied to your clipboard');
    expect(AUTH_URL_OPEN_FAILED_MESSAGE).toContain('Set a default browser');
  });
});
