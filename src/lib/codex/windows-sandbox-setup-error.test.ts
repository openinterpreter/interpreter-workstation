import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  formatWindowsSandboxSetupError,
  isWindowsSandboxFirewallSetupError,
} from './windows-sandbox-setup-error';

describe('isWindowsSandboxFirewallSetupError', () => {
  test('returns true for helper firewall create/add failures', () => {
    const error =
      'helper_firewall_rule_create_or_add_failed: SetRemoteAddresses failed: Error { code: HRESULT(0x80070057), message: "The parameter is incorrect." }';

    assert.equal(isWindowsSandboxFirewallSetupError(error), true);
  });

  test('returns false for non-firewall setup failures', () => {
    const error = 'helper_user_create_or_update_failed: net user exited with code 2';

    assert.equal(isWindowsSandboxFirewallSetupError(error), false);
  });
});

describe('formatWindowsSandboxSetupError', () => {
  test('maps firewall setup failures to an actionable message', () => {
    const error =
      'helper_firewall_rule_create_or_add_failed: SetRemoteAddresses failed: Error { code: HRESULT(0x80070057), message: "The parameter is incorrect." }';

    assert.equal(
      formatWindowsSandboxSetupError(error),
      'Windows sandbox setup could not configure Windows Firewall. Check firewall policy, then retry from the Windows sandbox setup card.',
    );
  });

  test('returns a generic message when setup error is missing', () => {
    assert.equal(
      formatWindowsSandboxSetupError(null),
      'Windows sandbox setup failed. Retry from the Windows sandbox setup card.',
    );
    assert.equal(
      formatWindowsSandboxSetupError('   '),
      'Windows sandbox setup failed. Retry from the Windows sandbox setup card.',
    );
  });

  test('preserves non-firewall setup messages', () => {
    const error = 'helper_user_create_or_update_failed: net user exited with code 2';

    assert.equal(formatWindowsSandboxSetupError(error), error);
  });
});
