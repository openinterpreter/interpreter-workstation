import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import type { Profile } from '../../shared/types/profile';
import {
  AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID,
  buildAutomaticClaudeCodeTerminalProfile,
  rememberDismissedAutomaticProfile,
  shouldEnsureAutomaticClaudeCodeTerminalProfile,
} from './automaticProfiles';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'custom:test-profile',
    name: 'Test Profile',
    provider: 'hosted',
    modelId: 'interpreter-smart',
    isBuiltin: false,
    ...overrides,
  };
}

describe('buildAutomaticClaudeCodeTerminalProfile', () => {
  test('builds the detected Claude Code terminal profile shape', () => {
    const profile = buildAutomaticClaudeCodeTerminalProfile();

    assert.equal(profile.id, AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID);
    assert.equal(profile.name, 'Claude Code');
    assert.equal(profile.provider, 'terminal');
    assert.equal(profile.modelId, 'claude-code');
    assert.equal(profile.isBuiltin, false);
    assert.equal(profile.providerConfig?.command, 'claude');
    assert.equal(profile.providerConfig?.hideInput, true);
    assert.equal(profile.providerConfig?.titleMarker, '⏺');
  });
});

describe('shouldEnsureAutomaticClaudeCodeTerminalProfile', () => {
  test('adds the profile when Claude Code is installed and no terminal profile exists yet', () => {
    assert.equal(
      shouldEnsureAutomaticClaudeCodeTerminalProfile(
        { profiles: [] },
        true,
      ),
      true,
    );
  });

  test('does not add the profile when the user already has a Claude Code terminal profile', () => {
    assert.equal(
      shouldEnsureAutomaticClaudeCodeTerminalProfile(
        {
          profiles: [
            makeProfile({
              provider: 'terminal',
              modelId: 'claude-code',
              providerConfig: {
                id: 'claude-code',
                command: 'claude',
              },
            }),
          ],
        },
        true,
      ),
      false,
    );
  });

  test('does not re-add the automatic profile after the user dismissed it', () => {
    assert.equal(
      shouldEnsureAutomaticClaudeCodeTerminalProfile(
        {
          profiles: [],
          dismissedAutomaticProfileIds: [AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID],
        },
        true,
      ),
      false,
    );
  });

  test('does not add the profile when Claude Code is not installed', () => {
    assert.equal(
      shouldEnsureAutomaticClaudeCodeTerminalProfile(
        { profiles: [] },
        false,
      ),
      false,
    );
  });
});

describe('rememberDismissedAutomaticProfile', () => {
  test('tracks dismissal for the auto-added Claude Code profile', () => {
    assert.deepEqual(
      rememberDismissedAutomaticProfile(AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID),
      [AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID],
    );
  });

  test('ignores non-automatic profile deletions', () => {
    assert.equal(
      rememberDismissedAutomaticProfile('custom:other-profile'),
      undefined,
    );
  });
});
