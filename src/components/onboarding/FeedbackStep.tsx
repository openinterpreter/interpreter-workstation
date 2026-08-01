/**
 * FeedbackStep Component
 *
 * Final onboarding step: Tell users about the feedback system.
 */

import { useMemo } from 'react';
import { Bug } from 'lucide-react';
import { getRuntimeSystemInfo } from '@/ipc';
import { flashFeedbackButton } from '../../utils/feedback';
import { Button } from '../ui/button';

interface FeedbackStepProps {
  onComplete: () => void;
  telemetryEnabled: boolean;
}

export function FeedbackStep({ onComplete, telemetryEnabled }: FeedbackStepProps) {
  const isWindows10Unsupported = useMemo(() => {
    const { platform, osRelease } = getRuntimeSystemInfo();
    if (platform !== 'win32') return false;

    const build = Number.parseInt(osRelease.split('.')[2] ?? '', 10);
    return !Number.isNaN(build) && build < 22000;
  }, []);

  const handleClick = () => {
    onComplete();

    // Flash the feedback button after sidebars have opened and settled
    setTimeout(() => {
      flashFeedbackButton();
    }, 3000);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full px-8 py-12">
      <div className="max-w-lg w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-normal leading-[1.1] text-foreground">
            Help Improve Interpreter Beta
          </h1>
          <p className="text-base text-muted-foreground">
            {telemetryEnabled
              ? "During the Interpreter beta, we're improving things quickly and your feedback helps us prioritize what to fix next."
              : "During the Interpreter beta, feedback is especially important because telemetry is off and we rely on your reports to improve the app."}
          </p>
          <p className="text-base text-muted-foreground">
            If you hit a bug or want to suggest something, please click Feedback.
          </p>
        </div>

        {isWindows10Unsupported && (
          <div
            className="rounded-[var(--control-radius-lg)] bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
            style={{ border: 'var(--border-width) solid oklch(from var(--destructive) l c h / 0.4)' }}
          >
            Windows 10 is currently unsupported in this beta. You can still try Interpreter, but we can&apos;t promise that everything will work reliably yet. If you run into issues, we&apos;d especially appreciate bug feedback while we improve Windows 10 support.
          </div>
        )}

        {/* Mock Feedback Button - centered with shadow */}
        <div className="flex justify-center py-4">
          <div
            className="relative rounded-[var(--control-radius-lg)]"
            style={{
              boxShadow: '0 0 80px 30px oklch(from var(--foreground) l c h / 0.12)',
            }}
          >
            <Button
              variant="ghost"
              size="element"
              className="pointer-events-none"
            >
              <Bug />
              Feedback
            </Button>
          </div>
        </div>

        {/* Description */}
        <p className="text-ui-sm text-muted-foreground text-center">
          The feedback form can include logs and screenshots, which helps us debug issues much faster.
        </p>

        {/* Start button */}
        <button
          onClick={handleClick}
          className="w-full py-2 rounded-control bg-foreground text-background text-ui-sm font-medium hover:opacity-90 transition-opacity"
        >
          Start
        </button>
      </div>
    </div>
  );
}
