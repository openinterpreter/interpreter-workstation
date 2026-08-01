import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  buildSuggestionChipMessageSource,
  describeVoiceError,
  getEffectiveComposerWorkspacePath,
  getPendingInputValidationError,
  isLikelyMicrophonePermissionError,
  normalizeWindowVoiceSelectedText,
  primeMicrophonePermission,
  resolveComposerMessageSource,
  getVoiceSendBehavior,
  shouldHandleManualTtsPlayRequest,
  shouldAdoptWindowWorkspaceForIdleComposer,
  shouldCancelCurrentTurnForVoiceBargeIn,
} from './ComposerArea.helpers';

describe('ComposerArea workspace helpers', () => {
  test('normalizes selected window text for overlay voice attachments', () => {
    assert.equal(normalizeWindowVoiceSelectedText('  use this paragraph  '), 'use this paragraph');
    assert.equal(normalizeWindowVoiceSelectedText('   '), null);
    assert.equal(normalizeWindowVoiceSelectedText(null), null);
  });

  test('adopts the window workspace only for untouched idle agent tabs', () => {
    assert.equal(shouldAdoptWindowWorkspaceForIdleComposer({
      isTerminal: false,
      onWorkspacePathChange: () => {},
      messageCount: 0,
      windowWorkspacePath: '/window/workspace',
      workspacePath: undefined,
    }), true);
  });

  test('preserves a manual workspace selection before the first send', () => {
    assert.equal(shouldAdoptWindowWorkspaceForIdleComposer({
      isTerminal: false,
      onWorkspacePathChange: () => {},
      messageCount: 0,
      windowWorkspacePath: '/window/workspace',
      workspacePath: '/manual/workspace',
    }), false);

    assert.equal(getEffectiveComposerWorkspacePath({
      windowWorkspacePath: '/window/workspace',
      workspacePath: '/manual/workspace',
    }), '/manual/workspace');
  });

  test('falls back to the window workspace when no per-agent workspace exists', () => {
    assert.equal(getEffectiveComposerWorkspacePath({
      windowWorkspacePath: '/window/workspace',
      workspacePath: undefined,
    }), '/window/workspace');
  });

  test('handles manual TTS install requests only for the owning agent composer', () => {
    assert.equal(shouldHandleManualTtsPlayRequest({
      composerAgentId: 'agent-editor',
      request: {
        agentId: 'agent-editor',
        messageId: 'msg-1',
        sentences: ['Hello there'],
        modelId: 'kokoro',
      },
    }), true);

    assert.equal(shouldHandleManualTtsPlayRequest({
      composerAgentId: 'agent-editor',
      request: {
        agentId: 'agent-sidebar',
        messageId: 'msg-1',
        sentences: ['Hello there'],
        modelId: 'kokoro',
      },
    }), false);

    assert.equal(shouldHandleManualTtsPlayRequest({
      composerAgentId: undefined,
      request: {
        agentId: 'agent-editor',
        messageId: 'msg-1',
        sentences: ['Hello there'],
        modelId: 'kokoro',
      },
    }), false);
  });

  test('rejects pending sends with overlay image attachments', () => {
    assert.equal(getPendingInputValidationError({
      text: '[image: screenshot.png]',
      attachments: [{
        id: 'att-1',
        kind: 'image',
        name: 'screenshot.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,abc123',
      }],
    }), 'This send path does not support raw image inputs. In the desktop composer, pasted or dropped images become file references. Overlay image inputs can only be sent through the attached overlay agent path.');

    assert.equal(getPendingInputValidationError({
      text: 'plain text only',
      attachments: [],
    }), null);
  });

  test('builds suggestion-chip message sources for telemetry', () => {
    assert.deepEqual(
      buildSuggestionChipMessageSource({
        id: 'settings-explain',
        label: 'Explain my settings',
        prompt: 'Explain what my current settings do.',
      }),
      {
        type: 'suggestion_chip',
        chipId: 'settings-explain',
        chipTitle: 'Explain my settings',
        chipContent: 'Explain what my current settings do.',
      },
    );
  });

  test('keeps pending chip metadata only when the chip content is still in the send text', () => {
    const pendingSource = buildSuggestionChipMessageSource({
      id: 'settings-explain',
      label: 'Explain my settings',
      prompt: 'Explain what my current settings do.',
    });

    assert.deepEqual(
      resolveComposerMessageSource({
        submission: {
          text: 'Explain what my current settings do.\n\nFocus on privacy too.',
          attachments: [],
        },
        pendingSource,
      }),
      pendingSource,
    );

    assert.equal(
      resolveComposerMessageSource({
        submission: {
          text: 'Ignore the earlier prompt and summarize the workspace instead.',
          attachments: [],
        },
        pendingSource,
      }),
      null,
    );
  });

  test('keeps conversational voice in the interrupt path but steers other modes mid-turn', () => {
    assert.equal(getVoiceSendBehavior({
      isStreaming: false,
      voiceMode: 'conversational',
    }), 'default-send');

    assert.equal(getVoiceSendBehavior({
      isStreaming: true,
      voiceMode: 'conversational',
    }), 'interrupt');

    assert.equal(getVoiceSendBehavior({
      isStreaming: true,
      voiceMode: 'push-to-talk',
    }), 'steer');

    assert.equal(getVoiceSendBehavior({
      isStreaming: true,
      voiceMode: 'ambient',
    }), 'steer');
  });

  test('only conversational voice cancels the current turn on barge-in', () => {
    assert.equal(shouldCancelCurrentTurnForVoiceBargeIn('conversational'), true);
    assert.equal(shouldCancelCurrentTurnForVoiceBargeIn('push-to-talk'), false);
    assert.equal(shouldCancelCurrentTurnForVoiceBargeIn('ambient'), false);
  });

  test('describeVoiceError prefers concrete messages and falls back safely', () => {
    assert.equal(describeVoiceError(new Error('permission denied'), 'fallback'), 'permission denied');
    assert.equal(describeVoiceError(' raw error ', 'fallback'), 'raw error');
    assert.equal(describeVoiceError({ code: 'NotAllowedError' }, 'fallback'), '{"code":"NotAllowedError"}');
    assert.equal(describeVoiceError(undefined, 'fallback'), 'fallback');
  });

  test('detects likely microphone permission errors', () => {
    assert.equal(isLikelyMicrophonePermissionError('Permission to the requested resource was denied.'), true);
    assert.equal(isLikelyMicrophonePermissionError(new Error('NotAllowedError: Permission denied')), true);
    assert.equal(isLikelyMicrophonePermissionError('Model file missing'), false);
  });

  test('primes microphone permission and stops probe tracks', async () => {
    const stopCalls: string[] = [];
    const constraintsSeen: MediaStreamConstraints[] = [];

    await primeMicrophonePermission(async (constraints) => {
      constraintsSeen.push(constraints);
      return {
        getTracks: () => [
          { stop: () => stopCalls.push('a') },
          { stop: () => stopCalls.push('b') },
        ],
      } as unknown as MediaStream;
    }, {
      audio: {
        channelCount: 1,
      },
    });

    assert.equal(constraintsSeen.length, 1);
    assert.deepEqual(stopCalls, ['a', 'b']);
  });
});
