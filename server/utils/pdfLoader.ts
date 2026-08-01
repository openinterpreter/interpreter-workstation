/**
 * PDF Dependencies Lazy Loader
 *
 * Lazy-loads pdfjs-dist and @napi-rs/canvas to avoid native binding crashes in sidecar mode.
 * pdfjs-dist requires DOMMatrix which comes from @napi-rs/canvas native bindings.
 *
 * Usage:
 *   const pdfjs = await getPdfjs();
 *   // or for rendering:
 *   const { pdfjs, createCanvas } = await getPdfDependencies();
 */

// Lazy-loaded modules
let pdfjsModule: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;
let canvasModule: typeof import('@napi-rs/canvas') | null = null;

/**
 * Get PDF.js module (lazy-loaded).
 * Use this when you only need to read/parse PDFs, not render them.
 */
export async function getPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  if (!pdfjsModule) {
    try {
      pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (err: any) {
      throw new Error(
        'PDF.js not available. This feature requires @napi-rs/canvas native bindings. ' +
        `Error: ${err.message}`
      );
    }
  }
  return pdfjsModule;
}

/**
 * Get both PDF.js and canvas modules (lazy-loaded).
 * Use this when you need to render PDF pages to images.
 */
export async function getPdfDependencies(): Promise<{
  pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  createCanvas: typeof import('@napi-rs/canvas').createCanvas;
}> {
  if (!pdfjsModule || !canvasModule) {
    try {
      pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
      canvasModule = await import('@napi-rs/canvas');
    } catch (err: any) {
      throw new Error(
        'PDF rendering dependencies not available. ' +
        'This feature requires @napi-rs/canvas native bindings. ' +
        `Error: ${err.message}`
      );
    }
  }
  return {
    pdfjs: pdfjsModule,
    createCanvas: canvasModule.createCanvas,
  };
}
