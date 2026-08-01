#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_ICON_PATH = path.join(ROOT, 'resources', 'icons', 'app.png');
const EXTENSION_ICON_DIR = path.join(ROOT, 'apps', 'interpreter-extension', 'extension', 'icons');
const WEBSITE_PUBLIC_DIR = path.join(ROOT, 'apps', 'interpreter-extension', 'website', 'public');
const STORE_ASSETS_DIR = path.join(ROOT, 'apps', 'interpreter-extension', 'store-assets');
const STORE_SCREENSHOT_SOURCE_PATH = path.join(
  ROOT,
  'apps',
  'interpreter-extension',
  'playwriter',
  'screenshot@2x.png',
);
const SIZES = [16, 32, 48, 128];

const BRAND = {
  idle: null,
  gray: { ring: '#7d838d', dot: '#7d838d', grayscale: true, brightness: 0.88, saturation: 0.25 },
  blue: { ring: '#2f6df6', dot: '#2f6df6' },
  green: { ring: '#1db56c', dot: '#1db56c' },
  red: { ring: '#db4d3f', dot: '#db4d3f' },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function decodePixels(input) {
  return sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function writePngIfPixelsChanged(targetPath, pngBuffer) {
  if (fs.existsSync(targetPath)) {
    const [current, next] = await Promise.all([
      decodePixels(targetPath),
      decodePixels(pngBuffer),
    ]);
    const sameShape =
      current.info.width === next.info.width &&
      current.info.height === next.info.height &&
      current.info.channels === next.info.channels;
    if (sameShape && current.data.equals(next.data)) {
      return false;
    }
  }

  fs.writeFileSync(targetPath, pngBuffer);
  return true;
}

function makeStatusOverlay({ ring, dot }) {
  return Buffer.from(
    `
      <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
        <defs>
          <filter id="ring-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="${ring}" flood-opacity="0.24" />
          </filter>
          <filter id="dot-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.32" />
          </filter>
        </defs>
        <rect
          x="54"
          y="54"
          width="916"
          height="916"
          rx="224"
          fill="none"
          stroke="${ring}"
          stroke-width="44"
          opacity="0.96"
          filter="url(#ring-shadow)"
        />
        <circle cx="812" cy="812" r="112" fill="${dot}" filter="url(#dot-shadow)" />
        <circle cx="812" cy="812" r="84" fill="${dot}" />
        <circle cx="812" cy="812" r="86" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="20" />
      </svg>
    `,
    'utf8',
  );
}

async function buildStateMaster(variantName) {
  const variant = BRAND[variantName];
  let pipeline = sharp(APP_ICON_PATH).resize(1024, 1024, { fit: 'contain' });
  if (variant?.grayscale) {
    pipeline = pipeline.grayscale().modulate({
      brightness: variant.brightness,
      saturation: variant.saturation,
    });
  }

  let output = pipeline.png();
  if (variant?.ring && variant?.dot) {
    output = output.composite([{ input: makeStatusOverlay(variant), blend: 'over' }]);
  }
  return output.png().toBuffer();
}

async function writeExtensionIcons() {
  ensureDir(EXTENSION_ICON_DIR);
  const variants = [
    ['black', 'idle'],
    ['gray', 'gray'],
    ['blue', 'blue'],
    ['green', 'green'],
    ['red', 'red'],
  ];

  for (const [filePrefix, variantName] of variants) {
    const master = await buildStateMaster(variantName);
    for (const size of SIZES) {
      const target = path.join(EXTENSION_ICON_DIR, `icon-${filePrefix}-${size}.png`);
      const pngBuffer = await sharp(master).resize(size, size, { fit: 'contain' }).png().toBuffer();
      await writePngIfPixelsChanged(target, pngBuffer);
    }
  }

  fs.writeFileSync(
    path.join(EXTENSION_ICON_DIR, 'GENERATED-FROM-APP-ICON.txt'),
    [
      'Generated from resources/icons/app.png.',
      '',
      'Do not hand-edit icon-black-*.png, icon-gray-*.png, icon-blue-*.png, icon-green-*.png, or icon-red-*.png.',
      'Regenerate with: pnpm run extension:assets',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function buildStoreScreenshot() {
  const frameWidth = 1280;
  const frameHeight = 800;
  const margin = 40;
  const innerWidth = frameWidth - margin * 2;
  const innerHeight = frameHeight - margin * 2;

  const source = sharp(STORE_SCREENSHOT_SOURCE_PATH).flatten({ background: '#000000' });
  const screenshot = await source
    .resize(innerWidth, innerHeight, {
      fit: 'contain',
      background: '#000000',
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: frameWidth,
      height: frameHeight,
      channels: 4,
      background: '#000000',
    },
  })
    .composite([{ input: screenshot, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function writeWebsiteAssets() {
  ensureDir(WEBSITE_PUBLIC_DIR);
  ensureDir(STORE_ASSETS_DIR);

  const websiteAssets = [
    ['logo-1024.png', 1024],
    ['logo-512.png', 512],
    ['favicon-32.png', 32],
    ['favicon-16.png', 16],
  ];
  for (const [fileName, size] of websiteAssets) {
    const pngBuffer = await sharp(APP_ICON_PATH).resize(size, size).png().toBuffer();
    await writePngIfPixelsChanged(path.join(WEBSITE_PUBLIC_DIR, fileName), pngBuffer);
  }

  const screenshotBuffer = await buildStoreScreenshot();

  await writePngIfPixelsChanged(path.join(WEBSITE_PUBLIC_DIR, 'screenshot@2x.png'), screenshotBuffer);
  await writePngIfPixelsChanged(
    path.join(STORE_ASSETS_DIR, 'chrome-store-screenshot-640x400.png'),
    await sharp(screenshotBuffer).resize(640, 400).png().toBuffer(),
  );
  await writePngIfPixelsChanged(
    path.join(STORE_ASSETS_DIR, 'chrome-store-screenshot-1280x800.png'),
    screenshotBuffer,
  );

  fs.writeFileSync(
    path.join(STORE_ASSETS_DIR, 'README.md'),
    [
      '# Chrome Web Store Assets',
      '',
      '- `chrome-store-screenshot-1280x800.png` is the primary screenshot for the store listing.',
      '- `chrome-store-screenshot-640x400.png` is a smaller alternative export.',
      '- Source image: `../playwriter/screenshot@2x.png`.',
      '',
      'Generated with:',
      '',
      '```bash',
      'pnpm run extension:assets',
      '```',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main() {
  if (!fs.existsSync(APP_ICON_PATH)) {
    throw new Error(`Missing app icon source: ${APP_ICON_PATH}`);
  }
  if (!fs.existsSync(STORE_SCREENSHOT_SOURCE_PATH)) {
    throw new Error(`Missing browser screenshot source: ${STORE_SCREENSHOT_SOURCE_PATH}`);
  }

  await writeExtensionIcons();
  await writeWebsiteAssets();
  console.log('[browser-extension-assets] Updated extension icons and store screenshots from app branding.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
