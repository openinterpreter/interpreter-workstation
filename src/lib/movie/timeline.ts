import {
  createMovieId,
  createMovieVisualStyle,
  getMovieClipEndFrame,
  ensureMovieTimelineDuration,
  getMovieClipDurationInFrames,
  type MovieAsset,
  type MovieAudioClip,
  type MovieClip,
  type MovieJsonObject,
  type MovieReactClip,
  type MovieTimelineDefinition,
  type MovieTrack,
  type MovieTrackKind,
  type MovieVideoClip,
  type MovieVisualStyle,
} from '../../../shared/movie-schema';

export interface InsertMovieAssetResult {
  timeline: MovieTimelineDefinition;
  createdClipIds: string[];
}

function cloneMovieTimeline(timeline: MovieTimelineDefinition): MovieTimelineDefinition {
  return structuredClone(timeline);
}

function getTrackKindLabel(kind: MovieTrackKind): string {
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  return 'Component';
}

function getTrackKindForClip(clip: MovieClip): MovieTrackKind {
  if (clip.kind === 'video') return 'video';
  if (clip.kind === 'audio') return 'audio';
  return 'react';
}

function getTrackInsertIndex(timeline: MovieTimelineDefinition, kind: MovieTrackKind): number {
  const existingIndices = timeline.tracks
    .map((track, index) => (track.kind === kind ? index : -1))
    .filter((index) => index >= 0);
  if (existingIndices.length > 0) {
    return existingIndices[existingIndices.length - 1]! + 1;
  }

  if (kind === 'video') {
    return timeline.tracks.findIndex((track) => track.kind !== 'video');
  }

  if (kind === 'audio') {
    const reactIndex = timeline.tracks.findIndex((track) => track.kind === 'react');
    return reactIndex >= 0 ? reactIndex : timeline.tracks.length;
  }

  return timeline.tracks.length;
}

function getTrackNameBase(timeline: MovieTimelineDefinition, kind: MovieTrackKind): string {
  const existing = timeline.tracks.find((track) => track.kind === kind);
  if (!existing) {
    return getTrackKindLabel(kind);
  }

  const trimmedName = existing.name.trim();
  return trimmedName.replace(/\s+\d+$/, '') || getTrackKindLabel(kind);
}

function createTrack(timeline: MovieTimelineDefinition, kind: MovieTrackKind): MovieTrack {
  const usedTrackIds = new Set(timeline.tracks.map((track) => track.id));
  const count = timeline.tracks.filter((track) => track.kind === kind).length + 1;
  const nextTrack: MovieTrack = {
    id: createTrackId(usedTrackIds, kind),
    kind,
    name: `${getTrackNameBase(timeline, kind)} ${count}`,
    clips: [],
  };
  const insertIndex = getTrackInsertIndex(timeline, kind);
  if (insertIndex < 0) {
    timeline.tracks.push(nextTrack);
  } else {
    timeline.tracks.splice(insertIndex, 0, nextTrack);
  }
  return nextTrack;
}

function sortClips(clips: MovieClip[]): MovieClip[] {
  return [...clips].sort((left, right) => {
    if (left.startFrame !== right.startFrame) {
      return left.startFrame - right.startFrame;
    }
    return left.id.localeCompare(right.id);
  });
}

function sortTrackClipsInPlace(track: MovieTrack): void {
  track.clips = sortClips(track.clips);
}

function clipsOverlap(left: MovieClip, right: MovieClip): boolean {
  return left.startFrame < getMovieClipEndFrame(right)
    && right.startFrame < getMovieClipEndFrame(left);
}

function canPlaceClipOnTrack(
  track: MovieTrack,
  clip: MovieClip,
  ignoreClipId: string | null = null,
): boolean {
  return track.kind === getTrackKindForClip(clip)
    && track.clips.every((existingClip) => existingClip.id === ignoreClipId || !clipsOverlap(existingClip, clip));
}

function createTrackId(usedTrackIds: Set<string>, kind: MovieTrackKind): string {
  let count = 1;
  while (usedTrackIds.has(`${kind}-track-${count}`)) {
    count += 1;
  }
  const nextId = `${kind}-track-${count}`;
  usedTrackIds.add(nextId);
  return nextId;
}

function repackAudioTracks(timeline: MovieTimelineDefinition): void {
  const existingAudioTracks = timeline.tracks.filter((track) => track.kind === 'audio');
  const firstAudioIndex = timeline.tracks.findIndex((track) => track.kind === 'audio');
  const insertIndex = firstAudioIndex >= 0
    ? firstAudioIndex
    : timeline.tracks.findIndex((track) => track.kind === 'react');
  const normalizedInsertIndex = insertIndex >= 0 ? insertIndex : timeline.tracks.length;
  const seedTrack = existingAudioTracks[0];
  const firstTrackName = seedTrack?.name?.trim() || 'Audio 1';
  const additionalTrackNameBase = firstTrackName.replace(/\s+\d+$/, '');
  const sortedAudioClips = sortClips(
    existingAudioTracks.flatMap((track) => track.clips),
  ) as MovieAudioClip[];
  const usedTrackIds = new Set(timeline.tracks.map((track) => track.id));

  const packedTracks = existingAudioTracks.map((track) => ({
    ...track,
    clips: [] as MovieClip[],
  }));

  if (packedTracks.length === 0) {
    packedTracks.push({
      id: createTrackId(usedTrackIds, 'audio'),
      kind: 'audio',
      name: firstTrackName,
      clips: [],
    });
  }

  for (const clip of sortedAudioClips) {
    let targetTrack = packedTracks.find((track) =>
      track.clips.every((existingClip) => !clipsOverlap(existingClip, clip)));

    if (!targetTrack) {
      targetTrack = {
        id: createTrackId(usedTrackIds, 'audio'),
        kind: 'audio',
        name: `${additionalTrackNameBase} ${packedTracks.length + 1}`,
        clips: [],
      };
      packedTracks.push(targetTrack);
    }

    targetTrack.clips.push(clip);
  }

  const keptAudioTracks = packedTracks
    .filter((track, index) => index === 0 || track.clips.length > 0)
    .map((track, index) => ({
      ...track,
      name: index === 0 ? firstTrackName : `${additionalTrackNameBase} ${index + 1}`,
      clips: sortClips(track.clips),
    }));

  const nonAudioTracks = timeline.tracks.filter((track) => track.kind !== 'audio');
  timeline.tracks = [
    ...nonAudioTracks.slice(0, normalizedInsertIndex),
    ...keptAudioTracks,
    ...nonAudioTracks.slice(normalizedInsertIndex),
  ];
}

function findAvailableTrackForClip(
  timeline: MovieTimelineDefinition,
  clip: MovieClip,
  preferredTrackId: string | null = null,
): MovieTrack {
  const kind = getTrackKindForClip(clip);

  if (preferredTrackId) {
    const preferredTrack = timeline.tracks.find((track) => track.id === preferredTrackId);
    if (preferredTrack && canPlaceClipOnTrack(preferredTrack, clip, clip.id)) {
      return preferredTrack;
    }
  }

  const existingTrack = timeline.tracks.find((track) => canPlaceClipOnTrack(track, clip, clip.id));
  if (existingTrack) {
    return existingTrack;
  }

  return createTrack(timeline, kind);
}

function createVideoClip(
  asset: MovieAsset,
  timeline: MovieTimelineDefinition,
  startFrame: number,
  linkedAudioClipId: string | null,
): MovieVideoClip {
  return {
    id: createMovieId('movie-video-clip'),
    kind: 'video',
    label: asset.label,
    assetId: asset.id,
    startFrame,
    sourceStartFrame: 0,
    sourceEndFrame: asset.durationInFrames,
    linkedAudioClipId,
    muted: asset.hasAudio,
    metadata: {},
    style: createDefaultVideoStyle(asset, timeline),
  };
}

function createAudioClip(
  asset: MovieAsset,
  startFrame: number,
  linkedVideoClipId: string | null,
): MovieAudioClip {
  return {
    id: createMovieId('movie-audio-clip'),
    kind: 'audio',
    label: asset.kind === 'video' ? `Audio · ${asset.label}` : asset.label,
    assetId: asset.id,
    startFrame,
    sourceStartFrame: 0,
    sourceEndFrame: asset.durationInFrames,
    linkedVideoClipId,
    muted: false,
    volume: 1,
    metadata: {},
  };
}

function createDefaultVideoStyle(
  asset: MovieAsset,
  timeline: MovieTimelineDefinition,
): MovieVisualStyle {
  const canvasWidth = timeline.settings.width;
  const canvasHeight = timeline.settings.height;
  const assetWidth = asset.width ?? canvasWidth;
  const assetHeight = asset.height ?? canvasHeight;

  if (assetWidth <= 0 || assetHeight <= 0) {
    return createMovieVisualStyle(canvasWidth, canvasHeight);
  }

  const scale = Math.min(canvasWidth / assetWidth, canvasHeight / assetHeight);
  const width = Math.max(1, Math.round(assetWidth * scale));
  const height = Math.max(1, Math.round(assetHeight * scale));
  const style = createMovieVisualStyle(width, height);
  style.x = Math.round((canvasWidth - width) / 2);
  style.y = Math.round((canvasHeight - height) / 2);
  return style;
}

function findClipLocation(
  timeline: MovieTimelineDefinition,
  clipId: string,
): { track: MovieTrack; clip: MovieClip; trackIndex: number; clipIndex: number } | null {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex += 1) {
    const track = timeline.tracks[trackIndex];
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
    if (clipIndex >= 0) {
      return {
        track,
        clip: track.clips[clipIndex],
        trackIndex,
        clipIndex,
      };
    }
  }
  return null;
}

function getLinkedClipId(clip: MovieClip): string | null {
  if (clip.kind === 'video') {
    return clip.linkedAudioClipId;
  }
  if (clip.kind === 'audio') {
    return clip.linkedVideoClipId;
  }
  return null;
}

function withUpdatedClip(
  timeline: MovieTimelineDefinition,
  clipId: string,
  updater: (clip: MovieClip) => MovieClip,
): void {
  const location = findClipLocation(timeline, clipId);
  if (!location) {
    return;
  }
  location.track.clips[location.clipIndex] = updater(location.clip);
}

function replaceOrRemoveClip(
  timeline: MovieTimelineDefinition,
  clipId: string,
  replacement: MovieClip | null,
): MovieClip | null {
  const location = findClipLocation(timeline, clipId);
  if (!location) {
    return null;
  }

  if (!replacement) {
    location.track.clips.splice(location.clipIndex, 1);
    return null;
  }

  location.track.clips[location.clipIndex] = replacement;
  sortTrackClipsInPlace(location.track);
  return replacement;
}

function trimClipStart(clip: MovieClip, nextStartFrame: number): MovieClip | null {
  const clipEndFrame = getMovieClipEndFrame(clip);
  const clampedStart = Math.max(clip.startFrame, Math.min(nextStartFrame, clipEndFrame));
  const trimmedDuration = clipEndFrame - clampedStart;
  if (trimmedDuration <= 0) {
    return null;
  }

  const deltaFrames = clampedStart - clip.startFrame;
  return {
    ...clip,
    startFrame: clampedStart,
    sourceStartFrame: clip.sourceStartFrame + deltaFrames,
  };
}

function trimClipEnd(clip: MovieClip, nextEndFrame: number): MovieClip | null {
  const clipEndFrame = getMovieClipEndFrame(clip);
  const clampedEnd = Math.max(clip.startFrame, Math.min(nextEndFrame, clipEndFrame));
  const trimmedDuration = clampedEnd - clip.startFrame;
  if (trimmedDuration <= 0) {
    return null;
  }

  return {
    ...clip,
    sourceEndFrame: clip.sourceStartFrame + trimmedDuration,
  };
}

function syncLinkedClipRange(
  timeline: MovieTimelineDefinition,
  clip: MovieClip,
  replacement: MovieClip | null,
): void {
  const linkedClipId = getLinkedClipId(clip);
  if (!linkedClipId) {
    return;
  }

  const linkedLocation = findClipLocation(timeline, linkedClipId);
  if (!linkedLocation) {
    return;
  }

  if (!replacement) {
    linkedLocation.track.clips.splice(linkedLocation.clipIndex, 1);
    return;
  }

  linkedLocation.track.clips[linkedLocation.clipIndex] = {
    ...linkedLocation.clip,
    startFrame: replacement.startFrame,
    sourceStartFrame: replacement.sourceStartFrame,
    sourceEndFrame: replacement.sourceEndFrame,
  };
  sortTrackClipsInPlace(linkedLocation.track);
}

function replaceOrRemoveClipWithLinkedSync(
  timeline: MovieTimelineDefinition,
  clipId: string,
  replacement: MovieClip | null,
): void {
  const location = findClipLocation(timeline, clipId);
  if (!location) {
    return;
  }

  const originalClip = location.clip;
  const nextClip = replaceOrRemoveClip(timeline, clipId, replacement);
  syncLinkedClipRange(timeline, originalClip, nextClip);
}

function overwriteTrackConflicts(
  timeline: MovieTimelineDefinition,
  trackId: string,
  clipId: string,
): void {
  const location = findClipLocation(timeline, clipId);
  if (!location || location.track.id !== trackId) {
    return;
  }

  const activeClip = location.clip;
  const activeClipEndFrame = getMovieClipEndFrame(activeClip);
  const conflictingClipIds = sortClips(
    location.track.clips.filter((candidate) => candidate.id !== clipId && clipsOverlap(candidate, activeClip)),
  ).map((candidate) => candidate.id);

  for (const conflictingClipId of conflictingClipIds) {
    const conflictLocation = findClipLocation(timeline, conflictingClipId);
    if (!conflictLocation || conflictLocation.track.id !== trackId) {
      continue;
    }

    const conflictClip = conflictLocation.clip;
    if (!clipsOverlap(conflictClip, activeClip)) {
      continue;
    }

    const replacement = conflictClip.startFrame < activeClip.startFrame
      ? trimClipEnd(conflictClip, activeClip.startFrame)
      : trimClipStart(conflictClip, activeClipEndFrame);
    replaceOrRemoveClipWithLinkedSync(timeline, conflictClip.id, replacement);
  }
}

function clampClipRange(
  startFrame: number,
  sourceStartFrame: number,
  sourceEndFrame: number,
  sourceDurationInFrames: number,
): { startFrame: number; sourceStartFrame: number; sourceEndFrame: number } {
  const clampedStart = Math.max(0, Math.min(sourceStartFrame, sourceDurationInFrames - 1));
  const clampedEnd = Math.max(clampedStart + 1, Math.min(sourceEndFrame, sourceDurationInFrames));
  return {
    startFrame: Math.max(0, startFrame),
    sourceStartFrame: clampedStart,
    sourceEndFrame: clampedEnd,
  };
}

export function insertMovieAssetAtPlayhead(
  timeline: MovieTimelineDefinition,
  asset: MovieAsset,
  startFrame = timeline.playheadFrame,
): InsertMovieAssetResult {
  const nextTimeline = cloneMovieTimeline(timeline);
  const createdClipIds: string[] = [];

  if (asset.kind === 'video') {
    const linkedAudioClip = asset.hasAudio ? createAudioClip(asset, startFrame, null) : null;
    const videoClip = createVideoClip(asset, nextTimeline, startFrame, linkedAudioClip?.id ?? null);
    const videoTrack = findAvailableTrackForClip(nextTimeline, videoClip);

    if (linkedAudioClip) {
      linkedAudioClip.linkedVideoClipId = videoClip.id;
      const audioTrack = findAvailableTrackForClip(nextTimeline, linkedAudioClip);
      audioTrack.clips.push(linkedAudioClip);
      sortTrackClipsInPlace(audioTrack);
      createdClipIds.push(linkedAudioClip.id);
    }

    videoTrack.clips.push(videoClip);
    sortTrackClipsInPlace(videoTrack);
    createdClipIds.unshift(videoClip.id);
  } else {
    const audioClip = createAudioClip(asset, startFrame, null);
    const audioTrack = findAvailableTrackForClip(nextTimeline, audioClip);
    audioTrack.clips.push(audioClip);
    sortTrackClipsInPlace(audioTrack);
    createdClipIds.push(audioClip.id);
  }

  repackAudioTracks(nextTimeline);

  return {
    timeline: ensureMovieTimelineDuration(nextTimeline),
    createdClipIds,
  };
}

export function unlinkMovieClipAudio(
  timeline: MovieTimelineDefinition,
  clipId: string,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  const location = findClipLocation(nextTimeline, clipId);
  if (!location) {
    return nextTimeline;
  }

  const linkedClipId = getLinkedClipId(location.clip);
  if (!linkedClipId) {
    return nextTimeline;
  }

  withUpdatedClip(nextTimeline, clipId, (clip) => {
    if (clip.kind === 'video') {
      return { ...clip, linkedAudioClipId: null };
    }
    if (clip.kind === 'audio') {
      return { ...clip, linkedVideoClipId: null };
    }
    return clip;
  });

  withUpdatedClip(nextTimeline, linkedClipId, (clip) => {
    if (clip.kind === 'video') {
      return { ...clip, linkedAudioClipId: null };
    }
    if (clip.kind === 'audio') {
      return { ...clip, linkedVideoClipId: null };
    }
    return clip;
  });

  return nextTimeline;
}

export function updateMovieClipTiming(
  timeline: MovieTimelineDefinition,
  clipId: string,
  patch: {
    startFrame?: number;
    sourceStartFrame?: number;
    sourceEndFrame?: number;
    trackId?: string;
  },
  syncLinkedAudio = true,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  const location = findClipLocation(nextTimeline, clipId);
  if (!location) {
    return nextTimeline;
  }

  const assetId = (location.clip.kind === 'react' ? null : location.clip.assetId);
  const assetDuration = assetId
    ? nextTimeline.assets.find((asset) => asset.id === assetId)?.durationInFrames ?? getMovieClipDurationInFrames(location.clip)
    : getMovieClipDurationInFrames(location.clip);

  const nextRange = clampClipRange(
    patch.startFrame ?? location.clip.startFrame,
    patch.sourceStartFrame ?? location.clip.sourceStartFrame,
    patch.sourceEndFrame ?? location.clip.sourceEndFrame,
    assetDuration,
  );

  let targetTrack = location.track;
  if (patch.trackId && patch.trackId !== location.track.id) {
    const nextTrack = nextTimeline.tracks.find((track) =>
      track.id === patch.trackId && track.kind === location.track.kind);
    if (nextTrack) {
      targetTrack = nextTrack;
      location.track.clips.splice(location.clipIndex, 1);
      targetTrack.clips.push(location.clip);
    }
  }

  const targetIndex = targetTrack.clips.findIndex((clip) => clip.id === clipId);
  if (targetIndex === -1) {
    return nextTimeline;
  }

  const applyTiming = (clip: MovieClip): MovieClip => ({
    ...clip,
    startFrame: nextRange.startFrame,
    sourceStartFrame: nextRange.sourceStartFrame,
    sourceEndFrame: nextRange.sourceEndFrame,
  });

  targetTrack.clips[targetIndex] = applyTiming(targetTrack.clips[targetIndex]);
  sortTrackClipsInPlace(targetTrack);

  const linkedClipId = syncLinkedAudio ? getLinkedClipId(location.clip) : null;
  if (linkedClipId) {
    withUpdatedClip(nextTimeline, linkedClipId, applyTiming);
  }

  if (targetTrack.kind !== 'audio') {
    overwriteTrackConflicts(nextTimeline, targetTrack.id, clipId);
  }

  repackAudioTracks(nextTimeline);
  return ensureMovieTimelineDuration(nextTimeline);
}

export function updateMovieClipMetadata(
  timeline: MovieTimelineDefinition,
  clipId: string,
  metadata: MovieJsonObject,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  withUpdatedClip(nextTimeline, clipId, (clip) => ({ ...clip, metadata }));
  return nextTimeline;
}

export function updateMovieReactClipProps(
  timeline: MovieTimelineDefinition,
  clipId: string,
  props: MovieJsonObject,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  withUpdatedClip(nextTimeline, clipId, (clip) => {
    if (clip.kind !== 'react') {
      return clip;
    }
    return { ...clip, props };
  });
  return nextTimeline;
}

export function updateMovieClipStyle(
  timeline: MovieTimelineDefinition,
  clipId: string,
  patch: Partial<MovieVideoClip['style'] | MovieReactClip['style']>,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  withUpdatedClip(nextTimeline, clipId, (clip) => {
    if (clip.kind !== 'video' && clip.kind !== 'react') {
      return clip;
    }
    return {
      ...clip,
      style: {
        ...clip.style,
        ...patch,
        crop: {
          ...clip.style.crop,
          ...(patch as Partial<MovieVideoClip['style']>).crop,
        },
      },
    };
  });
  return nextTimeline;
}

export function updateMovieAssetEntry(
  timeline: MovieTimelineDefinition,
  asset: MovieAsset,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  const index = nextTimeline.assets.findIndex((candidate) => candidate.id === asset.id);
  if (index >= 0) {
    nextTimeline.assets[index] = asset;
  } else {
    nextTimeline.assets.push(asset);
  }
  return ensureMovieTimelineDuration(nextTimeline);
}

export function setMoviePlayheadFrame(
  timeline: MovieTimelineDefinition,
  playheadFrame: number,
): MovieTimelineDefinition {
  return {
    ...timeline,
    playheadFrame: Math.max(0, Math.min(playheadFrame, timeline.settings.durationInFrames)),
  };
}

export function removeMovieClip(
  timeline: MovieTimelineDefinition,
  clipId: string,
): MovieTimelineDefinition {
  const nextTimeline = cloneMovieTimeline(timeline);
  const location = findClipLocation(nextTimeline, clipId);
  if (!location) {
    return nextTimeline;
  }

  const clipIdsToRemove = new Set<string>([clipId]);
  const linkedClipId = getLinkedClipId(location.clip);
  if (linkedClipId) {
    clipIdsToRemove.add(linkedClipId);
  }

  nextTimeline.tracks = nextTimeline.tracks.map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => !clipIdsToRemove.has(clip.id)),
  }));

  repackAudioTracks(nextTimeline);
  return ensureMovieTimelineDuration(nextTimeline);
}
