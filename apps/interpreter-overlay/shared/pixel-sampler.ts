import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RelativeBBox } from './types.js';

const require = createRequire(process.execPath);

type DecodedBitmap = {
  width: number;
  height: number;
  bytesPerRow: number;
  data: Buffer;
};

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

const decodedBitmapCache = new Map<string, DecodedBitmap>();
const DOMINANT_COLOR_MIN_SHARE = 0.2;

function getElectronNativeImage(): typeof import('electron').nativeImage {
  if (!process.versions.electron) {
    throw new Error('Electron nativeImage is unavailable outside Electron runtime.');
  }

  return (require('electron') as typeof import('electron')).nativeImage;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function decodeBitmap(screenshotBase64: string): DecodedBitmap {
  const cached = decodedBitmapCache.get(screenshotBase64);
  if (cached) {
    return cached;
  }

  const nativeImage = getElectronNativeImage();
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${screenshotBase64}`);
  if (image.isEmpty()) {
    throw new Error('Failed to decode screenshot buffer data URL with nativeImage.');
  }

  const size = image.getSize();
  const data = image.toBitmap();
  const bytesPerRow = Math.floor(data.length / Math.max(1, size.height));
  const decoded = {
    width: size.width,
    height: size.height,
    bytesPerRow,
    data,
  };
  decodedBitmapCache.set(screenshotBase64, decoded);
  return decoded;
}

function readPixel(bitmap: DecodedBitmap, x: number, y: number): RgbColor {
  const px = clamp(x, 0, bitmap.width - 1);
  const py = clamp(y, 0, bitmap.height - 1);
  const idx = py * bitmap.bytesPerRow + px * 4;

  // Electron nativeImage bitmap bytes are BGRA.
  return {
    r: bitmap.data[idx + 2] ?? 255,
    g: bitmap.data[idx + 1] ?? 255,
    b: bitmap.data[idx] ?? 255,
  };
}

function colorToHex(color: RgbColor): string {
  return `#${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`;
}

function saveSamplerDebugArtifacts(
  screenshotBase64: string,
  left: number,
  top: number,
  boxWidth: number,
  boxHeight: number,
): void {
  if (process.env.INTERPRETER_OVERLAY_SAMPLER_DEBUG !== '1') {
    return;
  }

  try {
    const outputDir = path.join(process.cwd(), 'form-tests', 'test-output', 'sampler-debug');
    fs.mkdirSync(outputDir, { recursive: true });
    const nativeImage = getElectronNativeImage();
    const image = nativeImage.createFromDataURL(`data:image/png;base64,${screenshotBase64}`);
    if (image.isEmpty()) {
      return;
    }

    const timestamp = Date.now();
    const fullPath = path.join(outputDir, `${timestamp}-full.png`);
    const cropPath = path.join(outputDir, `${timestamp}-crop.png`);
    const metaPath = path.join(outputDir, `${timestamp}-meta.json`);
    const cropRect = {
      x: Math.max(0, Math.floor(left)),
      y: Math.max(0, Math.floor(top)),
      width: Math.max(1, Math.ceil(boxWidth)),
      height: Math.max(1, Math.ceil(boxHeight)),
    };

    fs.writeFileSync(fullPath, Buffer.from(screenshotBase64, 'base64'));
    fs.writeFileSync(cropPath, image.crop(cropRect).toPNG());
    fs.writeFileSync(metaPath, `${JSON.stringify({ cropRect }, null, 2)}\n`);
    console.log(`[sampleCenterPixel] Saved sampler artifacts: ${cropPath}`);
  } catch (error) {
    console.warn('[sampleCenterPixel] Failed to save sampler artifacts:', error);
  }
}

export function sampleCenterPixel(screenshotBase64: string, bbox: RelativeBBox): string | null {
  try {
    const bitmap = decodeBitmap(screenshotBase64);
    const left = bbox.x_min * bitmap.width;
    const top = bbox.y_min * bitmap.height;
    const boxWidth = Math.max(1, (bbox.x_max - bbox.x_min) * bitmap.width);
    const boxHeight = Math.max(1, (bbox.y_max - bbox.y_min) * bitmap.height);
    saveSamplerDebugArtifacts(screenshotBase64, left, top, boxWidth, boxHeight);
    const innerInsetX = clamp(Math.round(boxWidth * 0.1), 6, 28);
    const innerInsetY = clamp(Math.round(boxHeight * 0.24), 5, 18);
    const innerLeft = Math.floor(left + innerInsetX);
    const innerTop = Math.floor(top + innerInsetY);
    const innerRight = Math.floor(left + boxWidth - innerInsetX);
    const innerBottom = Math.floor(top + boxHeight - innerInsetY);
    const bucketStats = new Map<string, number>();
    let sampleCount = 0;
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;

    for (let sampleY = innerTop; sampleY <= innerBottom; sampleY += 1) {
      for (let sampleX = innerLeft; sampleX <= innerRight; sampleX += 1) {
        const value = readPixel(bitmap, sampleX, sampleY);
        const key = `${value.r}-${value.g}-${value.b}`;
        bucketStats.set(key, (bucketStats.get(key) ?? 0) + 1);
        totalR += value.r;
        totalG += value.g;
        totalB += value.b;
        sampleCount += 1;
      }
    }
    if (sampleCount === 0) {
      return null;
    }

    let dominantBucketKey: string | null = null;
    let dominantBucketCount = 0;
    for (const [bucketKey, bucketCount] of bucketStats.entries()) {
      if (bucketCount > dominantBucketCount) {
        dominantBucketKey = bucketKey;
        dominantBucketCount = bucketCount;
      }
    }

    const dominantBucketShare = dominantBucketCount / sampleCount;
    const sampledColor = dominantBucketKey && dominantBucketShare >= DOMINANT_COLOR_MIN_SHARE
      ? (() => {
          const [r = '255', g = '255', b = '255'] = dominantBucketKey.split('-');
          return {
            r: Number.parseInt(r, 10),
            g: Number.parseInt(g, 10),
            b: Number.parseInt(b, 10),
          };
        })()
      : {
          r: Math.round(totalR / sampleCount),
          g: Math.round(totalG / sampleCount),
          b: Math.round(totalB / sampleCount),
        };
    const samplingMode = dominantBucketKey && dominantBucketShare >= DOMINANT_COLOR_MIN_SHARE
      ? 'dominant'
      : 'average';

    console.log(
      `[sampleCenterPixel] Sampled dominant interior color from (${innerLeft}, ${innerTop})-(${innerRight}, ${innerBottom}) `
      + `stride=1 in ${bitmap.width}x${bitmap.height}: `
      + `RGB(${sampledColor.r}, ${sampledColor.g}, ${sampledColor.b})`
      + ` mode=${samplingMode}`
      + (dominantBucketKey ? ` dominantCount=${dominantBucketCount} dominantShare=${dominantBucketShare.toFixed(3)}` : ''),
    );

    return colorToHex(sampledColor);
  } catch (error) {
    console.error('[sampleCenterPixel] Error sampling pixel:', error);
    return null;
  }
}
