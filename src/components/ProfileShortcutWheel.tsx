import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Profile } from '../../shared/types/profile';
import { getProfileShortcutWheelState } from '../utils/profileShortcutWheel';

const ROW_HEIGHT_PX = 18;
const SCROLL_INTERVAL_MS = 3000;
const SCROLL_TRANSITION_MS = 360;
const REWIND_TRANSITION_MS = 320;
const SHORTCUT_FADE_OUT_MS = 260;

type PreviewPhase = 'idle' | 'active' | 'rewinding' | 'fading';

interface ProfileShortcutWheelProps {
  profiles: Profile[];
  selectedProfileId?: string | null;
  fallbackLabel: string;
  isCommandHeld: boolean;
  className?: string;
  onPreviewVisibilityChange?: (isVisible: boolean) => void;
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

function toCenteredIndex(index: number, count: number): number {
  return count + clampIndex(index, count);
}

export function ProfileShortcutWheel({
  profiles,
  selectedProfileId,
  fallbackLabel,
  isCommandHeld,
  className,
  onPreviewVisibilityChange,
}: ProfileShortcutWheelProps) {
  const [phase, setPhase] = useState<PreviewPhase>('idle');
  const [index, setIndex] = useState(0);
  const [isTransitionEnabled, setIsTransitionEnabled] = useState(false);
  const rewindTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  const {
    previewProfiles,
    profileCount,
    selectedIndex,
    currentSlot,
    visibleTriggerLabel,
    isShortcutOpaque,
    isShortcutLayoutVisible,
  } = useMemo(() => getProfileShortcutWheelState({
    profiles,
    selectedProfileId,
    fallbackLabel,
    index,
    phase,
  }), [fallbackLabel, index, phase, profiles, selectedProfileId]);

  const rows = useMemo(() => {
    if (profileCount === 0) return [];
    return [...previewProfiles, ...previewProfiles, ...previewProfiles].map((profile, i) => ({
      profile,
      slot: (i % profileCount) + 1,
    }));
  }, [previewProfiles, profileCount]);

  const clearTimers = useCallback(() => {
    if (rewindTimerRef.current) {
      clearTimeout(rewindTimerRef.current);
      rewindTimerRef.current = null;
    }
    if (loopResetTimerRef.current) {
      clearTimeout(loopResetTimerRef.current);
      loopResetTimerRef.current = null;
    }
    if (fadeOutTimerRef.current) {
      clearTimeout(fadeOutTimerRef.current);
      fadeOutTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  useEffect(() => {
    onPreviewVisibilityChange?.(phase !== 'idle');
  }, [onPreviewVisibilityChange, phase]);

  useEffect(() => {
    if (profileCount === 0) {
      clearTimers();
      setPhase('idle');
      return;
    }

    if (isCommandHeld) {
      clearTimers();
      setPhase('active');
      setIsTransitionEnabled(false);
      const startIndex = toCenteredIndex(selectedIndex, profileCount);
      setIndex(startIndex);
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsTransitionEnabled(true);
        });
      });
      return () => cancelAnimationFrame(frame);
    }

    // Only start release transition once when leaving active mode.
    // Do not retrigger while already rewinding/fading.
    if (phase === 'idle' || phase === 'rewinding' || phase === 'fading') return;

    clearTimers();
    setPhase('rewinding');
    setIsTransitionEnabled(true);
    setIndex(toCenteredIndex(selectedIndex, profileCount));
    rewindTimerRef.current = setTimeout(() => {
      setPhase('fading');
      setIsTransitionEnabled(false);
      setIndex(toCenteredIndex(selectedIndex, profileCount));
      rewindTimerRef.current = null;

      fadeOutTimerRef.current = setTimeout(() => {
        setPhase('idle');
        fadeOutTimerRef.current = null;
      }, SHORTCUT_FADE_OUT_MS);
    }, REWIND_TRANSITION_MS + 40);
  }, [clearTimers, isCommandHeld, phase, profileCount, selectedIndex]);

  // Keep the rendered row synced to current selection in idle mode.
  useEffect(() => {
    if (profileCount === 0) return;
    if (phase !== 'idle') return;
    setIsTransitionEnabled(false);
    setIndex(toCenteredIndex(selectedIndex, profileCount));
  }, [phase, profileCount, selectedIndex]);

  useEffect(() => {
    if (phase !== 'active' || profileCount <= 1) return;
    const interval = setInterval(() => {
      setIndex((prev) => prev + 1);
    }, SCROLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [phase, profileCount]);

  useEffect(() => {
    if (phase !== 'active' || profileCount === 0) return;
    if (index < profileCount * 2) return;

    loopResetTimerRef.current = setTimeout(() => {
      setIsTransitionEnabled(false);
      setIndex((prev) => {
        const overflow = prev - profileCount * 2;
        return toCenteredIndex(overflow, profileCount);
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsTransitionEnabled(true);
        });
      });
      loopResetTimerRef.current = null;
    }, SCROLL_TRANSITION_MS);

    return () => {
      if (loopResetTimerRef.current) {
        clearTimeout(loopResetTimerRef.current);
        loopResetTimerRef.current = null;
      }
    };
  }, [phase, index, profileCount]);

  const baseClass = `relative inline-flex min-w-0 max-w-[11rem] whitespace-nowrap text-right align-middle ${className || ''}`;
  const shortcutLabelForSlot = (slot: number) => (isMac ? `⌥⌘${slot}` : `Alt+Ctrl+${slot}`);
  if (profileCount === 0) {
    return <span className={baseClass}>{fallbackLabel}</span>;
  }

  const translateY = -(index * ROW_HEIGHT_PX);
  const transitionDuration = phase === 'rewinding' ? REWIND_TRANSITION_MS : SCROLL_TRANSITION_MS;

  return (
    <span
      className={baseClass}
      style={{
        opacity: isShortcutLayoutVisible ? 0.5 : 1,
        transition: `opacity ${SHORTCUT_FADE_OUT_MS}ms cubic-bezier(0.2, 0.72, 0.25, 1)`,
      }}
    >
      {/**
       * IMPORTANT: the resting trigger label must come from `fallbackLabel`, not from the
       * shortcut wheel rows.
       *
       * Why this exists:
       * - The wheel intentionally previews only the first 9 profiles because it mirrors the
       *   shortcut slots (`Alt+Ctrl+1..9` / `Option+Command+1..9`).
       * - The full profile list can be much longer.
       * - When the selected profile lives outside the first 9 entries, `selectedProfileId`
       *   will not be found in `previewProfiles`.
       * - If the resting label is derived from the wheel's current row, React will render the
       *   first preview item instead of the actual selected profile. That produces the exact bug
       *   we hit here: the checkmark and real model switch are correct, but the closed trigger
       *   text looks stuck on an unrelated early item such as "Interpreter Smart".
       *
       * In other words, there are two different concepts here and they must stay separate:
       * - `fallbackLabel`: authoritative label for the real selected profile
       * - `currentProfileLabel`: transient label for the shortcut preview animation only
       *
       * Future rule: if this component is changed, never let the non-preview / resting state read
       * its visible label from `previewProfiles`, `selectedIndex`, or the wheel row position.
       * The wheel is an animation surface for shortcut slots, not the source of truth for the
       * selected model name.
       */}
      <span
        className="absolute right-full top-1/2 inline-block text-ui-sm leading-none whitespace-nowrap text-muted-foreground pointer-events-none"
        style={{
          opacity: isShortcutOpaque ? 1 : 0,
          marginRight: '0.5rem',
          transform: isShortcutLayoutVisible ? 'translate(0, -50%)' : 'translate(4px, -50%)',
          transition: 'opacity 260ms cubic-bezier(0.2, 0.72, 0.25, 1), transform 260ms cubic-bezier(0.2, 0.72, 0.25, 1)',
        }}
      >
        {shortcutLabelForSlot(currentSlot)}
      </span>
      <span className="invisible block max-w-[8rem] truncate">{visibleTriggerLabel}</span>
      <span
        className="absolute inset-0 flex items-center justify-end"
        style={{
          opacity: isShortcutLayoutVisible ? 0 : 1,
          transition: `opacity ${SHORTCUT_FADE_OUT_MS}ms cubic-bezier(0.2, 0.72, 0.25, 1)`,
        }}
      >
        <span className="block max-w-[8rem] truncate text-ui-sm leading-none text-right">{fallbackLabel}</span>
      </span>
      <span
        className="absolute inset-0"
        style={{
          height: `${ROW_HEIGHT_PX}px`,
          overflowY: 'hidden',
          overflowX: 'visible',
          opacity: isShortcutLayoutVisible ? 1 : 0,
          transition: `opacity ${SHORTCUT_FADE_OUT_MS}ms cubic-bezier(0.2, 0.72, 0.25, 1)`,
        }}
      >
        <span
          className="absolute inset-x-0 top-0"
          style={{
            transform: `translateY(${translateY}px)`,
            transition: isTransitionEnabled
              ? `transform ${transitionDuration}ms cubic-bezier(0.2, 0.72, 0.25, 1)`
              : 'none',
          }}
        >
          {rows.map(({ profile }, rowIndex) => (
            <span
              key={`${profile.id}-${rowIndex}`}
              className="flex w-full items-center justify-end text-right"
              style={{ height: `${ROW_HEIGHT_PX}px` }}
            >
              <span className="block max-w-[8rem] truncate text-ui-sm leading-none text-right">{profile.name}</span>
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
