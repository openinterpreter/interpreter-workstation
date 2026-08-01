import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ONBOARDING_TOUR_VIDEO_URLS,
  disposeOnboardingTourVideos,
  preloadOnboardingTourVideos,
} from './tourVideos';

type FetchCall = [url: string, init: RequestInit];

describe('onboarding tour video preload lifecycle', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    disposeOnboardingTourVideos();
    vi.restoreAllMocks();
  });

  test('fetches each video URL exactly once per lifecycle', () => {
    preloadOnboardingTourVideos();
    preloadOnboardingTourVideos();

    const calls = fetchSpy.mock.calls as FetchCall[];
    expect(calls).toHaveLength(ONBOARDING_TOUR_VIDEO_URLS.length);

    expect(calls.map(([url]) => url)).toEqual(ONBOARDING_TOUR_VIDEO_URLS);

    for (const [, init] of calls) {
      expect(init.mode).toBe('no-cors');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal!.aborted).toBe(false);
    }
  });

  test('dispose aborts in-flight fetches and allows a fresh cycle', () => {
    preloadOnboardingTourVideos();

    const firstSignals = (fetchSpy.mock.calls as FetchCall[]).map(([, init]) => init.signal!);

    disposeOnboardingTourVideos();

    expect(firstSignals.every((s) => s.aborted)).toBe(true);

    fetchSpy.mockClear();
    preloadOnboardingTourVideos();

    const secondCalls = fetchSpy.mock.calls as FetchCall[];
    expect(secondCalls).toHaveLength(ONBOARDING_TOUR_VIDEO_URLS.length);
    expect(secondCalls.every(([, init]) => !init.signal!.aborted)).toBe(true);
  });
});
