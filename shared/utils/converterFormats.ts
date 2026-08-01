/**
 * Shared converter format metadata.
 *
 * This module is the source of truth for Office-format classification and
 * extension-level conversion targets used across the app.
 */

export const OFFICE_EDITOR_EXTENSIONS = new Set([
  'docx', 'doc', 'odt', 'rtf',
  'xlsx', 'xls', 'xlsm', 'ods', 'csv',
  'pptx', 'ppt', 'odp',
]);

// Conversion targets supported by the compatible document-engine contract.
export const X2T_CONVERTIBLE_FORMATS: Record<string, string[]> = {
  // Documents
  '.doc': ['docx', 'pdf', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2'],
  '.docx': ['pdf', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2'],
  '.odt': ['docx', 'pdf', 'rtf', 'txt', 'html', 'epub', 'fb2'],
  '.rtf': ['docx', 'pdf', 'odt', 'txt', 'html', 'epub', 'fb2'],
  '.txt': ['docx', 'pdf', 'odt', 'rtf', 'html', 'epub', 'fb2'],
  '.html': ['docx', 'pdf', 'odt', 'txt', 'epub', 'fb2'],
  '.htm': ['docx', 'pdf', 'odt', 'txt', 'epub', 'fb2'],
  '.epub': ['docx', 'pdf', 'odt', 'rtf', 'txt', 'html', 'fb2'],
  '.fb2': ['docx', 'pdf', 'odt', 'rtf', 'txt', 'html', 'epub'],
  // Spreadsheets
  '.xls': ['xlsx', 'pdf', 'ods', 'csv'],
  '.xlsx': ['pdf', 'ods', 'csv'],
  '.ods': ['xlsx', 'pdf', 'csv'],
  '.csv': ['xlsx', 'pdf', 'ods'],
  '.fods': ['xlsx', 'pdf', 'ods', 'csv'],
  // Presentations
  '.ppt': ['pptx', 'pdf', 'odp'],
  '.pptx': ['pdf', 'odp'],
  '.odp': ['pptx', 'pdf'],
  '.fodp': ['pptx', 'pdf', 'odp'],
};

function normalizeExtension(ext: string): string {
  if (!ext) return '';
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

export function getPathExtension(filePath: string): string {
  if (!filePath) return '';
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot <= lastSlash) return '';
  return filePath.slice(lastDot).toLowerCase();
}

/**
 * Returns all target formats accepted by convert_file for the given input extension.
 * Returns only formats declared by the configured document-engine contract.
 */
export function getConversionTargetsForExtension(inputExtension: string): string[] | null {
  const ext = normalizeExtension(inputExtension);
  if (!ext) return null;

  const targets = X2T_CONVERTIBLE_FORMATS[ext] ?? [];
  return targets.length > 0 ? [...targets] : null;
}

export function getConversionTargetsForPath(filePath: string): string[] | null {
  const ext = getPathExtension(filePath);
  return getConversionTargetsForExtension(ext);
}
