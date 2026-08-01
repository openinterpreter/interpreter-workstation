import { Check, Loader2, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PlanChecklistState } from '../../src/hooks/use-chat';

const COMPOSER_WIDE_BREAKPOINT = 500;
const COMPLETED_STEP_VISIBLE_MS = 2000;
const COMPLETED_STEP_FADE_MS = 400;
const STATUS_SIZE = 13;

type PlanChecklistCardProps = {
  plan: PlanChecklistState;
  isRunning: boolean;
  onDismiss: () => void;
};

function StatusIcon({ status, isRunning }: {
  status: PlanChecklistState['steps'][number]['status'];
  isRunning: boolean;
}) {
  const baseStyle = {
    width: STATUS_SIZE,
    height: STATUS_SIZE,
  };
  const circleBorder = 'var(--border-width) solid color-mix(in srgb, var(--oa-text-muted, var(--foreground)) 58%, transparent)';

  if (status === 'completed') {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full"
        style={{
          ...baseStyle,
          backgroundColor: 'color-mix(in srgb, var(--oa-text-muted, var(--foreground)) 8%, transparent)',
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-text-muted, var(--foreground)) 36%, transparent)',
          color: 'var(--oa-text-muted, var(--foreground))',
        }}
      >
        <Check className="h-2 w-2" strokeWidth={2.2} />
      </span>
    );
  }

  if (status === 'inProgress') {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full"
        style={{
          ...baseStyle,
          backgroundColor: 'transparent',
          border: circleBorder,
          color: 'var(--oa-text-muted, var(--foreground))',
        }}
      >
        {isRunning ? (
          <Loader2 className="h-2 w-2 animate-spin" strokeWidth={2.15} />
        ) : null}
      </span>
    );
  }

  return (
    <span
      className="grid shrink-0 place-items-center rounded-full"
      style={{
        ...baseStyle,
        backgroundColor: 'transparent',
        border: circleBorder,
        color: 'color-mix(in srgb, var(--foreground) 42%, transparent)',
      }}
    />
  );
}

export function PlanChecklistCard({ plan, isRunning, onDismiss }: PlanChecklistCardProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLOListElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const [isWide, setIsWide] = useState(false);
  const [completedAtByStep, setCompletedAtByStep] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });

  const planStepsKey = useMemo(
    () => plan.steps.map((step, index) => `${index}:${step.step}:${step.status}`).join('|'),
    [plan.steps],
  );

  useEffect(() => {
    const currentCompletedKeys = new Set(
      plan.steps
        .map((step, index) => ({ key: `${index}:${step.step}`, status: step.status }))
        .filter((step) => step.status === 'completed')
        .map((step) => step.key),
    );
    const currentKeys = new Set(plan.steps.map((step, index) => `${index}:${step.step}`));
    const timestamp = Date.now();

    setCompletedAtByStep((previous) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const key of currentKeys) {
        if (currentCompletedKeys.has(key)) {
          next[key] = previous[key] ?? timestamp;
          changed = changed || next[key] !== previous[key];
        }
      }
      changed = changed || Object.keys(previous).some((key) => !(key in next));
      return changed ? next : previous;
    });
    setNow(timestamp);
  }, [planStepsKey, plan.steps]);

  useEffect(() => {
    if (Object.keys(completedAtByStep).length === 0) return;

    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [completedAtByStep]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      setIsWide((entries[0]?.contentRect.width ?? 0) >= COMPOSER_WIDE_BREAKPOINT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const updateScrollFade = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    setScrollFade({
      top: el.scrollTop > 2,
      bottom: el.scrollTop < maxScrollTop - 2,
    });
  }, []);

  const visibleSteps = plan.steps
    .map((item, index) => {
      const key = `${index}:${item.step}`;
      const completedAt = completedAtByStep[key];
      return { item, key, completedAt };
    })
    .filter(({ item, completedAt }) => {
      if (item.status !== 'completed') return true;
      return completedAt === undefined || now - completedAt < COMPLETED_STEP_VISIBLE_MS;
    });

  useEffect(() => {
    updateScrollFade();
    const el = scrollerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(updateScrollFade);
    observer.observe(el);
    window.requestAnimationFrame(updateScrollFade);
    return () => observer.disconnect();
  }, [updateScrollFade, visibleSteps.length, planStepsKey]);

  return (
    <div ref={wrapperRef} className="mx-auto mb-2 w-full max-w-[48rem]">
      <div style={{ padding: isWide ? '0 var(--unit-padding-medium)' : '0 0.5rem' }}>
        <section
          className="oa-composer-surface oa-interactive-surface relative overflow-hidden py-[14px] pl-[14px] pr-12"
          style={{ borderRadius: 'var(--oa-radius-22)' }}
          aria-label="Agent plan checklist"
        >
          <button
            type="button"
            className="absolute right-3 top-3 z-10 grid h-7 w-7 place-items-center rounded-full text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--foreground)]"
            style={{
              border: 'var(--border-width) solid transparent',
            }}
            aria-label="Dismiss plan checklist"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.2} />
          </button>
          <motion.div
            aria-hidden="true"
            className="oa-plan-scroll-fade oa-plan-scroll-fade-top"
            animate={{ opacity: scrollFade.top ? 1 : 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          />
          <motion.div
            aria-hidden="true"
            className="oa-plan-scroll-fade oa-plan-scroll-fade-bottom"
            animate={{ opacity: scrollFade.bottom ? 1 : 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          />
          <ol
            ref={scrollerRef}
            className="oa-plan-scroll max-h-[8.75rem] overflow-y-auto pr-1"
            onScroll={updateScrollFade}
          >
            <AnimatePresence initial={false}>
              {visibleSteps.map(({ item, key, completedAt }) => {
                const isCompleted = item.status === 'completed';
                const isActive = item.status === 'inProgress';
                const completedAge = completedAt === undefined ? 0 : now - completedAt;
                const isFadingOut = isCompleted
                  && completedAge >= COMPLETED_STEP_VISIBLE_MS - COMPLETED_STEP_FADE_MS;
                return (
                  <motion.li
                    key={key}
                    layout={!shouldReduceMotion}
                    initial={shouldReduceMotion ? false : { opacity: 0, height: 0, y: -4 }}
                    animate={{
                      opacity: isFadingOut
                        ? 0
                          : isCompleted
                            ? 0.5
                            : isActive && isRunning && !shouldReduceMotion
                              ? [0.48, 1, 0.48]
                            : 1,
                      height: 'auto',
                      y: 0,
                    }}
                    exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }}
                    transition={{
                      layout: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
                      height: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
                      opacity: isActive && isRunning && !shouldReduceMotion
                        ? { duration: 1.05, repeat: Infinity, ease: 'easeInOut' }
                        : { duration: 0.22, ease: 'easeOut' },
                      y: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                    }}
                    className="flex origin-left items-start gap-2.5 overflow-hidden py-[3px]"
                  >
                    <span className="flex h-[1.55rem] shrink-0 items-center">
                      <StatusIcon status={item.status} isRunning={isRunning} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className={`oa-plan-step-text ${
                          isCompleted
                            ? 'oa-plan-step-text-completed'
                            : isActive
                              ? 'oa-plan-step-text-active'
                              : 'oa-plan-step-text-pending'
                        }`}
                      >
                        {item.step}
                      </div>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
          {visibleSteps.length === 0 ? (
            <div
              className="flex items-center gap-2.5 text-[15px] font-normal leading-[1.7rem] text-[color:var(--oa-text-muted)]"
              style={{
                minHeight: '1.25rem',
              }}
            >
              <StatusIcon status="completed" isRunning={isRunning} />
              <span>Plan complete</span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
