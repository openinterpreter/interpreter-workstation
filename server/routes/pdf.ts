// PDF Routes - Direct API for UI (no IPC events)
// These endpoints use the PDF utilities directly without emitting FILE_REFRESHED events
// Use these from the UI to avoid triggering unnecessary refresh cycles

import { Router, type Request, type Response } from 'express';
import { addAnnotationsToPdf, removeAnnotationsFromPdf, addImageAnnotationsToPdf, type AnnotationInput, type ImageAnnotationInput } from '../tools/builtin-tools/pdf/pdfAnnotationUtils';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { normalize as normalizePath } from 'node:path';

interface FormFieldUpdate {
  name: string;
  value: any;
}

/**
 * Save form field values to PDF without emitting FILE_REFRESHED event.
 * Used by UI for auto-save to prevent refresh jank.
 */
async function saveFormFieldsToPdf(
  filePath: string,
  fields: FormFieldUpdate[]
): Promise<{ success: boolean; error?: string; updatedCount: number }> {
  try {
    const resolvedPath = normalizePath(filePath);

    if (!existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${resolvedPath}`, updatedCount: 0 };
    }

    // Read and load PDF
    const pdfData = await readFile(resolvedPath);
    const pdfDoc = await PDFDocument.load(pdfData);

    // Handle XFA forms (same as editPdfTool)
    const catalog = pdfDoc.catalog;
    const acroFormRef = catalog.lookup(PDFName.of('AcroForm'));
    const acroForm = acroFormRef instanceof PDFDict ? acroFormRef : null;

    if (acroForm && acroForm.has(PDFName.of('XFA'))) {
      acroForm.delete(PDFName.of('XFA'));
      acroForm.set(PDFName.of('NeedAppearances'), pdfDoc.context.obj(true));
    }

    const form = pdfDoc.getForm();
    const formFields = form.getFields();

    // Create field name map
    const fieldsByName = new Map<string, any>();
    formFields.forEach(field => {
      fieldsByName.set(field.getName(), field);
    });

    // Fill fields
    let updatedCount = 0;

    for (const fieldUpdate of fields) {
      const field = fieldsByName.get(fieldUpdate.name);
      if (!field) continue;

      const fieldType = field.constructor.name;

      try {
        if (fieldType.includes('Text')) {
          field.setText(String(fieldUpdate.value ?? ''));
          updatedCount++;
        } else if (fieldType.includes('CheckBox')) {
          const shouldCheck = normalizeBoolean(fieldUpdate.value);
          if (shouldCheck) {
            field.check();
          } else {
            field.uncheck();
          }
          updatedCount++;
        } else if (fieldType.includes('RadioGroup')) {
          field.select(String(fieldUpdate.value));
          updatedCount++;
        } else if (fieldType.includes('Dropdown')) {
          field.select(String(fieldUpdate.value));
          updatedCount++;
        } else if (fieldType.includes('OptionList')) {
          if (Array.isArray(fieldUpdate.value)) {
            field.select(fieldUpdate.value.map(String));
          } else {
            field.select([String(fieldUpdate.value)]);
          }
          updatedCount++;
        }
      } catch (e) {
        console.warn(`[saveFormFieldsToPdf] Error setting field "${fieldUpdate.name}":`, e);
      }
    }

    // Save the modified PDF
    const modifiedPdfBytes = await pdfDoc.save({
      updateFieldAppearances: true
    });

    await writeFile(resolvedPath, modifiedPdfBytes);

    return { success: true, updatedCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message, updatedCount: 0 };
  }
}

function normalizeBoolean(value: any): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return ['yes', 'true', 'on', 'checked', '1', 'x'].includes(lower);
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

const router = Router();

/**
 * POST /api/pdf/annotations/add
 * Add annotations to a PDF without triggering FILE_REFRESHED
 */
router.post('/annotations/add', async (req: Request, res: Response) => {
  try {
    const { path, annotations } = req.body as { path: string; annotations: AnnotationInput[] };

    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }

    if (!annotations || annotations.length === 0) {
      return res.status(400).json({ error: 'At least one annotation is required' });
    }

    const result = await addAnnotationsToPdf(path, annotations);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      success: true,
      createdIds: result.createdIds,
      results: result.results
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add annotations';
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pdf/annotations/add-image
 * Add image annotations to a PDF without triggering FILE_REFRESHED
 */
router.post('/annotations/add-image', async (req: Request, res: Response) => {
  try {
    const { path, annotations } = req.body as { path: string; annotations: ImageAnnotationInput[] };

    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }

    if (!annotations || annotations.length === 0) {
      return res.status(400).json({ error: 'At least one image annotation is required' });
    }

    const result = await addImageAnnotationsToPdf(path, annotations);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      success: true,
      createdIds: result.createdIds,
      results: result.results
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add image annotations';
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pdf/annotations/remove
 * Remove annotations from a PDF without triggering FILE_REFRESHED
 */
router.post('/annotations/remove', async (req: Request, res: Response) => {
  try {
    const { path, annotationIds } = req.body as { path: string; annotationIds: string[] };

    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }

    if (!annotationIds || annotationIds.length === 0) {
      return res.status(400).json({ error: 'At least one annotation ID is required' });
    }

    const result = await removeAnnotationsFromPdf(path, annotationIds);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      success: true,
      removedCount: result.removedCount,
      results: result.results
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove annotations';
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pdf/formfields/save
 * Save form field values to a PDF without triggering FILE_REFRESHED
 */
router.post('/formfields/save', async (req: Request, res: Response) => {
  try {
    const { path, fields } = req.body as { path: string; fields: FormFieldUpdate[] };

    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }

    if (!fields || fields.length === 0) {
      return res.status(400).json({ error: 'At least one field is required' });
    }

    const result = await saveFormFieldsToPdf(path, fields);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const fieldsSent = Array.isArray(fields) ? fields.length : 0;
    void import('../telemetry')
      .then(({ sendTelemetry }) =>
        sendTelemetry('info', {
          event: 'pdf_form_saved',
          fileType: 'pdf',
          extension: 'pdf',
          updatedCount: result.updatedCount,
          fieldCount: fieldsSent,
        })
      )
      .catch(() => {});

    return res.json({
      success: true,
      updatedCount: result.updatedCount
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save form fields';
    return res.status(500).json({ error: message });
  }
});

export default router;
