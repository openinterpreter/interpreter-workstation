// Edit PDF Tool
// Fills form fields in PDF documents

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, basename } from 'path';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { PDFDocument, PDFDict, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { emitEvent } from '../../../utils/ipcBridge';
import { broadcastEvent } from '../../../handlers/broadcast';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry';
import forge from 'node-forge';
import { PdfDigitalSigner } from 'sign-pdf-lib';
import { approvalManager } from '../../../approvalManager';

export const editPdfTool: BuiltinToolDefinition = {
  name: 'fill_pdf_form',
  description: `Fill INTERACTIVE form fields in a PDF document.

⚠️  ONLY works on PDFs with real AcroForm fields (clickable text boxes, checkboxes, dropdowns).
Does NOT work on PDFs with fake forms (just underlines or blank spaces drawn as text/lines).

Use read_pdf first to check if the PDF has form fields:
- If you see [fN] entries → use this tool
- If you only see text with blanks → use add_pdf_annotations instead

⚠️  CRITICAL: Fill ALL fields in ONE SINGLE CALL. Never call multiple times.

⚠️  CRITICAL: The "id" MUST be the exact "fN" string from read_pdf output (e.g. "f0", "f14", "f96").
Field IDs are NOT sequential in display order — always match by field name, not by number.

See read_pdf for the recommended workflow. Always use read_pdf first to get field IDs.

Example:
{
  "path": "form.pdf",
  "fields": [
    {"id": "f0", "value": "Acme Corporation"},
    {"id": "f5", "value": "123 Main Street"},
    {"id": "f23", "value": "San Francisco"}
  ]
}`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file (absolute or workspace-relative)'
      },
      fields: {
        type: 'array',
        description: 'Array of fields to fill',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Field ID from read_pdf output in "fN" format (e.g., "f0", "f5", "f23"). Must match the exact [fN] shown in read_pdf.'
            },
            value: {
              description: 'Value to set. For text fields: a string. For checkboxes: true/false (boolean or string). For dropdowns/radio: the option string. For signature fields: the signer\'s name (drawn as text in the signature box).'
            }
          },
          required: ['id', 'value']
        }
      }
    },
    required: ['path', 'fields']
  },
  fileAccess: {
    mode: 'write',
    pathArg: 'path'
  },
  mode: 'write',
  fileTypes: ['.pdf'],
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    try {
      const filePath = args.path as string;
      const fields = args.fields as Array<{
        id: number | string;  // Accept "f0" format from read_pdf or numeric index
        value: any;
      }>;

      if (!filePath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true
        };
      }

      if (fields && !Array.isArray(fields)) {
        return {
          content: [{
            type: 'text',
            text: 'Error: fields must be an array of {id,value} objects from read_pdf output, e.g. {"fields":[{"id":"f0","value":"Acme"}]}. Do not pass an object keyed by field name.'
          }],
          isError: true
        };
      }

      if (!fields || fields.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: Fields array is required and must not be empty. Use read_pdf first, then pass fields as [{"id":"f0","value":"..."}].' }],
          isError: true
        };
      }

      // Resolve path relative to workspace
      const workspace = getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(filePath, workspace);

      if (!existsSync(resolvedPath)) {
        return {
          content: [
            { type: 'text', text: `Error: File not found: ${resolvedPath}` },
          ],
          isError: true
        };
      }

      const ext = extname(resolvedPath).toLowerCase();
      if (ext !== '.pdf') {
        return {
          content: [
            { type: 'text', text: 'Error: Only .pdf files are supported' },
          ],
          isError: true
        };
      }

      // Read and load PDF
      const pdfData = await readFile(resolvedPath);
      const pdfDoc = await PDFDocument.load(pdfData);

      // Check for XFA forms
      // XFA is XML-based form data that overrides AcroForm values
      // pdf-lib doesn't support XFA, so we need to remove it for edits to work
      const catalog = pdfDoc.catalog;
      const acroFormRef = catalog.lookup(PDFName.of('AcroForm'));
      const acroForm = acroFormRef instanceof PDFDict ? acroFormRef : null;
      let hadXFA = false;

      if (acroForm && acroForm.has(PDFName.of('XFA'))) {
        hadXFA = true;
        console.log('[fillPdfFormTool] PDF contains XFA form data - converting to AcroForm');

        // Remove XFA to make AcroForm the source of truth
        // This is necessary because:
        // 1. pdf-lib doesn't support editing XFA
        // 2. XFA data would override our AcroForm edits when rendered
        // 3. This is similar to Adobe Acrobat's "Save As > Reduced Size PDF"
        acroForm.delete(PDFName.of('XFA'));

        // Set NeedAppearances to force PDF viewers to regenerate field appearances
        acroForm.set(PDFName.of('NeedAppearances'), pdfDoc.context.obj(true));
      }

      const form = pdfDoc.getForm();
      const formFields = form.getFields();

      // Strip RichText flag from all text fields BEFORE any operations.
      // pdf-lib's updateFieldAppearances() calls getText() on every field,
      // which throws RichTextFieldReadError for fields with the RichText flag.
      // Disabling it is safe — rich text (XFA) is deprecated in PDF 2.0,
      // and setText() already strips it for fields we write to.
      for (const field of formFields) {
        if (field.constructor.name.includes('Text') && typeof (field as any).isRichFormatted === 'function') {
          if ((field as any).isRichFormatted()) {
            (field as any).disableRichFormatting();
            console.log(`[fillPdfFormTool] Stripped RichText flag from field: ${field.getName()}`);
          }
        }
      }

      // Create field index map
      const fieldsByName = new Map<string, any>();
      const fieldsByIndex: any[] = [];

      formFields.forEach((field, index) => {
        const name = field.getName();
        fieldsByName.set(name, field);
        fieldsByIndex[index] = field;
      });

      // Build field-index → page-number mapping (1-based) so we can auto-scroll
      const pages = pdfDoc.getPages();
      const pageRefToNumber = new Map<any, number>();
      pages.forEach((p, i) => pageRefToNumber.set(p.ref, i + 1));

      function getFieldPage(field: any): number | null {
        try {
          const widgets = field.acroField.getWidgets();
          if (widgets.length > 0) {
            const pageRef = widgets[0].P();
            if (pageRef && pageRefToNumber.has(pageRef)) {
              return pageRefToNumber.get(pageRef)!;
            }
            // Fallback: search all pages for the widget annotation
            const widgetRef = pdfDoc.context.getObjectRef(widgets[0].dict);
            for (let pi = 0; pi < pages.length; pi++) {
              const annots = (pages[pi].node as any).Annots?.();
              if (annots && widgetRef) {
                for (let ai = 0; ai < annots.size(); ai++) {
                  if (annots.get(ai) === widgetRef) return pi + 1;
                }
              }
            }
          }
        } catch (_) {}
        return null;
      }

      // Resolve field indices first so we can group by page
      const errors: string[] = [];
      const resolvedFields: Array<{
        fieldUpdateIndex: number;
        fieldUpdate: typeof fields[number];
        fieldIndex: number;
        field: any;
        page: number | null;
      }> = [];

      for (const [fieldUpdateIndex, fieldUpdate] of fields.entries()) {
        if (fieldUpdate.id === undefined || fieldUpdate.id === null) {
          errors.push(`Missing id in field update at index ${fieldUpdateIndex}`);
          continue;
        }
        let rawId = fieldUpdate.id;
        let fieldIndex: number;
        if (typeof rawId === 'string' && rawId.startsWith('f')) {
          fieldIndex = Number(rawId.slice(1));
        } else if (typeof rawId === 'number') {
          fieldIndex = rawId;
        } else {
          fieldIndex = Number(rawId);
        }
        if (isNaN(fieldIndex) || fieldIndex < 0) {
          errors.push(`Invalid field id "${fieldUpdate.id}". Use the "fN" format from read_pdf (e.g., "f0", "f5", "f23").`);
          continue;
        }
        const field = fieldsByIndex[fieldIndex];
        if (!field) {
          const validIds = Object.keys(fieldsByIndex).slice(0, 10).map(k => `f${k}`).join(', ');
          errors.push(`Field f${fieldIndex} not found. Valid field IDs include: ${validIds}... (${Object.keys(fieldsByIndex).length} total)`);
          continue;
        }
        resolvedFields.push({
          fieldUpdateIndex,
          fieldUpdate,
          fieldIndex,
          field,
          page: getFieldPage(field),
        });
      }

      // Group by page, preserving order within each page
      const byPage = new Map<number, typeof resolvedFields>();
      const noPage: typeof resolvedFields = [];
      for (const rf of resolvedFields) {
        if (rf.page != null) {
          if (!byPage.has(rf.page)) byPage.set(rf.page, []);
          byPage.get(rf.page)!.push(rf);
        } else {
          noPage.push(rf);
        }
      }
      // Process pages in order
      const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
      const orderedGroups = [
        ...sortedPages.map(p => ({ page: p, fields: byPage.get(p)! })),
        ...(noPage.length > 0 ? [{ page: null as number | null, fields: noPage }] : []),
      ];

      // Fill the fields — for each page: scroll first, then fill + save, so user sees animation
      const updatedFields: string[] = [];
      const pendingSignatures: Array<{ fieldName: string; signerName: string }> = [];
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

      for (const group of orderedGroups) {
        // 1) SCROLL to this page FIRST so the user sees the fill animation
        if (group.page != null) {
          broadcastEvent(IPC_CHANNELS.WORKSTATION_OPEN_FILE, { path: resolvedPath, page: group.page });
          await sleep(1000); // Let scroll settle before filling
        }

        // 2) Fill fields in memory
        const filledOnThisPage: any[] = [];

        for (const { fieldUpdate, field } of group.fields) {
          let fieldName = field.getName();
          try {
            const fieldType = field.constructor.name;

            if (fieldType.includes('Text')) {
              const textValue = String(fieldUpdate.value);
              // Check maxLength BEFORE calling setText so we can give a clear error
              const maxLength = (field as any).getMaxLength?.();
              if (maxLength && textValue.length > maxLength) {
                errors.push(`REJECTED ${fieldUpdate.id} (${fieldName}): Value is ${textValue.length} chars but field only allows ${maxLength}. Shorten the value to fit.`);
                continue;
              }
              field.setText(textValue);
              filledOnThisPage.push(field);
              updatedFields.push(`${fieldName} (text) = "${textValue}"`);
            } else if (fieldType.includes('CheckBox')) {
              const shouldCheck = normalizeBoolean(fieldUpdate.value);
              if (shouldCheck) {
                field.check();
              } else {
                field.uncheck();
              }
              updatedFields.push(`${fieldName} (checkbox) = ${shouldCheck}`);
            } else if (fieldType.includes('RadioGroup')) {
              const resolved = matchOption(field.getOptions(), String(fieldUpdate.value));
              field.select(resolved);
              updatedFields.push(`${fieldName} (radio) = "${resolved}"`);
            } else if (fieldType.includes('Dropdown')) {
              const resolved = matchOption(field.getOptions(), String(fieldUpdate.value));
              field.select(resolved);
              filledOnThisPage.push(field);
              updatedFields.push(`${fieldName} (dropdown) = "${resolved}"`);
            } else if (fieldType.includes('OptionList')) {
              if (Array.isArray(fieldUpdate.value)) {
                const resolved = fieldUpdate.value.map((v: any) => matchOption(field.getOptions(), String(v)));
                field.select(resolved);
                updatedFields.push(`${fieldName} (listbox) = [${resolved.join(', ')}]`);
              } else {
                const resolved = matchOption(field.getOptions(), String(fieldUpdate.value));
                field.select([resolved]);
                updatedFields.push(`${fieldName} (listbox) = "${resolved}"`);
              }
              filledOnThisPage.push(field);
            } else if (fieldType.includes('Signature')) {
            // Digital signature requires user approval (session-aware).
            const signerName = String(fieldUpdate.value);
            const agentId = context?.agentId;
            const toolCallId = context?.toolCallId;

            try {
              const { approved } = await approvalManager.createSessionAwareApproval(
                'fill_pdf_form:signature',
                'builtin-pdf',
                {
                  document: basename(resolvedPath),
                  field: fieldName,
                  signer: signerName,
                },
                `Let Interpreter digitally sign "${basename(resolvedPath)}" as "${signerName}"?`,
                60000,
                toolCallId,
                agentId
              );

              if (!approved) {
                errors.push(`Signature on ${fieldName} denied by user`);
                continue;
              }
            } catch (approvalErr: any) {
              errors.push(`Signature approval failed for ${fieldName}: ${approvalErr.message}`);
              continue;
            }

            // Approved — two layers: visible text + real PKCS#7 digital signature
            pendingSignatures.push({ fieldName, signerName });

            // Draw visible signature text inside the widget box
            try {
              const widgets = field.acroField.getWidgets();
              if (widgets.length > 0) {
                const widget = widgets[0];
                const rect = widget.getRectangle();
                const pageRef = widget.P();
                const pages = pdfDoc.getPages();
                let page = pages.find((p: any) => p.ref === pageRef);
                if (!page) {
                  const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
                  for (const p of pages) {
                    const annots = (p.node as any).Annots?.();
                    if (annots && widgetRef) {
                      for (let ai = 0; ai < annots.size(); ai++) {
                        if (annots.get(ai) === widgetRef) { page = p; break; }
                      }
                    }
                    if (page) break;
                  }
                }
                if (page) {
                  const sigFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
                  const maxWidth = rect.width - 4;
                  let fontSize = 14;
                  while (fontSize > 6 && sigFont.widthOfTextAtSize(signerName, fontSize) > maxWidth) {
                    fontSize -= 0.5;
                  }
                  page.drawText(signerName, {
                    x: rect.x + 2,
                    y: rect.y + (rect.height - fontSize) / 2,
                    size: fontSize,
                    font: sigFont,
                    color: rgb(0.05, 0.05, 0.2),
                  });
                  // Hide the widget so drawn text shows through
                  const flags = widget.dict.get(PDFName.of('F'));
                  const currentFlags = flags && typeof (flags as any).asNumber === 'function'
                    ? (flags as any).asNumber() : 0;
                  widget.dict.set(PDFName.of('F'), pdfDoc.context.obj(currentFlags | 2));
                }
              }
            } catch (_) {
              // Visual text is best-effort — signing still happens below
            }

            updatedFields.push(`${fieldName} (signature) = "${signerName}"`);
          } else {
            errors.push(`Unsupported field type for ${fieldName}: ${fieldType}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          // Enhance error messages to be more actionable for the agent
          if (message.includes('maxLength')) {
            errors.push(`REJECTED ${fieldUpdate.id} (${fieldName}): Value "${String(fieldUpdate.value).substring(0, 30)}..." is ${String(fieldUpdate.value).length} chars but field only allows ${message.match(/maxLength=(\d+)/)?.[1]} chars. Shorten the value or check you're using the right field ID.`);
          } else if (message.includes('Valid options are:') || (message.includes('option') && message.includes('must be one of'))) {
            errors.push(`REJECTED ${fieldUpdate.id} (${fieldName}): ${message}`);
          } else {
            errors.push(`REJECTED ${fieldUpdate.id} (${fieldName}): ${message}`);
          }
        }
      } // end group.fields

        // 3) Save to disk and emit the unified refresh event so the viewer can animate from disk.
        if (filledOnThisPage.length > 0) {
          for (const f of filledOnThisPage) {
            const ft = f.constructor.name;
            if (ft.includes('Text') || ft.includes('Dropdown') || ft.includes('OptionList')) {
              try { (f as any).defaultUpdateAppearances(helv); } catch (_) {}
            }
          }
          const snap = await pdfDoc.save({ updateFieldAppearances: false });
          await writeFile(resolvedPath, snap);
          emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedPath });
          await sleep(2500); // Let typing animation play out before moving on
        }
      } // end orderedGroups

      // Final save (captures any remaining state like signature visual text)
      let pdfBuffer: Buffer<ArrayBufferLike> = Buffer.from(await pdfDoc.save({ updateFieldAppearances: false }));

      // Apply real digital signatures using sign-pdf-lib
      if (pendingSignatures.length > 0) {
        try {
          // Generate a self-signed P12 certificate for signing
          const p12Buffer = generateSelfSignedP12(
            pendingSignatures[0].signerName // Use first signer's name as CN
          );

          const signer = new PdfDigitalSigner({
            signatureLength: 4096,
            rangePlaceHolder: 65536,
            signatureComputer: {
              certificate: p12Buffer,
              password: '',
            },
          });

          // Sign each signature field sequentially (each call returns a new buffer)
          for (const sig of pendingSignatures) {
            try {
              pdfBuffer = await signer.signFieldAsync(pdfBuffer, {
                fieldName: sig.fieldName,
                signature: {
                  name: sig.signerName,
                  reason: 'Document signed digitally',
                  date: new Date(),
                },
              });
              console.log(`[editPdfTool] Digitally signed field: ${sig.fieldName}`);
            } catch (sigErr: any) {
              errors.push(`Failed to digitally sign ${sig.fieldName}: ${sigErr.message}`);
            }
          }
        } catch (certErr: any) {
          errors.push(`Failed to generate signing certificate: ${certErr.message}`);
        }
      }

      await writeFile(resolvedPath, pdfBuffer);

      // Emit the unified agent-edit refresh event so open viewers reload from disk.
      emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedPath });
      console.log('[editPdfTool] Emitted FILE_REFRESHED for:', resolvedPath);

      // Build response — keep it compact to save tokens
      let responseText = `Filled ${updatedFields.length} field(s) in ${basename(resolvedPath)}.`;

      if (hadXFA) {
        responseText += `\n⚠️  XFA form data was removed to enable editing (legacy Adobe format, deprecated 2019).`;
      }

      if (errors.length > 0) {
        responseText += `\n\nErrors (${errors.length}):\n`;
        errors.forEach(error => {
          responseText += `  ✗ ${error}\n`;
        });
      }

      return {
        content: [
          { type: 'text', text: responseText },
        ],
        isError: errors.length > 0 && updatedFields.length === 0
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to edit PDF document';
      return {
        content: [
          { type: 'text', text: `Error editing PDF document: ${message}` },
        ],
        isError: true
      };
    }
  }
};

/**
 * Match a user-provided value to a valid option.
 * Only auto-corrects when the intent is unambiguous:
 *   - Case-insensitive exact match ("No" → "NO")
 *   - Stripped trailing non-alphanumeric ("24%" → "24")
 * Everything else is rejected with a clear error listing valid options.
 */
function matchOption(options: string[], value: string): string {
  if (!value || !value.trim()) {
    const optionsList = options.map(o => `"${o}"`).join(', ');
    throw new Error(`Empty value provided. This is a radio/dropdown field — you must pick one of: [${optionsList}]. Leave this field out of your request entirely if you don't want to set it.`);
  }

  // Exact match
  if (options.includes(value)) return value;

  const trimmed = value.trim();

  // Case-insensitive exact match ("No" → "NO", "yes" → "Yes")
  const ciMatch = options.find(opt => opt.toLowerCase().trim() === trimmed.toLowerCase());
  if (ciMatch) return ciMatch;

  // Strip trailing non-alphanumeric chars and retry ("24%" → "24")
  const stripped = trimmed.replace(/[^a-zA-Z0-9]+$/, '');
  if (stripped !== trimmed) {
    const strippedMatch = options.find(opt => opt.toLowerCase().trim() === stripped.toLowerCase());
    if (strippedMatch) return strippedMatch;
  }

  // No match — reject with clear error listing every valid option
  const optionsList = options.map(o => `"${o}"`).join(', ');
  throw new Error(`Value "${value}" does not match any valid option. Valid options are: [${optionsList}]. Use one of these EXACTLY.`);
}


const TRUTHY_VALUES = ['yes', 'true', 'on', 'checked', '1', 'x'];
const FALSY_VALUES = ['no', 'false', 'off', 'unchecked', '0', ''];

function normalizeBoolean(value: any): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    throw new Error(`Unrecognized checkbox value: ${value}. Use true/false, yes/no, or 1/0.`);
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (TRUTHY_VALUES.includes(lower)) return true;
    if (FALSY_VALUES.includes(lower)) return false;
    throw new Error(`Unrecognized checkbox value: "${value}". Use true/false, yes/no, checked/unchecked, or 1/0.`);
  }
  throw new Error(`Unrecognized checkbox value type: ${typeof value}. Use true/false, yes/no, or 1/0.`);
}

/**
 * Generate a self-signed PKCS#12 certificate for PDF digital signing.
 * Uses node-forge to create a certificate with the signer's name as CN.
 * Returns a Buffer containing the P12 data (empty password).
 */
function generateSelfSignedP12(commonName: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, '');
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(p12Der, 'binary');
}
