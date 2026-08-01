import { useEffect, useMemo, useRef } from 'react';
import { Code2, Film, Link2, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  MOVIE_CLIP_ID,
  MOVIE_TIMELINE_ID,
  MOVIE_TRACK_ID,
} from '../../../shared/element-ids';
import {
  getMovieClipDurationInFrames,
  type MovieAssetMetadata,
  type MovieClip,
  type MovieTimelineDefinition,
  type MovieTrack,
} from '../../../shared/movie-schema';
import { MovieWaveform } from './MovieWaveform';

const TRACK_HEIGHT = 68;
const CLIP_INSET = 6;
const TIMELINE_LABEL_WIDTH = 140;

type ClipTimingPatch = {
  startFrame?: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  trackId?: string;
};

type DragState = {
  clipId: string;
  mode: 'move' | 'trim-start' | 'trim-end';
  baseTimeline: MovieTimelineDefinition;
  startClientX: number;
  initialStartFrame: number;
  initialSourceStartFrame: number;
  initialSourceEndFrame: number;
};

type ScrubState = {
  active: true;
};

function sortTrackClips(track: MovieTrack): MovieClip[] {
  return [...track.clips].sort((left, right) => {
    if (left.startFrame !== right.startFrame) {
      return left.startFrame - right.startFrame;
    }
    return left.id.localeCompare(right.id);
  });
}

function clampFrame(frame: number, maxFrame: number): number {
  return Math.max(0, Math.min(frame, maxFrame));
}

function formatFrameTime(frame: number, fps: number): string {
  const totalSeconds = Math.max(0, frame / fps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const tenths = Math.floor((totalSeconds % 1) * 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function getClipAccent(clip: MovieClip, selected: boolean): {
  border: string;
  background: string;
  textClassName: string;
  metaTextColor: string;
  boxShadow: string;
} {
  if (clip.kind === 'video') {
    return {
      border: selected ? 'rgba(255, 222, 144, 0.98)' : 'rgba(151, 98, 41, 0.42)',
      background: selected
        ? 'linear-gradient(180deg, rgba(201, 125, 31, 0.98) 0%, rgba(139, 76, 13, 0.98) 100%)'
        : 'linear-gradient(180deg, rgba(72, 42, 10, 0.9) 0%, rgba(54, 31, 8, 0.92) 100%)',
      textClassName: 'text-amber-50',
      metaTextColor: selected ? 'rgba(255, 240, 206, 0.84)' : 'rgba(255, 226, 176, 0.52)',
      boxShadow: selected
        ? '0 0 0 1px rgba(255, 229, 166, 0.22), 0 10px 24px rgba(209, 123, 21, 0.28), inset 0 1px 0 rgba(255, 245, 220, 0.18)'
        : 'inset 0 1px 0 rgba(255, 240, 204, 0.05)',
    };
  }

  if (clip.kind === 'audio') {
    return {
      border: selected ? 'rgba(164, 249, 218, 0.98)' : 'rgba(39, 122, 94, 0.42)',
      background: selected
        ? 'linear-gradient(180deg, rgba(27, 167, 128, 0.98) 0%, rgba(9, 111, 84, 0.98) 100%)'
        : 'linear-gradient(180deg, rgba(8, 58, 45, 0.92) 0%, rgba(6, 43, 33, 0.92) 100%)',
      textClassName: 'text-emerald-50',
      metaTextColor: selected ? 'rgba(220, 255, 241, 0.86)' : 'rgba(184, 245, 222, 0.52)',
      boxShadow: selected
        ? '0 0 0 1px rgba(176, 255, 228, 0.22), 0 10px 24px rgba(15, 156, 119, 0.26), inset 0 1px 0 rgba(236, 255, 248, 0.18)'
        : 'inset 0 1px 0 rgba(218, 255, 243, 0.05)',
    };
  }

  return {
    border: selected ? 'rgba(182, 204, 255, 0.98)' : 'rgba(78, 103, 181, 0.42)',
    background: selected
      ? 'linear-gradient(180deg, rgba(74, 126, 255, 0.98) 0%, rgba(48, 87, 206, 0.98) 100%)'
      : 'linear-gradient(180deg, rgba(33, 47, 110, 0.92) 0%, rgba(24, 35, 81, 0.92) 100%)',
    textClassName: 'text-sky-50',
    metaTextColor: selected ? 'rgba(228, 239, 255, 0.86)' : 'rgba(190, 210, 255, 0.54)',
    boxShadow: selected
      ? '0 0 0 1px rgba(196, 216, 255, 0.22), 0 10px 24px rgba(66, 115, 232, 0.28), inset 0 1px 0 rgba(238, 245, 255, 0.18)'
      : 'inset 0 1px 0 rgba(228, 238, 255, 0.05)',
  };
}

function getClipIcon(clip: MovieClip) {
  if (clip.kind === 'video') return Film;
  if (clip.kind === 'audio') return Volume2;
  return Code2;
}

export function MovieTimelineEditor({
  timeline,
  assetMetadataById,
  selectedClipId,
  playheadFrame,
  pixelsPerFrame,
  onSelectClip,
  onSetPlayheadFrame,
  onCompleteDrag,
  onUpdateClipTiming,
  onClipContextMenu,
}: {
  timeline: MovieTimelineDefinition;
  assetMetadataById: Record<string, MovieAssetMetadata>;
  selectedClipId: string | null;
  playheadFrame: number;
  pixelsPerFrame: number;
  onSelectClip: (clipId: string) => void;
  onSetPlayheadFrame: (frame: number) => void;
  onCompleteDrag: () => void;
  onUpdateClipTiming: (
    clipId: string,
    patch: ClipTimingPatch,
    options?: { baseTimeline?: MovieTimelineDefinition },
  ) => void;
  onClipContextMenu?: (event: React.MouseEvent<HTMLDivElement>, clip: MovieClip) => void;
}) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const scrubStateRef = useRef<ScrubState | null>(null);

  const timelineWidth = useMemo(() => {
    const paddedFrames = timeline.settings.durationInFrames + (timeline.settings.fps * 2);
    return Math.max(1080, paddedFrames * pixelsPerFrame);
  }, [timeline.settings.durationInFrames, timeline.settings.fps, pixelsPerFrame]);

  const totalTracksHeight = timeline.tracks.length * TRACK_HEIGHT;

  const beginClipDrag = (
    clip: MovieClip,
    mode: DragState['mode'],
    clientX: number,
  ) => {
    dragStateRef.current = {
      clipId: clip.id,
      mode,
      baseTimeline: timeline,
      startClientX: clientX,
      initialStartFrame: clip.startFrame,
      initialSourceStartFrame: clip.sourceStartFrame,
      initialSourceEndFrame: clip.sourceEndFrame,
    };
  };

  const beginPlayheadScrub = (clientX: number) => {
    scrubStateRef.current = { active: true };
    setPlayheadFromPointer(clientX);
  };

  useEffect(() => {
    const handleDragMove = (clientX: number) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const deltaFrames = Math.round((clientX - dragState.startClientX) / pixelsPerFrame);

      if (dragState.mode === 'move') {
        onUpdateClipTiming(dragState.clipId, {
          startFrame: dragState.initialStartFrame + deltaFrames,
        }, { baseTimeline: dragState.baseTimeline });
        return;
      }

      if (dragState.mode === 'trim-start') {
        onUpdateClipTiming(dragState.clipId, {
          startFrame: dragState.initialStartFrame + deltaFrames,
          sourceStartFrame: dragState.initialSourceStartFrame + deltaFrames,
        }, { baseTimeline: dragState.baseTimeline });
        return;
      }

      onUpdateClipTiming(dragState.clipId, {
        sourceEndFrame: dragState.initialSourceEndFrame + deltaFrames,
      }, { baseTimeline: dragState.baseTimeline });
    };

    const handleScrubMove = (clientX: number) => {
      if (!scrubStateRef.current) {
        return;
      }

      setPlayheadFromPointer(clientX);
    };

    const handlePointerMove = (event: PointerEvent) => {
      handleDragMove(event.clientX);
      handleScrubMove(event.clientX);
    };

    const handleMouseMove = (event: MouseEvent) => {
      handleDragMove(event.clientX);
      handleScrubMove(event.clientX);
    };

    const clearInteractions = () => {
      const hadDrag = dragStateRef.current !== null;
      dragStateRef.current = null;
      scrubStateRef.current = null;
      if (hadDrag) {
        onCompleteDrag();
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('pointerup', clearInteractions);
    window.addEventListener('pointercancel', clearInteractions);
    window.addEventListener('mouseup', clearInteractions);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointerup', clearInteractions);
      window.removeEventListener('pointercancel', clearInteractions);
      window.removeEventListener('mouseup', clearInteractions);
    };
  }, [onCompleteDrag, pixelsPerFrame, onUpdateClipTiming, timeline]);

  const setPlayheadFromPointer = (clientX: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const relativeX = clientX - rect.left + scroller.scrollLeft - TIMELINE_LABEL_WIDTH;
    const nextFrame = clampFrame(
      Math.round(relativeX / pixelsPerFrame),
      timeline.settings.durationInFrames,
    );
    onSetPlayheadFrame(nextFrame);
  };

  return (
    <div
      id={MOVIE_TIMELINE_ID}
      data-testid={MOVIE_TIMELINE_ID}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--oa-bg-subtle)]"
    >
      <div
        className="grid items-center border-b border-[var(--oa-border)]"
        style={{ gridTemplateColumns: `${TIMELINE_LABEL_WIDTH}px minmax(0, 1fr)` }}
      >
        <div className="px-3 py-2">
          <div className="text-ui-xs font-medium text-[var(--oa-text-muted)]">Timeline</div>
        </div>
        <div
          className="overflow-hidden px-2 py-2"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('[data-movie-clip-root="true"]')) {
              return;
            }
            event.preventDefault();
            beginPlayheadScrub(event.clientX);
          }}
        >
          <div className="relative h-8" style={{ width: timelineWidth }}>
            {Array.from({
              length: Math.ceil(timeline.settings.durationInFrames / timeline.settings.fps) + 2,
            }).map((_, index) => {
              const frame = index * timeline.settings.fps;
              const left = frame * pixelsPerFrame;
              return (
                <div key={frame} className="absolute inset-y-0" style={{ left }}>
                  <div className="h-3 border-l border-[var(--oa-border-strong)]" />
                  <div className="pt-1 text-[11px] tabular-nums text-[var(--oa-text-faint)]">
                    {formatFrameTime(frame, timeline.settings.fps)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: `${TIMELINE_LABEL_WIDTH}px minmax(0, 1fr)`, minWidth: `calc(${timelineWidth}px + ${TIMELINE_LABEL_WIDTH}px)` }}
        >
          <div className="border-r border-[var(--oa-border)] bg-[var(--oa-surface-center)]">
            {timeline.tracks.map((track) => (
              <div
                key={track.id}
                data-testid={MOVIE_TRACK_ID(track.id)}
                className="flex h-[68px] items-center border-b border-[var(--oa-border)] px-3"
              >
                <div className="truncate text-ui-sm font-medium text-[var(--oa-text)]">{track.name}</div>
              </div>
            ))}
          </div>

          <div
            className="relative"
            style={{ height: totalTracksHeight, width: timelineWidth }}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('[data-movie-clip-root="true"]')) {
                return;
              }
              event.preventDefault();
              beginPlayheadScrub(event.clientX);
            }}
          >
            {timeline.tracks.map((track, trackIndex) => {
              const rowTop = trackIndex * TRACK_HEIGHT;
              return (
                <div
                  key={track.id}
                  className="absolute left-0 right-0 border-b border-[var(--oa-border)]"
                  style={{ top: rowTop, height: TRACK_HEIGHT }}
                >
                  <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(15,23,42,0.05)_1px,transparent_1px)] [background-size:30px_100%]" />
                  <div className="absolute inset-x-0 top-1/2 border-t border-black/[0.05]" />

                  {sortTrackClips(track).map((clip) => {
                    const duration = getMovieClipDurationInFrames(clip);
                    const left = clip.startFrame * pixelsPerFrame;
                    const width = Math.max(28, duration * pixelsPerFrame);
                    const metadata = clip.kind === 'react' ? null : assetMetadataById[clip.assetId];
                    const Icon = getClipIcon(clip);
                    const isSelected = selectedClipId === clip.id;
                    const accent = getClipAccent(clip, isSelected);

                    return (
                      <div
                        key={clip.id}
                        data-testid={MOVIE_CLIP_ID(clip.id)}
                        data-movie-clip-root="true"
                        className={cn(
                          'absolute overflow-hidden rounded-[10px] border transition-[border-color,box-shadow,transform] duration-150',
                          isSelected && 'ring-1 ring-white/15',
                        )}
                        style={{
                          left,
                          top: CLIP_INSET,
                          width,
                          height: TRACK_HEIGHT - (CLIP_INSET * 2),
                          borderColor: accent.border,
                          background: accent.background,
                          boxShadow: accent.boxShadow,
                          zIndex: isSelected ? 2 : 1,
                        }}
                        onPointerDown={(event) => {
                          if ((event.target as HTMLElement).closest('[data-movie-handle]')) {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          onSelectClip(clip.id);
                          beginClipDrag(clip, 'move', event.clientX);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onSelectClip(clip.id);
                          onClipContextMenu?.(event, clip);
                        }}
                      >
                        <button
                          type="button"
                          data-movie-handle="start"
                          aria-label="Trim clip start"
                          className="absolute inset-y-0 left-0 z-10 w-3 cursor-ew-resize bg-black/[0.08] transition-colors hover:bg-black/[0.16]"
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onSelectClip(clip.id);
                            beginClipDrag(clip, 'trim-start', event.clientX);
                          }}
                        />
                        <button
                          type="button"
                          data-movie-handle="end"
                          aria-label="Trim clip end"
                          className="absolute inset-y-0 right-0 z-10 w-3 cursor-ew-resize bg-black/[0.08] transition-colors hover:bg-black/[0.16]"
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onSelectClip(clip.id);
                            beginClipDrag(clip, 'trim-end', event.clientX);
                          }}
                        />

                        <div className="pointer-events-none relative z-0 flex h-full flex-col px-3 py-2.5">
                          <div className={cn('flex items-center gap-2', accent.textClassName)}>
                            <Icon className="size-4 shrink-0" />
                            <div className="min-w-0 truncate text-ui-sm font-medium">{clip.label}</div>
                            {((clip.kind === 'video' && clip.linkedAudioClipId) || (clip.kind === 'audio' && clip.linkedVideoClipId)) ? (
                              <Link2 className="size-3.5 shrink-0 text-white/62" />
                            ) : null}
                          </div>

                          <div
                            className="mt-1 flex items-center gap-3 text-[11px] tabular-nums"
                            style={{ color: accent.metaTextColor }}
                          >
                            <span>{formatFrameTime(clip.startFrame, timeline.settings.fps)}</span>
                            <span>{duration}f</span>
                          </div>

                          {clip.kind === 'audio' ? (
                            <div className="mt-2 min-h-0 flex-1">
                              <MovieWaveform
                                samples={metadata?.waveform?.samples ?? []}
                                stroke="rgba(207,255,234,0.92)"
                                fill="rgba(153,255,212,0.2)"
                              />
                            </div>
                          ) : clip.kind === 'video' ? (
                            <div className="mt-2 flex min-h-0 flex-1 items-end overflow-hidden rounded-[6px] bg-black/14">
                              <div className="grid h-full w-full grid-cols-6 opacity-35">
                                {Array.from({ length: 6 }).map((_, index) => (
                                  <div
                                    key={index}
                                    className="border-r border-white/[0.08] last:border-r-0"
                                  />
                                ))}
                              </div>
                              {metadata?.waveform?.samples?.length ? (
                                <div className="pointer-events-none absolute inset-x-3 bottom-2 h-5 px-1 py-0.5">
                                  <MovieWaveform
                                    samples={metadata.waveform.samples}
                                    stroke="rgba(255,227,184,0.88)"
                                    fill="rgba(255,209,128,0.2)"
                                  />
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="mt-2 flex min-h-0 flex-1 items-center justify-center rounded-[6px] border border-dashed border-white/[0.16] bg-white/[0.06] text-ui-sm text-white/78">
                              {clip.componentId}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div
              className="absolute bottom-0 top-0 z-20 -ml-[6px] w-3 cursor-ew-resize"
              style={{ left: playheadFrame * pixelsPerFrame }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                beginPlayheadScrub(event.clientX);
              }}
            >
              <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[rgba(255,204,117,0.95)] shadow-[0_0_0_1px_rgba(255,204,117,0.18),0_0_18px_rgba(255,186,98,0.28)]" />
              <div className="pointer-events-none absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[rgba(255,204,117,0.96)] shadow-[0_0_0_4px_rgba(255,204,117,0.16)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
