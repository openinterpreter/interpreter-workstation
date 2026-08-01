const QRCode = require('qrcode');

const TARGET_PROBE_COLOR = '#ff00d4';
const OVERLAY_PROBE_COLOR = '#00e66b';

async function makeProbeDataUrl(payload, darkColor) {
  return QRCode.toDataURL(payload, {
    width: 168,
    margin: 0,
    color: {
      dark: darkColor,
      light: '#ffffff',
    },
  });
}

async function makeOverlayVisualProbeImages() {
  const [targetDataUrl, overlayDataUrl] = await Promise.all([
    makeProbeDataUrl('interpreter-target-underlay', TARGET_PROBE_COLOR),
    makeProbeDataUrl('interpreter-react-world-overlay', OVERLAY_PROBE_COLOR),
  ]);
  return { targetDataUrl, overlayDataUrl };
}

function clipBounds(bounds, png, margin = 0) {
  const x0 = Math.max(0, Math.floor(bounds.x - margin));
  const y0 = Math.max(0, Math.floor(bounds.y - margin));
  const x1 = Math.min(png.width, Math.ceil(bounds.x + bounds.width + margin));
  const y1 = Math.min(png.height, Math.ceil(bounds.y + bounds.height + margin));
  return { x0, y0, x1, y1 };
}

function probePixelStats(png, bounds, margin = 0) {
  const { x0, y0, x1, y1 } = clipBounds(bounds, png, margin);
  let green = 0;
  let red = 0;
  let dark = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (png.width * y + x) << 2;
      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      if (g > 135 && r < 105 && b < 150) green += 1;
      if (r > 170 && b > 150 && g < 110) red += 1;
      if (r < 80 && g < 80 && b < 80) dark += 1;
    }
  }
  return { green, red, dark, area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) };
}

function findProbeBounds(png, kind, searchBounds = null, margin = 0) {
  const search = searchBounds
    ? clipBounds(searchBounds, png, margin)
    : { x0: 0, y0: 0, x1: png.width, y1: png.height };
  const matches = [];
  for (let y = search.y0; y < search.y1; y += 1) {
    for (let x = search.x0; x < search.x1; x += 1) {
      const index = (png.width * y + x) << 2;
      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      const matched = kind === 'target'
        ? (r > 170 && b > 150 && g < 110)
        : (g > 135 && r < 105 && b < 150);
      if (matched) matches.push({ x, y });
    }
  }
  if (matches.length < 800) {
    throw new Error(`could not find ${kind} visual probe in desktop screenshot; matchedPixels=${matches.length} searchBounds=${JSON.stringify(searchBounds)}`);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of matches) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const boundsArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
  const density = matches.length / boundsArea;
  if (density < 0.08) {
    throw new Error(`could not find dense ${kind} visual probe in desktop screenshot; matchedPixels=${matches.length} density=${density.toFixed(4)} searchBounds=${JSON.stringify(searchBounds)}`);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    matchedPixels: matches.length,
  };
}

function overlayProbeCoversTarget(stats) {
  return stats.green >= 900 && stats.green >= stats.red * 2;
}

function assertOverlayProbeOccluded(stats, label, expectedBounds) {
  if (stats.green > 180) {
    throw new Error(`world overlay stayed above foreign window at ${label}; bounds=${JSON.stringify(expectedBounds)} stats=${JSON.stringify(stats)}`);
  }
}

module.exports = {
  TARGET_PROBE_COLOR,
  OVERLAY_PROBE_COLOR,
  makeOverlayVisualProbeImages,
  probePixelStats,
  findProbeBounds,
  overlayProbeCoversTarget,
  assertOverlayProbeOccluded,
};
