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

  test('does not let agents grant native MCP read approval', async () => {
    for (const path of ['nativeMcpReadGrants', 'nativeMcpReadGrants.0.toolName',
      'nativeMcpReadGrants[0].toolName', 'nativeCuaDiscoveryGrants',
      'nativeCuaDiscoveryGrants.0.threadId', 'nativeCuaDiscoveryGrants[0].toolName', 'headlessToolApprovalMode',
      'headlessToolApprovalMode[0]']) {
      const result = await settingsSetTool.handler({ path, value: 'sites.list_sites' });
      expect(result.isError).toBe(true);
    }
  });
});
