import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  buildTolerantPhrasePattern,
  mergeStreamingVoiceTranscript,
  normalizeVoiceText,
} from './voiceTranscript';

describe('normalizeVoiceText', () => {
  test('collapses repeated whitespace', () => {
    assert.equal(normalizeVoiceText('  make   it \n so '), 'make it so');
  });
});

describe('buildTolerantPhrasePattern', () => {
  test('matches punctuation-separated words', () => {
    const pattern = buildTolerantPhrasePattern('make it so');
    assert.equal(pattern.test('make it, so'), true);
    assert.equal(pattern.test('Make. It. So.'), true);
  });
});

describe('mergeStreamingVoiceTranscript', () => {
  test('keeps the earlier prefix when the latest fragment restates only the suffix', () => {
    assert.equal(
      mergeStreamingVoiceTranscript('Interpreter can you understand me', 'can you understand me'),
      'Interpreter can you understand me',
    );
  });

  test('retracts a stale trailing tail when the latest hypothesis is shorter', () => {
    assert.equal(
      mergeStreamingVoiceTranscript('turn on the light please', 'turn on the light'),
      'turn on the light',
    );
  });

  test('replaces a revised tail when the latest hypothesis keeps the same prefix', () => {
    assert.equal(
      mergeStreamingVoiceTranscript('turn on the light please', 'turn on the lights'),
      'turn on the lights',
    );
  });

  test('merges suffix-prefix overlap from revised qwen updates', () => {
    const merged = mergeStreamingVoiceTranscript(
      "Okay, I'm not sure how much you can",
      'not sure how much you can hear. But what if I say',
    );
    assert.equal(merged, "Okay, I'm not sure how much you can hear. But what if I say");
  });

  test('continues growing across multiple revised fragments', () => {
    const first = mergeStreamingVoiceTranscript(
      "Okay, I'm not sure how much you can hear. But what if I say",
      'what if I say something like Interpreter I want',
    );
    const second = mergeStreamingVoiceTranscript(
      first,
      'Interpreter I want you to go onto the web and say something',
    );

    assert.equal(
      second,
      "Okay, I'm not sure how much you can hear. But what if I say something like Interpreter I want you to go onto the web and say something",
    );
  });

  test('appends when there is no overlap', () => {
    assert.equal(
      mergeStreamingVoiceTranscript('Interpreter', 'make it so'),
      'Interpreter make it so',
    );
  });
});
