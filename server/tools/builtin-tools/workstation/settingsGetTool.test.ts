import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearConfigCache, setConfigOverride } from '../../../configStore';
import { settingsGetTool } from './settingsGetTool';

describe('settingsGetTool', () => {
  beforeEach(() => {
    clearConfigCache();
    setConfigOverride({ agents: {} } as any);
  });

  afterEach(() => {
    clearConfigCache();
  });

  test('treats __catalog like any other unknown path', async () => {
    const result = await settingsGetTool.handler({ path: '__catalog' });

    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.type).toBe('text');

    const text = result.content?.[0]?.text;
    expect(typeof text).toBe('string');

    expect(JSON.parse(String(text))).toBeNull();
  });
});
