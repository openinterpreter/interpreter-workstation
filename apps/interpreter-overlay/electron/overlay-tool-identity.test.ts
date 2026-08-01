import { describe, expect, test } from 'bun:test';

import {
  buildOverlayBuiltinToolIdentity,
  buildOverlayToolManagerIdentity,
  buildOverlayToolSessionIdentity,
} from './overlay-tool-identity';

describe('overlay tool identity', () => {
  test('builds typed direct-command identity for the app tool boundary', () => {
    const modelConfig = {
      provider: 'hosted',
      modelId: 'interpreter-fast',
      profileId: 'interpreter-fast',
    };

    expect(buildOverlayToolManagerIdentity({
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'interpreter-fast',
      modelConfig,
    })).toEqual({
      callerTabId: 'overlay-agent-1',
      workspace: '/workspace',
      profileId: 'interpreter-fast',
      modelConfig,
    });
  });

  test('omits optional typed direct-command identity fields when absent', () => {
    expect(buildOverlayToolManagerIdentity({
      agentId: 'overlay-agent-1',
      workspacePath: null,
      profileId: null,
    })).toEqual({
      callerTabId: 'overlay-agent-1',
    });
  });

  test('marks only reviewed overlay actions when requested', () => {
    expect(buildOverlayToolManagerIdentity({
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: null,
      overlayReviewedAction: true,
    })).toEqual({
      callerTabId: 'overlay-agent-1',
      workspace: '/workspace',
      overlayReviewedAction: true,
    });
  });

  test('builds advanced voice builtin-tool identity from the same overlay agent id', () => {
    const modelConfig = {
      provider: 'hosted',
      modelId: 'interpreter-fast',
      profileId: 'interpreter',
    };

    expect(buildOverlayBuiltinToolIdentity({
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      modelConfig,
    })).toEqual({
      agentId: 'overlay-agent-1',
      workspace: '/workspace',
      modelConfig,
    });
  });

  test('builds advanced voice overlay-session identity with caller token and window scope', () => {
    expect(buildOverlayToolSessionIdentity({
      agentId: 'overlay-agent-1',
      callerToken: 'caller-token-1',
      workspacePath: '/workspace',
      windowSessionKey: 'window-1',
    })).toEqual({
      agentId: 'overlay-agent-1',
      callerToken: 'caller-token-1',
      workspacePath: '/workspace',
      windowSessionKey: 'window-1',
    });
  });
});
