import { describe, test, expect } from 'bun:test';

/**
 * Unit tests for file conversion logic.
 * Tests format validation, conversion rules, and XML generation.
 */

// Replicate the format codes from convertFileTool.ts
const FORMAT_CODES: Record<string, number> = {
  docx: 65,
  odt: 67,
  rtf: 68,
  txt: 69,
  html: 70,
  epub: 72,
  fb2: 73,
  xlsx: 257,
  ods: 259,
  csv: 260,
  pptx: 129,
  odp: 131,
  pdf: 513,
};

// Replicate the conversion rules from convertFileTool.ts
const CONVERTIBLE_FORMATS: Record<string, string[]> = {
  '.doc': ['docx', 'pdf', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2'],
  '.docx': ['pdf', 'odt', 'rtf', 'txt', 'html', 'epub', 'fb2'],
  '.odt': ['docx', 'pdf', 'rtf', 'txt', 'html', 'epub', 'fb2'],
  '.rtf': ['docx', 'pdf', 'odt', 'txt', 'html', 'epub', 'fb2'],
  '.txt': ['docx', 'pdf', 'odt', 'rtf', 'html', 'epub', 'fb2'],
  '.html': ['docx', 'pdf', 'odt', 'txt', 'epub', 'fb2'],
  '.htm': ['docx', 'pdf', 'odt', 'txt', 'epub', 'fb2'],
  '.epub': ['docx', 'pdf', 'odt', 'rtf', 'txt', 'html', 'fb2'],
  '.fb2': ['docx', 'pdf', 'odt', 'rtf', 'txt', 'html', 'epub'],
  '.xls': ['xlsx', 'pdf', 'ods', 'csv'],
  '.xlsx': ['pdf', 'ods', 'csv'],
  '.ods': ['xlsx', 'pdf', 'csv'],
  '.csv': ['xlsx', 'pdf', 'ods'],
  '.fods': ['xlsx', 'pdf', 'ods', 'csv'],
  '.ppt': ['pptx', 'pdf', 'odp'],
  '.pptx': ['pdf', 'odp'],
  '.odp': ['pptx', 'pdf'],
  '.fodp': ['pptx', 'pdf', 'odp'],
};

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidConversion(inputExt: string, targetFormat: string): boolean {
  const allowed = CONVERTIBLE_FORMATS[inputExt.toLowerCase()];
  if (!allowed) return false;
  return allowed.includes(targetFormat);
}

function getFormatCode(format: string): number | undefined {
  return FORMAT_CODES[format];
}

describe('File conversion', () => {
  describe('FORMAT_CODES', () => {
    test('has all expected document formats', () => {
      expect(FORMAT_CODES.docx).toBe(65);
      expect(FORMAT_CODES.odt).toBe(67);
      expect(FORMAT_CODES.rtf).toBe(68);
      expect(FORMAT_CODES.txt).toBe(69);
      expect(FORMAT_CODES.html).toBe(70);
      expect(FORMAT_CODES.epub).toBe(72);
      expect(FORMAT_CODES.fb2).toBe(73);
    });

    test('has all expected spreadsheet formats', () => {
      expect(FORMAT_CODES.xlsx).toBe(257);
      expect(FORMAT_CODES.ods).toBe(259);
      expect(FORMAT_CODES.csv).toBe(260);
    });

    test('has all expected presentation formats', () => {
      expect(FORMAT_CODES.pptx).toBe(129);
      expect(FORMAT_CODES.odp).toBe(131);
    });

    test('has PDF format', () => {
      expect(FORMAT_CODES.pdf).toBe(513);
    });
  });

  describe('escapeXml', () => {
    test('escapes ampersands', () => {
      expect(escapeXml('foo & bar')).toBe('foo &amp; bar');
    });

    test('escapes less-than signs', () => {
      expect(escapeXml('a < b')).toBe('a &lt; b');
    });

    test('escapes greater-than signs', () => {
      expect(escapeXml('a > b')).toBe('a &gt; b');
    });

    test('escapes multiple special characters', () => {
      expect(escapeXml('<tag> & </tag>')).toBe('&lt;tag&gt; &amp; &lt;/tag&gt;');
    });

    test('handles empty string', () => {
      expect(escapeXml('')).toBe('');
    });

    test('returns unchanged string when no special characters', () => {
      expect(escapeXml('normal text')).toBe('normal text');
    });

    test('handles file paths with special characters', () => {
      expect(escapeXml('/path/to/file <copy>.docx')).toBe('/path/to/file &lt;copy&gt;.docx');
    });
  });

  describe('isValidConversion', () => {
    describe('document conversions', () => {
      test('docx can convert to pdf', () => {
        expect(isValidConversion('.docx', 'pdf')).toBe(true);
      });

      test('docx can convert to odt', () => {
        expect(isValidConversion('.docx', 'odt')).toBe(true);
      });

      test('docx cannot convert to xlsx (wrong category)', () => {
        expect(isValidConversion('.docx', 'xlsx')).toBe(false);
      });

      test('docx cannot convert to docx (same format)', () => {
        expect(isValidConversion('.docx', 'docx')).toBe(false);
      });

      test('doc can convert to docx (upgrade)', () => {
        expect(isValidConversion('.doc', 'docx')).toBe(true);
      });
    });

    describe('spreadsheet conversions', () => {
      test('xlsx can convert to pdf', () => {
        expect(isValidConversion('.xlsx', 'pdf')).toBe(true);
      });

      test('xlsx can convert to csv', () => {
        expect(isValidConversion('.xlsx', 'csv')).toBe(true);
      });

      test('xlsx cannot convert to docx (wrong category)', () => {
        expect(isValidConversion('.xlsx', 'docx')).toBe(false);
      });

      test('csv can convert to xlsx', () => {
        expect(isValidConversion('.csv', 'xlsx')).toBe(true);
      });
    });

    describe('presentation conversions', () => {
      test('pptx can convert to pdf', () => {
        expect(isValidConversion('.pptx', 'pdf')).toBe(true);
      });

      test('pptx can convert to odp', () => {
        expect(isValidConversion('.pptx', 'odp')).toBe(true);
      });

      test('pptx cannot convert to docx (wrong category)', () => {
        expect(isValidConversion('.pptx', 'docx')).toBe(false);
      });

      test('ppt can convert to pptx (upgrade)', () => {
        expect(isValidConversion('.ppt', 'pptx')).toBe(true);
      });
    });

    describe('unsupported formats', () => {
      test('returns false for unsupported input format', () => {
        expect(isValidConversion('.mp3', 'pdf')).toBe(false);
      });

      test('returns false for image formats', () => {
        expect(isValidConversion('.png', 'pdf')).toBe(false);
        expect(isValidConversion('.jpg', 'pdf')).toBe(false);
      });
    });

    describe('case insensitivity', () => {
      test('handles uppercase extensions', () => {
        expect(isValidConversion('.DOCX', 'pdf')).toBe(true);
      });

      test('handles mixed case extensions', () => {
        expect(isValidConversion('.DocX', 'pdf')).toBe(true);
      });
    });
  });

  describe('getFormatCode', () => {
    test('returns correct code for pdf', () => {
      expect(getFormatCode('pdf')).toBe(513);
    });

    test('returns correct code for docx', () => {
      expect(getFormatCode('docx')).toBe(65);
    });

    test('returns undefined for unsupported format', () => {
      expect(getFormatCode('mp3')).toBeUndefined();
    });
  });

  describe('All formats can convert to PDF', () => {
    const allInputFormats = Object.keys(CONVERTIBLE_FORMATS);

    for (const format of allInputFormats) {
      test(`${format} can convert to PDF`, () => {
        expect(isValidConversion(format, 'pdf')).toBe(true);
      });
    }
  });
});
