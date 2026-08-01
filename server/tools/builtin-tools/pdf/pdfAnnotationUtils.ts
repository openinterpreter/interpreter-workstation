// PDF Annotation Utilities
// Core functionality for adding/removing annotations without IPC events
// Tools wrap these and add event emission, UI can use directly

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname } from 'path';
import { Resvg } from '@resvg/resvg-js';
import {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFString,
  PDFRef
} from 'pdf-lib';

export interface AnnotationInput {
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text: string;
  fontSize?: number;
  color?: { r: number; g: number; b: number };
}

export interface ImageAnnotationInput {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  imagePath: string;  // Absolute or workspace-relative path to image file
}

export interface AddImageAnnotationsResult {
  success: boolean;
  error?: string;
  createdIds: string[];
  results: string[];
  resolvedPath: string;
}

export interface AddAnnotationsResult {
  success: boolean;
  error?: string;
  createdIds: string[];
  results: string[];
  resolvedPath: string;
}

export interface RemoveAnnotationsResult {
  success: boolean;
  error?: string;
  removedCount: number;
  results: string[];
  resolvedPath: string;
}

// Create a FreeText annotation dictionary
function createFreeTextAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  annot: AnnotationInput
): PDFRef {
  const context = pdfDoc.context;
  const pageHeight = page.getHeight();

  const fontSize = annot.fontSize || 12;
  const textWidth = annot.width || Math.max(annot.text.length * fontSize * 0.6, 100);
  const textHeight = annot.height || fontSize * 1.5;

  // Convert from top-left origin to PDF bottom-left origin
  const pdfY = pageHeight - annot.y - textHeight;

  const rect = PDFArray.withContext(context);
  rect.push(PDFNumber.of(annot.x));
  rect.push(PDFNumber.of(pdfY));
  rect.push(PDFNumber.of(annot.x + textWidth));
  rect.push(PDFNumber.of(pdfY + textHeight));

  const r = annot.color?.r ?? 0;
  const g = annot.color?.g ?? 0;
  const b = annot.color?.b ?? 0;

  const annotDict = context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: rect,
    Contents: PDFString.of(annot.text),
    DA: PDFString.of(`/Helv ${fontSize} Tf ${r} ${g} ${b} rg`),
    F: PDFNumber.of(4),
    BS: context.obj({
      W: PDFNumber.of(0),
      S: PDFName.of('S')
    }),
    CreationDate: PDFString.of(`D:${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`),
  });

  const appearanceStream = createAppearanceStream(context, annot.text, textWidth, textHeight, fontSize, r, g, b);
  const appearanceStreamRef = context.register(appearanceStream);

  const apDict = context.obj({
    N: appearanceStreamRef
  });

  annotDict.set(PDFName.of('AP'), apDict);

  return context.register(annotDict);
}

function createAppearanceStream(
  context: any,
  text: string,
  width: number,
  height: number,
  fontSize: number,
  r: number,
  g: number,
  b: number
): PDFDict {
  const escapedText = text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

  const streamContent = [
    'q',
    `${r} ${g} ${b} rg`,
    'BT',
    `/Helv ${fontSize} Tf`,
    `2 ${height - fontSize - 2} Td`,
    `(${escapedText}) Tj`,
    'ET',
    'Q'
  ].join('\n');

  const streamBytes = new TextEncoder().encode(streamContent);

  const stream = context.stream(streamBytes, {
    Type: PDFName.of('XObject'),
    Subtype: PDFName.of('Form'),
    FormType: PDFNumber.of(1),
    BBox: PDFArray.withContext(context),
    Resources: context.obj({
      Font: context.obj({
        Helv: context.obj({
          Type: PDFName.of('Font'),
          Subtype: PDFName.of('Type1'),
          BaseFont: PDFName.of('Helvetica'),
          Encoding: PDFName.of('WinAnsiEncoding')
        })
      })
    })
  });

  const bbox = stream.dict.get(PDFName.of('BBox')) as PDFArray;
  bbox.push(PDFNumber.of(0));
  bbox.push(PDFNumber.of(0));
  bbox.push(PDFNumber.of(width));
  bbox.push(PDFNumber.of(height));

  return stream;
}

/**
 * Add annotations to a PDF file (core functionality, no IPC events)
 */
export async function addAnnotationsToPdf(
  filePath: string,
  annotations: AnnotationInput[]
): Promise<AddAnnotationsResult> {
  // Path should already be resolved by the calling tool
  const resolvedPath = filePath;

  if (!existsSync(resolvedPath)) {
    return {
      success: false,
      error: `File not found: ${resolvedPath}`,
      createdIds: [],
      results: [],
      resolvedPath
    };
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (ext !== '.pdf') {
    return {
      success: false,
      error: 'Only .pdf files are supported',
      createdIds: [],
      results: [],
      resolvedPath
    };
  }

  const pdfData = await readFile(resolvedPath);
  const pdfDoc = await PDFDocument.load(pdfData);
  const pages = pdfDoc.getPages();

  // Count existing annotations to determine starting ID
  let existingAnnotCount = 0;
  for (const page of pages) {
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (annotsRef) {
      let annots: PDFArray | undefined;
      if (annotsRef instanceof PDFArray) {
        annots = annotsRef;
      } else {
        const resolved = page.node.context.lookup(annotsRef);
        if (resolved instanceof PDFArray) {
          annots = resolved;
        }
      }
      if (annots) {
        for (let i = 0; i < annots.size(); i++) {
          try {
            const annotRef = annots.get(i);
            const annotDict = page.node.context.lookup(annotRef);
            if (annotDict instanceof PDFDict) {
              const subtype = annotDict.get(PDFName.of('Subtype'));
              const subtypeStr = subtype?.toString().replace('/', '') || '';
              if (subtypeStr !== 'Widget') {
                existingAnnotCount++;
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  const results: string[] = [];
  const createdIds: string[] = [];
  let nextAnnotId = existingAnnotCount;

  for (const annot of annotations) {
    if (annot.page < 1 || annot.page > pages.length) {
      results.push(`Skipped: Page ${annot.page} does not exist (PDF has ${pages.length} pages)`);
      continue;
    }

    const page = pages[annot.page - 1];

    try {
      const annotRef = createFreeTextAnnotation(pdfDoc, page, annot);
      const existingAnnots = page.node.get(PDFName.of('Annots'));

      if (existingAnnots instanceof PDFArray) {
        existingAnnots.push(annotRef);
      } else if (existingAnnots) {
        const resolved = page.node.context.lookup(existingAnnots);
        if (resolved instanceof PDFArray) {
          resolved.push(annotRef);
        } else {
          const newAnnots = PDFArray.withContext(pdfDoc.context);
          newAnnots.push(existingAnnots as PDFRef);
          newAnnots.push(annotRef);
          page.node.set(PDFName.of('Annots'), newAnnots);
        }
      } else {
        const newAnnots = PDFArray.withContext(pdfDoc.context);
        newAnnots.push(annotRef);
        page.node.set(PDFName.of('Annots'), newAnnots);
      }

      const annotId = `a${nextAnnotId}`;
      createdIds.push(annotId);
      nextAnnotId++;
      results.push(`[${annotId}] Added on page ${annot.page} at (${annot.x}, ${annot.y}): "${annot.text.substring(0, 30)}${annot.text.length > 30 ? '...' : ''}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      results.push(`Failed to add annotation on page ${annot.page}: ${msg}`);
    }
  }

  const modifiedPdf = await pdfDoc.save({ useObjectStreams: false });
  await writeFile(resolvedPath, modifiedPdf);

  return {
    success: true,
    createdIds,
    results,
    resolvedPath
  };
}

/**
 * Remove annotations from a PDF file (core functionality, no IPC events)
 */
export async function removeAnnotationsFromPdf(
  filePath: string,
  annotationIds: string[]
): Promise<RemoveAnnotationsResult> {
  // Path should already be resolved by the calling tool
  const resolvedPath = filePath;

  if (!existsSync(resolvedPath)) {
    return {
      success: false,
      error: `File not found: ${resolvedPath}`,
      removedCount: 0,
      results: [],
      resolvedPath
    };
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (ext !== '.pdf') {
    return {
      success: false,
      error: 'Only .pdf files are supported',
      removedCount: 0,
      results: [],
      resolvedPath
    };
  }

  // Parse annotation IDs
  const targetIndices: number[] = [];
  for (const id of annotationIds) {
    const match = id.match(/^a(\d+)$/);
    if (!match) {
      return {
        success: false,
        error: `Invalid annotation ID format "${id}". Expected format: a0, a1, a2, etc.`,
        removedCount: 0,
        results: [],
        resolvedPath
      };
    }
    targetIndices.push(parseInt(match[1], 10));
  }

  const pdfData = await readFile(resolvedPath);
  const pdfDoc = await PDFDocument.load(pdfData);
  const pages = pdfDoc.getPages();

  // Build a map of annotation global indices to their locations
  interface AnnotationLocation {
    pageIndex: number;
    annotIndex: number;
  }
  const annotLocations: Map<number, AnnotationLocation> = new Map();
  let globalAnnotIndex = 0;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const annotsRef = page.node.get(PDFName.of('Annots'));

    if (!annotsRef) continue;

    let annots: PDFArray | undefined;

    if (annotsRef instanceof PDFArray) {
      annots = annotsRef;
    } else {
      const resolved = page.node.context.lookup(annotsRef);
      if (resolved instanceof PDFArray) {
        annots = resolved;
      }
    }

    if (!annots) continue;

    for (let i = 0; i < annots.size(); i++) {
      try {
        const annotRef = annots.get(i);
        const annotDict = page.node.context.lookup(annotRef);

        if (!(annotDict instanceof PDFDict)) continue;

        const subtype = annotDict.get(PDFName.of('Subtype'));
        const subtypeStr = subtype?.toString().replace('/', '') || '';

        if (subtypeStr === 'Widget') continue;

        annotLocations.set(globalAnnotIndex, {
          pageIndex,
          annotIndex: i
        });
        globalAnnotIndex++;
      } catch {
        // Skip problematic annotations
      }
    }
  }

  // Validate all target indices exist
  for (const idx of targetIndices) {
    if (!annotLocations.has(idx)) {
      return {
        success: false,
        error: `Annotation a${idx} not found`,
        removedCount: 0,
        results: [],
        resolvedPath
      };
    }
  }

  // Group removals by page, sorted by annotIndex descending
  const removalsByPage: Map<number, number[]> = new Map();
  for (const idx of targetIndices) {
    const loc = annotLocations.get(idx)!;
    if (!removalsByPage.has(loc.pageIndex)) {
      removalsByPage.set(loc.pageIndex, []);
    }
    removalsByPage.get(loc.pageIndex)!.push(loc.annotIndex);
  }

  for (const [, indices] of removalsByPage) {
    indices.sort((a, b) => b - a);
  }

  const results: string[] = [];

  for (const [pageIndex, annotIndicesToRemove] of removalsByPage) {
    const page = pages[pageIndex];
    const annotsRef = page.node.get(PDFName.of('Annots'));

    if (!annotsRef) continue;

    let annots: PDFArray | undefined;

    if (annotsRef instanceof PDFArray) {
      annots = annotsRef;
    } else {
      const resolved = page.node.context.lookup(annotsRef);
      if (resolved instanceof PDFArray) {
        annots = resolved;
      }
    }

    if (!annots) continue;

    for (const annotIndex of annotIndicesToRemove) {
      try {
        annots.remove(annotIndex);
        results.push(`Removed annotation at page ${pageIndex + 1}, index ${annotIndex}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        results.push(`Failed to remove annotation at page ${pageIndex + 1}, index ${annotIndex}: ${msg}`);
      }
    }

    if (annots.size() === 0) {
      page.node.delete(PDFName.of('Annots'));
      results.push(`Removed empty Annots array from page ${pageIndex + 1}`);
    }
  }

  const modifiedPdf = await pdfDoc.save({ useObjectStreams: false });
  await writeFile(resolvedPath, modifiedPdf);

  return {
    success: true,
    removedCount: targetIndices.length,
    results,
    resolvedPath
  };
}

/**
 * Create a Stamp annotation dictionary with an image appearance
 */
function createImageAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  imageAnnot: ImageAnnotationInput,
  embeddedImage: any
): PDFRef {
  const context = pdfDoc.context;
  const pageHeight = page.getHeight();

  const { x, y, width, height } = imageAnnot;

  // Convert from top-left origin to PDF bottom-left origin
  const pdfY = pageHeight - y - height;

  const rect = PDFArray.withContext(context);
  rect.push(PDFNumber.of(x));
  rect.push(PDFNumber.of(pdfY));
  rect.push(PDFNumber.of(x + width));
  rect.push(PDFNumber.of(pdfY + height));

  // Create the annotation dictionary as a Stamp annotation
  const annotDict = context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Stamp'),
    Rect: rect,
    F: PDFNumber.of(4), // Print flag
    Contents: PDFString.of(`Image: ${imageAnnot.imagePath}`),
    CreationDate: PDFString.of(`D:${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`),
  });

  // Create appearance stream with the image
  const imageRef = embeddedImage.ref;

  // Create an XObject Form that contains the image
  const streamContent = [
    'q',
    `${width} 0 0 ${height} 0 0 cm`,
    '/Img Do',
    'Q'
  ].join('\n');

  const streamBytes = new TextEncoder().encode(streamContent);

  const appearanceStream = context.stream(streamBytes, {
    Type: PDFName.of('XObject'),
    Subtype: PDFName.of('Form'),
    FormType: PDFNumber.of(1),
    BBox: PDFArray.withContext(context),
    Resources: context.obj({
      XObject: context.obj({
        Img: imageRef
      })
    })
  });

  const bbox = appearanceStream.dict.get(PDFName.of('BBox')) as PDFArray;
  bbox.push(PDFNumber.of(0));
  bbox.push(PDFNumber.of(0));
  bbox.push(PDFNumber.of(width));
  bbox.push(PDFNumber.of(height));

  const appearanceStreamRef = context.register(appearanceStream);

  const apDict = context.obj({
    N: appearanceStreamRef
  });

  annotDict.set(PDFName.of('AP'), apDict);

  return context.register(annotDict);
}

/**
 * Add image annotations to a PDF file (core functionality, no IPC events)
 */
export async function addImageAnnotationsToPdf(
  filePath: string,
  annotations: ImageAnnotationInput[],
  _workspace?: string
): Promise<AddImageAnnotationsResult> {
  const resolvedPath = filePath;

  if (!existsSync(resolvedPath)) {
    return {
      success: false,
      error: `File not found: ${resolvedPath}`,
      createdIds: [],
      results: [],
      resolvedPath
    };
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (ext !== '.pdf') {
    return {
      success: false,
      error: 'Only .pdf files are supported',
      createdIds: [],
      results: [],
      resolvedPath
    };
  }

  const pdfData = await readFile(resolvedPath);
  const pdfDoc = await PDFDocument.load(pdfData);
  const pages = pdfDoc.getPages();

  // Count existing annotations to determine starting ID
  let existingAnnotCount = 0;
  for (const page of pages) {
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (annotsRef) {
      let annots: PDFArray | undefined;
      if (annotsRef instanceof PDFArray) {
        annots = annotsRef;
      } else {
        const resolved = page.node.context.lookup(annotsRef);
        if (resolved instanceof PDFArray) {
          annots = resolved;
        }
      }
      if (annots) {
        for (let i = 0; i < annots.size(); i++) {
          try {
            const annotRef = annots.get(i);
            const annotDict = page.node.context.lookup(annotRef);
            if (annotDict instanceof PDFDict) {
              const subtype = annotDict.get(PDFName.of('Subtype'));
              const subtypeStr = subtype?.toString().replace('/', '') || '';
              if (subtypeStr !== 'Widget') {
                existingAnnotCount++;
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  const results: string[] = [];
  const createdIds: string[] = [];
  let nextAnnotId = existingAnnotCount;

  for (const annot of annotations) {
    if (annot.page < 1 || annot.page > pages.length) {
      results.push(`Skipped: Page ${annot.page} does not exist (PDF has ${pages.length} pages)`);
      continue;
    }

    const page = pages[annot.page - 1];

    try {
      // Load the image
      const imagePath = annot.imagePath;
      if (!existsSync(imagePath)) {
        results.push(`Skipped: Image file not found: ${imagePath}`);
        continue;
      }

      let imageBytes = await readFile(imagePath);
      const imageExt = extname(imagePath).toLowerCase();

      // Convert SVG to PNG if needed
      if (imageExt === '.svg') {
        try {
          const resvg = new Resvg(imageBytes);
          const pngData = resvg.render();
          imageBytes = Buffer.from(pngData.asPng());
        } catch (svgError) {
          const errMsg = svgError instanceof Error ? svgError.message : 'Unknown error';
          results.push(`Skipped: Failed to convert SVG: ${errMsg}`);
          continue;
        }
      }

      // Embed the image
      let embeddedImage;
      if (imageExt === '.png' || imageExt === '.svg') {
        embeddedImage = await pdfDoc.embedPng(imageBytes);
      } else if (imageExt === '.jpg' || imageExt === '.jpeg') {
        embeddedImage = await pdfDoc.embedJpg(imageBytes);
      } else {
        // Try PNG first, then JPG
        try {
          embeddedImage = await pdfDoc.embedPng(imageBytes);
        } catch {
          embeddedImage = await pdfDoc.embedJpg(imageBytes);
        }
      }

      const annotRef = createImageAnnotation(pdfDoc, page, annot, embeddedImage);
      const existingAnnots = page.node.get(PDFName.of('Annots'));

      if (existingAnnots instanceof PDFArray) {
        existingAnnots.push(annotRef);
      } else if (existingAnnots) {
        const resolved = page.node.context.lookup(existingAnnots);
        if (resolved instanceof PDFArray) {
          resolved.push(annotRef);
        } else {
          const newAnnots = PDFArray.withContext(pdfDoc.context);
          newAnnots.push(existingAnnots as PDFRef);
          newAnnots.push(annotRef);
          page.node.set(PDFName.of('Annots'), newAnnots);
        }
      } else {
        const newAnnots = PDFArray.withContext(pdfDoc.context);
        newAnnots.push(annotRef);
        page.node.set(PDFName.of('Annots'), newAnnots);
      }

      const annotId = `a${nextAnnotId}`;
      createdIds.push(annotId);
      nextAnnotId++;
      results.push(`[${annotId}] Added image on page ${annot.page} at (${annot.x}, ${annot.y}), size ${annot.width}x${annot.height}: "${imagePath}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      results.push(`Failed to add image annotation on page ${annot.page}: ${msg}`);
    }
  }

  const modifiedPdf = await pdfDoc.save({ useObjectStreams: false });
  await writeFile(resolvedPath, modifiedPdf);

  return {
    success: true,
    createdIds,
    results,
    resolvedPath
  };
}
