import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetTelemetryContextForTests,
  getEnrichment,
  getScreenIndex,
  noteUserAction,
  setActiveProfile,
  setCurrentScreen,
} from './telemetryContext';

describe('telemetryContext', () => {
  beforeEach(() => {
    __resetTelemetryContextForTests();
  });

  test('setCurrentScreen returns previous screen + duration and advances index', async () => {
    const first = setCurrentScreen('home');
    expect(first.previousScreen).toBeNull();

    await new Promise((r) => setTimeout(r, 10));
    const second = setCurrentScreen('settings.models');
    expect(second.previousScreen).toBe('home');
    expect(second.previousDurationMs).toBeGreaterThan(0);
    expect(getScreenIndex()).toBe(2);
  });

  test('setting the same screen twice is a no-op for the index', () => {
    setCurrentScreen('home');
    const index = getScreenIndex();
    const again = setCurrentScreen('home');
    expect(again.previousDurationMs).toBe(0);
    expect(getScreenIndex()).toBe(index);
  });

  test('getEnrichment reflects currentScreen, profile, and last user action', async () => {
    setCurrentScreen('home');
    setActiveProfile({ profileId: 'p1', model: 'm1', provider: 'hosted' });
    noteUserAction('message_sent');
    await new Promise((r) => setTimeout(r, 5));

    const enriched = getEnrichment();
    expect(enriched.currentScreen).toBe('home');
    expect(enriched.activeProfileId).toBe('p1');
    expect(enriched.activeModel).toBe('m1');
    expect(enriched.activeProvider).toBe('hosted');
    expect(enriched.lastUserActionEvent).toBe('message_sent');
    expect(enriched.lastUserActionMsAgo).toBeGreaterThanOrEqual(0);
    expect(enriched.sessionDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('partial profile updates preserve existing fields', () => {
    setActiveProfile({ profileId: 'p1', model: 'm1', provider: 'hosted' });
    setActiveProfile({ model: 'm2' });
    const enriched = getEnrichment();
    expect(enriched.activeProfileId).toBe('p1');
    expect(enriched.activeModel).toBe('m2');
    expect(enriched.activeProvider).toBe('hosted');
  });
});
