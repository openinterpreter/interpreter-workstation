import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  extractAmbientCommandText,
  resolveAmbientCommandFinalText,
  resolveAmbientDetectorFinishRequest,
  resolveAmbientEndPhrase,
  resolveAmbientTranscriptGate,
} from './ambientVoice';
import { buildTolerantPhrasePattern, buildTolerantPhraseSetPattern } from './voiceTranscript';

describe('resolveAmbientEndPhrase', () => {
  const endPattern = buildTolerantPhrasePattern('make it so');

  test('requests an immediate send when the end phrase is present and no send is active', () => {
    assert.deepEqual(
      resolveAmbientEndPhrase('turn on the lights make it so', endPattern, false),
      {
        type: 'send',
        matchedPhrase: 'make it so',
        finalText: 'turn on the lights',
      },
    );
  });

  test('defers the send when the end phrase arrives during another send', () => {
    assert.deepEqual(
      resolveAmbientEndPhrase('open the pod bay doors make it so', endPattern, true),
      {
        type: 'defer',
        matchedPhrase: 'make it so',
        finalText: 'open the pod bay doors',
      },
    );
  });

  test('resets without sending when only the end phrase was spoken', () => {
    assert.deepEqual(
      resolveAmbientEndPhrase('make it so', endPattern, false),
      {
        type: 'reset-empty',
        matchedPhrase: 'make it so',
      },
    );
  });

  test('ignores transcripts without the end phrase', () => {
    assert.deepEqual(
      resolveAmbientEndPhrase('open the pod bay doors', endPattern, false),
      { type: 'none' },
    );
  });
});

describe('extractAmbientCommandText', () => {
  const triggerPattern = buildTolerantPhrasePattern('Interpreter');

  test('drops chatter before the wake word and punctuation after it', () => {
    assert.equal(
      extractAmbientCommandText('I was just thinking... Interpreter, turn on the lights', triggerPattern),
      'turn on the lights',
    );
  });

  test('falls back to the normalized transcript when qwen omits the wake word', () => {
    assert.equal(
      extractAmbientCommandText('  turn on   the lights  ', triggerPattern),
      'turn on the lights',
    );
  });
});

describe('resolveAmbientTranscriptGate', () => {
  const triggerPattern = buildTolerantPhraseSetPattern(['Interpreter', 'Repertor']);
  const endPattern = buildTolerantPhraseSetPattern(['make it so', 'take it so']);

  test('ignores transcript updates before the wake word while waiting', () => {
    assert.deepEqual(
      resolveAmbientTranscriptGate(
        'can you hear me',
        'waiting',
        triggerPattern,
        endPattern,
        false,
      ),
      {
        triggerDetected: false,
        commandText: '',
        endAction: { type: 'none' },
      },
    );
  });

  test('starts command text only after the wake word while waiting', () => {
    assert.deepEqual(
      resolveAmbientTranscriptGate(
        'Interpreter, turn on the lights',
        'waiting',
        triggerPattern,
        endPattern,
        false,
      ),
      {
        triggerDetected: true,
        commandText: 'turn on the lights',
        endAction: { type: 'none' },
      },
    );
  });

  test('accepts a configured alias when moonshine mis-transcribes the wake phrase', () => {
    assert.deepEqual(
      resolveAmbientTranscriptGate(
        'Repertor, turn on the lights',
        'waiting',
        triggerPattern,
        endPattern,
        false,
      ),
      {
        triggerDetected: true,
        commandText: 'turn on the lights',
        endAction: { type: 'none' },
      },
    );
  });

  test('sends immediately when wake word and end phrase arrive in one transcript', () => {
    assert.deepEqual(
      resolveAmbientTranscriptGate(
        'Interpreter turn on the lights make it so',
        'waiting',
        triggerPattern,
        endPattern,
        false,
      ),
      {
        triggerDetected: true,
        commandText: 'turn on the lights make it so',
        endAction: {
          type: 'send',
          matchedPhrase: 'make it so',
          finalText: 'turn on the lights',
        },
      },
    );
  });

  test('keeps accumulating command text without requiring the wake word again', () => {
    assert.deepEqual(
      resolveAmbientTranscriptGate(
        'turn on the lights in the living room',
        'accumulating',
        triggerPattern,
        endPattern,
        false,
      ),
      {
        triggerDetected: false,
        commandText: 'turn on the lights in the living room',
        endAction: { type: 'none' },
      },
    );
  });
});

describe('resolveAmbientCommandFinalText', () => {
  const triggerPattern = buildTolerantPhrasePattern('Interpreter');
  const endPattern = buildTolerantPhrasePattern('make it so');

  test('prefers qwen final text over the native preview when qwen has the command transcript', () => {
    assert.deepEqual(
      resolveAmbientCommandFinalText(
        'Interpreter what is the weather today make it so',
        'what is the wether today',
        triggerPattern,
        endPattern,
      ),
      {
        finalText: 'what is the weather today',
        source: 'qwen',
      },
    );
  });

  test('falls back to the native preview when qwen final text is unavailable', () => {
    assert.deepEqual(
      resolveAmbientCommandFinalText(
        '',
        'what is the weather today',
        triggerPattern,
        endPattern,
      ),
      {
        finalText: 'what is the weather today',
        source: 'native-detector',
      },
    );
  });
});

describe('resolveAmbientDetectorFinishRequest', () => {
  const triggerPattern = buildTolerantPhrasePattern('Interpreter');
  const endPattern = buildTolerantPhrasePattern('make it so');

  test('keeps the last qwen preview when the native detector retracts to only the end phrase', () => {
    assert.deepEqual(
      resolveAmbientDetectorFinishRequest(
        'Make it so',
        triggerPattern,
        endPattern,
        'can you see the note that I have open',
      ),
      {
        matchedPhrase: 'Make it so',
        previewText: 'can you see the note that I have open',
      },
    );
  });

  test('uses the detector command text when the command is still present', () => {
    assert.deepEqual(
      resolveAmbientDetectorFinishRequest(
        'Interpreter, can you see what browser tabs I have given you control over make it so',
        triggerPattern,
        endPattern,
        'stale qwen preview',
      ),
      {
        matchedPhrase: 'make it so',
        previewText: 'can you see what browser tabs I have given you control over',
      },
    );
  });

  test('returns an empty preview when only the end phrase was spoken', () => {
    assert.deepEqual(
      resolveAmbientDetectorFinishRequest(
        'Make it so',
        triggerPattern,
        endPattern,
        '',
      ),
      {
        matchedPhrase: 'Make it so',
        previewText: '',
      },
    );
  });

  test('ignores detector transcripts without the end phrase', () => {
    assert.equal(
      resolveAmbientDetectorFinishRequest(
        'Interpreter can you see the note that I have open',
        triggerPattern,
        endPattern,
        'can you see the note that I have open',
      ),
      null,
    );
  });
});
