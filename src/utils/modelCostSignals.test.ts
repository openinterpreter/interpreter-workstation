import { describe, expect, test } from 'bun:test';
import { calculatePercentRemaining, isExpensiveModelId } from './modelCostSignals';

describe('isExpensiveModelId', () => {
  test('flags Claude Opus 4.7 hosted and direct model IDs as expensive', () => {
    expect(isExpensiveModelId('anthropic/claude-opus-4.7')).toBe(true);
    expect(isExpensiveModelId('claude-opus-4.7')).toBe(true);
  });

  test('normalizes whitespace and casing before checking expensive models', () => {
    expect(isExpensiveModelId(' ANTHROPIC/CLAUDE-OPUS-4.7 ')).toBe(true);
  });

  test('does not flag non-Opus Claude models as expensive', () => {
    expect(isExpensiveModelId('anthropic/claude-sonnet-4.6')).toBe(false);
    expect(isExpensiveModelId('anthropic/claude-haiku-4.5')).toBe(false);
  });
});

describe('calculatePercentRemaining', () => {
  test('clamps invalid and out-of-range credit percentages', () => {
    expect(calculatePercentRemaining(20, 0)).toBe(0);
    expect(calculatePercentRemaining(-10, 100)).toBe(0);
    expect(calculatePercentRemaining(150, 100)).toBe(100);
  });
});
