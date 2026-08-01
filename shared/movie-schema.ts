export const MOVIE_MANIFEST_VERSION = 2 as const;
export const MOVIE_TIMELINE_VERSION = 1 as const;
export const MOVIE_ASSET_METADATA_VERSION = 1 as const;
export const MOVIE_COMPOSITION_ID = 'InterpreterMovieComposition' as const;
export const MOVIE_TIMELINE_JSON_START = '__INTERPRETER_MOVIE_TIMELINE_JSON_START__' as const;
export const MOVIE_TIMELINE_JSON_END = '__INTERPRETER_MOVIE_TIMELINE_JSON_END__' as const;

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

export interface MovieManifest {
  version: typeof MOVIE_MANIFEST_VERSION;
  name: string;
  assetsDir: string;
  metadataDir: string;
  rendersDir: string;
  timelinePath: string;
  componentsPath: string;
  runtimePath: string;
  entryPoint: string;
}

export interface MovieTimelineSettings {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  background: string;
}

export type MovieAssetKind = 'video' | 'audio';
export type MovieAssetSourceMode = 'managed' | 'reference';
export type MovieTrackKind = 'video' | 'audio' | 'react';

export interface MovieAsset {
  id: string;
  kind: MovieAssetKind;
  label: string;
  sourceMode: MovieAssetSourceMode;
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

export interface MovieWaveform {
  sampleCount: number;
  samples: number[];
}

export interface MovieTranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface MovieTranscript {
  kind: 'transcript';
  language?: string | null;
  words: MovieTranscriptWord[];
}

export interface MovieAnnotation {
  id: string;
  kind: string;
  label: string;
  startMs: number;
  endMs: number;
  data?: MovieJsonObject;
}

export interface MovieAssetMetadata {
  version: typeof MOVIE_ASSET_METADATA_VERSION;
  assetId: string;
  durationSeconds: number;
  durationInFrames: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  waveform: MovieWaveform | null;
  transcript: MovieTranscript | null;
  annotations: MovieAnnotation[];
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
  kind: MovieAssetKind | 'react';
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
  kind: MovieTrackKind;
  name: string;
  clips: MovieClip[];
}

export interface MovieTimelineDefinition {
  version: typeof MOVIE_TIMELINE_VERSION;
  playheadFrame: number;
  settings: MovieTimelineSettings;
  assets: MovieAsset[];
  tracks: MovieTrack[];
}

export function createMovieId(prefix: string): string {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${randomPart}`;
}

export function createMovieManifest(name: string): MovieManifest {
  return {
    version: MOVIE_MANIFEST_VERSION,
    name,
    assetsDir: 'assets',
    metadataDir: 'meta',
    rendersDir: 'renders',
    timelinePath: 'timeline.tsx',
    componentsPath: 'components.tsx',
    runtimePath: 'movie-runtime.tsx',
    entryPoint: 'index.ts',
  };
}

export function createMovieVisualStyle(width = 1920, height = 1080): MovieVisualStyle {
  return {
    x: 0,
    y: 0,
    width,
    height,
    rotation: 0,
    opacity: 1,
    blur: 0,
    zIndex: 0,
    crop: {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    },
  };
}

export function createMovieAssetMetadata(assetId: string): MovieAssetMetadata {
  return {
    version: MOVIE_ASSET_METADATA_VERSION,
    assetId,
    durationSeconds: 0,
    durationInFrames: 0,
    width: null,
    height: null,
    hasAudio: false,
    waveform: null,
    transcript: null,
    annotations: [],
  };
}

export function createDefaultMovieTimeline(name: string): MovieTimelineDefinition {
  const videoTrack: MovieTrack = {
    id: 'video-track-1',
    kind: 'video',
    name: `${name} Video`,
    clips: [],
  };

  const audioTrack: MovieTrack = {
    id: 'audio-track-1',
    kind: 'audio',
    name: `${name} Audio`,
    clips: [],
  };

  const reactTrack: MovieTrack = {
    id: 'react-track-1',
    kind: 'react',
    name: `${name} Components`,
    clips: [],
  };

  return {
    version: MOVIE_TIMELINE_VERSION,
    playheadFrame: 0,
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 300,
      background: '#050505',
    },
    assets: [],
    tracks: [videoTrack, audioTrack, reactTrack],
  };
}

export function getMovieClipDurationInFrames(clip: MovieClip): number {
  return Math.max(1, clip.sourceEndFrame - clip.sourceStartFrame);
}

export function getMovieClipEndFrame(clip: MovieClip): number {
  return clip.startFrame + getMovieClipDurationInFrames(clip);
}

export function getMovieTrackEndFrame(track: MovieTrack): number {
  return track.clips.reduce((maxEnd, clip) => Math.max(maxEnd, getMovieClipEndFrame(clip)), 0);
}

export function getMovieTimelineEndFrame(timeline: MovieTimelineDefinition): number {
  return timeline.tracks.reduce((maxEnd, track) => Math.max(maxEnd, getMovieTrackEndFrame(track)), 0);
}

export function ensureMovieTimelineDuration(
  timeline: MovieTimelineDefinition,
  minimumDuration = 300,
): MovieTimelineDefinition {
  const maxClipEnd = getMovieTimelineEndFrame(timeline);
  return {
    ...timeline,
    settings: {
      ...timeline.settings,
      durationInFrames: Math.max(minimumDuration, timeline.settings.durationInFrames, maxClipEnd),
    },
  };
}
