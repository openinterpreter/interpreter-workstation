/**
 * Capture - Screenshot capture for the active display.
 *
 * Implements CapturePort using Electron's desktopCapturer.
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { INTERPRETER_OVERLAY_VISION_MODE as OVERLAY_VISION_MODE } from '../../shared/agent-mode.js';
import { INTERPRETER_OVERLAY_STRIP_RATIO } from '../../shared/layout.js';
import type { CapturePort, DisplayInfo } from '../../shared/ports.js';
import type { Bounds } from '../../shared/types.js';
import { clampBoundsToBounds } from '../../shared/scope.js';

const require = createRequire(process.execPath);
const VISION_CAPTURE_RETRY_COUNT = 6;
const VISION_CAPTURE_RETRY_DELAY_MS = 120;
const AX_CAPTURE_RETRY_COUNT = 3;
const AX_CAPTURE_RETRY_DELAY_MS = 120;
const execFileAsync = promisify(execFile);

interface CaptureHooks {
  beforeCapture?: () => Promise<void> | void;
  afterCapture?: () => Promise<void> | void;
}

function getElectronCaptureModule(): Pick<typeof import('electron'), 'desktopCapturer' | 'nativeImage' | 'screen'> {
  if (!process.versions.electron) {
    throw new Error('Electron capture is unavailable outside Electron runtime.');
  }

  return require('electron') as Pick<typeof import('electron'), 'desktopCapturer' | 'nativeImage' | 'screen'>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Capture implements CapturePort {
  constructor(private readonly hooks: CaptureHooks = {}) {}

  private async captureDisplayWithScreencapture(): Promise<Electron.NativeImage> {
    if (process.platform !== 'darwin') {
      throw new Error('screencapture fallback is only available on macOS.');
    }

    const { nativeImage } = getElectronCaptureModule();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interpreter-overlay-capture-'));
    const pngPath = path.join(dir, 'screen.png');
    try {
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-D', '1', pngPath], { timeout: 15000 });
      const image = nativeImage.createFromPath(pngPath);
      const size = image.getSize();
      console.log('[Capture] screencapture fallback size:', size);
      if (size.width <= 0 || size.height <= 0) {
        throw new Error('screencapture produced an empty image.');
      }
      return image;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private toDisplayInfo(electronDisplay: Electron.Display): DisplayInfo {
    console.log('[Capture] Display bounds:', JSON.stringify(electronDisplay.bounds));
    console.log('[Capture] Display workArea:', JSON.stringify(electronDisplay.workArea));
    console.log('[Capture] Display size:', JSON.stringify(electronDisplay.size));

    const menuBarHeight = electronDisplay.workArea.y - electronDisplay.bounds.y;
    console.log('[Capture] Calculated menu bar height:', menuBarHeight);

    const displayInfo: DisplayInfo = {
      id: String(electronDisplay.id),
      scaleFactor: electronDisplay.scaleFactor,
      boundsDIP: {
        x: electronDisplay.bounds.x,
        y: electronDisplay.bounds.y,
        width: electronDisplay.bounds.width,
        height: electronDisplay.bounds.height,
      },
    };
    console.log('[Capture] Returning displayInfo:', JSON.stringify(displayInfo));
    return displayInfo;
  }

  getActiveDisplay(): DisplayInfo {
    const { screen } = getElectronCaptureModule();
    const cursorPoint = screen.getCursorScreenPoint();
    const electronDisplay = screen.getDisplayNearestPoint(cursorPoint);

    if (!electronDisplay) {
      throw new Error('Could not find display at cursor position');
    }

    return this.toDisplayInfo(electronDisplay);
  }

  getDisplayById(displayId: string): DisplayInfo {
    const { screen } = getElectronCaptureModule();
    const electronDisplay = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId);
    if (!electronDisplay) {
      throw new Error(`Could not find display with id ${displayId}`);
    }

    return this.toDisplayInfo(electronDisplay);
  }

  private async captureDisplayImage(
    display: DisplayInfo,
    cropToStrip: boolean,
    cropBoundsDIP?: Bounds,
  ): Promise<{
    base64: string;
    display: DisplayInfo;
  }> {
    const { desktopCapturer } = getElectronCaptureModule();
    let sourceThumbnail: Electron.NativeImage | null = null;
    let sourceSize = { width: 0, height: 0 };
    let useLogicalCapture = OVERLAY_VISION_MODE;
    let requestedCaptureWidth = 0;
    let requestedCaptureHeight = 0;
    const maxAttempts = OVERLAY_VISION_MODE ? VISION_CAPTURE_RETRY_COUNT : AX_CAPTURE_RETRY_COUNT;
    const retryDelayMs = OVERLAY_VISION_MODE ? VISION_CAPTURE_RETRY_DELAY_MS : AX_CAPTURE_RETRY_DELAY_MS;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      requestedCaptureWidth = useLogicalCapture
        ? Math.floor(display.boundsDIP.width)
        : Math.floor(display.boundsDIP.width * display.scaleFactor);
      requestedCaptureHeight = useLogicalCapture
        ? Math.floor(display.boundsDIP.height)
        : Math.floor(display.boundsDIP.height * display.scaleFactor);

      console.log('[Capture] Requesting screenshot with size:', {
        targetWidth: requestedCaptureWidth,
        targetHeight: requestedCaptureHeight,
        useLogicalCapture,
        attempt: attempt + 1,
      });

      if (OVERLAY_VISION_MODE) {
        await this.hooks.beforeCapture?.();
      }

      let sources: Electron.DesktopCapturerSource[];
      try {
        sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: requestedCaptureWidth,
            height: requestedCaptureHeight,
          },
        });
      } finally {
        if (OVERLAY_VISION_MODE) {
          await this.hooks.afterCapture?.();
        }
      }

      if (sources.length === 0) {
        if (attempt === maxAttempts - 1) {
          throw new Error('No screen sources available for capture');
        }

        console.warn(
          `[Capture] No screen sources available; retrying in ${retryDelayMs}ms`,
        );
        await delay(retryDelayMs);
        continue;
      }

      console.log('[Capture] Got', sources.length, 'sources');

      const source = sources.find((s) => {
        const match = s.id.match(/^screen:(\d+):/);
        return match && match[1] === display.id;
      });

      if (!source) {
        console.warn(
          `Could not find exact match for display ${display.id}, using first available source`
        );
      }

      const selectedSource = source || sources[0];
      console.log('[Capture] Selected source:', selectedSource.id, 'attempt', attempt + 1);

      sourceThumbnail = selectedSource.thumbnail;
      sourceSize = sourceThumbnail.getSize();
      console.log('[Capture] Actual screenshot size:', sourceSize);

      if (sourceSize.width > 0 && sourceSize.height > 0) {
        break;
      }

      if (!useLogicalCapture && display.scaleFactor > 1) {
        console.warn('[Capture] Empty retina-sized screenshot; retrying with logical display pixels');
        useLogicalCapture = true;
      }

      if (attempt === maxAttempts - 1) {
        break;
      }

      console.warn(`[Capture] Received empty screenshot thumbnail; retrying in ${retryDelayMs}ms`);
      await delay(retryDelayMs);
    }

    if (!sourceThumbnail || sourceSize.width <= 0 || sourceSize.height <= 0) {
      console.warn('[Capture] Electron screen capture returned an empty image; trying macOS screencapture fallback.');
      sourceThumbnail = await this.captureDisplayWithScreencapture();
      sourceSize = sourceThumbnail.getSize();
    }

    const thumbnail = OVERLAY_VISION_MODE
      && (sourceSize.width !== requestedCaptureWidth || sourceSize.height !== requestedCaptureHeight)
      ? sourceThumbnail.resize({
          width: requestedCaptureWidth,
          height: requestedCaptureHeight,
          quality: 'best',
        })
      : sourceThumbnail;
    const actualSize = thumbnail.getSize();
    console.log('[Capture] Effective screenshot size:', actualSize);

    return this.encodeCapturedImage(thumbnail, display, cropToStrip, cropBoundsDIP);
  }

  private encodeCapturedImage(
    thumbnail: Electron.NativeImage,
    display: DisplayInfo,
    cropToStrip: boolean,
    cropBoundsDIP?: Bounds,
  ): {
    base64: string;
    display: DisplayInfo;
  } {
    const actualSize = thumbnail.getSize();
    console.log('[Capture] Effective screenshot size:', actualSize);

    const image = cropToStrip
      ? thumbnail.crop({
          x: 0,
          y: Math.floor(actualSize.height * (1 - INTERPRETER_OVERLAY_STRIP_RATIO)),
          width: actualSize.width,
          height: actualSize.height - Math.floor(actualSize.height * (1 - INTERPRETER_OVERLAY_STRIP_RATIO)),
        })
      : cropBoundsDIP
        ? (() => {
            const clamped = clampBoundsToBounds(cropBoundsDIP, display.boundsDIP);
            const localX = clamped.x - display.boundsDIP.x;
            const localY = clamped.y - display.boundsDIP.y;
            const scaleX = actualSize.width / display.boundsDIP.width;
            const scaleY = actualSize.height / display.boundsDIP.height;

            return thumbnail.crop({
              x: Math.max(0, Math.round(localX * scaleX)),
              y: Math.max(0, Math.round(localY * scaleY)),
              width: Math.max(1, Math.round(clamped.width * scaleX)),
              height: Math.max(1, Math.round(clamped.height * scaleY)),
            });
          })()
        : thumbnail;

    console.log(
      cropToStrip ? '[Capture] Cropped to bottom strip:' : '[Capture] Full-display screenshot:',
      image.getSize(),
    );

    console.log('[Capture] Encoding screenshot to PNG');
    const pngBytes = image.toPNG();
    console.log('[Capture] Encoded screenshot bytes:', pngBytes.length);
    const base64 = pngBytes.toString('base64');
    console.log('[Capture] Encoded screenshot base64 length:', base64.length);

    return {
      base64,
      display,
    };
  }

  async captureDisplay(
    display: DisplayInfo,
    cropBoundsDIP?: Bounds,
  ): Promise<{
    base64: string;
    display: DisplayInfo;
  }> {
    return this.captureDisplayImage(display, false, cropBoundsDIP);
  }

  async captureActiveDisplay(): Promise<{
    base64: string;
    display: DisplayInfo;
  }> {
    return this.captureDisplay(this.getActiveDisplay());
  }

  async captureDisplayStrip(display: DisplayInfo): Promise<{
    base64: string;
    display: DisplayInfo;
  }> {
    return this.captureDisplayImage(display, true);
  }

  async captureActiveDisplayStrip(): Promise<{
    base64: string;
    display: DisplayInfo;
  }> {
    return this.captureDisplayStrip(this.getActiveDisplay());
  }
}
