import { describe, expect, test } from 'bun:test';
import {
  AGENT_COMPOSER_PLACEHOLDERS,
  pickAgentComposerPlaceholder,
  pickRandomComposerPlaceholder,
} from './composerPlaceholder';

describe('composerPlaceholder', () => {
  test('caches the first random placeholder chosen for an agent', () => {
    const originalRandom = Math.random;

    try {
      Math.random = () => 0;
      const firstPlaceholder = pickAgentComposerPlaceholder('agent-cache-test');

      Math.random = () => 0.99;
      const secondPlaceholder = pickAgentComposerPlaceholder('agent-cache-test');

      expect(firstPlaceholder).toBe('What are you thinking about?');
      expect(secondPlaceholder).toBe(firstPlaceholder);
    } finally {
      Math.random = originalRandom;
    }
  });

  test('only returns configured placeholder options for agent-based selection', () => {
    expect(AGENT_COMPOSER_PLACEHOLDERS).toContain(pickAgentComposerPlaceholder('agent-123'));
    expect(AGENT_COMPOSER_PLACEHOLDERS).toContain(pickAgentComposerPlaceholder('agent-456'));
  });

  test('uses a fresh random choice for each new agent', () => {
    const originalRandom = Math.random;

    try {
      Math.random = () => 0;
      const firstAgentPlaceholder = pickAgentComposerPlaceholder('agent-random-a');

      Math.random = () => 0.99;
      const secondAgentPlaceholder = pickAgentComposerPlaceholder('agent-random-b');

      expect(firstAgentPlaceholder).toBe('What are you thinking about?');
      expect(secondAgentPlaceholder).toBe('How can I help?');
    } finally {
      Math.random = originalRandom;
    }
  });

  test('only returns configured placeholder options for random selection', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(AGENT_COMPOSER_PLACEHOLDERS).toContain(pickRandomComposerPlaceholder());
    }
  });
});
