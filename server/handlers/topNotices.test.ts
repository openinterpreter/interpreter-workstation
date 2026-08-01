import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { clearConfigCache, loadConfig, setConfigOverride } from '../configStore';
import { dismissTopNotice, listTopNotices } from './topNotices';

describe('topNotices', () => {
  beforeEach(() => {
    setConfigOverride({
      agents: {},
    } as never);
  });

  afterEach(() => {
    clearConfigCache();
  });

  test('lists the current whats-new notice without requiring a video', async () => {
    const { notices } = await listTopNotices();

    expect(notices).toEqual([
      expect.objectContaining({
        id: 'whats-new',
        kind: 'release',
        version: '2026-06-22-main-window-start',
        youtubeVideoId: undefined,
      }),
    ]);
    expect(notices[0]?.items.map((item) => item.id)).toEqual([
      'shortcut',
      'documents',
      'desktop',
      'browser',
      'record-skill',
    ]);
  });

  test('dismisses a top notice by versioned id', async () => {
    await dismissTopNotice('whats-new');

    const config = await loadConfig();
    expect(config.dismissedTopNoticeVersions?.['whats-new']).toBe('2026-06-22-main-window-start');

    const afterDismiss = await listTopNotices();
    expect(afterDismiss.notices).toEqual([]);
  });

  test('uses translation keys that exist in the English locale', async () => {
    const locale = JSON.parse(
      readFileSync(resolve(process.cwd(), 'shared/locales/en.json'), 'utf8'),
    ) as Record<string, string>;
    const { notices } = await listTopNotices();
    const keys = notices.flatMap((notice) => [
      notice.labelKey,
      notice.dismissLabelKey,
      notice.titleKey,
      notice.subtitleKey,
      ...(notice.footerKey ? [notice.footerKey] : []),
      ...notice.items.flatMap((item) => [item.titleKey, item.bodyKey]),
      ...notice.items.flatMap((item) => (item.promptKey ? [item.promptKey] : [])),
      ...(notice.action ? [notice.action.labelKey] : []),
    ]);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(locale[key]).toEqual(expect.any(String));
      expect(locale[key]).not.toBe('');
    }
  });
});
