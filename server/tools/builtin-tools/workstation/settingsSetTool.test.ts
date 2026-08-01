import { describe, expect, test } from 'bun:test';
import { settingsSetTool } from './settingsSetTool';

describe('settingsSetTool', () => {
  test('does not let agents change native Computer Use access policy', async () => {
    const result = await settingsSetTool.handler({
      path: 'cuaAccessPolicy.permissions.control.mode',
      value: 'all',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'The cuaAccessPolicy setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > Permissions.',
    }]);
  });
});

