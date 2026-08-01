/**
 * FeatureCardSlide
 *
 * A single full-screen feature showcase slide. Each feature (Markdown,
 * Spreadsheets, PDF, Word) gets its own slide in the onboarding flow.
 * Shows a full-width preview area flush to the top, then title + description below.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExperimentalBadge } from '../components/ExperimentalBadge';
import { OnboardingHeading } from '../components/OnboardingScreenShell';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureCardSlideProps {
  /** Feature title (e.g. "Markdown") */
  title: string;
  /** Short description */
  description: string;
  /** Whether to show the Experimental badge */
  experimental?: boolean;
  /** Demo video URL (autoplay loop) */
  videoUrl?: string;
  /** Placeholder icon rendered in preview area when no videoUrl */
  placeholderIcon: React.ReactNode;
  /** Tailwind bg class for placeholder area */
  placeholderColor: string;
  /** Advance to next screen */
  onNext: () => void;
  /** Skip feature tour and jump to setup */
  onSkipTour?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function getOnboardingVideoName(videoUrl: string): string {
  return videoUrl.split('/').pop() || videoUrl;
}

function logOnboardingVideoLifecycle(
  event: 'mount' | 'loadedmetadata' | 'playing' | 'error' | 'teardown',
  detail: { title: string; videoUrl: string } & Partial<{
    autoPlay: boolean;
    loop: boolean;
    muted: boolean;
    preload: string;
  }>,
): void {
  console.info(`[OnboardingVideo] ${event}`, {
    ...(detail.autoPlay === undefined ? {} : { autoPlay: detail.autoPlay }),
    ...(detail.loop === undefined ? {} : { loop: detail.loop }),
    ...(detail.muted === undefined ? {} : { muted: detail.muted }),
    ...(detail.preload === undefined ? {} : { preload: detail.preload }),
    title: detail.title,
    video: getOnboardingVideoName(detail.videoUrl),
  });
}

export function FeatureCardSlide({
  title,
  description,
  experimental,
  videoUrl,
  placeholderIcon,
  placeholderColor,
  onNext: _onNext,
  onSkipTour: _onSkipTour,
}: FeatureCardSlideProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // NOTE(victor): Issue source: https://github.com/openinterpreter/iworkstation-issues/issues/1744.
  // Sentry event: https://openinterpreter.sentry.io/issues/7447890242/events/c21eb8adeaeb4237b54ec71ce4b27c4a/.
  // The renderer hit a V8 OOM while decoding https://www.openinterpreter.com/videos/demos/excel.mp4 on an 8 GB Mac.
  // The demo video must still render; bound preload and release the media source on
  // slide teardown instead of suppressing the onboarding experience.
  useEffect(() => {
    const video = videoRef.current;
    if (video && videoUrl) {
      logOnboardingVideoLifecycle('mount', {
        autoPlay: video.autoplay,
        loop: video.loop,
        muted: video.muted,
        preload: video.preload,
        title,
        videoUrl,
      });
    }

    return () => {
      if (!video) {
        return;
      }

      if (videoUrl) {
        logOnboardingVideoLifecycle('teardown', { title, videoUrl });
      }
      video.pause();
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // NOTE(victor): JSDOM does not implement media loading; Chromium uses this to release the decoder.
      }
    };
  }, [title, videoUrl]);

  const previewBackground = videoUrl
    ? 'color-mix(in oklch, var(--oa-bg-app) 90%, var(--oa-bg-input) 10%)'
    : 'color-mix(in oklch, var(--oa-bg-app) 86%, var(--oa-bg-subtle) 14%)';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            className="h-full min-h-[300px] w-full shrink-0 basis-[70%] object-cover object-bottom"
            style={{
              backgroundColor: previewBackground,
            }}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            aria-label={t('onboarding.features.demoVideoLabel', { title })}
            onError={() => logOnboardingVideoLifecycle('error', { title, videoUrl })}
            onLoadedMetadata={() => logOnboardingVideoLifecycle('loadedmetadata', { title, videoUrl })}
            onPlaying={() => logOnboardingVideoLifecycle('playing', { title, videoUrl })}
          />
        ) : (
          <div
            className={`flex min-h-[300px] w-full shrink-0 basis-[70%] items-center justify-center ${placeholderColor}`}
            style={{
              backgroundColor: previewBackground,
            }}
          >
            <div className="flex min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
              {placeholderIcon}
              <span className="text-ui-sm text-muted-foreground/80">{t('onboarding.features.noDemo')}</span>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-5 sm:px-8 sm:py-6">
          <OnboardingHeading
            title={(
              <span className="inline-flex flex-wrap items-center justify-center gap-2">
                <span>{title}</span>
                {experimental && <ExperimentalBadge />}
              </span>
            )}
            description={description}
            className="space-y-2.5"
            descriptionClassName="max-w-[34rem]"
          />
        </div>
    </div>
  );
}
