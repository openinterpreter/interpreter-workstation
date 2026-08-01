import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { getPdfDependencies } from '../server/utils/pdfLoader';

const TARGET_IMAGE_WIDTH = 1600;
const MIN_LABEL_SIZE = 28;

type Args = {
  pdfPath: string;
  pageNumber: number;
  outPath: string;
};

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

  const outArg = getArgValue(args, ['--out']);
  const resolvedPdf = path.resolve(pdfArg);
  const baseName = path.basename(resolvedPdf, path.extname(resolvedPdf));
  const defaultOutDir = path.join(process.cwd(), 'scripts', 'output');
  const defaultOutPath = path.join(defaultOutDir, `${baseName}-page${pageNumber}-annotated.png`);
  const outPath = path.resolve(outArg ?? defaultOutPath);

  return {
    pdfPath: resolvedPdf,
    pageNumber,
    outPath
  };
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

function getOverlayColor(index: number): { stroke: string; fill: string; label: string } {
  const hue = (index * 137.508) % 360;
  const { r, g, b } = hslToRgb(hue, 0.72, 0.45);
  return {
    stroke: `rgba(${r}, ${g}, ${b}, 0.9)`,
    fill: `rgba(${r}, ${g}, ${b}, 0.2)`,
    label: `rgba(${r}, ${g}, ${b}, 0.85)`
  };
}

async function main() {
  const { pdfPath, pageNumber, outPath } = parseArgs();

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
  const scale = Math.min(2.0, TARGET_IMAGE_WIDTH / baseViewport.width);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx as any,
    canvas: canvas as any,
    viewport
  }).promise;

  const annotatedCanvas = createCanvas(viewport.width, viewport.height);
  const annotatedCtx = annotatedCanvas.getContext('2d');
  annotatedCtx.drawImage(canvas as any, 0, 0);
  annotatedCtx.textAlign = 'center';
  annotatedCtx.textBaseline = 'middle';

  const pdfDoc = await PDFDocument.load(pdfDataForLib);
  const pdfPages = pdfDoc.getPages();
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  fields.forEach((field, index) => {
    const widgets = (field as any).acroField.getWidgets();
    if (widgets.length === 0) return;
    for (const widget of widgets) {
      const rect = widget.getRectangle();
      const widgetDict = widget.dict;
      const pageRef = widgetDict.get(PDFName.of('P'));
      let fieldPage = 1;
      if (pageRef) {
        for (let p = 0; p < pdfPages.length; p++) {
          if (pdfPages[p].ref === pageRef) {
            fieldPage = p + 1;
            break;
          }
        }
      }
      if (fieldPage !== pageNumber) continue;

      const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle([
        rect.x,
        rect.y,
        rect.x + rect.width,
        rect.y + rect.height
      ]);
      const left = Math.min(vx1, vx2);
      const top = Math.min(vy1, vy2);
      const width = Math.abs(vx2 - vx1);
      const height = Math.abs(vy2 - vy1);

      const colors = getOverlayColor(index);
      annotatedCtx.fillStyle = colors.fill;
      annotatedCtx.strokeStyle = colors.stroke;
      annotatedCtx.lineWidth = Math.max(2, Math.round(scale));
      annotatedCtx.fillRect(left, top, width, height);
      annotatedCtx.strokeRect(left, top, width, height);

      const labelSize = Math.max(MIN_LABEL_SIZE, Math.min(width, height) * 0.8);
      const labelX = left + width / 2;
      const labelY = top + height / 2;
      const fontSize = Math.max(12, Math.floor(labelSize * 0.6));

      annotatedCtx.fillStyle = colors.label;
      annotatedCtx.fillRect(labelX - labelSize / 2, labelY - labelSize / 2, labelSize, labelSize);
      annotatedCtx.fillStyle = '#fff';
      annotatedCtx.font = `bold ${fontSize}px Arial, sans-serif`;
      annotatedCtx.fillText(`${index + 1}`, labelX, labelY);
    }
  });

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, annotatedCanvas.toBuffer('image/png'));

  console.log(`Rendered ${pdfPath} page ${pageNumber}/${totalPages}`);
  console.log(`Output: ${outPath}`);

  await pdfDocument.destroy();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
