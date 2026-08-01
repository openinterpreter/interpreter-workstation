// XML Validation for Office Open XML documents
import { XMLValidator } from 'fast-xml-parser';

export interface XmlValidationError {
  line?: number;
  column?: number;
  message: string;
  code?: string;
  lineContent?: string; // The actual problematic line
  contextBefore?: string[]; // 2-3 lines before the error
  contextAfter?: string[]; // 2-3 lines after the error
  suggestedFix?: string; // Optional hint for fixing
}

export interface XmlValidationResult {
  valid: boolean;
  errors: XmlValidationError[];
}

export function validateOoxmlDocument(xmlContent: string): XmlValidationResult {
  const validation = XMLValidator.validate(xmlContent);

  if (validation === true) {
    return { valid: true, errors: [] };
  }

  const errorInfo = extractErrorInfo(validation.err, xmlContent);
  return {
    valid: false,
    errors: [errorInfo]
  };
}

function extractErrorInfo(error: any, xmlContent: string): XmlValidationError {
  const message = error?.message || error?.msg || String(error);

  // Try to extract line number from error message
  const lineMatch = message.match(/line[:\s]+(\d+)/i);
  const line = typeof error?.line === 'number'
    ? error.line
    : lineMatch ? parseInt(lineMatch[1], 10) : undefined;

  const colMatch = message.match(/col(?:umn)?[:\s]+(\d+)/i);
  const column = typeof error?.col === 'number'
    ? error.col
    : typeof error?.column === 'number'
      ? error.column
      : colMatch ? parseInt(colMatch[1], 10) : undefined;

  // Extract line context if we have a line number
  let lineContent: string | undefined;
  let contextBefore: string[] | undefined;
  let contextAfter: string[] | undefined;
  let suggestedFix: string | undefined;

  if (line && xmlContent) {
    const lines = xmlContent.split('\n');
    const lineIndex = line - 1; // Convert to 0-based

    if (lineIndex >= 0 && lineIndex < lines.length) {
      lineContent = lines[lineIndex];

      // Get 2-3 lines before
      const beforeStart = Math.max(0, lineIndex - 3);
      contextBefore = lines.slice(beforeStart, lineIndex);

      // Get 2-3 lines after
      const afterEnd = Math.min(lines.length, lineIndex + 4);
      contextAfter = lines.slice(lineIndex + 1, afterEnd);
    }
  }

  // Generate suggested fixes based on common error patterns
  if (message.toLowerCase().includes('unclosed') || message.toLowerCase().includes('expected')) {
    if (message.includes('</')) {
      suggestedFix = 'Ensure all opening tags have matching closing tags. Check for typos in tag names.';
    } else if (message.includes('>')) {
      suggestedFix = 'Missing closing bracket (>) or incorrect tag nesting detected.';
    }
  } else if (message.toLowerCase().includes('invalid') || message.toLowerCase().includes('unexpected')) {
    suggestedFix = 'Check for special characters that need escaping (<, >, &) or invalid XML structure.';
  } else if (message.toLowerCase().includes('namespace')) {
    suggestedFix = 'Ensure namespace prefixes (w:, r:, a:, etc.) are properly declared in root element.';
  } else if (message.toLowerCase().includes('attribute')) {
    suggestedFix = 'Check attribute syntax: attributes must be in quotes and properly formatted (attr="value").';
  }

  return { line, column, message, lineContent, contextBefore, contextAfter, suggestedFix };
}
