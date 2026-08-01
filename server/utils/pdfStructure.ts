// PDF Structure Reader
// Shared utility that extracts structured data from PDFs.
// Used by both the read_pdf tool (for text formatting) and
// the PDFViewer (for diff-based refresh of form fields/annotations).

import { readFile } from 'fs/promises';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';
import { getPdfjs } from './pdfLoader';

/**
 * Strip null bytes and other control characters that break text processing
 * (e.g. grep treats files with \0 as binary and stops searching).
 */
function sanitizePdfString(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x00/g, '');
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfElement {
  id: string;
  type: 'text' | 'annotation' | 'formField';
  page: number;
  bbox: BoundingBox;
  text?: string;
  annotationType?: string;
  contents?: string;
  fontSize?: number;
  color?: { r: number; g: number; b: number };
  fieldName?: string;
  fieldType?: string;
  fieldValue?: any;
  fieldIndex?: number;
}

export interface PageInfo {
  number: number;
  width: number;
  height: number;
}

export interface PdfStructure {
  path: string;
  pages: PageInfo[];
  elements: PdfElement[];
}

/**
 * Read a PDF file and return its structured representation.
 * Extracts text, annotations, and form fields with bounding boxes.
 *
 * @param resolvedPath - Absolute path to the PDF file
 * @param specificPage - Optional page number (1-indexed) to inspect
 */
export async function readPdfStructure(
  resolvedPath: string,
  specificPage?: number
): Promise<PdfStructure> {
  const pdfData = await readFile(resolvedPath);
  const pdfjs = await getPdfjs();
  const pdfProxy = await pdfjs.getDocument({ data: new Uint8Array(pdfData) }).promise;

  try {
    const pdfDoc = await PDFDocument.load(pdfData);
    const pdfPages = pdfDoc.getPages();

    const structure: PdfStructure = {
      path: resolvedPath,
      pages: [],
      elements: []
    };

    for (let i = 0; i < pdfPages.length; i++) {
      const page = pdfPages[i];
      const { width, height } = page.getSize();
      structure.pages.push({
        number: i + 1,
        width: Math.round(width),
        height: Math.round(height)
      });
    }

    const pagesToProcess = specificPage
      ? [specificPage]
      : Array.from({ length: pdfPages.length }, (_, i) => i + 1);

    let textId = 0;
    let annotId = 0;

    for (const pageNum of pagesToProcess) {
      if (pageNum < 1 || pageNum > pdfPages.length) continue;

      const pageHeight = structure.pages[pageNum - 1].height;

      // Extract text items
      try {
        const page = await pdfProxy.getPage(pageNum);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });

        const rawItems: Array<{ str: string; x: number; y: number; width: number; height: number }> = [];

        for (const item of textContent.items as any[]) {
          if (!item.str || !item.str.trim()) continue;

          const transform = item.transform;
          const itemHeight = item.height || Math.abs(transform[3]);
          const x = transform[4];
          const y = viewport.height - transform[5] - itemHeight;
          const width = item.width || 0;
          const height = itemHeight;

          rawItems.push({ str: sanitizePdfString(item.str), x, y, width, height });
        }

        const textGroups = groupTextItems(rawItems, pageHeight);

        for (const group of textGroups) {
          structure.elements.push({
            id: `t${textId++}`,
            type: 'text',
            page: pageNum,
            bbox: group.bbox,
            text: group.text
          });
        }
      } catch (e) {
        console.error(`[readPdfStructure] Error extracting text from page ${pageNum}:`, e);
      }

      // Extract annotations
      const pdfPage = pdfPages[pageNum - 1];
      const annotsRef = pdfPage.node.get(PDFName.of('Annots'));

      if (annotsRef) {
        let annots: PDFArray | undefined;

        if (annotsRef instanceof PDFArray) {
          annots = annotsRef;
        } else {
          const resolved = pdfPage.node.context.lookup(annotsRef);
          if (resolved instanceof PDFArray) {
            annots = resolved;
          }
        }

        if (annots) {
          for (let i = 0; i < annots.size(); i++) {
            try {
              const annotRef = annots.get(i);
              const annotDict = pdfPage.node.context.lookup(annotRef);

              if (!(annotDict instanceof PDFDict)) continue;

              const subtype = annotDict.get(PDFName.of('Subtype'));
              const subtypeStr = subtype?.toString().replace('/', '') || 'Unknown';

              if (subtypeStr === 'Widget') continue;

              const rectArray = annotDict.get(PDFName.of('Rect'));
              if (!(rectArray instanceof PDFArray)) continue;

              const coords: number[] = [];
              for (let j = 0; j < rectArray.size(); j++) {
                const val = rectArray.get(j);
                if (val instanceof PDFNumber) {
                  coords.push(val.asNumber());
                }
              }
              if (coords.length !== 4) continue;

              const x = Math.min(coords[0], coords[2]);
              const y = pageHeight - Math.max(coords[1], coords[3]);
              const width = Math.abs(coords[2] - coords[0]);
              const height = Math.abs(coords[3] - coords[1]);

              let contents = '';
              const contentsVal = annotDict.get(PDFName.of('Contents'));
              if (contentsVal instanceof PDFString) {
                contents = sanitizePdfString(contentsVal.asString());
              } else if (contentsVal instanceof PDFHexString) {
                contents = sanitizePdfString(contentsVal.decodeText());
              }

              let color: { r: number; g: number; b: number } | undefined;
              const colorArray = annotDict.get(PDFName.of('C'));
              if (colorArray instanceof PDFArray && colorArray.size() >= 3) {
                const r = colorArray.get(0);
                const g = colorArray.get(1);
                const b = colorArray.get(2);
                if (r instanceof PDFNumber && g instanceof PDFNumber && b instanceof PDFNumber) {
                  color = {
                    r: Math.round(r.asNumber() * 255),
                    g: Math.round(g.asNumber() * 255),
                    b: Math.round(b.asNumber() * 255)
                  };
                }
              }

              let fontSize: number | undefined;
              const defaultStyle = annotDict.get(PDFName.of('DS'));
              const defaultAppearance = annotDict.get(PDFName.of('DA'));

              if (defaultStyle instanceof PDFString) {
                const dsStr = defaultStyle.asString();
                const fontMatch = dsStr.match(/(\d+(?:\.\d+)?)\s*pt/i);
                if (fontMatch) {
                  fontSize = parseFloat(fontMatch[1]);
                }
              }

              if (!fontSize && defaultAppearance instanceof PDFString) {
                const daStr = defaultAppearance.asString();
                const tfMatch = daStr.match(/(\d+(?:\.\d+)?)\s+Tf/);
                if (tfMatch) {
                  fontSize = parseFloat(tfMatch[1]);
                }
              }

              if (!color && defaultAppearance instanceof PDFString) {
                const daStr = defaultAppearance.asString();
                const rgbMatch = daStr.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+rg/);
                if (rgbMatch) {
                  color = {
                    r: Math.round(parseFloat(rgbMatch[1]) * 255),
                    g: Math.round(parseFloat(rgbMatch[2]) * 255),
                    b: Math.round(parseFloat(rgbMatch[3]) * 255)
                  };
                }
                const grayMatch = daStr.match(/(\d+(?:\.\d+)?)\s+g(?:\s|$)/);
                if (!color && grayMatch) {
                  const gray = Math.round(parseFloat(grayMatch[1]) * 255);
                  color = { r: gray, g: gray, b: gray };
                }
              }

              structure.elements.push({
                id: `a${annotId++}`,
                type: 'annotation',
                page: pageNum,
                bbox: {
                  x: Math.round(x * 100) / 100,
                  y: Math.round(y * 100) / 100,
                  width: Math.round(width * 100) / 100,
                  height: Math.round(height * 100) / 100
                },
                annotationType: subtypeStr,
                contents,
                fontSize,
                color
              });
            } catch (e) {
              console.error(`[readPdfStructure] Error processing annotation:`, e);
            }
          }
        }
      }
    }

    // Extract form fields
    try {
      const form = pdfDoc.getForm();
      const fields = form.getFields();

      fields.forEach((field, index) => {
        const name = sanitizePdfString(field.getName());
        const fieldType = field.constructor.name;
        let type = 'text';
        let value: any = '';

        if (fieldType.includes('Text')) {
          type = 'text';
          try {
            const raw = (field as any).getText?.() || '';
            value = typeof raw === 'string' ? sanitizePdfString(raw) : raw;
          } catch { value = ''; }
        } else if (fieldType.includes('CheckBox')) {
          type = 'checkbox';
          try { value = (field as any).isChecked?.() || false; } catch { value = false; }
        } else if (fieldType.includes('RadioGroup')) {
          type = 'radio';
          try {
            const raw = (field as any).getSelected?.() || '';
            value = typeof raw === 'string' ? sanitizePdfString(raw) : raw;
          } catch { value = ''; }
        } else if (fieldType.includes('Dropdown')) {
          type = 'dropdown';
          try {
            const raw = (field as any).getSelected?.() || [];
            value = typeof raw === 'string' ? sanitizePdfString(raw) : raw;
          } catch { value = []; }
        } else if (fieldType.includes('OptionList')) {
          type = 'listbox';
          try {
            const raw = (field as any).getSelected?.() || [];
            value = typeof raw === 'string' ? sanitizePdfString(raw) : raw;
          } catch { value = []; }
        }

        const widgets = (field as any).acroField.getWidgets();
        if (widgets.length === 0) return;

        const widget = widgets[0];
        const rect = widget.getRectangle();

        let fieldPage = 1;
        const widgetDict = widget.dict;
        const pageRef = widgetDict.get(PDFName.of('P'));
        if (pageRef) {
          for (let p = 0; p < pdfPages.length; p++) {
            if (pdfPages[p].ref === pageRef) {
              fieldPage = p + 1;
              break;
            }
          }
        }

        // When a specific page is requested, include only fields on that page.
        if (specificPage && fieldPage !== specificPage) return;

        const pageHeight = structure.pages[fieldPage - 1]?.height || 792;
        const bbox: BoundingBox = {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round((pageHeight - rect.y - rect.height) * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100
        };

        structure.elements.push({
          id: `f${index}`,
          type: 'formField',
          page: fieldPage,
          bbox,
          fieldName: name,
          fieldType: type,
          fieldValue: value,
          fieldIndex: index
        });
      });
    } catch (e) {
      console.error('[readPdfStructure] Error extracting form fields:', e);
    }

    // Sort all elements by position (top-to-bottom, left-to-right)
    structure.elements.sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      const yDiff = a.bbox.y - b.bbox.y;
      if (Math.abs(yDiff) > 5) return yDiff;
      return a.bbox.x - b.bbox.x;
    });

    return structure;
  } finally {
    pdfProxy.destroy();
  }
}

// --- Text grouping helpers (extracted from readPdfTool) ---

interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextBlock {
  items: TextItem[];
  bbox: BoundingBox;
}

interface TextSegment {
  text: string;
  bbox: BoundingBox;
}

function calcBbox(items: TextItem[]): BoundingBox {
  if (items.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...items.map(i => i.x));
  const maxX = Math.max(...items.map(i => i.x + i.width));
  const minY = Math.min(...items.map(i => i.y));
  const maxY = Math.max(...items.map(i => i.y + i.height));
  return {
    x: Math.round(minX * 100) / 100,
    y: Math.round(minY * 100) / 100,
    width: Math.round((maxX - minX) * 100) / 100,
    height: Math.round((maxY - minY) * 100) / 100
  };
}

function areTouching(a: TextItem, b: TextItem): boolean {
  const lineHeight = Math.max(a.height, b.height);
  if (Math.abs(a.y - b.y) > lineHeight * 0.7) return false;
  const left = a.x < b.x ? a : b;
  const right = a.x < b.x ? b : a;
  const gap = right.x - (left.x + left.width);
  const touchThreshold = lineHeight * 0.8;
  return gap < touchThreshold && gap > -lineHeight;
}

function clusterIntoBlocks(items: TextItem[]): TextBlock[] {
  if (items.length === 0) return [];

  // Sort by Y to enable sweep-line with early termination
  const indexed = items.map((item, i) => ({ item, origIdx: i }));
  indexed.sort((a, b) => a.item.y - b.item.y);

  // Compute max item height for Y-band threshold
  let maxHeight = 0;
  for (const { item } of indexed) {
    if (item.height > maxHeight) maxHeight = item.height;
  }
  const yThreshold = maxHeight * 0.7;

  const parent: number[] = items.map((_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  };
  const union = (i: number, j: number) => {
    const pi = find(i), pj = find(j);
    if (pi !== pj) parent[pi] = pj;
  };

  // Sweep: only compare items within the Y band
  for (let i = 0; i < indexed.length; i++) {
    const itemI = indexed[i];
    for (let j = i + 1; j < indexed.length; j++) {
      const itemJ = indexed[j];
      if (itemJ.item.y - itemI.item.y > yThreshold) break;
      if (areTouching(itemI.item, itemJ.item)) union(itemI.origIdx, itemJ.origIdx);
    }
  }

  const clusters = new Map<number, TextItem[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(items[i]);
  }
  const blocks: TextBlock[] = [];
  for (const clusterItems of clusters.values()) {
    clusterItems.sort((a, b) => a.x - b.x);
    blocks.push({ items: clusterItems, bbox: calcBbox(clusterItems) });
  }
  blocks.sort((a, b) => {
    const yDiff = a.bbox.y - b.bbox.y;
    if (Math.abs(yDiff) > 10) return yDiff;
    return a.bbox.x - b.bbox.x;
  });
  return blocks;
}

function splitIntoSegments(block: TextBlock): TextSegment[] {
  const results: TextSegment[] = [];
  const items = block.items;
  if (items.length === 0) return results;

  interface CharInfo { char: string; itemIdx: number; xOffset: number; }
  const chars: CharInfo[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const charWidth = item.width / Math.max(item.str.length, 1);
    for (let c = 0; c < item.str.length; c++) {
      chars.push({ char: item.str[c], itemIdx: i, xOffset: c * charWidth });
    }
    if (i < items.length - 1) {
      chars.push({ char: ' ', itemIdx: i, xOffset: item.width });
    }
  }

  const fullText = chars.map(c => c.char).join('');
  const splitRegex = /(?<=:\s)|(?<=[.!?]\s)/g;
  const segments: string[] = fullText.split(splitRegex).filter(s => s.trim());
  if (segments.length === 0) return results;

  let charOffset = 0;
  for (const segment of segments) {
    const segmentText = segment.trim();
    if (!segmentText) { charOffset += segment.length; continue; }
    const startCharIdx = charOffset;
    const endCharIdx = charOffset + segment.length;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = startCharIdx; i < endCharIdx && i < chars.length; i++) {
      const charInfo = chars[i];
      if (charInfo.char === ' ' && i === startCharIdx) continue;
      const item = items[charInfo.itemIdx];
      const charX = item.x + charInfo.xOffset;
      const charWidth = item.width / Math.max(item.str.length, 1);
      minX = Math.min(minX, charX);
      maxX = Math.max(maxX, charX + charWidth);
      minY = Math.min(minY, item.y);
      maxY = Math.max(maxY, item.y + item.height);
    }
    if (minX !== Infinity) {
      results.push({
        text: segmentText,
        bbox: {
          x: Math.round(minX * 100) / 100,
          y: Math.round(minY * 100) / 100,
          width: Math.round((maxX - minX) * 100) / 100,
          height: Math.round((maxY - minY) * 100) / 100
        }
      });
    }
    charOffset += segment.length;
  }

  if (results.length === 0 && fullText.trim()) {
    results.push({ text: fullText.trim(), bbox: block.bbox });
  }
  return results;
}

function groupTextItems(items: TextItem[], _pageHeight: number): TextSegment[] {
  if (items.length === 0) return [];
  const blocks = clusterIntoBlocks(items);
  const allSegments: TextSegment[] = [];
  for (const block of blocks) {
    allSegments.push(...splitIntoSegments(block));
  }
  return allSegments;
}
