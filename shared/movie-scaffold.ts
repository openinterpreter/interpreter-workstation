import {
  MOVIE_TIMELINE_JSON_END,
  MOVIE_TIMELINE_JSON_START,
  type MovieTimelineDefinition,
} from './movie-schema';

function escapeTimelineJsonForTemplateLiteral(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

export function serializeMovieTimeline(timeline: MovieTimelineDefinition): string {
  return JSON.stringify(timeline, null, 2);
}

export function extractMovieTimelineJson(content: string): string {
  const startIndex = content.indexOf(MOVIE_TIMELINE_JSON_START);
  const endIndex = content.indexOf(MOVIE_TIMELINE_JSON_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error('Movie timeline markers were not found');
  }

  return content
    .slice(startIndex + MOVIE_TIMELINE_JSON_START.length, endIndex)
    .trim();
}

export function parseMovieTimelineModule(content: string): MovieTimelineDefinition {
  return JSON.parse(extractMovieTimelineJson(content)) as MovieTimelineDefinition;
}

export function replaceMovieTimelineJsonInModule(
  content: string,
  timeline: MovieTimelineDefinition,
): string {
  const startIndex = content.indexOf(MOVIE_TIMELINE_JSON_START);
  const endIndex = content.indexOf(MOVIE_TIMELINE_JSON_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error('Movie timeline markers were not found');
  }

  const serializedTimeline = serializeMovieTimeline(timeline);
  const prefix = content.slice(0, startIndex + MOVIE_TIMELINE_JSON_START.length);
  const suffix = content.slice(endIndex);
  return `${prefix}
${serializedTimeline}
${suffix}`;
}

export function renderMovieTimelineModule(timeline: MovieTimelineDefinition): string {
  const serializedTimeline = escapeTimelineJsonForTemplateLiteral(serializeMovieTimeline(timeline));

  return `import {
  defineMovieTimeline,
  parseMovieTimelineDefinition,
  type MovieTimelineDefinition,
} from './movie-runtime';

export const movieTimeline = defineMovieTimeline(
  parseMovieTimelineDefinition(String.raw\`
${MOVIE_TIMELINE_JSON_START}
${serializedTimeline}
${MOVIE_TIMELINE_JSON_END}
\`) as MovieTimelineDefinition
);

export default movieTimeline;
`;
}

export function renderMovieIndexModule(): string {
  return `export { movieTimeline } from './timeline';
export { movieReactComponents } from './components';
export * from './movie-runtime';
`;
}

export function renderMovieComponentsModule(): string {
  return `import React from 'react';

export const movieReactComponents: Record<string, React.ComponentType<Record<string, unknown>>> = {};
`;
}

export function renderMovieRuntimeModule(): string {
  return `import React from 'react';

export const MOVIE_TIMELINE_JSON_START = '${MOVIE_TIMELINE_JSON_START}';
export const MOVIE_TIMELINE_JSON_END = '${MOVIE_TIMELINE_JSON_END}';

export type MovieJsonValue =
  | string
  | number
  | boolean
  | null
  | MovieJsonObject
  | MovieJsonValue[];

export interface MovieJsonObject {
  [key: string]: MovieJsonValue;
}

export interface MovieTimelineSettings {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  background: string;
}

export interface MovieAsset {
  id: string;
  kind: 'video' | 'audio';
  label: string;
  sourceMode: 'managed' | 'reference';
  path: string;
  sourceUrl: string;
  metadataPath: string;
  durationInFrames: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  createdAt: number;
}

export interface MovieVisualCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MovieVisualStyle {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  blur: number;
  zIndex: number;
  crop: MovieVisualCrop;
}

export interface MovieBaseClip {
  id: string;
  kind: 'video' | 'audio' | 'react';
  label: string;
  startFrame: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  metadata: MovieJsonObject;
}

export interface MovieVideoClip extends MovieBaseClip {
  kind: 'video';
  assetId: string;
  linkedAudioClipId: string | null;
  muted: boolean;
  style: MovieVisualStyle;
}

export interface MovieAudioClip extends MovieBaseClip {
  kind: 'audio';
  assetId: string;
  linkedVideoClipId: string | null;
  muted: boolean;
  volume: number;
}

export interface MovieReactClip extends MovieBaseClip {
  kind: 'react';
  componentId: string;
  props: MovieJsonObject;
  draggable: boolean;
  style: MovieVisualStyle;
}

export type MovieClip = MovieVideoClip | MovieAudioClip | MovieReactClip;

export interface MovieTrack {
  id: string;
  kind: 'video' | 'audio' | 'react';
  name: string;
  clips: MovieClip[];
}

export interface MovieTimelineDefinition {
  version: 1;
  playheadFrame: number;
  settings: MovieTimelineSettings;
  assets: MovieAsset[];
  tracks: MovieTrack[];
}

type MovieComponentRegistry = Record<string, React.ComponentType<Record<string, unknown>>>;
type MovieRuntimeMode = 'preview' | 'render';

export interface MovieStageProps {
  timeline: MovieTimelineDefinition;
  frame: number;
  isPlaying?: boolean;
  assetUrls?: Record<string, string>;
  components?: MovieComponentRegistry;
  mode?: MovieRuntimeMode;
  onFrameReady?: (frame: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export interface MovieSequenceProps {
  from?: number;
  durationInFrames?: number;
  premountFor?: number;
  layout?: 'absolute-fill' | 'none';
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

interface MoviePreviewAudioSource {
  id: string;
  asset: MovieAsset;
  startFrame: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  volume: number;
}

const PREMOUNT_FRAMES = 18;
const FrameContext = React.createContext(0);
const ConfigContext = React.createContext<MovieTimelineSettings | null>(null);
const SequenceOffsetContext = React.createContext(0);

const noop = () => {};

const getClipDuration = (clip: MovieClip): number => {
  return Math.max(1, clip.sourceEndFrame - clip.sourceStartFrame);
};

const getClipEndFrame = (clip: MovieClip): number => {
  return clip.startFrame + getClipDuration(clip);
};

const sortClips = (clips: MovieClip[]): MovieClip[] => {
  return [...clips].sort((left, right) => {
    if (left.startFrame !== right.startFrame) {
      return left.startFrame - right.startFrame;
    }
    return left.id.localeCompare(right.id);
  });
};

const normalizeCrop = (crop: MovieVisualCrop | undefined): MovieVisualCrop => {
  return {
    left: crop?.left ?? 0,
    top: crop?.top ?? 0,
    right: crop?.right ?? 0,
    bottom: crop?.bottom ?? 0,
  };
};

const getWrapperStyle = (style: MovieVisualStyle): React.CSSProperties => {
  return {
    position: 'absolute',
    left: style.x,
    top: style.y,
    width: style.width,
    height: style.height,
    opacity: style.opacity,
    overflow: 'hidden',
    zIndex: style.zIndex,
    transform: 'rotate(' + style.rotation + 'deg)',
    filter: style.blur > 0 ? 'blur(' + style.blur + 'px)' : undefined,
    transformOrigin: 'center center',
  };
};

const getInnerMediaStyle = (style: MovieVisualStyle): React.CSSProperties => {
  const crop = normalizeCrop(style.crop);
  return {
    position: 'absolute',
    left: String(crop.left * -100) + '%',
    top: String(crop.top * -100) + '%',
    width: String(100 + (crop.left + crop.right) * 100) + '%',
    height: String(100 + (crop.top + crop.bottom) * 100) + '%',
    objectFit: 'fill',
  };
};

const findAsset = (timeline: MovieTimelineDefinition, assetId: string): MovieAsset => {
  const asset = timeline.assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    throw new Error('Missing movie asset: ' + assetId);
  }
  return asset;
};

const clampFrame = (frame: number, durationInFrames: number): number => {
  return Math.max(0, Math.min(frame, Math.max(0, durationInFrames - 1)));
};

const clampTime = (time: number, durationSeconds: number): number => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return Math.max(0, time);
  }
  return Math.max(0, Math.min(time, Math.max(0, durationSeconds - 0.001)));
};

const getTargetMediaTime = (
  currentFrame: number,
  clipStartFrame: number,
  sourceStartFrame: number,
  durationInFrames: number,
  fps: number,
  durationSeconds: number,
): number => {
  const localFrame = currentFrame - clipStartFrame;
  if (localFrame <= 0) {
    return clampTime(sourceStartFrame / fps, durationSeconds);
  }
  if (localFrame >= durationInFrames) {
    return clampTime((sourceStartFrame + durationInFrames - 1) / fps, durationSeconds);
  }
  return clampTime((sourceStartFrame + localFrame) / fps, durationSeconds);
};

const createReadyReporter = (
  frame: number,
  onFrameReady?: (frame: number) => void,
) => {
  if (!onFrameReady) {
    return noop;
  }

  let cancelled = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!cancelled) {
        onFrameReady(frame);
      }
    });
  });

  return () => {
    cancelled = true;
  };
};

const waitForMediaSeek = async (
  element: HTMLMediaElement,
  time: number,
): Promise<void> => {
  const targetTime = clampTime(time, element.duration);
  if (Math.abs(element.currentTime - targetTime) <= 0.001 && element.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      element.removeEventListener('seeked', done);
      element.removeEventListener('loadeddata', done);
      element.removeEventListener('canplay', done);
      element.removeEventListener('error', done);
    };

    element.addEventListener('seeked', done, { once: true });
    element.addEventListener('loadeddata', done, { once: true });
    element.addEventListener('canplay', done, { once: true });
    element.addEventListener('error', done, { once: true });

    try {
      element.currentTime = targetTime;
    } catch {
      done();
    }
  });
};

const ReactClipFallback: React.FC<{ componentId: string }> = ({ componentId }) => {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        border: '1px dashed rgba(255,255,255,0.38)',
        background: 'rgba(255,255,255,0.06)',
        color: 'rgba(255,255,255,0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 18,
      }}
    >
      {componentId}
    </div>
  );
};

export const defineMovieTimeline = (
  timeline: MovieTimelineDefinition,
): MovieTimelineDefinition => timeline;

export const parseMovieTimelineDefinition = (
  content: string,
): MovieTimelineDefinition => {
  const withoutStartMarker = content.replace(MOVIE_TIMELINE_JSON_START, '');
  const withoutMarkers = withoutStartMarker.replace(MOVIE_TIMELINE_JSON_END, '');
  return JSON.parse(withoutMarkers.trim()) as MovieTimelineDefinition;
};

export const useMovieFrame = (): number => {
  return React.useContext(FrameContext) - React.useContext(SequenceOffsetContext);
};

export const useMovieConfig = (): MovieTimelineSettings => {
  const config = React.useContext(ConfigContext);
  if (!config) {
    throw new Error('useMovieConfig() must be used inside <MovieStage>');
  }
  return config;
};

export const MovieSequence: React.FC<MovieSequenceProps> = ({
  from = 0,
  durationInFrames = Infinity,
  premountFor = 0,
  layout = 'absolute-fill',
  style,
  className,
  children,
}) => {
  const absoluteFrame = React.useContext(FrameContext);
  const parentOffset = React.useContext(SequenceOffsetContext);
  const sequenceStart = parentOffset + from;
  const shouldMount = absoluteFrame >= (sequenceStart - premountFor)
    && absoluteFrame < (sequenceStart + durationInFrames);

  if (!shouldMount) {
    return null;
  }

  const content = (
    <SequenceOffsetContext.Provider value={sequenceStart}>
      {children}
    </SequenceOffsetContext.Provider>
  );

  if (layout === 'none') {
    return content;
  }

  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        ...style,
      }}
    >
      {content}
    </div>
  );
};

const MovieManagedVideo: React.FC<{
  clip: MovieVideoClip;
  asset: MovieAsset;
  src: string;
  frame: number;
  fps: number;
  isPlaying: boolean;
  mode: MovieRuntimeMode;
  onReady?: (clipId: string, frame: number) => void;
}> = ({ clip, asset, src, frame, fps, isPlaying, mode, onReady }) => {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const durationInFrames = getClipDuration(clip);
  const localFrame = frame - clip.startFrame;
  const isActive = localFrame >= 0 && localFrame < durationInFrames;
  const shouldMount = mode === 'render'
    ? isActive
    : localFrame >= -PREMOUNT_FRAMES && localFrame < durationInFrames + 1;
  const targetTime = getTargetMediaTime(
    clampFrame(frame, clip.startFrame + durationInFrames),
    clip.startFrame,
    clip.sourceStartFrame,
    durationInFrames,
    fps,
    asset.durationSeconds,
  );
  const wrapperStyle = React.useMemo(() => {
    const nextStyle = getWrapperStyle(clip.style);
    if (!isActive) {
      nextStyle.visibility = 'hidden';
      nextStyle.pointerEvents = 'none';
    }
    return nextStyle;
  }, [clip.style, isActive]);
  const mediaStyle = React.useMemo(() => getInnerMediaStyle(clip.style), [clip.style]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let cancelled = false;

    const syncVideo = async () => {
      video.muted = true;
      video.playsInline = true;
      video.loop = false;

      if (!shouldMount) {
        video.pause();
        return;
      }

      if (mode === 'preview' && isPlaying && isActive) {
        if (Math.abs(video.currentTime - targetTime) > 0.18) {
          await waitForMediaSeek(video, targetTime);
        }
        if (cancelled) return;
        await video.play().catch(() => {});
        return;
      }

      video.pause();
      await waitForMediaSeek(video, targetTime);
      if (!cancelled && mode === 'render' && isActive) {
        onReady?.(clip.id, frame);
      }
    };

    void syncVideo();

    return () => {
      cancelled = true;
    };
  }, [clip.id, frame, isActive, isPlaying, mode, onReady, shouldMount, src, targetTime]);

  if (!shouldMount) {
    return null;
  }

  return (
    <div style={wrapperStyle}>
      <video
        ref={videoRef}
        src={src}
        preload="auto"
        muted
        playsInline
        style={mediaStyle}
      />
    </div>
  );
};

const MovieManagedAudio: React.FC<{
  source: MoviePreviewAudioSource;
  src: string;
  frame: number;
  fps: number;
  isPlaying: boolean;
}> = ({ source, src, frame, fps, isPlaying }) => {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const durationInFrames = Math.max(1, source.sourceEndFrame - source.sourceStartFrame);
  const localFrame = frame - source.startFrame;
  const isActive = localFrame >= 0 && localFrame < durationInFrames;
  const shouldMount = localFrame >= -PREMOUNT_FRAMES && localFrame < durationInFrames + 1;
  const targetTime = getTargetMediaTime(
    clampFrame(frame, source.startFrame + durationInFrames),
    source.startFrame,
    source.sourceStartFrame,
    durationInFrames,
    fps,
    source.asset.durationSeconds,
  );

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    let cancelled = false;

    const syncAudio = async () => {
      audio.loop = false;
      audio.volume = Math.max(0, Math.min(2, source.volume));

      if (!shouldMount) {
        audio.pause();
        return;
      }

      if (isPlaying && isActive) {
        if (Math.abs(audio.currentTime - targetTime) > 0.18) {
          await waitForMediaSeek(audio, targetTime);
        }
        if (cancelled) return;
        await audio.play().catch(() => {});
        return;
      }

      audio.pause();
      await waitForMediaSeek(audio, targetTime);
    };

    void syncAudio();

    return () => {
      cancelled = true;
    };
  }, [frame, isActive, isPlaying, shouldMount, source.volume, src, targetTime]);

  if (!shouldMount) {
    return null;
  }

  return (
    <audio
      ref={audioRef}
      src={src}
      preload="auto"
    />
  );
};

export const MovieStage: React.FC<MovieStageProps> = ({
  timeline,
  frame,
  isPlaying = false,
  assetUrls = {},
  components = {},
  mode = 'preview',
  onFrameReady,
  className,
  style,
}) => {
  const videoClips = React.useMemo(() => {
    return sortClips(
      timeline.tracks.flatMap((track) => track.kind === 'video' ? track.clips : []),
    ) as MovieVideoClip[];
  }, [timeline]);

  const reactClips = React.useMemo(() => {
    return sortClips(
      timeline.tracks.flatMap((track) => track.kind === 'react' ? track.clips : []),
    ) as MovieReactClip[];
  }, [timeline]);

  const audioSources = React.useMemo(() => {
    const explicitAudioClips = sortClips(
      timeline.tracks.flatMap((track) => track.kind === 'audio' ? track.clips : []),
    ) as MovieAudioClip[];

    const timelineAudioSources: MoviePreviewAudioSource[] = explicitAudioClips
      .filter((clip) => !clip.muted)
      .map((clip) => ({
        id: clip.id,
        asset: findAsset(timeline, clip.assetId),
        startFrame: clip.startFrame,
        sourceStartFrame: clip.sourceStartFrame,
        sourceEndFrame: clip.sourceEndFrame,
        volume: clip.volume,
      }));

    const embeddedVideoAudioSources = videoClips
      .map((clip) => ({
        clip,
        asset: findAsset(timeline, clip.assetId),
      }))
      .filter(({ clip, asset }) => !clip.muted && asset.hasAudio)
      .map(({ clip, asset }) => ({
        id: clip.id + '-embedded-audio',
        asset,
        startFrame: clip.startFrame,
        sourceStartFrame: clip.sourceStartFrame,
        sourceEndFrame: clip.sourceEndFrame,
        volume: 1,
      }));

    return [...timelineAudioSources, ...embeddedVideoAudioSources]
      .sort((left, right) => {
        if (left.startFrame !== right.startFrame) {
          return left.startFrame - right.startFrame;
        }
        return left.id.localeCompare(right.id);
      });
  }, [timeline, videoClips]);

  const expectedVideoIds = React.useMemo(() => {
    if (mode !== 'render') {
      return [] as string[];
    }

    return videoClips
      .filter((clip) => frame >= clip.startFrame && frame < getClipEndFrame(clip))
      .map((clip) => clip.id);
  }, [frame, mode, videoClips]);

  const expectedVideoIdsKey = React.useMemo(() => expectedVideoIds.join('|'), [expectedVideoIds]);
  const readyVideoIdsRef = React.useRef<Record<string, true>>({});
  const frameRef = React.useRef(frame);

  React.useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  React.useEffect(() => {
    readyVideoIdsRef.current = {};
    if (mode !== 'render' || expectedVideoIds.length === 0) {
      const cancel = createReadyReporter(frame, onFrameReady);
      return cancel;
    }
    return undefined;
  }, [expectedVideoIds.length, expectedVideoIdsKey, frame, mode, onFrameReady]);

  const handleVideoReady = React.useCallback((clipId: string, readyFrame: number) => {
    if (mode !== 'render' || readyFrame !== frameRef.current) {
      return;
    }

    readyVideoIdsRef.current[clipId] = true;
    const allReady = expectedVideoIds.every((candidate) => readyVideoIdsRef.current[candidate]);
    if (allReady) {
      createReadyReporter(readyFrame, onFrameReady);
    }
  }, [expectedVideoIds, mode, onFrameReady]);

  return (
    <ConfigContext.Provider value={timeline.settings}>
      <FrameContext.Provider value={frame}>
        <div
          className={className}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            background: timeline.settings.background,
            ...style,
          }}
        >
          {videoClips.map((clip) => {
            const asset = findAsset(timeline, clip.assetId);
            const src = assetUrls[asset.id] ?? asset.sourceUrl ?? asset.path;

            return (
              <MovieManagedVideo
                key={clip.id}
                clip={clip}
                asset={asset}
                src={src}
                frame={frame}
                fps={timeline.settings.fps}
                isPlaying={isPlaying}
                mode={mode}
                onReady={handleVideoReady}
              />
            );
          })}

          {reactClips.map((clip) => {
            const Component = components[clip.componentId] ?? null;
            const durationInFrames = getClipDuration(clip);

            return (
              <MovieSequence
                key={clip.id}
                from={clip.startFrame}
                durationInFrames={durationInFrames}
                premountFor={clip.draggable ? PREMOUNT_FRAMES : 0}
                layout="none"
              >
                <div style={getWrapperStyle(clip.style)}>
                  {Component
                    ? <Component {...clip.props} />
                    : <ReactClipFallback componentId={clip.componentId} />}
                </div>
              </MovieSequence>
            );
          })}

          {mode === 'preview' ? audioSources.map((source) => {
            const src = assetUrls[source.asset.id] ?? source.asset.sourceUrl ?? source.asset.path;

            return (
              <MovieManagedAudio
                key={source.id}
                source={source}
                src={src}
                frame={frame}
                fps={timeline.settings.fps}
                isPlaying={isPlaying}
              />
            );
          }) : null}
        </div>
      </FrameContext.Provider>
    </ConfigContext.Provider>
  );
};
`;
}
