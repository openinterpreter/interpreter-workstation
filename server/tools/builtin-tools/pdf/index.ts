// PDF Server
// Provides tools for creating, reading, editing, and annotating PDF documents

import type { BuiltinServerDefinition } from '../../builtinTools';
import { createPdfTool } from './createPdfTool';
import { readPdfTool } from './readPdfTool';
import { editPdfTool as fillPdfFormTool } from './editPdfTool';
import { addAnnotationsTool } from './addAnnotationsTool';
import { addImageAnnotationsTool } from './addImageAnnotationsTool';
import { removeAnnotationsTool } from './removeAnnotationsTool';
import { mergePdfsTool } from './mergePdfsTool';

export const pdfServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-pdf',
  name: 'PDF Documents',
  description: 'Create, read, edit, merge, and annotate PDF documents with form filling, text annotations, and image annotations',
  isBuiltin: true,
  tools: [
    createPdfTool,
    readPdfTool,              // read_pdf - structured reading with positions
    fillPdfFormTool,          // fill_pdf_form - fill interactive form fields
    mergePdfsTool,            // merge_pdfs - combine multiple PDFs into one
    addAnnotationsTool,       // add_pdf_annotations - place text at coordinates
    addImageAnnotationsTool,  // add_pdf_image_annotations - place images at coordinates
    removeAnnotationsTool     // remove_pdf_annotations - remove by ID
  ],
  resources: [],
  prompts: []
};
