import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { MovieTimelineDefinition } from '../../../shared/movie-schema';

export interface MoviePreviewStageProps {
  timeline: MovieTimelineDefinition;
  frame: number;
  isPlaying?: boolean;
  assetUrls?: Record<string, string>;
  components?: Record<string, ComponentType<Record<string, unknown>>>;
  mode?: 'preview' | 'render';
  onFrameReady?: (frame: number) => void;
  className?: string;
  style?: CSSProperties;
}

export type MoviePreviewStageComponent = ComponentType<MoviePreviewStageProps>;

export const MoviePreview = memo(function MoviePreview({
  timeline,
  frame,
  isPlaying,
  assetUrls,
  reactComponents,
  stageComponent: StageComponent,
  className,
  style,
}: {
  timeline: MovieTimelineDefinition;
  frame: number;
  isPlaying: boolean;
  assetUrls: Record<string, string>;
  reactComponents: Record<string, ComponentType<Record<string, unknown>>>;
  stageComponent: MoviePreviewStageComponent | null;
  className?: string;
  style?: CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateBounds = () => {
      const rect = element.getBoundingClientRect();
      setBounds({
        width: rect.width,
        height: rect.height,
      });
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const scale = useMemo(() => {
    if (bounds.width <= 0 || bounds.height <= 0) {
      return 1;
    }

    return Math.min(
      bounds.width / timeline.settings.width,
      bounds.height / timeline.settings.height,
    );
  }, [bounds.height, bounds.width, timeline.settings.height, timeline.settings.width]);

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full overflow-hidden bg-black', className)}
      style={{
        aspectRatio: `${timeline.settings.width} / ${timeline.settings.height}`,
        ...style,
      }}
    >
      {StageComponent ? (
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: timeline.settings.width,
            height: timeline.settings.height,
            transform: `translate(-50%, -50%) scale(${scale})`,
            transformOrigin: 'center center',
          }}
        >
          <StageComponent
            timeline={timeline}
            frame={frame}
            isPlaying={isPlaying}
            assetUrls={assetUrls}
            components={reactComponents}
            mode="preview"
            className="h-full w-full"
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-ui-sm text-white/48">
          Movie runtime unavailable
        </div>
      )}
    </div>
  );
});
