/**
 * Hook that measures how long a feature/screen is "active" and emits a
 * feature_duration telemetry event on unmount.
 *
 * Pauses the timer when the tab is hidden (visibilitychange → hidden) so
 * "alt-tabbed for 30 minutes" does not get recorded as engagement.
 *
 * Usage:
 *   useFeatureTimer('voice_mode');
 *   useFeatureTimer('file_preview', { extra: { ext } });
 */

import { useEffect, useRef } from 'react';
import { trackFeatureDuration } from '../utils/telemetry';

interface Options {
  /** When false, the hook does nothing. Useful for gating on a prop. */
  enabled?: boolean;
  /** Free-form metadata added to the emitted event. */
  extra?: Record<string, unknown>;
  /** Minimum duration in ms to emit; anything shorter is dropped as noise. */
  minDurationMs?: number;
}

let spanSeq = 0;
function nextSpanId(): string {
  spanSeq += 1;
  return `${Date.now().toString(36)}-${spanSeq.toString(36)}`;
}

export function useFeatureTimer(feature: string, options: Options = {}): void {
  const { enabled = true, extra, minDurationMs = 250 } = options;

  // Keep latest values in refs so the effect stays mounted for the span
  // lifecycle while still emitting the most recent metadata on unmount.
  const featureRef = useRef(feature);
  const extraRef = useRef(extra);
  const minRef = useRef(minDurationMs);

  useEffect(() => {
    featureRef.current = feature;
  }, [feature]);
  useEffect(() => {
    extraRef.current = extra;
  }, [extra]);
  useEffect(() => {
    minRef.current = minDurationMs;
  }, [minDurationMs]);

  useEffect(() => {
    if (!enabled) return;

    const spanId = nextSpanId();
    let accumulatedMs = 0;
    let lastResumeAt: number | null = typeof document === 'undefined' || !document.hidden ? Date.now() : null;

    const pause = () => {
      if (lastResumeAt !== null) {
        accumulatedMs += Date.now() - lastResumeAt;
        lastResumeAt = null;
      }
    };
    const resume = () => {
      if (lastResumeAt === null) {
        lastResumeAt = Date.now();
      }
    };

    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        pause();
      } else {
        resume();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      pause();
      if (accumulatedMs >= minRef.current) {
        trackFeatureDuration({
          feature: featureRef.current,
          durationMs: accumulatedMs,
          spanId,
          extra: extraRef.current,
        });
      }
    };
    // Intentionally single-shot — changing `enabled` true→false emits and ends
    // the span; changing false→true starts a fresh one.
  }, [enabled]);
}
