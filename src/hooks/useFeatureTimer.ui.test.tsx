import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useFeatureTimer } from './useFeatureTimer';

const trackMock = vi.fn();

vi.mock('../utils/telemetry', () => ({
  trackFeatureDuration: (...args: unknown[]) => trackMock(...args),
}));

function Harness({ feature, extra, minDurationMs }: { feature: string; extra?: Record<string, unknown>; minDurationMs?: number }) {
  useFeatureTimer(feature, { extra, minDurationMs });
  return <div />;
}

describe('useFeatureTimer', () => {
  test('emits feature_duration on unmount with accumulated duration', async () => {
    trackMock.mockClear();
    const view = render(<Harness feature="voice_mode" extra={{ backend: 'moonshine' }} minDurationMs={0} />);
    await new Promise((r) => setTimeout(r, 20));
    view.unmount();

    expect(trackMock).toHaveBeenCalledTimes(1);
    const [arg] = trackMock.mock.calls[0] as [{ feature: string; durationMs: number; extra?: Record<string, unknown> }];
    expect(arg.feature).toBe('voice_mode');
    expect(arg.durationMs).toBeGreaterThanOrEqual(15);
    expect(arg.extra).toEqual({ backend: 'moonshine' });
  });

  test('drops spans shorter than minDurationMs', () => {
    trackMock.mockClear();
    const view = render(<Harness feature="fast_hover" minDurationMs={10_000} />);
    view.unmount();
    expect(trackMock).not.toHaveBeenCalled();
  });
});
