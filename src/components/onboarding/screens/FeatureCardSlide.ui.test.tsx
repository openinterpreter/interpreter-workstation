import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { FeatureCardSlide } from './FeatureCardSlide';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { title?: string }) => {
      if (key === 'onboarding.features.demoVideoLabel') {
        return `${values?.title ?? 'Feature'} demo video`;
      }
      if (key === 'onboarding.features.noDemo') {
        return 'No demo video';
      }
      return key;
    },
  }),
}));

function renderFeatureCard(videoUrl?: string) {
  return render(
    <FeatureCardSlide
      title="Spreadsheets"
      description="Review workbooks"
      videoUrl={videoUrl}
      placeholderIcon={<span data-testid="placeholder-icon" />}
      placeholderColor="bg-muted"
      onNext={() => {}}
    />,
  );
}

describe('FeatureCardSlide demo video memory behavior', () => {
  let pause: ReturnType<typeof vi.spyOn>;
  let load: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('always renders the configured demo video with bounded preload', () => {
    const { unmount } = renderFeatureCard('https://www.openinterpreter.com/videos/demos/excel.mp4');

    const video = screen.getByLabelText('Spreadsheets demo video');
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveAttribute('src', 'https://www.openinterpreter.com/videos/demos/excel.mp4');

    unmount();
  });

  test('uses the placeholder only when the slide has no demo video URL', () => {
    renderFeatureCard();

    expect(screen.queryByLabelText('Spreadsheets demo video')).not.toBeInTheDocument();
    expect(screen.getByText('No demo video')).toBeVisible();
    expect(screen.getByTestId('placeholder-icon')).toBeVisible();
  });

  test('releases the video source during teardown', () => {
    const { unmount } = renderFeatureCard('https://www.openinterpreter.com/videos/demos/excel.mp4');
    const video = screen.getByLabelText('Spreadsheets demo video');

    unmount();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(video).not.toHaveAttribute('src');
  });

  test('logs demo video lifecycle while preserving autoplay', () => {
    const { unmount } = renderFeatureCard('https://www.openinterpreter.com/videos/demos/excel.mp4');

    const video = screen.getByLabelText('Spreadsheets demo video');
    fireEvent.loadedMetadata(video);
    fireEvent.playing(video);

    expect(video).toHaveAttribute('autoplay');
    expect(info).toHaveBeenCalledWith('[OnboardingVideo] mount', {
      autoPlay: true,
      loop: true,
      muted: true,
      preload: 'metadata',
      title: 'Spreadsheets',
      video: 'excel.mp4',
    });
    expect(info).toHaveBeenCalledWith('[OnboardingVideo] loadedmetadata', {
      title: 'Spreadsheets',
      video: 'excel.mp4',
    });
    expect(info).toHaveBeenCalledWith('[OnboardingVideo] playing', {
      title: 'Spreadsheets',
      video: 'excel.mp4',
    });

    unmount();
  });
});
