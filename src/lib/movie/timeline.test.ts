import { describe, expect, test } from 'bun:test';
import {
  createDefaultMovieTimeline,
  type MovieAsset,
} from '../../../shared/movie-schema';
import {
  parseMovieTimelineModule,
  renderMovieTimelineModule,
  replaceMovieTimelineJsonInModule,
} from '../../../shared/movie-scaffold';
import {
  insertMovieAssetAtPlayhead,
  removeMovieClip,
  unlinkMovieClipAudio,
  updateMovieClipTiming,
} from './timeline';

function makeVideoAsset(overrides: Partial<MovieAsset> = {}): MovieAsset {
  return {
    id: 'asset-video-1',
    kind: 'video',
    label: 'Camera',
    sourceMode: 'managed',
    path: 'assets/camera.mp4',
    sourceUrl: 'file:///tmp/camera.mp4',
    metadataPath: 'meta/asset-video-1.json',
    durationInFrames: 180,
    durationSeconds: 6,
    width: 1920,
    height: 1080,
    hasAudio: true,
    createdAt: 1,
    ...overrides,
  };
}

function makeAudioAsset(overrides: Partial<MovieAsset> = {}): MovieAsset {
  return {
    id: 'asset-audio-1',
    kind: 'audio',
    label: 'Music',
    sourceMode: 'reference',
    path: '/tmp/music.mp3',
    sourceUrl: 'file:///tmp/music.mp3',
    metadataPath: 'meta/asset-audio-1.json',
    durationInFrames: 180,
    durationSeconds: 6,
    width: null,
    height: null,
    hasAudio: true,
    createdAt: 1,
    ...overrides,
  };
}

describe('movie timeline scaffold', () => {
  test('round-trips generated timeline modules', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    timeline.playheadFrame = 42;
    timeline.assets.push(makeVideoAsset());

    const moduleContent = renderMovieTimelineModule(timeline);
    const parsed = parseMovieTimelineModule(moduleContent);

    expect(parsed).toEqual(timeline);
    expect(moduleContent.includes('parseMovieTimelineDefinition(String.raw`')).toBe(true);
    expect(moduleContent.includes('JSON.parse(String.raw`')).toBe(false);
  });

  test('replaces only the timeline JSON block inside the generated module', () => {
    const initialTimeline = createDefaultMovieTimeline('Movie');
    const initialModule = renderMovieTimelineModule(initialTimeline);

    const nextTimeline = createDefaultMovieTimeline('Movie');
    nextTimeline.playheadFrame = 99;
    nextTimeline.assets.push(makeVideoAsset());

    const updatedModule = replaceMovieTimelineJsonInModule(initialModule, nextTimeline);
    const parsed = parseMovieTimelineModule(updatedModule);

    expect(parsed).toEqual(nextTimeline);
    expect(updatedModule.includes("from './movie-runtime'")).toBe(true);
    expect(updatedModule.includes('export const movieTimeline = defineMovieTimeline')).toBe(true);
  });
});

describe('movie timeline operations', () => {
  test('inserting a video asset with audio creates linked video and audio clips', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    timeline.playheadFrame = 60;

    const result = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());

    const videoTrack = result.timeline.tracks.find((track) => track.kind === 'video');
    const audioTrack = result.timeline.tracks.find((track) => track.kind === 'audio');
    expect(videoTrack?.clips).toHaveLength(1);
    expect(audioTrack?.clips).toHaveLength(1);

    const videoClip = videoTrack!.clips[0];
    const audioClip = audioTrack!.clips[0];
    expect(videoClip.kind).toBe('video');
    expect(audioClip.kind).toBe('audio');
    expect(videoClip.startFrame).toBe(60);
    expect(audioClip.startFrame).toBe(60);
    expect((videoClip.kind === 'video' && videoClip.linkedAudioClipId) || null).toBe(audioClip.id);
    expect((audioClip.kind === 'audio' && audioClip.linkedVideoClipId) || null).toBe(videoClip.id);
    expect(audioClip.label).toContain('Audio');
  });

  test('new video clips fit the movie canvas instead of using source pixel size directly', () => {
    const timeline = createDefaultMovieTimeline('Movie');

    const result = insertMovieAssetAtPlayhead(timeline, makeVideoAsset({
      width: 320,
      height: 176,
    }));

    const videoTrack = result.timeline.tracks.find((track) => track.kind === 'video');
    const videoClip = videoTrack?.clips[0];
    if (!videoClip || videoClip.kind !== 'video') {
      throw new Error('Expected inserted video clip');
    }

    expect(videoClip.style.width).toBe(1920);
    expect(videoClip.style.height).toBe(1056);
    expect(videoClip.style.x).toBe(0);
    expect(videoClip.style.y).toBe(12);
  });

  test('moving a linked video clip moves its linked audio clip', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    const inserted = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());
    const videoClipId = inserted.createdClipIds[0];
    const moved = updateMovieClipTiming(inserted.timeline, videoClipId, {
      startFrame: 120,
      sourceStartFrame: 30,
      sourceEndFrame: 150,
    });

    const videoTrack = moved.tracks.find((track) => track.kind === 'video')!;
    const audioTrack = moved.tracks.find((track) => track.kind === 'audio')!;
    const videoClip = videoTrack.clips[0];
    const audioClip = audioTrack.clips[0];

    expect(videoClip.startFrame).toBe(120);
    expect(audioClip.startFrame).toBe(120);
    expect(videoClip.sourceStartFrame).toBe(30);
    expect(audioClip.sourceStartFrame).toBe(30);
    expect(videoClip.sourceEndFrame).toBe(150);
    expect(audioClip.sourceEndFrame).toBe(150);
  });

  test('unlinking a clip pair breaks both link references', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    const inserted = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());
    const videoClipId = inserted.createdClipIds[0];

    const unlinked = unlinkMovieClipAudio(inserted.timeline, videoClipId);
    const videoTrack = unlinked.tracks.find((track) => track.kind === 'video')!;
    const audioTrack = unlinked.tracks.find((track) => track.kind === 'audio')!;
    const videoClip = videoTrack.clips[0];
    const audioClip = audioTrack.clips[0];

    expect(videoClip.kind === 'video' ? videoClip.linkedAudioClipId : 'bad').toBeNull();
    expect(audioClip.kind === 'audio' ? audioClip.linkedVideoClipId : 'bad').toBeNull();
  });

  test('removing a linked clip removes its linked video and audio pair together', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    const inserted = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());
    const videoClipId = inserted.createdClipIds[0];

    const removed = removeMovieClip(inserted.timeline, videoClipId);
    const videoTracks = removed.tracks.filter((track) => track.kind === 'video');
    const audioTracks = removed.tracks.filter((track) => track.kind === 'audio');

    expect(videoTracks.every((track) => track.clips.length === 0)).toBe(true);
    expect(audioTracks.every((track) => track.clips.length === 0)).toBe(true);
  });

  test('removing an unlinked audio clip leaves the video clip in place', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    const inserted = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());
    const videoClipId = inserted.createdClipIds[0];
    const audioClipId = inserted.createdClipIds[1];
    const unlinked = unlinkMovieClipAudio(inserted.timeline, videoClipId);

    const removed = removeMovieClip(unlinked, audioClipId);
    const videoTrack = removed.tracks.find((track) => track.kind === 'video');
    const audioTracks = removed.tracks.filter((track) => track.kind === 'audio');

    expect(videoTrack?.clips).toHaveLength(1);
    expect(audioTracks.every((track) => track.clips.length === 0)).toBe(true);
  });

  test('overlapping audio clips are packed into separate audio tracks', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    timeline.playheadFrame = 0;

    const firstInsert = insertMovieAssetAtPlayhead(timeline, makeAudioAsset());
    const secondInsert = insertMovieAssetAtPlayhead(firstInsert.timeline, makeAudioAsset({
      id: 'asset-audio-2',
      label: 'Voiceover',
      path: '/tmp/voiceover.wav',
      sourceUrl: 'file:///tmp/voiceover.wav',
      metadataPath: 'meta/asset-audio-2.json',
    }));

    const audioTracks = secondInsert.timeline.tracks.filter((track) => track.kind === 'audio');
    const audioClipCount = audioTracks.reduce((total, track) => total + track.clips.length, 0);

    expect(audioTracks).toHaveLength(2);
    expect(audioClipCount).toBe(2);
    expect(audioTracks.every((track) => track.clips.length === 1)).toBe(true);
  });

  test('overlapping video inserts create separate video and audio tracks', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    timeline.playheadFrame = 0;

    const firstInsert = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());
    const secondInsert = insertMovieAssetAtPlayhead(firstInsert.timeline, makeVideoAsset({
      id: 'asset-video-2',
      label: 'Screen',
      path: 'assets/screen.mp4',
      sourceUrl: 'file:///tmp/screen.mp4',
      metadataPath: 'meta/asset-video-2.json',
    }));

    const videoTracks = secondInsert.timeline.tracks.filter((track) => track.kind === 'video');
    const audioTracks = secondInsert.timeline.tracks.filter((track) => track.kind === 'audio');
    const totalVideoClips = videoTracks.reduce((total, track) => total + track.clips.length, 0);
    const totalAudioClips = audioTracks.reduce((total, track) => total + track.clips.length, 0);

    expect(videoTracks).toHaveLength(2);
    expect(totalVideoClips).toBe(2);
    expect(videoTracks.every((track) => track.clips.length === 1)).toBe(true);
    expect(audioTracks).toHaveLength(2);
    expect(totalAudioClips).toBe(2);
    expect(audioTracks.every((track) => track.clips.length === 1)).toBe(true);
  });

  test('moving a video clip earlier on the same track trims the clip already on that track', () => {
    const timeline = createDefaultMovieTimeline('Movie');
    const firstInsert = insertMovieAssetAtPlayhead(timeline, makeVideoAsset());
    const secondInsert = insertMovieAssetAtPlayhead(firstInsert.timeline, makeVideoAsset({
      id: 'asset-video-2',
      label: 'Screen',
      path: 'assets/screen.mp4',
      sourceUrl: 'file:///tmp/screen.mp4',
      metadataPath: 'meta/asset-video-2.json',
    }), 180);

    const firstVideoClipId = firstInsert.createdClipIds[0];
    const secondVideoClipId = secondInsert.createdClipIds[0];
    const moved = updateMovieClipTiming(secondInsert.timeline, secondVideoClipId, {
      startFrame: 90,
    });

    const videoTrack = moved.tracks.find((track) => track.kind === 'video');
    const audioTrack = moved.tracks.find((track) => track.kind === 'audio');
    const firstVideoClip = videoTrack?.clips.find((clip) => clip.id === firstVideoClipId);
    const secondVideoClip = videoTrack?.clips.find((clip) => clip.id === secondVideoClipId);
    const firstAudioClip = audioTrack?.clips.find((clip) =>
      clip.kind === 'audio' && clip.linkedVideoClipId === firstVideoClipId);

    if (!firstVideoClip || !secondVideoClip || !firstAudioClip) {
      throw new Error('Expected both video clips and the trimmed linked audio clip');
    }

    expect(firstVideoClip.startFrame).toBe(0);
    expect(firstVideoClip.sourceEndFrame).toBe(90);
    expect(secondVideoClip.startFrame).toBe(90);
    expect(firstAudioClip.startFrame).toBe(0);
    expect(firstAudioClip.sourceEndFrame).toBe(90);
  });
});
