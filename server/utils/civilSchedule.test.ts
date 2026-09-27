import { expect, test } from 'bun:test';
import { nextCivilDaily } from './civilSchedule';

test('07:00 Los Angeles remains a local wall time across both DST changes', () => {
  const zone = 'America/Los_Angeles';
  expect(nextCivilDaily(Date.parse('2026-03-07T00:00:00Z'), zone, '07:00')).toBe('2026-03-07T15:00:00.000Z');
  expect(nextCivilDaily(Date.parse('2026-03-08T00:00:00Z'), zone, '07:00')).toBe('2026-03-08T14:00:00.000Z');
  expect(nextCivilDaily(Date.parse('2026-11-01T00:00:00Z'), zone, '07:00')).toBe('2026-11-01T15:00:00.000Z');
});

test('nonexistent local times skip the day and ambiguous local times run once', () => {
  const zone = 'America/Los_Angeles';
  expect(nextCivilDaily(Date.parse('2026-03-08T00:00:00Z'), zone, '02:30')).toBe('2026-03-09T09:30:00.000Z');
  expect(nextCivilDaily(Date.parse('2026-11-01T00:00:00Z'), zone, '01:30')).toBe('2026-11-01T08:30:00.000Z');
  expect(nextCivilDaily(Date.parse('2026-11-01T09:00:00Z'), zone, '01:30')).toBe('2026-11-02T09:30:00.000Z');
});

test('invalid zone and local clock inputs fail before persistence', () => {
  expect(() => nextCivilDaily(Date.now(), 'not-a-zone', '07:00')).toThrow();
  expect(() => nextCivilDaily(Date.now(), 'America/Los_Angeles', '25:00')).toThrow();
});
