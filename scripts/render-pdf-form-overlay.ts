import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { getPdfDependencies } from '../server/utils/pdfLoader';

type Args = {
  pdfPath: string;
  pageNumber: number;
  outPath: string;
  targetWidth: number;
};

const DEFAULT_TARGET_WIDTH = 1600;
const MAX_SCALE = 2.0;

function getArgValue(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
  }
  return undefined;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const pdfArg = getArgValue(args, ['--pdf', '--path']);
  if (!pdfArg) {
    throw new Error('Missing required --pdf <path> argument.');
  }

  const pageArg = getArgValue(args, ['--page']);
  const pageNumber = pageArg ? Number.parseInt(pageArg, 10) : 1;
  if (!Number.isFinite(pageNumber) || pageNumber < 1) {
    throw new Error('Invalid --page value. Must be a positive integer.');
  }

  const widthArg = getArgValue(args, ['--width']);
  const targetWidth = widthArg ? Number.parseInt(widthArg, 10) : DEFAULT_TARGET_WIDTH;
  if (!Number.isFinite(targetWidth) || targetWidth < 1) {
    throw new Error('Invalid --width value. Must be a positive integer.');
  }

  const outArg = getArgValue(args, ['--out']);
  const resolvedPdf = path.resolve(pdfArg);
  const baseName = path.basename(resolvedPdf, path.extname(resolvedPdf));
  const defaultOutDir = path.join(process.cwd(), 'scripts', 'output');
  const defaultOutPath = path.join(defaultOutDir, `${baseName}-page${pageNumber}-form-overlay.png`);
  const outPath = path.resolve(outArg ?? defaultOutPath);

  return {
    pdfPath: resolvedPdf,
    pageNumber,
    outPath,
    targetWidth
  };
}

type FieldOverlay = {
  id: string;
  indexLabel: string;
  name: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  color: string;
  colorFill: string;
};

type MarginLabel = {
  field: FieldOverlay;
  x: number;
  y: number;
  width: number;
  height: number;
  side: 'left' | 'right';
  lineY: number;
};


function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp >= 0 && hp < 1) {
    r = c;
    g = x;
  } else if (hp >= 1 && hp < 2) {
    r = x;
    g = c;
  } else if (hp >= 2 && hp < 3) {
    g = c;
    b = x;
  } else if (hp >= 3 && hp < 4) {
    g = x;
    b = c;
  } else if (hp >= 4 && hp < 5) {
    r = x;
    b = c;
  } else if (hp >= 5 && hp < 6) {
    r = c;
    b = x;
  }

  const m = l - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

function makeColor(index: number): { stroke: string; fill: string } {
  const hue = (index * 137.508) % 360;
  const { r, g, b } = hslToRgb(hue, 0.72, 0.45);
  return {
    stroke: `rgb(${r}, ${g}, ${b})`,
    fill: `rgba(${r}, ${g}, ${b}, 0.35)`
  };
}

function layoutLabelsAvoidingCollisions(
  labels: MarginLabel[],
  minY: number,
  maxY: number,
  minGap: number,
  allFields: FieldOverlay[],
  viewportWidth: number
): void {
  if (labels.length === 0) return;

  const placed: MarginLabel[] = [];
  const step = Math.max(4, Math.floor(minGap));
  const candidates = (center: number, minCenter: number, maxCenter: number): number[] => {
    const list: number[] = [];
    list.push(center);
    for (let i = 1; i < 40; i += 1) {
      const up = center - i * step;
      const down = center + i * step;
      if (up >= minCenter) list.push(up);
      if (down <= maxCenter) list.push(down);
      if (up < minCenter && down > maxCenter) break;
    }
    return list;
  };

  const lineCollidesField = (label: MarginLabel, lineY: number): boolean => {
    const field = label.field;
    const lineStartX = label.side === 'left' ? label.x + label.width : label.x;
    const lineEndX = label.side === 'left' ? field.left : field.left + field.width;
    const x1 = Math.min(lineStartX, lineEndX);
    const x2 = Math.max(lineStartX, lineEndX);
    const padding = 3;

    for (const other of allFields) {
      if (other === field) continue;
      const top = other.top - padding;
      const bottom = other.top + other.height + padding;
      if (lineY < top || lineY > bottom) continue;
      const left = other.left - padding;
      const right = other.left + other.width + padding;
      if (x2 < left || x1 > right) continue;
      return true;
    }
    return false;
  };

  for (const label of labels) {
    const desiredCenter = clamp(
      label.field.centerY,
      minY + label.height / 2,
      maxY - label.height / 2
    );
    const centerCandidates = candidates(desiredCenter, minY + label.height / 2, maxY - label.height / 2);

    let placedLabelY = desiredCenter - label.height / 2;
    let placedLineY = desiredCenter;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const centerY of centerCandidates) {
      const candidateTop = centerY - label.height / 2;
      const candidateBottom = centerY + label.height / 2;
      let overlaps = false;
      for (const other of placed) {
        const otherTop = other.y;
        const otherBottom = other.y + other.height;
        const separated = candidateBottom + minGap <= otherTop || candidateTop >= otherBottom + minGap;
        if (!separated) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      if (lineCollidesField(label, centerY)) continue;

      const score = Math.abs(centerY - desiredCenter);
      if (score < bestScore) {
        bestScore = score;
        placedLabelY = candidateTop;
        placedLineY = centerY;
      }
      if (score === 0) break;
    }

    label.y = clamp(placedLabelY, minY, maxY - label.height);
    label.lineY = clamp(placedLineY, minY, maxY);
    placed.push(label);
  }
}


async function main() {
  const { pdfPath, pageNumber, outPath, targetWidth } = parseArgs();

  const pdfData = new Uint8Array(await fs.readFile(pdfPath));
  const pdfDataForLib = pdfData.slice();
  const { pdfjs, createCanvas } = await getPdfDependencies();

  const pdfDocument = await pdfjs.getDocument({ data: pdfData }).promise;
  const totalPages = pdfDocument.numPages;
  if (pageNumber > totalPages) {
    await pdfDocument.destroy();
    throw new Error(`Page ${pageNumber} does not exist. PDF has ${totalPages} pages.`);
  }

  const page = await pdfDocument.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1.0 });
  const scale = Math.min(MAX_SCALE, targetWidth / baseViewport.width);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx as any,
    canvas: canvas as any,
    viewport
  }).promise;

  const pdfDoc = await PDFDocument.load(pdfDataForLib);
  const pdfPages = pdfDoc.getPages();
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const pageRefToNumber = new Map(pdfPages.map((pdfPage, index) => [pdfPage.ref, index + 1]));

  const overlays: FieldOverlay[] = [];

  fields.forEach((field, fieldIndex) => {
    const widgets = (field as any).acroField.getWidgets();
    for (const widget of widgets) {
      const rect = widget.getRectangle();
      const widgetDict = widget.dict;
      const pageRef = widgetDict.get(PDFName.of('P'));
      const fieldPage = pageRef ? pageRefToNumber.get(pageRef) : undefined;
      if (fieldPage !== pageNumber) continue;

      const x1 = rect.x;
      const y1 = rect.y;
      const x2 = rect.x + rect.width;
      const y2 = rect.y + rect.height;
      const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle([x1, y1, x2, y2]);
      const left = Math.min(vx1, vx2);
      const top = Math.min(vy1, vy2);
      const width = Math.abs(vx2 - vx1);
      const height = Math.abs(vy2 - vy1);

      const fieldLabel = `${fieldIndex + 1}`;
      const colors = makeColor(fieldIndex);
      const centerX = left + width / 2;
      const centerY = top + height / 2;

      overlays.push({
        id: `f${fieldIndex}`,
        indexLabel: fieldLabel,
        name: field.getName(),
        type: field.constructor.name.replace('PDF', '').replace('Field', '').toLowerCase(),
        left,
        top,
        width,
        height,
        centerX,
        centerY,
        color: colors.stroke,
        colorFill: colors.fill
      });
    }
  });

  // Margin labels + connecting lines
  const minLabelGap = 18;
  const marginGap = minLabelGap;
  const marginInset = 10;
  const labelFontSize = 26;
  const labelPadding = 10;
  const slotGap = minLabelGap;
  ctx.font = `bold ${labelFontSize}px Arial, sans-serif`;

  const leftLabels: MarginLabel[] = [];
  const rightLabels: MarginLabel[] = [];
  let maxLeftWidth = 0;
  let maxRightWidth = 0;

  const leftOverlays = overlays
    .filter((overlay) => overlay.centerX < viewport.width / 2)
    .sort((a, b) => a.centerY - b.centerY);
  const rightOverlays = overlays
    .filter((overlay) => overlay.centerX >= viewport.width / 2)
    .sort((a, b) => a.centerY - b.centerY);

  const buildLabel = (overlay: FieldOverlay, side: 'left' | 'right') => {
    const labelText = overlay.indexLabel;
    const textWidth = ctx.measureText(labelText).width;
    const labelWidth = Math.max(62, textWidth + labelPadding * 2);
    const labelHeight = Math.max(34, labelFontSize + labelPadding * 2);
    const desiredY = clamp(overlay.centerY - labelHeight / 2, marginInset, viewport.height - marginInset - labelHeight);

    const label: MarginLabel = {
      field: overlay,
      x: 0,
      y: desiredY,
      width: labelWidth,
      height: labelHeight,
      side,
      lineY: 0
    };
    return label;
  };

  for (const overlay of leftOverlays) {
    const label = buildLabel(overlay, 'left');
    leftLabels.push(label);
    maxLeftWidth = Math.max(maxLeftWidth, label.width);
  }

  for (const overlay of rightOverlays) {
    const label = buildLabel(overlay, 'right');
    rightLabels.push(label);
    maxRightWidth = Math.max(maxRightWidth, label.width);
  }

  for (const label of leftLabels) {
    label.width = maxLeftWidth;
    label.x = marginInset;
  }
  for (const label of rightLabels) {
    label.width = maxRightWidth;
    label.x = viewport.width - maxRightWidth - marginInset;
  }

  layoutLabelsAvoidingCollisions(
    leftLabels,
    marginInset,
    viewport.height - marginInset,
    minLabelGap,
    overlays,
    viewport.width
  );
  layoutLabelsAvoidingCollisions(
    rightLabels,
    marginInset,
    viewport.height - marginInset,
    minLabelGap,
    overlays,
    viewport.width
  );

  const marginLabels = [...leftLabels, ...rightLabels];
  for (const label of marginLabels) {
    const { field } = label;
    // Connector line
    const startX = label.side === 'left' ? label.x + label.width : label.x;
    const startY = label.y + label.height / 2;
    const fieldEdgeX = label.side === 'left' ? field.left : field.left + field.width;
    const lineY = clamp(label.lineY, marginInset, viewport.height - marginInset);
    const edgeY = clamp(lineY, field.top + 4, field.top + field.height - 4);

    ctx.save();
    ctx.strokeStyle = field.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(fieldEdgeX, lineY);
    ctx.lineTo(fieldEdgeX, edgeY);
    ctx.stroke();
    ctx.restore();
  }

  // Draw field boxes and internal labels on top of connectors
  for (const overlay of overlays) {
    const { left, top, width, height } = overlay;
    if (width <= 0 || height <= 0) continue;

    ctx.save();
    ctx.fillStyle = overlay.colorFill;
    ctx.strokeStyle = overlay.color;
    ctx.lineWidth = Math.max(2, Math.round(scale * 1.2));
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left, top, width, height);

    const label = overlay.indexLabel;
    const padding = 3;
    let fontSize = Math.min(22, Math.max(10, Math.floor(Math.min(width, height) * 0.75)));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    let textWidth = ctx.measureText(label).width;

    while ((textWidth + padding * 2 > width || fontSize + padding * 2 > height) && fontSize > 6) {
      fontSize -= 1;
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      textWidth = ctx.measureText(label).width;
    }

    const labelWidth = Math.max(textWidth + padding * 2, Math.min(width, 18));
    const labelHeight = Math.max(fontSize + padding * 2, Math.min(height, 18));
    const labelX = clamp(left + (width - labelWidth) / 2, 0, viewport.width - labelWidth);
    const labelY = clamp(top + (height - labelHeight) / 2, 0, viewport.height - labelHeight);

    ctx.fillStyle = overlay.color;
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, labelX + padding, labelY + padding);
    ctx.restore();
  }

  for (const label of marginLabels) {
    const { field } = label;
    const labelText = field.indexLabel;

    // Margin label box
    ctx.save();
    ctx.fillStyle = field.color;
    ctx.strokeStyle = field.color;
    ctx.lineWidth = 2;
    ctx.fillRect(label.x, label.y, label.width, label.height);
    ctx.strokeRect(label.x, label.y, label.width, label.height);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = `bold ${labelFontSize}px Arial, sans-serif`;
    ctx.fillText(labelText, label.x + label.width / 2, label.y + label.height / 2);
    ctx.restore();
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, canvas.toBuffer('image/png'));

  console.log(`Rendered ${pdfPath} page ${pageNumber}/${totalPages}`);
  console.log(`Fields on page: ${overlays.length}`);
  console.log(`Output: ${outPath}`);
  if (overlays.length > 0) {
    console.log('Fields:');
    for (const overlay of overlays) {
      console.log(`  ${overlay.id}: "${overlay.name}" (${overlay.type})`);
    }
  }

  await pdfDocument.destroy();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
