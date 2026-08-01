import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './fixtures';
import {
  getTestWorkspace,
  setWorkspace,
  waitForAppReady,
  waitForFileTreeLoaded,
} from './helpers';
import { sel } from './selectors';
import { parseMovieTimelineModule } from '../shared/movie-scaffold';

async function dragExplorerFileToTarget(
  page: import('@playwright/test').Page,
  sourcePath: string,
  targetSelector: string,
): Promise<void> {
  await page.evaluate(({ sourcePath, targetSelector }) => {
    const targetEl = document.querySelector(targetSelector) as HTMLElement | null;

    if (!targetEl) {
      throw new Error('Drag target missing');
    }

    const getPathFilename = (filePath: string): string => {
      const normalizedPath = filePath.split('\\').join('/');
      const lastSeparatorIndex = normalizedPath.lastIndexOf('/');
      return lastSeparatorIndex >= 0 ? normalizedPath.slice(lastSeparatorIndex + 1) : normalizedPath;
    };

    const toFileUri = (filePath: string): string => {
      const normalizedPath = filePath.split('\\').join('/');
      if (/^[A-Za-z]:\//.test(normalizedPath)) {
        return `file:///${encodeURI(normalizedPath)}`;
      }
      if (normalizedPath.startsWith('//')) {
        return `file://${encodeURI(normalizedPath.slice(2))}`;
      }
      return `file://${encodeURI(normalizedPath)}`;
    };

    const targetRect = targetEl.getBoundingClientRect();
    const clientX = targetRect.left + (targetRect.width / 2);
    const clientY = targetRect.top + Math.min(160, Math.max(48, targetRect.height * 0.25));
    const fileName = getPathFilename(sourcePath) || sourcePath;
    const dataTransfer = new DataTransfer();
    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('application/json', JSON.stringify({
      type: 'file',
      sourceContext: 'explorer',
      filePath: sourcePath,
      fileName,
      isDirectory: false,
    }));
    dataTransfer.setData('text/uri-list', toFileUri(sourcePath));

    const createSyntheticDragEvent = (type: 'dragenter' | 'dragover' | 'drop'): DragEvent => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        dataTransfer,
      });
      (event as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic = true;
      return event;
    };

    targetEl.dispatchEvent(createSyntheticDragEvent('dragenter'));
    targetEl.dispatchEvent(createSyntheticDragEvent('dragover'));
    targetEl.dispatchEvent(createSyntheticDragEvent('drop'));
  }, { sourcePath, targetSelector });
}

test.describe('Movie editor', () => {
  let testWorkspace: string;

  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    testWorkspace = getTestWorkspace();
    await setWorkspace(page, testWorkspace);
    await waitForFileTreeLoaded(page);
  });

  test('references explorer media, stacks audio lanes, trims handles, and persists timeline edits', async ({ page }) => {
    test.slow();

    const createResult = await page.evaluate(async (workspacePath) => {
      return await (window as any).electron.files.create('movie', workspacePath);
    }, testWorkspace);

    expect(createResult?.success).toBe(true);
    const manifestPath = createResult?.path as string;
    expect(manifestPath).toBeTruthy();

    await page.evaluate((pathToOpen) => {
      (window as any).__layoutContext?.openFile(pathToOpen);
    }, manifestPath);

    await expect(page.locator(sel('movieViewer'))).toBeVisible({ timeout: 15000 });
    await expect(page.locator(sel('movieTimeline'))).toBeVisible({ timeout: 15000 });

    const sampleVideoPath = path.join(testWorkspace, 'media', 'sample-video.mp4');
    const musicPath = path.join(testWorkspace, 'media', 'music.mp3');

    await dragExplorerFileToTarget(page, sampleVideoPath, sel('movieViewer'));

    await expect.poll(async () => {
      return page.locator(`${sel('movieTimeline')} [data-testid^="movie-clip-"]`).count();
    }, { timeout: 20000 }).toBeGreaterThanOrEqual(2);

    await expect(page.locator(sel('movieUnlinkAudioButton'))).toBeVisible({ timeout: 10000 });

    await dragExplorerFileToTarget(page, musicPath, sel('movieViewer'));

    await expect.poll(async () => {
      return page.locator(`${sel('movieTimeline')} [data-testid^="movie-clip-"]`).count();
    }, { timeout: 20000 }).toBeGreaterThanOrEqual(3);

    const firstClip = page.locator(`${sel('movieTimeline')} [data-testid^="movie-clip-"]`).first();
    await expect(firstClip).toBeVisible({ timeout: 10000 });
    await firstClip.click();
    await expect(page.locator(sel('movieUnlinkAudioButton'))).toBeVisible({ timeout: 10000 });

    await page.locator(sel('movieUnlinkAudioButton')).click();

    const trimHandle = firstClip.locator('[data-movie-handle="end"]').first();
    const handleBox = await trimHandle.boundingBox();
    const clipBox = await firstClip.boundingBox();
    const timelineBox = await page.locator(sel('movieTimeline')).boundingBox();
    if (!handleBox) {
      throw new Error('Trim handle is not visible');
    }
    if (!clipBox || !timelineBox) {
      throw new Error('Timeline geometry is unavailable');
    }

    await trimHandle.dragTo(page.locator(sel('movieTimeline')), {
      force: true,
      sourcePosition: {
        x: handleBox.width / 2,
        y: handleBox.height / 2,
      },
      targetPosition: {
        x: Math.max(16, (clipBox.x + clipBox.width - 140) - timelineBox.x),
        y: Math.max(16, (clipBox.y + (clipBox.height / 2)) - timelineBox.y),
      },
    });

    const timelinePath = path.join(path.dirname(manifestPath), 'timeline.tsx');

    await expect.poll(async () => {
      const source = await fs.readFile(timelinePath, 'utf8');
      const timeline = parseMovieTimelineModule(source);
      const videoTrack = timeline.tracks.find((track) => track.kind === 'video');
      const audioTracks = timeline.tracks.filter((track) => track.kind === 'audio');
      const totalAudioClips = audioTracks.reduce((total, track) => total + track.clips.length, 0);
      const sampleVideoAsset = timeline.assets.find((asset) => asset.label === 'sample-video.mp4');
      const musicAsset = timeline.assets.find((asset) => asset.label === 'music.mp3');

      if (!videoTrack || !sampleVideoAsset || !musicAsset) {
        return false;
      }

      const videoClip = videoTrack.clips[0];
      const linkedAudioClip = audioTracks
        .flatMap((track) => track.clips)
        .find((clip) => clip.kind === 'audio' && clip.assetId === sampleVideoAsset.id);

      if (videoClip.kind !== 'video' || !linkedAudioClip || linkedAudioClip.kind !== 'audio') {
        throw new Error('Movie timeline persisted invalid clip kinds');
      }

      return (
        videoTrack.clips.length === 1
        && audioTracks.length === 2
        && totalAudioClips === 2
        && videoClip.linkedAudioClipId === null
        && linkedAudioClip.linkedVideoClipId === null
        && sampleVideoAsset.sourceMode === 'reference'
        && musicAsset.sourceMode === 'reference'
        && videoClip.style.width >= 1000
        && videoClip.sourceEndFrame < 300
      );
    }, { timeout: 10000 }).toBe(true);

    const persistedTimelineSource = await fs.readFile(timelinePath, 'utf8');
    const persistedTimeline = parseMovieTimelineModule(persistedTimelineSource);
    const persistedVideoTrack = persistedTimeline.tracks.find((track) => track.kind === 'video');
    if (!persistedVideoTrack || persistedVideoTrack.clips[0]?.kind !== 'video') {
      throw new Error('Persisted movie timeline is missing the video clip');
    }

    expect(persistedVideoTrack.clips[0].sourceEndFrame).toBeLessThan(300);
  });

  test('dropping overlapping videos creates separate video and audio tracks', async ({ page }) => {
    const createResult = await page.evaluate(async (workspacePath) => {
      return await (window as any).electron.files.create('movie', workspacePath);
    }, testWorkspace);

    expect(createResult?.success).toBe(true);
    const manifestPath = createResult?.path as string;
    expect(manifestPath).toBeTruthy();

    await page.evaluate((pathToOpen) => {
      (window as any).__layoutContext?.openFile(pathToOpen);
    }, manifestPath);

    await expect(page.locator(sel('movieViewer'))).toBeVisible({ timeout: 15000 });
    await expect(page.locator(sel('movieTimeline'))).toBeVisible({ timeout: 15000 });

    const sampleVideoPath = path.join(testWorkspace, 'media', 'sample-video.mp4');

    await dragExplorerFileToTarget(page, sampleVideoPath, sel('movieViewer'));

    await expect.poll(async () => {
      return page.locator(`${sel('movieTimeline')} [data-testid^="movie-clip-"]`).count();
    }, { timeout: 20000 }).toBeGreaterThanOrEqual(2);

    await dragExplorerFileToTarget(page, sampleVideoPath, sel('movieViewer'));

    await expect.poll(async () => {
      return page.locator(`${sel('movieTimeline')} [data-testid^="movie-clip-"]`).count();
    }, { timeout: 20000 }).toBeGreaterThanOrEqual(4);

    const timelinePath = path.join(path.dirname(manifestPath), 'timeline.tsx');

    await expect.poll(async () => {
      const source = await fs.readFile(timelinePath, 'utf8');
      const timeline = parseMovieTimelineModule(source);
      const videoTracks = timeline.tracks.filter((track) => track.kind === 'video');
      const audioTracks = timeline.tracks.filter((track) => track.kind === 'audio');
      const totalVideoClips = videoTracks.reduce((total, track) => total + track.clips.length, 0);
      const totalAudioClips = audioTracks.reduce((total, track) => total + track.clips.length, 0);

      return (
        videoTracks.length === 2
        && totalVideoClips === 2
        && videoTracks.every((track) => track.clips.length === 1)
        && audioTracks.length === 2
        && totalAudioClips === 2
        && audioTracks.every((track) => track.clips.length === 1)
      );
    }, { timeout: 10000 }).toBe(true);
  });

  test('expands a recorder source preview into a large modal', async ({ page }) => {
    const createResult = await page.evaluate(async (workspacePath) => {
      return await (window as any).electron.files.create('movie', workspacePath);
    }, testWorkspace);

    expect(createResult?.success).toBe(true);
    const manifestPath = createResult?.path as string;
    expect(manifestPath).toBeTruthy();

    await page.evaluate((pathToOpen) => {
      (window as any).__layoutContext?.openFile(pathToOpen);
    }, manifestPath);

    await expect(page.locator(sel('movieViewer'))).toBeVisible({ timeout: 15000 });
    await expect(page.locator(sel.movieSourcePreviewExpandButtonAny()).first()).toBeVisible({ timeout: 15000 });

    await page.locator(sel.movieSourcePreviewExpandButtonAny()).first().click();
    await expect(page.locator(sel('movieSourcePreviewModal'))).toBeVisible({ timeout: 10000 });
    await expect(page.locator(sel('movieSourcePreviewDelaySlider'))).toBeVisible({ timeout: 10000 });
    await expect(page.locator(sel('movieSourcePreviewCloseButton'))).toBeVisible({ timeout: 10000 });

    await page.locator(sel('movieSourcePreviewCloseButton')).click();
    await expect(page.locator(sel('movieSourcePreviewModal'))).toBeHidden({ timeout: 10000 });
  });
});
