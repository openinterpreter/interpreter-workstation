import { describe, expect, test } from 'bun:test';

import { WINDOWS_APP_USER_MODEL_ID } from './windowsAppConfig';

describe('windowsAppConfig', () => {
  test('uses the packaged Windows app user model id', () => {
    expect(WINDOWS_APP_USER_MODEL_ID).toBe('Microsoft.Interpreter');
  });
});
